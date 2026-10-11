/**
 * A folder as one .zip.
 *
 * Drives the real route and checks the archive by every means to hand: the
 * reader this project already has, the system's unzip, and Python's zipfile -
 * three implementations that have to agree it is a good archive. Then the part
 * that is about somebody's folder rather than about the format: a link out of
 * it is not followed, files that hold credentials are not packed, a path that
 * leaves the folder is refused, an unreasonable archive is refused before any
 * of it is sent, and a download that is cancelled lets go of everything.
 *
 * No network. Run with Node 22:
 *   npm run test:files-zip
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-files-zip-"));
process.chdir(root);
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-files-zip-outside-"));
fs.writeFileSync(path.join(outside, "private.txt"), "NOT-FOR-THE-ARCHIVE");

const project = path.join(root, "data", "projects", "p1");
const write = (relative: string, content: string | Buffer, mode?: number) => {
  const full = path.join(project, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (mode) fs.chmodSync(full, mode);
};

const bigText = "The quick brown fox jumps over the lazy dog.\n".repeat(30_000);
const randomBytes = crypto.randomBytes(200_000);
write("report/summary.md", "# Summary\n\nAll good.\n");
write("report/data/numbers.csv", "a,b\n1,2\n3,4\n");
write("report/\u043e\u0442\u0447\u0451\u0442 \u043d\u043e\u044f\u0431\u0440\u044c.txt", "\u043f\u0440\u0438\u0432\u0435\u0442");
write("report/empty.txt", "");
write("report/big.txt", bigText);
write("report/photo.png", randomBytes);
write("report/run.sh", "#!/bin/sh\necho hi\n", 0o755);
// What must not be packed.
write("report/.env", "API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaa");
write("report/.mcp.json", "{\"mcpServers\":{}}");
write("report/server.pem", "-----BEGIN PRIVATE KEY-----");
write("report/node_modules/dep/index.js", "module.exports = 1;");
write("report/.venv/bin/python", "x");
write("report/.git/config", "x");
write("report/.DS_Store", "x");
write("loose.txt", "at the root");
write("other/readme.md", "other folder");
fs.symlinkSync(path.join(outside, "private.txt"), path.join(project, "report", "link-to-private.txt"));
fs.symlinkSync(outside, path.join(project, "link-to-outside"));

const { GET } = await import("../src/app/api/files/zip/route.ts");
const { listZip, readZipEntry } = await import("../src/lib/skills/zip-reader.ts");
const { planZip, ZipLimitError, ZipPathError } = await import("../src/lib/files/zip-walk.ts");
const { zipStream } = await import("../src/lib/files/zip-writer.ts");

const call = (query: string) => GET(new NextRequest(`http://localhost/api/files/zip?${query}`));
async function archive(query: string): Promise<{ buffer: Buffer; headers: Headers }> {
  const response = await call(query);
  assert.equal(response.status, 200, await response.clone().text());
  return { buffer: Buffer.from(await response.arrayBuffer()), headers: response.headers };
}
const openFiles = () => {
  try {
    return fs.readdirSync("/dev/fd").length;
  } catch {
    return -1;
  }
};

console.log("A folder, packed\n");

const folder = await archive("project=p1&path=report");
const entries = listZip(folder.buffer);
const names = entries.map((entry) => entry.path).sort();

await check("it is sent as a download named after the folder", () => {
  assert.equal(folder.headers.get("content-type"), "application/zip");
  assert.match(folder.headers.get("content-disposition") ?? "", /attachment; filename="report\.zip"/);
  assert.equal(folder.headers.get("cache-control"), "no-store");
});
await check("one folder unpacks as that folder, with its structure", () => {
  assert.ok(names.includes("report/summary.md"));
  assert.ok(names.includes("report/data/numbers.csv"));
  assert.ok(names.every((name) => name.startsWith("report/")), names.join(", "));
});
await check("every file comes back byte for byte, and its CRC checks", async () => {
  for (const entry of entries) {
    const contents = await readZipEntry(folder.buffer, entry);
    const source = fs.readFileSync(path.join(project, entry.path));
    assert.ok(contents.equals(source), entry.path);
  }
});
await check("a Russian name survives, an empty file is there, an executable stays executable", () => {
  assert.ok(names.includes("report/\u043e\u0442\u0447\u0451\u0442 \u043d\u043e\u044f\u0431\u0440\u044c.txt"));
  const empty = entries.find((entry) => entry.path === "report/empty.txt");
  assert.equal(empty?.size, 0);
  assert.equal(entries.find((entry) => entry.path === "report/run.sh")?.executable, true);
  assert.equal(entries.find((entry) => entry.path === "report/summary.md")?.executable, false);
});
await check("text is compressed and a picture is not recompressed", () => {
  const big = entries.find((entry) => entry.path === "report/big.txt");
  assert.ok(big && big.compressedSize < big.size / 5, "text should shrink a lot");
  const photo = entries.find((entry) => entry.path === "report/photo.png");
  assert.ok(photo && photo.compressedSize >= photo.size, "a picture is stored, not squeezed");
  assert.ok(photo.compressedSize < photo.size + 1024, "...and not made much larger either");
});
await check("the system's unzip agrees it is a good archive", () => {
  const file = path.join(root, "folder.zip");
  fs.writeFileSync(file, folder.buffer);
  const result = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
  if (result.error) {
    console.log("        (no unzip on this machine: skipped)");
    return;
  }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /No errors detected/);
});
await check("Python's zipfile agrees too, and reads the same names", () => {
  const file = path.join(root, "folder.zip");
  fs.writeFileSync(file, folder.buffer);
  const script = "import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint('\\n'.join(sorted(i.filename for i in z.infolist())))";
  const out = execFileSync("python3", ["-I", "-c", script, file], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n"), names);
});

console.log("\nWhat is not packed\n");

await check("links are not followed, and a folder that is a link out is not entered", () => {
  assert.ok(!names.some((name) => name.includes("link-to-private")));
  const whole = listZip(Buffer.from(fs.readFileSync(path.join(root, "folder.zip"))));
  assert.ok(whole.every((entry) => !entry.path.includes("NOT-FOR")));
});
await check("files that hold credentials are left out, and the person is told how many", async () => {
  assert.ok(!names.some((name) => /\.env|\.mcp\.json|\.pem/.test(name)), names.join(", "));
  const info = await (await call("project=p1&path=report&check=1")).json() as { files: number; skipped: { secrets: number; links: number; hidden: number } };
  assert.equal(info.skipped.secrets, 3);
  assert.equal(info.skipped.links, 1);
  assert.ok(info.skipped.hidden >= 4, "dependencies, the virtualenv, git and the Finder file");
  assert.equal(info.files, entries.length);
});
await check("dependencies, caches and the runtime's own state are not in a download", () => {
  assert.ok(!names.some((name) => /node_modules|\.venv|\.git|DS_Store/.test(name)));
});

console.log("\nPaths\n");

await check("a path that leaves the folder is refused", async () => {
  for (const query of ["project=p1&path=..", "project=p1&path=../../..", "project=p1&path=report/../../.."]) {
    const response = await call(query);
    assert.equal(response.status, 403, query);
  }
});
await check("a folder on the way that is a link out is refused, not read", async () => {
  const response = await call("project=p1&path=link-to-outside");
  // A link as the target is skipped; as an ancestor it is refused. Either way nothing of it is sent.
  assert.ok(response.status === 404 || response.status === 403, String(response.status));
  const nested = await call("project=p1&path=link-to-outside/private.txt");
  assert.ok(nested.status === 403 || nested.status === 404, String(nested.status));
  assert.notEqual(nested.status, 200);
});
await check("a name that is not there is nothing to download", async () => {
  assert.equal((await call("project=p1&path=nothing-here")).status, 404);
});
await check("the project is required", async () => {
  assert.equal((await call("path=report")).status, 400);
});

console.log("\nSeveral files, and the whole workspace\n");

await check("named files keep their place in the folder", async () => {
  const { buffer, headers } = await archive("project=p1&path=report/summary.md&path=loose.txt");
  assert.deepEqual(listZip(buffer).map((entry) => entry.path).sort(), ["loose.txt", "report/summary.md"]);
  assert.match(headers.get("content-disposition") ?? "", /files\.zip/);
});
await check("the whole project is packed relative to itself", async () => {
  const { buffer, headers } = await archive("project=p1");
  const all = listZip(buffer).map((entry) => entry.path);
  assert.ok(all.includes("loose.txt") && all.includes("report/summary.md") && all.includes("other/readme.md"));
  assert.match(headers.get("content-disposition") ?? "", /p1\.zip/);
});
await check("the orchestrator's folder is the whole of data/projects", async () => {
  const { buffer, headers } = await archive("project=none");
  const all = listZip(buffer).map((entry) => entry.path);
  assert.ok(all.includes("p1/loose.txt"));
  assert.match(headers.get("content-disposition") ?? "", /workspace\.zip/);
});

console.log("\nWhen it is too much\n");

await check("too many files is refused with the limit, before anything is sent", async () => {
  process.env.EGGENT_ZIP_MAX_FILES = "3";
  try {
    const response = await call("project=p1&path=report");
    assert.equal(response.status, 413);
    const body = await response.json() as { reason: string; limit: number; error: string };
    assert.equal(body.reason, "files");
    assert.equal(body.limit, 3);
    assert.match(body.error, /too many files/i);
  } finally {
    delete process.env.EGGENT_ZIP_MAX_FILES;
  }
});
await check("too many bytes is refused too, naming both sizes", async () => {
  process.env.EGGENT_ZIP_MAX_MB = "0.1";
  try {
    const response = await call("project=p1&path=report");
    assert.equal(response.status, 413);
    const body = await response.json() as { reason: string; error: string };
    assert.equal(body.reason, "bytes");
    assert.match(body.error, /too large/i);
  } finally {
    delete process.env.EGGENT_ZIP_MAX_MB;
  }
});
await check("the same limits are enforced by the planner on its own", async () => {
  await assert.rejects(planZip(project, ["report"], { maxFiles: 2 }), (error) => error instanceof ZipLimitError && error.kind === "files");
  await assert.rejects(planZip(project, ["report"], { maxBytes: 10 }), (error) => error instanceof ZipLimitError && error.kind === "bytes");
  await assert.rejects(planZip(project, ["../x"]), (error) => error instanceof ZipPathError);
});

console.log("\nCancelling\n");

await check("a download that is cancelled lets go of every file, and the next one is not turned away", async () => {
  const files = [];
  for (let index = 0; index < 20; index += 1) {
    const name = `bulk/file-${index}.bin`;
    write(name, crypto.randomBytes(300_000));
    files.push(name);
  }
  const before = openFiles();
  const response = await call("project=p1&path=bulk");
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (before >= 0) assert.ok(openFiles() <= before + 1, `${openFiles() - before} handles left open`);
  const next = await call("project=p1&path=report");
  assert.equal(next.status, 200, "the slot was not released");
  await next.arrayBuffer();
});
await check("one archive is made at a time", async () => {
  const first = await call("project=p1&path=bulk");
  assert.equal(first.status, 200);
  const reader = first.body!.getReader();
  await reader.read();
  const second = await call("project=p1&path=report");
  assert.equal(second.status, 429);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await call("project=p1&path=report")).status, 200);
});
await check("a file that shrinks while it is read leaves a consistent archive", async () => {
  const target = path.join(project, "shrinks.bin");
  fs.writeFileSync(target, crypto.randomBytes(500_000));
  const plan = await planZip(project, ["shrinks.bin"]);
  fs.truncateSync(target, 1000);
  const chunks: Buffer[] = [];
  for await (const chunk of zipStream(plan.files)) chunks.push(chunk as Buffer);
  const buffer = Buffer.concat(chunks);
  const [entry] = listZip(buffer);
  // The directory says what was actually written, and what was written checks.
  assert.equal(entry.size, 1000);
  assert.equal((await readZipEntry(buffer, entry)).length, 1000);
});

fs.rmSync(outside, { recursive: true, force: true });
process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
