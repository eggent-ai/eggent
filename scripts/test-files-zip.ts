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

const { GET, HEAD } = await import("../src/app/api/files/zip/route.ts");
const { listZip, readZipEntry } = await import("../src/lib/skills/zip-reader.ts");
const { planZip, isSecretFileName, ZipLimitError, ZipPathError } = await import("../src/lib/files/zip-walk.ts");
const { zipStream } = await import("../src/lib/files/zip-writer.ts");

const call = (query: string) => GET(new NextRequest(`http://localhost/api/files/zip?${query}`));
async function archive(query: string): Promise<{ buffer: Buffer; headers: Headers }> {
  const response = await call(query);
  assert.equal(response.status, 200, await response.clone().text());
  return { buffer: Buffer.from(await response.arrayBuffer()), headers: response.headers };
}
/** What the archive says when it is unpacked: entries are compressed, so the raw bytes cannot show a leak. */
async function unpacked(buffer: Buffer): Promise<string> {
  const parts: string[] = [];
  for (const entry of listZip(buffer)) parts.push((await readZipEntry(buffer, entry)).toString("utf8"));
  return parts.join("\n");
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
  const after = await call("project=p1&path=report");
  assert.equal(after.status, 200);
  await after.arrayBuffer();
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

console.log("\nWhat holds credentials\n");

await check("the names that hold credentials are all recognised, and ordinary names are not", () => {
  const holds = [
    ".env", ".env.local", "prod.env", ".envrc", ".mcp.json", "auth.json", "token.json", ".npmrc", ".netrc", ".pgpass", ".pypirc", ".htpasswd",
    ".git-credentials", "id_rsa", "id_ed25519.pub", "id_dsa", "server.pem", "cert.p12", "store.jks", "putty.ppk", "AuthKey_ABC.p8", "vault.kdbx",
    "credentials", "credentials.json", "client_secret_123.apps.example.json", "my-service-account.json", "serviceAccount.json",
    "kubeconfig", "secrets.yaml", "secret.json", "terraform.tfstate", "terraform.tfstate.backup", "prod.tfvars", "wp-config.php",
  ];
  for (const name of holds) assert.ok(isSecretFileName(name), `${name} was not recognised`);
  const ordinary = [
    "README.md", "report.docx", "environment.ts", "credentials-policy.md", "secrets-of-success.txt", "keyboard.txt", "tokens.csv",
    "service.json", "client.json", "env.md", "notes.env.md", "key-points.pdf", "monkey.png", "tokens.json", "design-tokens.json",
  ];
  for (const name of ordinary) assert.ok(!isSecretFileName(name), `${name} was taken for a secret`);
});
await check("folders made to hold credentials are left out whole, even when they are named", async () => {
  write("creds/.ssh/id_known", "x");
  write("creds/.ssh/config", "Host x");
  write("creds/.aws/credentials", "[default]");
  write("creds/.git/config", "x");
  write("creds/readme.txt", "hello");
  const info = await (await call("project=p1&path=creds&check=1")).json() as { files: number; skipped: { secrets: number; hidden: number } };
  assert.equal(info.files, 1);
  assert.equal(info.skipped.secrets, 2, "the two folders, counted once each");
  assert.equal(info.skipped.hidden, 1, "git");
  for (const named of ["creds/.ssh", "creds/.aws", "creds/.git"]) {
    const response = await call(`project=p1&path=${named}`);
    assert.equal(response.status, 404, `${named} -> ${response.status}`);
  }
});
await check("a file with another name elsewhere is not packed: it may be a door to a file that is not here", async () => {
  fs.linkSync(path.join(outside, "private.txt"), path.join(project, "creds", "innocent-notes.txt"));
  const info = await (await call("project=p1&path=creds&check=1")).json() as { files: number; skipped: { links: number } };
  assert.equal(info.files, 1);
  assert.equal(info.skipped.links, 1);
  const { buffer } = await archive("project=p1&path=creds");
  assert.ok(!(await unpacked(buffer)).includes("NOT-FOR-THE-ARCHIVE"));
});

console.log("\nNames, and what is not there any more\n");

await check("a backslash in a name does not become a way out of the folder it is unpacked into", async () => {
  write("names/..\\..\\evil.txt", "x");
  write("names/..dotted", "kept");
  const { buffer } = await archive("project=p1&path=names");
  const found = listZip(buffer).map((entry) => entry.path).sort();
  assert.deepEqual(found, ["names/.._.._evil.txt", "names/..dotted"]);
});
await check("a file that is gone by the time it is looked at is counted, not the end of the archive", async () => {
  write("vanish/keep.txt", "kept");
  write("vanish/ghost.txt", "gone soon");
  const realLstat = fs.promises.lstat;
  const patched = async (target: fs.PathLike, ...rest: unknown[]): Promise<fs.Stats> => {
    if (String(target).endsWith("ghost.txt")) throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    return (realLstat as unknown as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest);
  };
  Object.assign(fs.promises, { lstat: patched });
  try {
    const plan = await planZip(project, ["vanish"]);
    assert.deepEqual(plan.files.map((file) => file.name), ["vanish/keep.txt"]);
    assert.equal(plan.skipped.unreadable, 1);
  } finally {
    Object.assign(fs.promises, { lstat: realLstat });
  }
});
await check("a folder that cannot be opened is counted and the rest is packed", async () => {
  if (process.getuid?.() === 0) {
    console.log("        (running as root: permissions do not apply, skipped)");
    return;
  }
  write("locked/inside.txt", "x");
  write("locked/fine.txt", "x");
  const folder = path.join(project, "locked", "sealed");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "secret.txt"), "x");
  fs.chmodSync(folder, 0o000);
  try {
    const plan = await planZip(project, ["locked"]);
    assert.deepEqual(plan.files.map((file) => file.name).sort(), ["locked/fine.txt", "locked/inside.txt"]);
    assert.equal(plan.skipped.unreadable, 1);
  } finally {
    fs.chmodSync(folder, 0o755);
  }
});

console.log("\nA folder that changes while it is sent\n");

const sealed = async (files: Awaited<ReturnType<typeof planZip>>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of zipStream(files.files, { root: files.root })) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

await check("a file replaced by a link to somewhere else after the plan is not followed", async () => {
  write("swap/a.txt", "first");
  write("swap/b.txt", "second");
  const plan = await planZip(project, ["swap"]);
  fs.rmSync(path.join(project, "swap", "b.txt"));
  fs.symlinkSync(path.join(outside, "private.txt"), path.join(project, "swap", "b.txt"));
  const buffer = await sealed(plan);
  assert.deepEqual(listZip(buffer).map((entry) => entry.path), ["swap/a.txt"]);
  assert.ok(!(await unpacked(buffer)).includes("NOT-FOR-THE-ARCHIVE"));
});
await check("a folder replaced by a link to somewhere else after the plan is not entered", async () => {
  write("swapdir/inner/data.txt", "mine");
  const plan = await planZip(project, ["swapdir"]);
  const elsewhere = path.join(outside, "inner");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "data.txt"), "NOT-FOR-THE-ARCHIVE too");
  fs.rmSync(path.join(project, "swapdir", "inner"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(project, "swapdir", "inner"));
  const buffer = await sealed(plan);
  assert.deepEqual(listZip(buffer), []);
  assert.ok(!(await unpacked(buffer)).includes("NOT-FOR-THE-ARCHIVE"));
});
await check("a file given a second name after the plan is not packed", async () => {
  // As long as what it will be swapped for, or the archive could only ever hold part of it.
  write("relink/plain.txt", "p".repeat(64));
  const plan = await planZip(project, ["relink"]);
  fs.linkSync(path.join(outside, "private.txt"), path.join(outside, "twin.txt"));
  fs.rmSync(path.join(project, "relink", "plain.txt"));
  fs.linkSync(path.join(outside, "twin.txt"), path.join(project, "relink", "plain.txt"));
  const buffer = await sealed(plan);
  assert.ok(!(await unpacked(buffer)).includes("NOT-FOR-THE-ARCHIVE"), "the other name's contents were packed");
  assert.deepEqual(listZip(buffer), []);
});
await check("a file that is gone after the plan leaves a good archive of the rest", async () => {
  write("gone/one.txt", "one");
  write("gone/two.txt", "two");
  const plan = await planZip(project, ["gone"]);
  fs.rmSync(path.join(project, "gone", "one.txt"));
  const buffer = await sealed(plan);
  const file = path.join(root, "gone.zip");
  fs.writeFileSync(file, buffer);
  assert.deepEqual(listZip(buffer).map((entry) => entry.path), ["gone/two.txt"]);
  const result = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
  if (!result.error) assert.equal(result.status, 0, result.stdout + result.stderr);
});
await check("the archive says when it moves, so a stalled one can be told from a slow one", async () => {
  const plan = await planZip(project, ["report"]);
  let moves = 0;
  for await (const _chunk of zipStream(plan.files, { root: plan.root, onActivity: () => { moves += 1; } })) void _chunk;
  assert.ok(moves >= plan.files.length, `${moves} signs of life for ${plan.files.length} files`);
});

await check("a file swapped for a pipe after the plan neither hangs the archive nor is waited for", async () => {
  try {
    execFileSync("mkfifo", [path.join(root, ".probe-fifo")]);
    fs.rmSync(path.join(root, ".probe-fifo"));
  } catch {
    console.log("        (no mkfifo on this machine: skipped)");
    return;
  }
  write("pipe/a.txt", "first");
  write("pipe/b.txt", "second");
  const plan = await planZip(project, ["pipe"]);
  fs.rmSync(path.join(project, "pipe", "b.txt"));
  execFileSync("mkfifo", [path.join(project, "pipe", "b.txt")]);
  const buffer = await Promise.race([sealed(plan), new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 4000))]);
  assert.notEqual(buffer, "HUNG", "opening a pipe nobody writes to blocked the archive");
  assert.deepEqual(listZip(buffer as Buffer).map((entry) => entry.path), ["pipe/a.txt"]);
  const { openPlainFile } = await import("../src/lib/files/safe-open.ts");
  const started = Date.now();
  assert.equal(await openPlainFile(path.join(project, "pipe", "b.txt")), null);
  assert.ok(Date.now() - started < 1000, "the open waited");
});
await check("an archive that is dropped while it is held back lets go of every file it had opened", async () => {
  // Read in flowing mode to a threshold and drop the stream while the reader holds it back: the
  // generator then rests at a different yield each time, header, data or trailer. A header is
  // written after the next file is opened, and a handle opened and then not closed is left to the
  // garbage collector - which on newer Node ends the process.
  for (let index = 0; index < 2000; index += 1) write(`tiny/f${String(index).padStart(5, "0")}.txt`, "x".repeat(10 + (index % 7)));
  const plan = await planZip(project, ["tiny"]);
  const before = openFiles();
  for (let round = 0; round < 60; round += 1) {
    const stream = zipStream(plan.files, { root: plan.root });
    const target = 3000 + ((round * 7919) % 40000);
    let got = 0;
    await new Promise<void>((resolve) => {
      stream.on("data", (chunk: Buffer) => {
        got += chunk.length;
        if (got >= target) {
          stream.pause();
          setImmediate(() => stream.destroy());
        }
      });
      stream.on("close", () => resolve());
      stream.on("error", () => undefined);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (before >= 0) assert.ok(openFiles() <= before, `${openFiles() - before} handles left open`);
});
await check("a file named outright inside a folder that holds credentials is not packed either, in any case", async () => {
  write("kept/ok.txt", "fine");
  write("kept/.kube/config", "apiVersion: v1");
  write("kept/.git/config", "[remote] url = https://token@example.test/x.git");
  write("kept/.SSH/known", "host key");
  write("kept/.Aws/credentials", "[default]");
  write("kept/node_modules/dep/index.js", "module.exports = 1;");
  const base = path.join(project, "kept");
  for (const target of [".kube/config", ".git/config", ".SSH/known", ".ssh/known", ".Aws/credentials", ".aws/credentials", "node_modules/dep/index.js"]) {
    const plan = await planZip(base, [target, "ok.txt"]);
    assert.deepEqual(plan.files.map((file) => file.name), ["ok.txt"], `${target} was packed`);
    assert.ok(plan.skipped.secrets + plan.skipped.hidden >= 1, `${target} was not counted`);
  }
  // Walking the folder leaves the same ones out, whatever case their names are in.
  const whole = await planZip(base, [""]);
  assert.deepEqual(whole.files.map((file) => file.name), ["ok.txt"]);
});

console.log("\nThe place, and who may hold it\n");

await check("asking for the headers holds no place and sends no body", async () => {
  const head = await HEAD(new NextRequest("http://localhost/api/files/zip?project=p1&path=bulk", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "application/zip");
  assert.match(head.headers.get("content-disposition") ?? "", /bulk\.zip/);
  assert.equal(head.body, null);
  // Never read, never cancelled - as a client that only wanted the headers leaves it.
  const next = await call("project=p1&path=report");
  assert.equal(next.status, 200, "a header request kept the place");
  await next.arrayBuffer();
  assert.equal((await HEAD(new NextRequest("http://localhost/api/files/zip?project=p1&path=nothing", { method: "HEAD" }))).status, 404);
});
await check("an archive nobody is taking is let go, and the place is free again", async () => {
  process.env.EGGENT_ZIP_IDLE_SECONDS = "1";
  try {
    const stalled = await call("project=p1&path=bulk");
    assert.equal(stalled.status, 200);
    const reader = stalled.body!.getReader();
    await reader.read();
    // The reader now stops: no more reads, no cancel, the connection simply goes quiet.
    assert.equal((await call("project=p1&path=report")).status, 429, "the place was not held while the archive was moving");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const after = await call("project=p1&path=report");
    assert.equal(after.status, 200, "a stalled archive kept the place");
    await after.arrayBuffer();
    await reader.cancel().catch(() => undefined);
  } finally {
    delete process.env.EGGENT_ZIP_IDLE_SECONDS;
  }
});
await check("a project id that is not a name is refused, and so is a project whose folder is a link", async () => {
  assert.equal((await call("project=..%2F..%2Fetc&path=")).status, 403);
  assert.equal((await call("project=..&path=")).status, 403);
  fs.symlinkSync(path.join(root, "data"), path.join(root, "data", "projects", "linked"));
  const linked = await call("project=linked");
  assert.equal(linked.status, 403, "a folder that is a link to the data directory was packed");
  assert.equal((await HEAD(new NextRequest("http://localhost/api/files/zip?project=linked", { method: "HEAD" }))).status, 403);
  fs.rmSync(path.join(root, "data", "projects", "linked"));
});

fs.rmSync(outside, { recursive: true, force: true });
process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
