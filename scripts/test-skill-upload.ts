/**
 * Checks that a skill can be uploaded as a file, and that a file which is not a
 * skill leaves nothing behind.
 *
 * Run with Node 22:
 *   EGGENT_TEST_STUBS=i18n/server node --experimental-strip-types \
 *     --import ./scripts/alias-loader-register.mjs scripts/test-skill-upload.ts
 *
 * What has to hold, because each is a way for an upload to do harm or to look
 * as if it worked:
 *
 *   - the archive is a stranger's, so a name that climbs out of the skill's
 *     folder, a link, an entry that lies about its size, a password and a
 *     bomb are all refused before a byte is written;
 *   - a skill the check accepts is a skill the agent runtime loads: the same
 *     YAML library reads the header, and the runtime's own loader is asked;
 *   - a failed install removes what it made, a half-written skill is never
 *     visible under its name, and an existing skill is never overwritten unless
 *     the person said to;
 *   - the route refuses a request with no session, from another page, or with a
 *     body it does not read, and every refusal arrives as a sentence.
 *
 * The archives are forged here, byte by byte, so a lie in them is a field the
 * test chose; a few more are made by the system's `zip`, when there is one, to
 * show the reader agrees with a real tool.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-skill-upload-"));
process.chdir(workDir);
process.env.EGGENT_AUTH_SECRET = "skill-upload-test-secret-0123456789abcdef";
const projectsDir = path.join(workDir, "data", "projects");
await fs.mkdir(projectsDir, { recursive: true });

const { crc32, listZip, readZipEntry, ZipError } = await import("../src/lib/skills/zip-reader.ts");
const { checkSkillUpload } = await import("../src/lib/skills/upload-check.ts");
const { installUploadedSkill, REPLACED_DIRNAME } = await import("../src/lib/skills/upload-install.ts");
const { splitSkillFile, readFrontmatterStrings } = await import("../src/lib/skills/frontmatter.ts");
const { SKILL_ISSUE_MESSAGES } = await import("../src/lib/skills/issues.ts");
const { SKILL_MAX_FILES, SKILL_UNPACKED_MAX_BYTES, SKILL_ARCHIVE_MAX_BYTES } = await import("../src/lib/skills/limits.ts");
const store = await import("../src/lib/storage/project-store.ts");
const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const route = await import("../src/app/api/projects/[id]/skills/upload/route.ts");
const { NextRequest } = await import("next/server.js");

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}
function skip(name: string, why: string): void {
  console.log(`  skip  ${name} (${why})`);
}

// --- Forging archives --------------------------------------------------------

interface ForgedEntry {
  name: string | Buffer;
  data?: Buffer | string;
  /** 0 stored, 8 deflated; anything else is written as the label only. */
  method?: number;
  /** Unix mode with its type bits: 0o100755 is an executable file, 0o120777 a link. */
  mode?: number;
  flags?: number;
  /** Declared size and CRC, when the entry is to lie. */
  size?: number;
  crc?: number;
  /** Bytes stored in place of the real ones. */
  raw?: Buffer;
  /** The "made by" host: 3 is Unix, 0 is MS-DOS. */
  host?: number;
}

function forgeZip(entries: ForgedEntry[], options: { total?: number; comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, "utf-8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf-8");
    const method = entry.method ?? 8;
    const packed = entry.raw ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = entry.crc ?? crc32(data);
    const size = entry.size ?? data.length;
    const flags = entry.flags ?? 0x0800;
    const isDirectory = !Buffer.isBuffer(entry.name) && entry.name.endsWith("/");
    const mode = entry.mode ?? (isDirectory ? 0o040755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([local, name, packed]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.host ?? 3) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((mode << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);

    locals.push(localRecord);
    centrals.push(Buffer.concat([central, name]));
    offset += localRecord.length;
  }
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "", "utf-8");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.total ?? entries.length, 8);
  end.writeUInt16LE(options.total ?? entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment]);
}

const header = (name: string, description = "Does a thing. Use when asked.", extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nSteps.\n`;
const GOOD = header("my-skill");

async function accepted(fileName: string, data: Buffer) {
  const result = await checkSkillUpload({ fileName, data });
  assert.ok(result.ok, result.ok ? "" : `refused: ${JSON.stringify(result.issues)}`);
  return result.skill;
}
async function refused(fileName: string, data: Buffer, code: string) {
  const result = await checkSkillUpload({ fileName, data });
  assert.ok(!result.ok, "was accepted");
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes(code as never), `expected ${code}, got ${codes.join(", ")}`);
  return result.issues;
}

// --- The reader --------------------------------------------------------------
console.log("\nthe reader:");

await check("the CRC the fixtures rely on is the standard one", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

await check("stored and deflated entries read back exactly, with their modes", async () => {
  const zip = forgeZip([
    { name: "a.txt", data: "hello", method: 0 },
    { name: "run.sh", data: "#!/bin/sh\n".repeat(500), mode: 0o100755 },
    { name: "dir/", data: "" },
    { name: "empty.txt", data: "" },
  ]);
  const entries = listZip(zip);
  assert.deepEqual(entries.map((entry) => [entry.path, entry.kind, entry.executable]), [
    ["a.txt", "file", false],
    ["run.sh", "file", true],
    ["dir/", "directory", false],
    ["empty.txt", "file", false],
  ]);
  assert.equal((await readZipEntry(zip, entries[0])).toString(), "hello");
  assert.equal((await readZipEntry(zip, entries[1])).length, 5000);
  assert.equal((await readZipEntry(zip, entries[3])).length, 0);
});

await check("an archive comment, even one that looks like a record, does not fool it", async () => {
  const zip = forgeZip([{ name: "a.txt", data: "x" }], { comment: "PK\u0005\u0006 not the end" });
  assert.equal(listZip(zip).length, 1);
});

await check("an entry that claims 10 bytes and unpacks to 50 MB stops at 10 and is called damaged", async () => {
  const bomb = zlib.deflateRawSync(Buffer.alloc(50 * 1024 * 1024));
  assert.ok(bomb.length < 100 * 1024, "the bomb should be small");
  const zip = forgeZip([{ name: "a.txt", data: Buffer.alloc(10), raw: bomb }]);
  const [entry] = listZip(zip);
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(readZipEntry(zip, entry), (error: unknown) => error instanceof ZipError && error.code === "corrupt");
  assert.ok(process.memoryUsage().arrayBuffers - before < 20 * 1024 * 1024, "it should not have inflated the lot");
});

await check("a wrong CRC, a short entry and a cut-off body are all damage", async () => {
  for (const entry of [
    { name: "a.txt", data: "hello", crc: 1 },
    { name: "a.txt", data: "hello", size: 9, method: 0 },
    { name: "a.txt", data: "hello", raw: Buffer.from("he"), method: 0 },
  ]) {
    const zip = forgeZip([entry]);
    await assert.rejects(readZipEntry(zip, listZip(zip)[0]), (error: unknown) => error instanceof ZipError && error.code === "corrupt");
  }
});

await check("an archive that is not one, or is cut off, is not a zip", () => {
  for (const data of [Buffer.from("hello"), Buffer.alloc(0), Buffer.alloc(100), forgeZip([{ name: "a", data: "x" }]).subarray(0, 40)]) {
    assert.throws(() => listZip(data), (error: unknown) => error instanceof ZipError && error.code === "not-zip");
  }
});

// --- The check: what is let through -----------------------------------------
console.log("\nwhat the check lets through:");

await check("a SKILL.md on its own", async () => {
  const skill = await accepted("my-skill.md", Buffer.from(GOOD));
  assert.equal(skill.name, "my-skill");
  assert.equal(skill.description, "Does a thing. Use when asked.");
  assert.deepEqual(skill.files.map((file) => file.path), ["SKILL.md"]);
  assert.equal(skill.files[0].data.toString(), GOOD, "written exactly as sent");
  assert.deepEqual(skill.notes, []);
});

await check("a header with a byte-order mark and Windows line endings", async () => {
  const text = "\uFEFF" + GOOD.replace(/\n/g, "\r\n");
  const skill = await accepted("x.md", Buffer.from(text));
  assert.equal(skill.name, "my-skill");
  assert.equal(skill.files[0].data.toString(), text, "the file is not rewritten for it");
});

await check("a description written as a folded block, a literal block, or in quotes with colons", async () => {
  const folded = await accepted("x.md", Buffer.from("---\nname: a\ndescription: >-\n  Builds the report.\n  Use when: asked.\n---\nBody\n"));
  assert.equal(folded.description, "Builds the report. Use when: asked.");
  const literal = await accepted("x.md", Buffer.from("---\nname: a\ndescription: |\n  Line one.\n  Line two.\n---\nBody\n"));
  assert.equal(literal.description, "Line one.\nLine two.");
  const quoted = await accepted("x.md", Buffer.from('---\nname: a\ndescription: "Use when: the user asks"\n---\nBody\n'));
  assert.equal(quoted.description, "Use when: the user asks");
});

await check("the optional fields of the format, and keys of its own, do no harm", async () => {
  const skill = await accepted(
    "x.md",
    Buffer.from("---\nname: pdf2-text\ndescription: d\nlicense: MIT\ncompatibility: needs python\nmetadata:\n  version: \"1.0\"\nallowed-tools: Bash Read\ncard_order: 3\n---\nBody\n")
  );
  assert.equal(skill.name, "pdf2-text");
});

await check("an archive with the skill in one folder, as `zip -r skill.zip my-skill` makes it", async () => {
  const zip = forgeZip([
    { name: "my-skill/", data: "" },
    { name: "my-skill/SKILL.md", data: GOOD },
    { name: "my-skill/scripts/run.sh", data: "echo hi\n", mode: 0o100755 },
    { name: "my-skill/references/guide.md", data: "guide\n", method: 0 },
    { name: "my-skill/assets/", data: "" },
  ]);
  const skill = await accepted("my-skill.zip", zip);
  assert.deepEqual(skill.files.map((file) => file.path).sort(), ["SKILL.md", "references/guide.md", "scripts/run.sh"]);
  assert.deepEqual(skill.directories, ["assets"], "an empty folder is kept; the skill's own folder is not one of its folders");
  assert.equal(skill.files.find((file) => file.path === "scripts/run.sh")?.executable, true);
  assert.equal(skill.files.find((file) => file.path === "SKILL.md")?.executable, false);
});

await check("an archive with the skill at the top, and the same file called .skill", async () => {
  const zip = forgeZip([
    { name: "SKILL.md", data: GOOD },
    { name: "scripts/a.py", data: "print(1)\n" },
  ]);
  assert.equal((await accepted("x.zip", zip)).files.length, 2);
  assert.equal((await accepted("x.skill", zip)).files.length, 2);
  assert.equal((await accepted("X.SKILL", zip)).files.length, 2);
});

await check("what a file manager adds is dropped, not complained about", async () => {
  const zip = forgeZip([
    { name: "__MACOSX/my-skill/._SKILL.md", data: "junk" },
    { name: "my-skill/SKILL.md", data: GOOD },
    { name: "my-skill/.DS_Store", data: "junk" },
    { name: "my-skill/._notes.md", data: "junk" },
    { name: "my-skill/.git/config", data: "junk" },
    { name: "my-skill/Thumbs.db", data: "junk" },
    { name: "my-skill/references/", data: "" },
    { name: "my-skill/references/.DS_Store", data: "junk" },
  ]);
  assert.deepEqual((await accepted("x.zip", zip)).files.map((file) => file.path), ["SKILL.md"]);
});

await check("names written with ./ and with backslashes, and a file name in another script", async () => {
  const zip = forgeZip([
    { name: "./SKILL.md", data: GOOD },
    { name: "references\\guide.md", data: "x" },
    { name: "references/参考資料.md", data: "y" },
  ]);
  const paths = (await accepted("x.zip", zip)).files.map((file) => file.path).sort();
  assert.deepEqual(paths, ["SKILL.md", "references/guide.md", "references/参考資料.md"].sort());
});

await check("files beside the skill's folder are left out of it", async () => {
  const zip = forgeZip([
    { name: "README.md", data: "not part of the skill" },
    { name: "my-skill/SKILL.md", data: GOOD },
    { name: "other/file.txt", data: "x" },
  ]);
  assert.deepEqual((await accepted("x.zip", zip)).files.map((file) => file.path), ["SKILL.md"]);
});

const haveZip = (() => {
  try {
    execFileSync("zip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!haveZip) skip("an archive made by the system's zip", "no zip here");
else await check("an archive made by the system's zip", async () => {
  const dir = path.join(workDir, "real-zip", "real-skill");
  await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), header("real-skill"));
  await fs.writeFile(path.join(dir, "scripts", "go.sh"), "echo go\n", { mode: 0o755 });
  await fs.writeFile(path.join(dir, ".DS_Store"), "junk");
  const parent = path.dirname(dir);
  execFileSync("zip", ["-r", "-q", "real.zip", "real-skill"], { cwd: parent });
  const skill = await accepted("real.zip", await fs.readFile(path.join(parent, "real.zip")));
  assert.equal(skill.name, "real-skill");
  assert.deepEqual(skill.files.map((file) => file.path).sort(), ["SKILL.md", "scripts/go.sh"]);
  assert.equal(skill.files.find((file) => file.path === "scripts/go.sh")?.executable, true);

  await fs.symlink("SKILL.md", path.join(dir, "alias.md"));
  execFileSync("zip", ["-r", "-q", "-y", "linked.zip", "real-skill"], { cwd: parent });
  await refused("linked.zip", await fs.readFile(path.join(parent, "linked.zip")), "link");
});

// --- The check: what is turned away ----------------------------------------
console.log("\nwhat the check turns away:");

await check("a file that is not a skill file at all, an empty one, one that is too big", async () => {
  await refused("notes.txt", Buffer.from(GOOD), "unsupportedType");
  await refused("skill", Buffer.from(GOOD), "unsupportedType");
  await refused("x.md", Buffer.alloc(0), "empty");
  await refused("x.zip", Buffer.alloc(SKILL_ARCHIVE_MAX_BYTES + 1), "tooLarge");
});

await check("an archive that is not one, is cut off, uses ZIP64, or is protected by a password", async () => {
  await refused("x.zip", Buffer.from(GOOD), "notZip");
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD }]).subarray(0, 60), "notZip");
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD }], { total: 0xffff }), "zipUnsupported");
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD, flags: 0x0801 }]), "zipEncrypted");
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD, method: 9 }]), "zipUnsupported");
});

await check("an entry that is damaged is named", async () => {
  const issues = await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD }, { name: "a.bin", data: "hello", crc: 7 }]), "zipCorrupt");
  assert.equal(issues[0].params?.path, "a.bin");
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD, crc: 7 }]), "zipCorrupt");
});

await check("a name that climbs out of the skill's folder, in any of its spellings", async () => {
  for (const name of ["../evil.sh", "a/../../evil.sh", "/etc/passwd", "C:/evil.sh", "..\\evil.sh", "a/b/../../../c", "..", "bad\u0001name"]) {
    const zip = forgeZip([{ name: "SKILL.md", data: GOOD }, { name, data: "x" }]);
    await refused("x.zip", zip, "unsafePath");
  }
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD }, { name: Buffer.from("a\u0000b"), data: "x" }]), "unsafePath");
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD }, { name: "x".repeat(300), data: "x" }]), "unsafePath");
});

await check("one that sits inside a file manager's junk is judged too", async () => {
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD }, { name: "__MACOSX/../evil", data: "x" }]), "unsafePath");
});

await check("a link, a device, a pipe", async () => {
  for (const mode of [0o120777, 0o020644, 0o010644, 0o140755]) {
    const zip = forgeZip([{ name: "SKILL.md", data: GOOD }, { name: "refs/x", data: "../../etc/passwd", mode }]);
    await refused("x.zip", zip, "link");
  }
});

await check("the same name twice, and a name that is a file and a folder", async () => {
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD }, { name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }]), "duplicatePath");
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD }, { name: "a", data: "1" }, { name: "a/b", data: "2" }]), "duplicatePath");
});

await check("too many files, and files that add up to too much", async () => {
  const many = Array.from({ length: SKILL_MAX_FILES }, (_, i) => ({ name: `f/${i}.txt`, data: "x" }));
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD }, ...many]), "tooManyFiles");
  await accepted("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD }, ...many.slice(1)]));
  const half = Math.floor(SKILL_UNPACKED_MAX_BYTES / 2) + 1;
  await refused(
    "x.zip",
    forgeZip([{ name: "SKILL.md", data: GOOD }, { name: "a.bin", data: "x", size: half }, { name: "b.bin", data: "x", size: half }]),
    "unpackedTooLarge"
  );
});

await check("where SKILL.md is not, and where it is instead", async () => {
  await refused("x.zip", forgeZip([{ name: "my-skill/readme.md", data: "x" }]), "skillMdMissing");
  await refused("x.zip", forgeZip([]), "skillMdMissing");
  const lower = await refused("x.zip", forgeZip([{ name: "my-skill/skill.md", data: GOOD }]), "skillMdCase");
  assert.equal(lower[0].params?.path, "my-skill/skill.md");
  const deep = await refused("x.zip", forgeZip([{ name: "repo-main/skills/pdf/SKILL.md", data: GOOD }]), "skillMdNested");
  assert.equal(deep[0].params?.path, "repo-main/skills/pdf/SKILL.md");
  const several = await refused("x.zip", forgeZip([{ name: "a/SKILL.md", data: GOOD }, { name: "b/SKILL.md", data: GOOD }]), "severalSkills");
  assert.equal(several[0].params?.names, "a, b");
});

await check("a SKILL.md that is not text, or is too long", async () => {
  await refused("x.md", Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0xfa]), "skillMdNotText");
  await refused("x.md", Buffer.from(GOOD + "\u0000"), "skillMdNotText");
  await refused("x.md", Buffer.from(GOOD + "x".repeat(600 * 1024)), "skillMdTooLarge");
  await refused("x.zip", forgeZip([{ name: "SKILL.md", data: GOOD + "x".repeat(600 * 1024) }]), "skillMdTooLarge");
});

await check("a header that is missing, has something before it, or is never closed", async () => {
  await refused("x.md", Buffer.from("# Just a document\n"), "frontmatterMissing");
  await refused("x.md", Buffer.from("\n" + GOOD), "frontmatterMissing");
  await refused("x.md", Buffer.from("--- name\n" + GOOD.slice(4)), "frontmatterMissing");
  await refused("x.md", Buffer.from("---\nname: a\ndescription: d\n\nbody"), "frontmatterUnclosed");
  await refused("x.md", Buffer.from("---\nname: a\ndescription: d\n----\nbody"), "frontmatterUnclosed");
});

await check("a header that is not YAML, with the line it breaks on", async () => {
  const colon = await refused("x.md", Buffer.from("---\nname: a\ndescription: Use when: the user asks\n---\nBody\n"), "frontmatterYaml");
  assert.equal(colon[0].params?.line, 3);
  assert.match(String(colon[0].params?.reason), /mapping|compact|implicit/i);
  await refused("x.md", Buffer.from("---\nname: a\nname: b\ndescription: d\n---\nBody\n"), "frontmatterYaml");
  await refused("x.md", Buffer.from('---\nname: a\ndescription: "unclosed\n---\nBody\n'), "frontmatterYaml");
  await refused("x.md", Buffer.from("---\nname: a\n\tdescription: d\n---\nBody\n"), "frontmatterYaml");
  await refused("x.md", Buffer.from("---\n- one\n- two\n---\nBody\n"), "frontmatterNotMap");
  await refused("x.md", Buffer.from("---\njust words\n---\nBody\n"), "frontmatterNotMap");
});

await check("every fault in the header is reported, not only the first", async () => {
  const issues = await refused("x.md", Buffer.from("---\n---\nBody\n"), "fieldMissing");
  assert.deepEqual(issues.map((issue) => `${issue.code}:${issue.params?.field}`), ["fieldMissing:name", "fieldMissing:description"]);
  const mixed = await refused("x.md", Buffer.from("---\nname: Bad_Name\ndescription:\n---\nBody\n"), "nameInvalid");
  assert.deepEqual(mixed.map((issue) => issue.code), ["nameInvalid", "fieldMissing"]);
});

await check("a name that is not a name, and fields that are not text or are too long", async () => {
  for (const name of ["My-Skill", "my_skill", "-skill", "skill-", "a--b", "my skill", "名前"]) {
    await refused("x.md", Buffer.from(header(`"${name}"`)), "nameInvalid");
  }
  await refused("x.md", Buffer.from(header("123")), "fieldNotText");
  await refused("x.md", Buffer.from("---\nname: a\ndescription: [one, two]\n---\nBody\n"), "fieldNotText");
  await refused("x.md", Buffer.from(header("a".repeat(65))), "fieldTooLong");
  await refused("x.md", Buffer.from(header("a", "d".repeat(1025))), "fieldTooLong");
  await accepted("x.md", Buffer.from(header("a".repeat(64), "d".repeat(1024))));
  await refused("x.md", Buffer.from(header("a", "d", `compatibility: ${"c".repeat(501)}\n`)), "fieldTooLong");
});

await check("a header built to blow up when it is read is refused, quickly", async () => {
  const lines = ["name: bomb", "description: d", 'a: &a ["x","x","x","x","x","x","x","x","x"]'];
  let previous = "a";
  for (const next of "bcdefghi") {
    lines.push(`${next}: &${next} [${Array(9).fill(`*${previous}`).join(",")}]`);
    previous = next;
  }
  const started = Date.now();
  await refused("x.md", Buffer.from(`---\n${lines.join("\n")}\n---\nBody\n`), "frontmatterYaml");
  assert.ok(Date.now() - started < 2000, "it should not have been expanded");
});

await check("every problem has a sentence of its own", () => {
  const codes = Object.keys(SKILL_ISSUE_MESSAGES);
  assert.equal(new Set(Object.values(SKILL_ISSUE_MESSAGES)).size, codes.length);
});

// --- The agent's mark --------------------------------------------------------
console.log("\nthe mark of a skill the agent wrote:");

await check("the mark comes off an uploaded skill, which is then the person's, and they are told", async () => {
  const text = '---\nname: learned-one\ndescription: Made by the agent.\norigin: learned\nlearned_at: "2026-10-01T10:00:00.000Z"\nlicense: MIT\n---\n\nBody\n';
  const skill = await accepted("x.md", Buffer.from(text));
  assert.deepEqual(skill.notes, ["learnedMarkerRemoved"]);
  const written = skill.files[0].data.toString();
  assert.equal(written, '---\nname: learned-one\ndescription: Made by the agent.\nlicense: MIT\n---\n\nBody\n');
  const parsed = readFrontmatterStrings((splitSkillFile(written) as { block: string }).block);
  assert.equal(parsed?.origin, undefined);
  assert.equal(parsed?.license, "MIT");
});

await check("with Windows line endings the lines go and the endings stay", async () => {
  const text = "---\r\nname: a\r\ndescription: d\r\norigin: 'learned'\r\n---\r\nBody\r\n";
  const written = (await accepted("x.md", Buffer.from(text))).files[0].data.toString();
  assert.equal(written, "---\r\nname: a\r\ndescription: d\r\n---\r\nBody\r\n");
});

await check("a mark that cannot be taken out cleanly is a refusal, not a silent keep", async () => {
  await refused("x.md", Buffer.from("---\n{name: a, description: d, origin: learned}\n---\nBody\n"), "learnedMarker");
});

await check("a header with nothing under it is let through, with a note", async () => {
  const skill = await accepted("x.md", Buffer.from("---\nname: a\ndescription: d\n---\n"));
  assert.deepEqual(skill.notes, ["emptyBody"]);
});

// --- What the runtime makes of it -------------------------------------------
console.log("\nthe agent runtime's own reading:");

let pi: typeof import("@earendil-works/pi-coding-agent") | null = null;
try {
  pi = await import("@earendil-works/pi-coding-agent");
} catch {
  pi = null;
}

async function runtimeLoads(skillMd: string, folder = "probe"): Promise<{ names: string[]; descriptions: string[]; diagnostics: number }> {
  const base = await fs.mkdtemp(path.join(workDir, "pi-"));
  await fs.mkdir(path.join(base, folder), { recursive: true });
  await fs.writeFile(path.join(base, folder, "SKILL.md"), skillMd);
  const loaded = pi!.loadSkillsFromDir({ dir: base, source: "path" });
  return {
    names: loaded.skills.map((skill) => skill.name),
    descriptions: loaded.skills.map((skill) => skill.description),
    diagnostics: loaded.diagnostics.length,
  };
}

if (!pi) {
  skip("the runtime loads what the check lets through", "the agent SDK does not load here");
} else {
  await check("everything the check accepts, the runtime loads with the same name and description", async () => {
    const samples = [
      GOOD,
      "\uFEFF" + GOOD.replace(/\n/g, "\r\n"),
      "---\nname: my-skill\ndescription: >-\n  Folded text.\n  Use when: asked.\n---\nBody\n",
      "---\nname: my-skill\ndescription: |\n  Literal.\n---\nBody\n",
      '---\nname: my-skill\ndescription: "Quoted: yes"\nlicense: MIT\nmetadata:\n  version: "1"\n---\nBody\n',
      "---\nname: my-skill # the name\ndescription: d\n---\nBody\n",
    ];
    for (const sample of samples) {
      const skill = await accepted("x.md", Buffer.from(sample));
      const loaded = await runtimeLoads(sample, skill.name);
      assert.deepEqual(loaded.names, [skill.name], JSON.stringify(sample));
      assert.equal(loaded.diagnostics, 0, JSON.stringify(sample));
      assert.equal(loaded.descriptions[0].replace(/\s+/g, " ").trim(), skill.description.replace(/\s+/g, " "), JSON.stringify(sample));
    }
  });

  await check("the header the check refuses for its colon is one the runtime drops without a word", async () => {
    const colon = "---\nname: my-skill\ndescription: Use when: the user asks\n---\nBody\n";
    await refused("x.md", Buffer.from(colon), "frontmatterYaml");
    const loaded = await runtimeLoads(colon, "my-skill");
    assert.deepEqual(loaded.names, []);
  });
}

// --- Installing --------------------------------------------------------------
console.log("\ninstalling:");

await store.createProject({ id: "demo", name: "Demo", description: "", instructions: "# Demo\n", memoryMode: "global" });
const skillsOf = (scope: string) => store.getProjectSkillsDir(scope);
const listDir = async (dir: string) => (await fs.readdir(dir).catch(() => [])).sort();

await check("a skill lands in a project's skills folder as a whole, scripts executable", async () => {
  const zip = forgeZip([
    { name: "inst-one/SKILL.md", data: header("inst-one") },
    { name: "inst-one/scripts/run.sh", data: "echo hi\n", mode: 0o100755 },
    { name: "inst-one/references/a.md", data: "a\n" },
    { name: "inst-one/assets/", data: "" },
  ]);
  const skill = await accepted("inst-one.zip", zip);
  const result = await installUploadedSkill("demo", skill, { replace: false });
  assert.ok(result.ok);
  const dir = path.join(skillsOf("demo"), "inst-one");
  assert.deepEqual(await listDir(dir), ["SKILL.md", "assets", "references", "scripts"]);
  assert.equal(await fs.readFile(path.join(dir, "SKILL.md"), "utf-8"), header("inst-one"));
  assert.ok(((await fs.stat(path.join(dir, "scripts", "run.sh"))).mode & 0o111) !== 0, "executable");
  assert.ok(((await fs.stat(path.join(dir, "SKILL.md"))).mode & 0o111) === 0, "not executable");
  assert.deepEqual((await listDir(skillsOf("demo"))).filter((name) => name.startsWith(".")), [], "no staging folder left");
  const listed = await store.loadProjectSkillsMetadata("demo");
  assert.deepEqual(listed.map((item) => item.name), ["inst-one"]);
});

await check("and into the orchestrator's, with the id the settings page uses for it", async () => {
  const result = await installUploadedSkill("none", await accepted("x.md", Buffer.from(header("orch-one"))), { replace: false });
  assert.ok(result.ok);
  assert.deepEqual(await listDir(path.join(projectsDir, "skills")), ["orch-one"]);
});

await check("a skill that is already there is not touched, and nothing is left behind", async () => {
  const dir = path.join(skillsOf("demo"), "inst-one");
  await fs.writeFile(path.join(dir, "my-edit.md"), "hand-made\n");
  const result = await installUploadedSkill("demo", await accepted("x.md", Buffer.from(header("inst-one", "A different one."))), { replace: false });
  assert.deepEqual(result, { ok: false, code: "exists" });
  assert.equal(await fs.readFile(path.join(dir, "my-edit.md"), "utf-8"), "hand-made\n");
  assert.equal(await fs.readFile(path.join(dir, "SKILL.md"), "utf-8"), header("inst-one"));
  assert.deepEqual((await listDir(skillsOf("demo"))).filter((name) => name.startsWith(".")), []);
});

await check("replacing keeps the old folder, with what the person added to it, and puts the new one in", async () => {
  const replacement = header("inst-one", "The replacement.");
  const result = await installUploadedSkill("demo", await accepted("x.md", Buffer.from(replacement)), { replace: true });
  assert.ok(result.ok && result.replaced);
  const dir = path.join(skillsOf("demo"), "inst-one");
  assert.equal(await fs.readFile(path.join(dir, "SKILL.md"), "utf-8"), replacement);
  assert.deepEqual(await listDir(dir), ["SKILL.md"], "the new skill is the whole of the folder");
  assert.ok(result.ok && result.keptAs?.startsWith(`${REPLACED_DIRNAME}/inst-one-`));
  const kept = path.join(skillsOf("demo"), (result as { keptAs: string }).keptAs);
  assert.equal(await fs.readFile(path.join(kept, "my-edit.md"), "utf-8"), "hand-made\n");
  assert.equal(await fs.readFile(path.join(kept, "scripts", "run.sh"), "utf-8"), "echo hi\n");
  assert.deepEqual((await store.loadProjectSkillsMetadata("demo")).map((item) => item.name), ["inst-one"], "what was put aside is not a skill");
});

await check("replacing a skill that is not there is just an install", async () => {
  const result = await installUploadedSkill("demo", await accepted("x.md", Buffer.from(header("fresh-one"))), { replace: true });
  assert.ok(result.ok && !result.replaced && result.keptAs === null);
});

await check("a write that fails leaves no folder, no half skill and nothing outside", async () => {
  const bad = {
    name: "doomed-one",
    description: "d",
    files: [
      { path: "SKILL.md", data: Buffer.from(header("doomed-one")), executable: false },
      { path: "../../outside.txt", data: Buffer.from("x"), executable: false },
    ],
    directories: [],
    notes: [],
  };
  const before = await listDir(skillsOf("demo"));
  const originalError = console.error;
  console.error = () => {};
  const result = await installUploadedSkill("demo", bad, { replace: false }).finally(() => {
    console.error = originalError;
  });
  assert.deepEqual(result, { ok: false, code: "writeFailed" });
  assert.deepEqual(await listDir(skillsOf("demo")), before);
  assert.equal(await fs.stat(path.join(projectsDir, "demo", "outside.txt")).catch(() => null), null);
  assert.equal(await fs.stat(path.join(projectsDir, "outside.txt")).catch(() => null), null);
});

await check("a staging folder a dead process left is swept up, a recent one is not", async () => {
  const stale = path.join(skillsOf("demo"), ".incoming-deadbeef");
  const fresh = path.join(skillsOf("demo"), ".incoming-cafebabe");
  await fs.mkdir(path.join(stale, "inner"), { recursive: true });
  await fs.mkdir(fresh);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(stale, old, old);
  const result = await installUploadedSkill("demo", await accepted("x.md", Buffer.from(header("sweeper"))), { replace: false });
  assert.ok(result.ok);
  assert.equal(await fs.stat(stale).catch(() => null), null);
  assert.ok(await fs.stat(fresh));
  await fs.rm(fresh, { recursive: true });
});

await check("two uploads of one name at once: one installs, the other is told it exists, nothing is mixed", async () => {
  const a = await accepted("x.md", Buffer.from(header("racer", "From A.")));
  const b = await accepted("x.md", Buffer.from(header("racer", "From B.")));
  const results = await Promise.all([installUploadedSkill("demo", a, { replace: false }), installUploadedSkill("demo", b, { replace: false })]);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  assert.ok(results.some((result) => !result.ok && result.code === "exists"));
  const text = await fs.readFile(path.join(skillsOf("demo"), "racer", "SKILL.md"), "utf-8");
  assert.ok(text.includes("From A.") !== text.includes("From B."));
  assert.deepEqual((await listDir(skillsOf("demo"))).filter((name) => name.startsWith(".incoming")), []);
});

await check("a skill in an older project's .meta folder counts as installed", async () => {
  await store.createProject({ id: "legacy", name: "Legacy", description: "", instructions: "# L\n", memoryMode: "global" });
  await fs.rm(skillsOf("legacy"), { recursive: true, force: true });
  await fs.mkdir(path.join(projectsDir, "legacy", ".meta", "skills", "old-one"), { recursive: true });
  await fs.writeFile(path.join(projectsDir, "legacy", ".meta", "skills", "old-one", "SKILL.md"), header("old-one"));
  const result = await installUploadedSkill("legacy", await accepted("x.md", Buffer.from(header("old-one", "New."))), { replace: false });
  assert.deepEqual(result, { ok: false, code: "exists" });
});

// --- The skills list ---------------------------------------------------------
console.log("\nthe skills list:");

await check("a description written as a block reads as one line, not as a lone > or |", async () => {
  const dir = path.join(skillsOf("demo"), "block-one");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: block-one\ndescription: >-\n  Folded over\n  two lines.\n---\n\nBody\n");
  const dir2 = path.join(skillsOf("demo"), "block-two");
  await fs.mkdir(dir2, { recursive: true });
  await fs.writeFile(path.join(dir2, "SKILL.md"), "---\nname: block-two\ndescription: |\n  Literal one.\n  Literal two.\n---\n\nBody\n");
  const byName = new Map((await store.loadProjectSkillsMetadata("demo")).map((item) => [item.name, item.description]));
  assert.equal(byName.get("block-one"), "Folded over two lines.");
  assert.equal(byName.get("block-two"), "Literal one. Literal two.");
  const full = await store.loadProjectSkills("demo");
  assert.equal(full.find((item) => item.name === "block-one")?.description, "Folded over two lines.");
});

await check("a header that is not YAML is still read line by line, as before", async () => {
  const dir = path.join(skillsOf("demo"), "legacy-header");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: legacy-header\ndescription: Use when: the user asks for it\n---\n\nBody\n");
  const found = (await store.loadProjectSkillsMetadata("demo")).find((item) => item.name === "legacy-header");
  assert.equal(found?.description, "Use when: the user asks for it");
});

await check("a name with a trailing comment still matches its folder", async () => {
  const dir = path.join(skillsOf("demo"), "commented-one");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: commented-one # the name\ndescription: d\n---\n\nBody\n");
  assert.ok((await store.loadProjectSkillsMetadata("demo")).some((item) => item.name === "commented-one"));
});

// --- The route ---------------------------------------------------------------
console.log("\nthe route:");

const ORIGIN = "https://workspace.example.test";
const session = await createSessionToken("owner@example.test", false);
const defaultLoginSession = await createSessionToken("admin", true);

interface UploadOptions {
  cookie?: string | null;
  origin?: string | null;
  site?: string;
  field?: string;
  replace?: boolean;
  json?: boolean;
  contentLength?: number;
}
function uploadRequest(projectId: string, fileName: string, data: Buffer | string, options: UploadOptions = {}) {
  const headers = new Headers();
  const cookie = options.cookie === undefined ? session : options.cookie;
  if (cookie) headers.set("cookie", `${AUTH_COOKIE_NAME}=${cookie}`);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.set("origin", origin);
  headers.set("host", new URL(ORIGIN).host);
  if (options.site) headers.set("sec-fetch-site", options.site);
  if (options.contentLength !== undefined) headers.set("content-length", String(options.contentLength));
  let body: BodyInit;
  if (options.json) {
    headers.set("content-type", "application/json");
    body = JSON.stringify({ file: "x" });
  } else {
    const form = new FormData();
    form.set(options.field ?? "file", new File([typeof data === "string" ? data : new Uint8Array(data)], fileName));
    if (options.replace) form.set("replace", "1");
    body = form;
  }
  return new NextRequest(`${ORIGIN}/api/projects/${projectId}/skills/upload`, { method: "POST", headers, body });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function post(projectId: string, fileName: string, data: Buffer | string, options: UploadOptions = {}) {
  const response = await route.POST(uploadRequest(projectId, fileName, data, options), params(projectId));
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { response, payload };
}

await check("a request with no session, a forged one, or the default login is refused", async () => {
  assert.equal((await post("demo", "x.md", GOOD, { cookie: null })).response.status, 401);
  assert.equal((await post("demo", "x.md", GOOD, { cookie: "forged.value" })).response.status, 401);
  assert.equal((await post("demo", "x.md", GOOD, { cookie: defaultLoginSession })).response.status, 401);
  assert.equal(await fs.stat(path.join(skillsOf("demo"), "route-one")).catch(() => null), null);
});

await check("a page on another site cannot upload with the cookie the browser attaches", async () => {
  for (const origin of ["https://evil.example.test", "https://other-workspace.example.test", "null"]) {
    assert.equal((await post("demo", "x.md", header("route-one"), { origin })).response.status, 403, origin);
  }
  assert.equal((await post("demo", "x.md", header("route-one"), { site: "same-site" })).response.status, 403);
  assert.equal((await post("demo", "x.md", header("route-one"), { site: "cross-site" })).response.status, 403);
  assert.equal(await fs.stat(path.join(skillsOf("demo"), "route-one")).catch(() => null), null);
});

await check("a body that is not a form is refused", async () => {
  assert.equal((await post("demo", "x.md", GOOD, { json: true })).response.status, 415);
});

await check("a skill goes in, and the answer says what it was called and what was done to it", async () => {
  const { response, payload } = await post("demo", "x.md", header("route-one"), { site: "same-origin" });
  assert.equal(response.status, 201);
  assert.equal(payload?.ok, true);
  assert.equal(payload?.skill, "route-one");
  assert.equal(payload?.replaced, false);
  assert.deepEqual(payload?.notes, []);
  assert.ok(await fs.stat(path.join(skillsOf("demo"), "route-one", "SKILL.md")));
});

await check("a file that fails the check is answered in words, nothing is written, and every fault is listed", async () => {
  const before = await listDir(skillsOf("demo"));
  const { response, payload } = await post("demo", "x.md", "---\nname: Bad_Name\n---\nBody\n");
  assert.equal(response.status, 422);
  assert.equal(payload?.ok, false);
  assert.equal(payload?.code, "nameInvalid");
  const problems = payload?.problems as string[];
  assert.equal(problems.length, 2);
  assert.match(problems[0], /Bad_Name/);
  assert.match(problems[1], /description/);
  assert.equal(payload?.error, problems[0]);
  assert.deepEqual(await listDir(skillsOf("demo")), before);
});

await check("an archive with its SKILL.md in the wrong place says where it was found", async () => {
  const { response, payload } = await post("demo", "x.zip", forgeZip([{ name: "repo/skills/pdf/SKILL.md", data: GOOD }]));
  assert.equal(response.status, 422);
  assert.equal(payload?.code, "skillMdNested");
  assert.match(String(payload?.error), /repo\/skills\/pdf\/SKILL\.md/);
});

await check("a skill that exists is a conflict until the person says to replace it", async () => {
  const again = await post("demo", "x.md", header("route-one", "Second."));
  assert.equal(again.response.status, 409);
  assert.equal(again.payload?.code, "exists");
  assert.match(String(again.payload?.error), /route-one/);
  assert.match(await fs.readFile(path.join(skillsOf("demo"), "route-one", "SKILL.md"), "utf-8"), /Does a thing/);

  const replaced = await post("demo", "x.md", header("route-one", "Second."), { replace: true });
  assert.equal(replaced.response.status, 201);
  assert.equal(replaced.payload?.replaced, true);
  assert.match(String(replaced.payload?.keptAs), /^skills\/\.replaced\/route-one-/);
  assert.match(await fs.readFile(path.join(skillsOf("demo"), "route-one", "SKILL.md"), "utf-8"), /Second\./);
});

await check("the orchestrator is addressed as none, a project that is gone is a 404", async () => {
  assert.equal((await post("none", "x.md", header("route-orch"))).response.status, 201);
  assert.ok(await fs.stat(path.join(projectsDir, "skills", "route-orch", "SKILL.md")));
  const missing = await post("no-such-project", "x.md", header("route-gone"));
  assert.equal(missing.response.status, 404);
  assert.equal(await fs.stat(path.join(projectsDir, "no-such-project")).catch(() => null), null);
});

await check("a project id that tries to leave the projects folder is a project that does not exist", async () => {
  for (const id of ["../outside", "..", "demo/../../outside", "skills"]) {
    const { response } = await post(id, "x.md", header("route-evil"));
    assert.equal(response.status, 404, id);
  }
  assert.equal(await fs.stat(path.join(workDir, "data", "outside")).catch(() => null), null);
  assert.equal(await fs.stat(path.join(projectsDir, "skills", "route-evil")).catch(() => null), null);
  assert.equal(await fs.stat(path.join(workDir, "data", "skills")).catch(() => null), null);
});

await check("a request without a file, or too large to be a skill, is turned away before it is read", async () => {
  const none = await post("demo", "x.md", GOOD, { field: "attachment" });
  assert.equal(none.response.status, 400);
  assert.equal(none.payload?.code, "noFile");
  const big = await post("demo", "x.zip", "x", { contentLength: SKILL_ARCHIVE_MAX_BYTES + 2 * 1024 * 1024 });
  assert.equal(big.response.status, 413);
  assert.match(String(big.payload?.error), /too big/);
});

await check("a skill that was told its mark was removed says so in the answer", async () => {
  const text = "---\nname: route-learned\ndescription: d\norigin: learned\n---\nBody\n";
  const { response, payload } = await post("demo", "x.md", text);
  assert.equal(response.status, 201);
  assert.equal((payload?.notes as string[]).length, 1);
  assert.match((payload?.notes as string[])[0], /origin: learned/);
  assert.doesNotMatch(await fs.readFile(path.join(skillsOf("demo"), "route-learned", "SKILL.md"), "utf-8"), /origin/);
  assert.ok(!(await store.loadProjectSkillsMetadata("demo")).find((item) => item.name === "route-learned")?.learned);
});

console.log(`\n${ran} checks, ${failed} failed`);
await fs.rm(workDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
