/**
 * File history: what is kept, when, by whom, and how it is shown and restored.
 *
 * In four parts. The rules that need nothing on disk - which files get a
 * history, how two texts are compared, which versions are let go of. Then the
 * store and the capture on a real folder: before and after a write, a change
 * made elsewhere, a deletion, links, credentials, the daily sweep. Then the
 * routes, behind their guard, and the editor's own save. Last, the real runner
 * against a stub model that writes, edits and runs commands, with the file the
 * person has open told to it; and `eggent-history`, the agent's own command,
 * reading the same store.
 *
 * No network. Run with Node 22:
 *   npm run test:file-versions
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// A stub model: the test's messages say what it should do.
// ---------------------------------------------------------------------------

const PROVIDER = "stub";
const MODEL = "stub-model";
const requests: Array<{ lastUser: string }> = [];

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
  return "";
}

const provider = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  let body = "";
  req.on("data", (part) => (body += String(part)));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }> };
    const messages = payload.messages ?? [];
    const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
    const lastUser = textOf(messages[lastUserIndex]?.content);
    // Tool results since the person's message: which step of a scripted turn this is.
    const step = messages.slice(lastUserIndex + 1).filter((message) => message.role === "tool").length;
    requests.push({ lastUser });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const reply = (text: string) => {
      res.write(chunk({ role: "assistant" }));
      res.write(chunk({ content: text }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    };
    const call = (name: string, args: Record<string, unknown>) => {
      res.write(chunk({ role: "assistant" }));
      res.write(chunk({ tool_calls: [{ index: 0, id: `c-${name}-${messages.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
      res.write(chunk({}, "tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
    };
    // A helper started with the Agent tool: its own first message carries the mark.
    const firstUser = textOf(messages.find((message) => message.role === "user")?.content);
    if (firstUser.includes("HELPER-TASK")) {
      return step === 0 ? call("write", { path: "helper-notes.md", content: "from the helper\n" }) : reply("written");
    }
    const script: Array<[string, Record<string, unknown>]> | null =
      lastUser.includes("HELPER-WRITE") ? [
        ["Agent", { description: "Write the notes", subagent_type: "general-purpose", run_in_background: false, prompt: "HELPER-TASK write helper-notes.md" }],
      ]
      : lastUser.includes("WRITE-THEN-EDIT") ? [
        ["write", { path: "notes.md", content: "First line\nSecond line\n" }],
        ["edit", { path: "notes.md", edits: [{ oldText: "Second line", newText: "Second line, edited" }] }],
      ]
      : lastUser.includes("EDIT-CONTRACT") ? [
        ["edit", { path: "contract.md", edits: [{ oldText: "term 100", newText: "term 120" }] }],
      ]
      : lastUser.includes("BASH-DOC") ? [
        ["bash", { command: "printf 'Report v1\\n' > report.md && printf '{\"a\":1}' > data.json" }],
      ]
      : lastUser.includes("BASH-SED") ? [
        ["bash", { command: "sed -i.bak 's/alpha/beta/' plain.txt && rm -f plain.txt.bak" }],
      ]
      : lastUser.includes("WRITE-NEW") ? [
        ["write", { path: "brand-new.md", content: "made from nothing\n" }],
      ]
      : lastUser.includes("BASH-READ") ? [
        ["bash", { command: "cat read-only-notes.md && head -n 1 read-only-notes.md" }],
      ]
      : lastUser.includes("WRITE-SYNC-WRITE") ? [
        ["write", { path: "shared-draft.md", content: "first\n" }],
        ["write", { path: "shared-draft.md", content: "second\n" }],
      ]
      : lastUser.includes("BASH-JSON") ? [
        ["bash", { command: "printf '{\"a\":2}' > data.json" }],
      ]
      : null;
    // Between the two writes, the sync brings the file as it was edited on a laptop.
    if (lastUser.includes("WRITE-SYNC-WRITE") && step === 1) fs.writeFileSync(path.join(shopDir, "shared-draft.md"), "from the laptop\n");
    if (script && step < script.length) return call(script[step][0], script[step][1]);
    return reply("done");
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-versions-"));
const root_ = root;
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: { [PROVIDER]: { name: "Stub", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, api: "openai-completions", models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 16384, maxTokens: 2048 }] } },
}));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
// pi-subagents, when there is a copy to load, for the helper's writes (EGGENT_SUBAGENTS_EXTENSIONS).
const subagentsExtension = [
  ...(process.env.EGGENT_SUBAGENTS_EXTENSIONS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
  "/opt/eggent-pi-seed/npm/node_modules/@tintinweb/pi-subagents",
].find((candidate) => fs.existsSync(path.join(candidate, "package.json"))) ?? null;
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
  defaultProvider: PROVIDER,
  defaultModel: MODEL,
  ...(subagentsExtension ? { packages: [subagentsExtension] } : {}),
}));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";
// Where `eggent-history` is found, as the image's working directory would say.
process.env.EGGENT_APP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
process.env.EGGENT_TURN_WATCHDOG = "off";

const rules = await import("../src/lib/files/versions/rules.ts");
const diffModel = await import("../src/lib/files/versions/diff-model.ts");
const storeModule = await import("../src/lib/files/versions/store.ts");
const capture = await import("../src/lib/files/versions/capture.ts");
const textModule = await import("../src/lib/files/versions/text.ts");
const service = await import("../src/lib/files/versions/service.ts");
const projectStore = await import("../src/lib/storage/project-store.ts");
const { crc32 } = await import("../src/lib/skills/zip-reader.ts");
const { createSessionToken } = await import("../src/lib/auth/session.ts");
const { saveSettings } = await import("../src/lib/storage/settings-store.ts");
const { forgetVersionsSwitch } = await import("../src/lib/files/versions/config.ts");
const { settleFileVersionCaptures } = await import("../src/lib/files/versions/agent-hooks.ts");

const store = storeModule.getVersionStore();
const projectsDir = path.join(root, "data", "projects");
fs.mkdirSync(path.join(projectsDir, "skills"), { recursive: true });
await projectStore.createProject({ id: "shop", name: "Shop", description: "", instructions: "Shop rules.", memoryMode: "isolated" } as never);
const shopDir = path.join(projectsDir, "shop");
const put = (relative: string, content: string | Buffer, ageMs = 0) => {
  const full = path.join(shopDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(full, when, when);
  }
  return full;
};
const journalOf = (relative: string) => store.journal(`shop/${relative}`);
const kinds = async (relative: string) => (await journalOf(relative))?.versions.map((entry) => entry.by.kind) ?? [];

/** A zip of uncompressed entries: enough for a document's parts. */
function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const docx = (paragraphs: string[], table?: string[][]) =>
  makeZip({
    "word/document.xml": `<?xml version="1.0"?><w:document><w:body>${paragraphs
      .map((text) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`)
      .join("")}${table ? `<w:tbl>${table.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>` : ""}<w:p><w:del w:id="1" w:author="x"><w:r><w:t>gone</w:t></w:r><w:r><w:delText>gone too</w:delText></w:r></w:del></w:p></w:body></w:document>`,
  });

console.log("Which files get a history\n");

await check("documents and text do; pictures, archives, PDFs and lock files do not", () => {
  assert.equal(rules.versionedKindOf("contract.docx"), "document");
  assert.equal(rules.versionedKindOf("notes.md"), "text");
  assert.equal(rules.versionedKindOf("README"), "sniff");
  for (const name of ["photo.png", "a.zip", "report.pdf", "~$contract.docx", "package-lock.json", "app.min.js", "build.log", "x.tmp"]) {
    assert.equal(rules.versionedKindOf(name), null, name);
  }
});
await check("the history key is the path under the projects folder, whichever scope names the file", () => {
  assert.equal(rules.historyKeyOf("shop", "a/b.md"), "shop/a/b.md");
  assert.equal(rules.historyKeyOf("none", "shop/a/b.md"), "shop/a/b.md");
  assert.equal(rules.historyKeyOf("none", "notes.md"), "notes.md");
});
await check("the agent's bookkeeping, credentials and dependency folders have no history", () => {
  for (const key of ["memory.md", "shop/memory.md", "shop/skills/x/SKILL.md", "shop/.mcp.json", "shop/.env", "shop/node_modules/x/readme.md", "shop/.git/config", "shop/.ssh/notes.md", "shop/project.json", "shop/a/../b.md"]) {
    assert.equal(capture.isVersionablePath(key), false, key);
  }
  for (const key of ["shop/contract.md", "shop/context.md", "notes.md", "shop/Αλληλογραφία/Πέτρος/επιστολή.docx"]) {
    assert.equal(capture.isVersionablePath(key), true, key);
  }
});

console.log("\nComparing two versions\n");

// Greek rather than Russian here, which this repository keeps on its own branch: any script the
// diff library does not count as letters shows the fault the same way.
await check("a changed word in a non-Latin sentence is marked as a word, not as scattered letters", () => {
  const segments = diffModel.wordSegments("Η τιμή είναι εκατό ευρώ.", "Η τιμή είναι εκατό πενήντα ευρώ.");
  assert.deepEqual(segments?.filter((segment) => segment.kind !== "same").map((segment) => [segment.kind, segment.text]), [["add", "πενήντα "]]);
  const replaced = diffModel.wordSegments("Παράδοση σε πέντε ημέρες.", "Παράδοση σε δέκα ημέρες.");
  assert.deepEqual(replaced?.filter((segment) => segment.kind !== "same").map((segment) => [segment.kind, segment.text]), [["del", "πέντε"], ["add", "δέκα"]]);
});
await check("a change keeps a few lines around it and folds the rest away", () => {
  const older = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
  const newer = older.replace("line 20", "line twenty");
  const model = diffModel.buildDiff(older, newer);
  assert.equal(model.changes, 1);
  assert.equal(model.added, 1);
  assert.equal(model.removed, 1);
  const folded = model.blocks.filter((block) => block.type === "same" && block.collapsed);
  assert.equal(folded.length, 2);
  const change = model.blocks.find((block) => block.type === "change");
  assert.ok(change && change.type === "change");
  assert.equal(change.removed[0].oldNo, 20);
  assert.equal(change.added[0].newNo, 20);
  assert.deepEqual(change.added[0].segments?.filter((segment) => segment.kind === "add").map((segment) => segment.text), ["twenty"]);
});
await check("identical texts have no changes; line endings do not count as one", () => {
  assert.equal(diffModel.buildDiff("a\nb\n", "a\r\nb\r\n").changes, 0);
  assert.deepEqual(diffModel.lineStats("a\nb\n", "a\nc\nd\n"), { added: 2, removed: 1 });
});
await check("separate edits are separate changes, in order, for the arrows to walk through", () => {
  const older = Array.from({ length: 30 }, (_, index) => `p${index}`).join("\n");
  const newer = older.replace("p3", "P3").replace("p25", "P25");
  const model = diffModel.buildDiff(older, newer);
  assert.equal(model.changes, 2);
  const indexes = model.blocks.filter((block) => block.type === "change").map((block) => (block as { index: number }).index);
  assert.deepEqual(indexes, [0, 1]);
});

console.log("\nWhich versions are kept\n");

const DAY = 24 * 60 * 60 * 1000;
const retention = { keepDays: 30, dailyDays: 90, maxPerFile: 200 };
const entry = (n: number, daysAgo: number, extra: Record<string, unknown> = {}) =>
  ({ n, at: new Date(Date.now() - daysAgo * DAY).toISOString(), size: 1, sha: "a".repeat(64), by: { kind: "person" }, ...extra }) as never;

await check("a version replaced within 30 days stays; the newest always stays", () => {
  const kept = storeModule.pruneVersions([entry(1, 400), entry(2, 20), entry(3, 10)], Date.now(), retention);
  // v1 was replaced 20 days ago: it is younger than 30 days in the way that counts.
  assert.deepEqual(kept.map((item: { n: number }) => item.n), [1, 2, 3]);
});
await check("between 30 and 90 days one version a day is kept, older ones go", () => {
  const now = Date.now();
  const at = (days: number, hours = 0) => new Date(now - days * DAY - hours * 3600_000).toISOString();
  const entries = [
    { n: 1, at: at(200), size: 1, sha: "a".repeat(64), by: { kind: "person" } },
    { n: 2, at: at(50, 5), size: 1, sha: "a".repeat(64), by: { kind: "person" } },
    { n: 3, at: at(50, 3), size: 1, sha: "a".repeat(64), by: { kind: "person" } },
    { n: 4, at: at(50, 1), size: 1, sha: "a".repeat(64), by: { kind: "person" } },
    { n: 5, at: at(1), size: 1, sha: "a".repeat(64), by: { kind: "person" } },
  ] as never[];
  // v1 replaced 50 days ago, v2 and v3 the same day, v4 replaced a day ago.
  const kept = storeModule.pruneVersions(entries, now, retention).map((item: { n: number }) => item.n);
  assert.deepEqual(kept, [3, 4, 5]);
});
await check("a file deleted long ago leaves nothing behind; no file keeps more than the cap", () => {
  assert.deepEqual(storeModule.pruneVersions([entry(1, 200), entry(2, 100, { deleted: true, sha: null })], Date.now(), retention), []);
  const many = Array.from({ length: 10 }, (_, index) => entry(index + 1, 1));
  assert.deepEqual(storeModule.pruneVersions(many, Date.now(), { ...retention, maxPerFile: 4 }).map((item: { n: number }) => item.n), [7, 8, 9, 10]);
});

console.log("\nKeeping versions on disk\n");

await check("before a write the file's state is kept; after it the new one; the same bytes twice make one version", async () => {
  const file = put("contract.md", "term 100\n", 3 * DAY);
  await capture.captureBefore(file);
  fs.writeFileSync(file, "term 110\n");
  await capture.captureAfter(file, { kind: "person" });
  await capture.captureAfter(file, { kind: "person" });
  assert.deepEqual(await kinds("contract.md"), ["earlier", "person"]);
  const journal = await journalOf("contract.md");
  assert.equal(journal?.versions[1].added, 1);
  assert.equal(journal?.versions[1].removed, 1);
  // The state found before the first change is dated when it was seen; the file's own date is kept beside it.
  assert.ok(Date.parse(journal!.versions[0].at) > Date.now() - 60_000);
  assert.ok(Date.parse(journal!.versions[0].fileTime ?? "") < Date.now() - 2 * DAY);
  assert.equal((await store.content("shop/contract.md", 1))?.toString(), "term 100\n");
});
await check("a change nobody here made is noticed before the next write, as made outside", async () => {
  const file = path.join(shopDir, "contract.md");
  fs.writeFileSync(file, "term 115\n");
  await capture.captureBefore(file);
  fs.writeFileSync(file, "term 100\n");
  await capture.captureAfter(file, { kind: "person" });
  assert.deepEqual(await kinds("contract.md"), ["earlier", "person", "outside", "person"]);
});
await check("several writes of one turn make one version: what the turn left", async () => {
  const file = put("draft.md", "a\n");
  await capture.captureBefore(file);
  for (const text of ["b\n", "c\n", "d\n"]) {
    fs.writeFileSync(file, text);
    await capture.captureAfter(file, { kind: "agent", chat: "chat-1", run: "run-1" });
  }
  fs.writeFileSync(file, "e\n");
  await capture.captureAfter(file, { kind: "agent", chat: "chat-1", run: "run-2" });
  const journal = await journalOf("draft.md");
  assert.deepEqual(journal?.versions.map((item) => [item.by.kind, item.by.run ?? null]), [["earlier", null], ["agent", "run-1"], ["agent", "run-2"]]);
  assert.equal((await store.content("shop/draft.md", journal!.versions[1].n))?.toString(), "d\n");
});
await check("a deleted file is recorded as deleted, and its history stays for the agent to bring it back", async () => {
  const file = path.join(shopDir, "draft.md");
  fs.rmSync(file);
  assert.equal(await capture.checkTracked("shop/draft.md"), "deleted");
  const journal = await journalOf("draft.md");
  assert.equal(journal?.versions.at(-1)?.deleted, true);
  fs.writeFileSync(file, "back\n");
  assert.equal(await capture.checkTracked("shop/draft.md"), "changed");
  assert.equal((await journalOf("draft.md"))?.versions.at(-1)?.by.kind, "outside");
});
await check("the pass over tracked files reads only the files whose size or time moved", async () => {
  const before = (await journalOf("contract.md"))?.versions.length;
  const quiet = await service.checkTrackedFiles();
  assert.equal(quiet.changed, 0);
  assert.equal((await journalOf("contract.md"))?.versions.length, before);
  fs.writeFileSync(path.join(shopDir, "contract.md"), "term 130 - from the laptop\n");
  const moved = await service.checkTrackedFiles();
  assert.equal(moved.changed, 1);
  assert.equal((await journalOf("contract.md"))?.versions.at(-1)?.by.kind, "outside");
});
await check("a link is never read, nor a file with a second name, nor a credential, nor a file over the size cap", async () => {
  const outside = path.join(root, "outside-secret.md");
  fs.writeFileSync(outside, "NOT YOURS");
  fs.symlinkSync(outside, path.join(shopDir, "linked.md"));
  await capture.captureAfter(path.join(shopDir, "linked.md"), { kind: "person" });
  assert.equal(await journalOf("linked.md"), null);
  fs.linkSync(outside, path.join(shopDir, "twin.md"));
  await capture.captureAfter(path.join(shopDir, "twin.md"), { kind: "person" });
  assert.equal(await journalOf("twin.md"), null);
  put(".env", "KEY=sk-abcdefghijklmnopqrstuvwxyz");
  await capture.captureAfter(path.join(shopDir, ".env"), { kind: "person" });
  assert.equal(await journalOf(".env"), null);
  process.env.EGGENT_VERSIONS_MAX_FILE_MB = "0.001";
  put("big.md", "x".repeat(4000));
  await capture.captureAfter(path.join(shopDir, "big.md"), { kind: "person" });
  delete process.env.EGGENT_VERSIONS_MAX_FILE_MB;
  assert.equal(await journalOf("big.md"), null);
  put("README", "plain text\n");
  put("BINARY", Buffer.from([1, 0, 2, 0]));
  await capture.captureAfter(path.join(shopDir, "README"), { kind: "person" });
  await capture.captureAfter(path.join(shopDir, "BINARY"), { kind: "person" });
  assert.ok(await journalOf("README"));
  assert.equal(await journalOf("BINARY"), null);
});
await check("a write into the folder never goes through a link, nor makes folders where a link points", async () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-versions-out-"));
  fs.symlinkSync(outsideDir, path.join(shopDir, "door"));
  await assert.rejects(capture.writeFileInside(path.join(shopDir, "door", "new", "x.md"), "x", shopDir));
  assert.deepEqual(fs.readdirSync(outsideDir), []);
  await assert.rejects(capture.writeFileInside(path.join(shopDir, "linked.md"), "overwritten", shopDir));
  assert.equal(fs.readFileSync(path.join(root, "outside-secret.md"), "utf8"), "NOT YOURS");
  await capture.writeFileInside(path.join(shopDir, "fresh", "made.md"), "made", shopDir);
  assert.equal(fs.readFileSync(path.join(shopDir, "fresh", "made.md"), "utf8"), "made");
});
await check("a turn's commands: files with a history get a version; files only created get none", async () => {
  const since = Date.now() - 1000;
  put("out/summary.md", "summary\n");
  put("out/data.csv", "a,b\n");
  put("contract.md", "term 140\n");
  await capture.captureRunChanges({ cwd: shopDir, since, by: { kind: "agent", chat: "chat-2", run: "run-x" } });
  assert.equal(await journalOf("out/summary.md"), null);
  assert.equal(await journalOf("out/data.csv"), null);
  assert.equal((await journalOf("contract.md"))?.versions.at(-1)?.by.chat, "chat-2");
});
await check("a command that set a file's date back is still seen: by its status time", async () => {
  const file = path.join(shopDir, "contract.md");
  const since = Date.now() - 1000;
  fs.writeFileSync(file, "term 145 - copied with its old date\n");
  const old = new Date(Date.now() - 300 * DAY);
  fs.utimesSync(file, old, old);
  await capture.captureRunChanges({ cwd: shopDir, since, by: { kind: "agent", chat: "chat-2", run: "run-y" } });
  const journal = await journalOf("contract.md");
  assert.equal((await store.content("shop/contract.md", journal!.versions.at(-1)!.n))?.toString(), "term 145 - copied with its old date\n");
  // Dated when seen: the version it replaced is young, not 300 days old, and is kept.
  assert.ok(journal!.versions.some((item) => item.by.run === "run-x"));
});
await check("in the orchestrator's folder only the files lying in it are looked at", async () => {
  const top = path.join(projectsDir, "top-note.md");
  fs.writeFileSync(top, "top\n");
  const inProject = put("synced-from-laptop.md", "arrived\n");
  for (const file of [top, inProject]) {
    await capture.captureBefore(file);
    fs.appendFileSync(file, "more\n");
    await capture.captureAfter(file, { kind: "person" });
  }
  const before = (await journalOf("synced-from-laptop.md"))!.versions.length;
  const since = Date.now() - 1000;
  fs.appendFileSync(top, "from a command\n");
  fs.appendFileSync(inProject, "from the laptop\n");
  await capture.captureRunChanges({ cwd: projectsDir, since, by: { kind: "agent", run: "run-o" } });
  assert.equal((await store.journal("top-note.md"))!.versions.at(-1)!.by.kind, "agent");
  assert.equal((await journalOf("synced-from-laptop.md"))!.versions.length, before);
});
await check("a company's shared folders get no history here, at the top or in a project", () => {
  assert.equal(capture.isVersionablePath(".shared/finance/q3.docx"), false);
  assert.equal(capture.isVersionablePath("shop/shared/finance/q3.docx"), false);
  assert.equal(capture.isVersionablePath("shop/shared/notes.md"), true);
});
await check("files a command line names are found, so they can be kept before it runs", () => {
  const found = capture.pathsInCommand(`sed -i 's/a/b/' notes.md && python3 - <<'EOF'\nfrom docx import Document\nd = Document("contract.docx")\nEOF`, shopDir);
  assert.deepEqual(found, [path.join(shopDir, "notes.md"), path.join(shopDir, "contract.docx")]);
  assert.deepEqual(capture.pathsInCommand("curl https://example.test/a.md -o b.txt", shopDir), [path.join(shopDir, "b.txt")]);
});
await check("forgetting a folder forgets every file in it, and frees what only they held at once", async () => {
  for (const name of ["out/summary.md", "out/data.csv"]) {
    const file = path.join(shopDir, name);
    await capture.captureBefore(file);
    fs.appendFileSync(file, `${name} changed\n`);
    await capture.captureAfter(file, { kind: "person" });
  }
  // Older than the moment a deletion lets go of things.
  await new Promise((resolve) => setTimeout(resolve, 5200));
  const shas = [...((await journalOf("out/summary.md"))?.versions ?? []), ...((await journalOf("out/data.csv"))?.versions ?? [])].map((item) => item.sha);
  assert.equal(shas.length, 4);
  const objectFile = (sha: string | null) => path.join(root_, "data", "versions", "objects", String(sha).slice(0, 2), `${sha}.gz`);
  assert.ok(shas.every((sha) => fs.existsSync(objectFile(sha))));
  await capture.forgetHistory("shop", "out", { folder: true });
  assert.equal(await journalOf("out/summary.md"), null);
  assert.equal(await journalOf("out/data.csv"), null);
  assert.deepEqual(shas.filter((sha) => fs.existsSync(objectFile(sha))), [], "what only these versions held is still on the disk");
  const tracked = await store.tracked();
  assert.ok(tracked.has("shop/contract.md"));
  assert.equal(tracked.has("shop/out/summary.md"), false);
});
await check("the sweep drops the history of a project that is gone and the objects nothing names", async () => {
  await projectStore.createProject({ id: "gone", name: "Gone", description: "", instructions: "x", memoryMode: "isolated" } as never);
  const file = path.join(projectsDir, "gone", "doc.md");
  fs.writeFileSync(file, "only here\n");
  await capture.captureAfter(file, { kind: "person" });
  assert.ok(await store.journal("gone/doc.md"));
  fs.rmSync(path.join(projectsDir, "gone"), { recursive: true });
  const objectsBefore = fs.readdirSync(path.join(root, "data", "versions", "objects")).length;
  const result = await store.sweep({ keepKey: async (key) => !key.startsWith("gone/"), graceMs: 0 });
  assert.equal(await store.journal("gone/doc.md"), null);
  assert.ok(result.objects >= 1, JSON.stringify(result));
  assert.ok(fs.readdirSync(path.join(root, "data", "versions", "objects")).length <= objectsBefore);
  // Everything still named is still there.
  for (const key of (await store.tracked()).keys()) {
    const journal = await store.journal(key);
    for (const item of journal?.versions ?? []) if (!item.deleted) assert.ok(await store.content(key, item.n), `${key} v${item.n}`);
  }
});
await check("clearing what is older than a few days keeps every file's newest version", async () => {
  const file = put("old-history.md", "one\n");
  await capture.captureAfter(file, { kind: "person" });
  fs.writeFileSync(file, "two\n");
  await capture.captureAfter(file, { kind: "person" });
  // Make the first version look replaced a long time ago.
  const journalFile = path.join(root, "data", "versions", "files");
  for (const shard of fs.readdirSync(journalFile)) {
    for (const name of fs.readdirSync(path.join(journalFile, shard))) {
      const full = path.join(journalFile, shard, name);
      const journal = JSON.parse(fs.readFileSync(full, "utf8"));
      if (journal.key !== "shop/old-history.md") continue;
      journal.versions[0].at = new Date(Date.now() - 20 * DAY).toISOString();
      journal.versions[1].at = new Date(Date.now() - 10 * DAY).toISOString();
      fs.writeFileSync(full, JSON.stringify(journal));
    }
  }
  await store.clear({ olderThanDays: 7 });
  assert.deepEqual((await journalOf("old-history.md"))?.versions.map((item) => item.n), [2]);
});
await check("a journal that cannot be read for a moment is not taken for a broken one", async () => {
  const file = put("permissions.md", "one\n");
  await capture.captureBefore(file);
  fs.writeFileSync(file, "two\n");
  await capture.captureAfter(file, { kind: "person" });
  const journals = path.join(root_, "data", "versions", "files");
  let target = "";
  for (const shard of fs.readdirSync(journals)) {
    for (const name of fs.readdirSync(path.join(journals, shard))) {
      const full = path.join(journals, shard, name);
      if (JSON.parse(fs.readFileSync(full, "utf8")).key === "shop/permissions.md") target = full;
    }
  }
  // Old enough that only its being unreadable, not its age, could keep it.
  const old = new Date(Date.now() - 3 * 3600_000);
  fs.utimesSync(target, old, old);
  fs.chmodSync(target, 0o000);
  try {
    await store.sweep({ graceMs: 0 });
  } finally {
    fs.chmodSync(target, 0o644);
  }
  assert.ok(fs.existsSync(target), "the sweep deleted a journal it could not read");
  assert.equal((await journalOf("permissions.md"))?.versions.length, 2);
});
await check("a folder on the way that has become a link is not followed into another file's history", async () => {
  fs.mkdirSync(path.join(shopDir, "deals"), { recursive: true });
  const file = put("deals/terms.md", "terms one\n");
  await capture.captureBefore(file);
  fs.writeFileSync(file, "terms two\n");
  await capture.captureAfter(file, { kind: "person" });
  const count = (await journalOf("deals/terms.md"))!.versions.length;
  fs.mkdirSync(path.join(shopDir, "elsewhere"), { recursive: true });
  fs.writeFileSync(path.join(shopDir, "elsewhere", "terms.md"), "a different file\n");
  fs.renameSync(path.join(shopDir, "deals"), path.join(shopDir, "deals-old"));
  fs.symlinkSync(path.join(shopDir, "elsewhere"), path.join(shopDir, "deals"));
  assert.equal(await capture.checkTracked("shop/deals/terms.md"), "gone");
  assert.equal((await journalOf("deals/terms.md"))!.versions.length, count);
});
await check("turned off in Settings, nothing is kept", async () => {
  await saveSettings({ fileHistory: { enabled: false } } as never);
  forgetVersionsSwitch();
  const file = put("while-off.md", "x\n");
  await capture.captureAfter(file, { kind: "person" });
  assert.equal(await journalOf("while-off.md"), null);
  await saveSettings({ fileHistory: { enabled: true } } as never);
  forgetVersionsSwitch();
});

console.log("\nThe text of a document\n");

await check("a Word document is read as paragraphs and table rows; deleted tracked text is not read", async () => {
  const extracted = await textModule.extractVersionText("contract.docx", docx(["Σύμβαση αρ. 5", "Τιμή: 100 & ΦΠΑ"], [["Είδος", "Τιμή"], ["Αλεύρι", "100"]]));
  assert.equal(extracted.kind, "extracted");
  assert.equal(extracted.text, "Σύμβαση αρ. 5\nΤιμή: 100 & ΦΠΑ\nΕίδος | Τιμή\nΑλεύρι | 100\n");
});
await check("a spreadsheet is read sheet by sheet, row by row, shared strings and formulas included", async () => {
  const workbook = makeZip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="Τιμές" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Αλεύρι</t></si><si><r><t>Ζάχα</t></r><r><t>ρη</t></r></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>100</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>B1*2</f><v>200</v></c></row></sheetData></worksheet>`,
  });
  const extracted = await textModule.extractVersionText("stock.xlsx", workbook);
  assert.equal(extracted.text, "## Τιμές\n1. A: Αλεύρι | B: 100\n2. A: Ζάχαρη | B: 200 (=B1*2)");
});
await check("a presentation is read slide by slide", async () => {
  const deck = makeZip({
    "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>`,
    "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>Point</a:t></a:r></a:p></p:sld>`,
  });
  const extracted = await textModule.extractVersionText("deck.pptx", deck, { slide: "Page" });
  assert.equal(extracted.text, "## Page 1\nTitle\nPoint\n\n## Page 2\nSecond");
});
await check("a document with thousands of tags that never close is read in a moment, not in minutes", async () => {
  const hostile = [
    makeZip({ "word/document.xml": `<w:document><w:body>${"<w:p><w:r><w:t>x".repeat(60_000)}</w:body></w:document>` }),
    makeZip({ "word/document.xml": `<w:document><w:body>${"<w:tbl><w:tr><w:tc>".repeat(60_000)}</w:body></w:document>` }),
    makeZip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${"<row r=\"1\"><c r=\"A1\"><v>1".repeat(60_000)}</sheetData></worksheet>`,
    }),
  ];
  for (const [index, data] of hostile.entries()) {
    const started = Date.now();
    await textModule.extractVersionText(index === 2 ? "sheet.xlsx" : "doc.docx", data);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `case ${index}: ${elapsed} ms`);
  }
});
await check("a damaged document is not compared, and nothing breaks", async () => {
  assert.deepEqual(await textModule.extractVersionText("broken.docx", Buffer.from("not a zip")), { kind: "none", text: "" });
});

console.log("\nThe routes\n");

process.env.EGGENT_AUTH_SECRET = process.env.EGGENT_AUTH_SECRET || "test-secret";
const token = await createSessionToken("tester", false);
const historyRoute = await import("../src/app/api/files/versions/route.ts");
const contentRoute = await import("../src/app/api/files/versions/content/route.ts");
const downloadRoute = await import("../src/app/api/files/versions/download/route.ts");
const restoreRoute = await import("../src/app/api/files/versions/restore/route.ts");
const usageRoute = await import("../src/app/api/files/versions/usage/route.ts");
const fileContentRoute = await import("../src/app/api/files/content/route.ts");
const filesRoute = await import("../src/app/api/files/route.ts");
const request = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; cookie?: boolean } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: { ...(init.cookie === false ? {} : { cookie: `eggent_auth=${token}` }), ...(init.headers ?? {}) },
    ...(init.body ? { body: init.body } : {}),
  });

await check("no session, another site, or a body that is not JSON: refused", async () => {
  assert.equal((await historyRoute.GET(request("/api/files/versions?project=shop&path=contract.md", { cookie: false }))).status, 401);
  assert.equal((await historyRoute.GET(request("/api/files/versions?project=shop&path=contract.md", { headers: { "sec-fetch-site": "same-site" } }))).status, 403);
  assert.equal((await restoreRoute.POST(request("/api/files/versions/restore", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ project: "shop", path: "contract.md", n: 1 }) }))).status, 415);
  assert.equal((await downloadRoute.GET(request("/api/files/versions/download?project=shop&path=contract.md&n=1", { cookie: false }))).status, 401);
});
await check("the history lists versions newest first, with who made them", async () => {
  const response = await historyRoute.GET(request("/api/files/versions?project=shop&path=contract.md"));
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.versioned, true);
  assert.equal(view.comparison, "text");
  assert.ok(view.versions.length >= 4);
  assert.ok(view.versions[0].n > view.versions[1].n);
  assert.equal(view.versions.at(-1).by.kind, "earlier");
  assert.ok(view.bytes > 0);
  assert.equal(view.versions[0].sha, undefined, "the object name is not the client's business");
});
await check("the same file named from the orchestrator has the same history", async () => {
  const fromProject = await (await historyRoute.GET(request("/api/files/versions?project=shop&path=contract.md"))).json();
  const fromOrchestrator = await (await historyRoute.GET(request("/api/files/versions?project=none&path=shop/contract.md"))).json();
  assert.deepEqual(fromOrchestrator.versions.map((item: { n: number }) => item.n), fromProject.versions.map((item: { n: number }) => item.n));
});
await check("a version's text, and the version as a file named after it", async () => {
  const text = await (await contentRoute.GET(request("/api/files/versions/content?project=shop&path=contract.md&n=1"))).json();
  assert.equal(text.text, "term 100\n");
  const download = await downloadRoute.GET(request("/api/files/versions/download?project=shop&path=contract.md&n=1"));
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition") || "", /contract \(v1\)\.md/);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.equal(Buffer.from(await download.arrayBuffer()).toString(), "term 100\n");
  assert.equal((await contentRoute.GET(request("/api/files/versions/content?project=shop&path=contract.md&n=999"))).status, 404);
  assert.equal((await contentRoute.GET(request("/api/files/versions/content?project=shop&path=../../etc/passwd&n=1"))).status, 403);
});
await check("restoring brings the text back as a new version, and what it replaced stays", async () => {
  const before = fs.readFileSync(path.join(shopDir, "contract.md"), "utf8");
  // A change made elsewhere a moment ago, not seen yet: it must not be lost by the restore.
  fs.writeFileSync(path.join(shopDir, "contract.md"), "term 999 - typed on the laptop\n");
  const response = await restoreRoute.POST(request("/api/files/versions/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "shop", path: "contract.md", n: 1 }) }));
  assert.equal(response.status, 200);
  const { version, lost } = await response.json();
  assert.equal(version.by.kind, "restore");
  assert.equal(version.by.restoredFrom, 1);
  assert.equal(lost, undefined, "a restore that kept what it replaced must not say it was lost");
  assert.equal(fs.readFileSync(path.join(shopDir, "contract.md"), "utf8"), "term 100\n");
  const texts: string[] = [];
  for (const item of (await journalOf("contract.md"))!.versions) texts.push((await store.content("shop/contract.md", item.n))?.toString() ?? "");
  assert.ok(texts.includes("term 999 - typed on the laptop\n"), "the change made elsewhere was lost");
  assert.ok(texts.includes(before));
});
await check("the editor's save keeps what was there and what was saved; a link at the name is refused", async () => {
  put("letter.md", "Dear Pyotr,\n", 2 * DAY);
  const save = (file: string, content: string) =>
    fileContentRoute.PUT(request(`/api/files/content?project=shop&path=${encodeURIComponent(file)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) }));
  assert.equal((await save("letter.md", "Dear Pyotr,\nThe meeting moved.\n")).status, 200);
  assert.deepEqual(await kinds("letter.md"), ["earlier", "person"]);
  assert.equal((await save("linked.md", "through the link")).status, 403);
  assert.equal(fs.readFileSync(path.join(root, "outside-secret.md"), "utf8"), "NOT YOURS");
});
await check("a restore that cannot keep what the file holds now asks first, and goes ahead only when told", async () => {
  const file = put("grown.md", "small\n", DAY);
  await capture.captureBefore(file);
  fs.writeFileSync(file, "small, edited\n");
  await capture.captureAfter(file, { kind: "person" });
  // The file grew past what a history keeps.
  fs.writeFileSync(file, "x".repeat(3000));
  process.env.EGGENT_VERSIONS_MAX_FILE_MB = "0.001";
  const restore = (force: boolean) => restoreRoute.POST(request("/api/files/versions/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "shop", path: "grown.md", n: 1, ...(force ? { force: true } : {}) }) }));
  try {
    const refused = await restore(false);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "unkept");
    assert.equal(fs.readFileSync(file, "utf8").length, 3000);
    const forced = await restore(true);
    assert.equal(forced.status, 200);
    assert.equal((await forced.json()).lost, true, "the screen must be told what was replaced is not in the history");
    assert.equal(fs.readFileSync(file, "utf8"), "small\n");
  } finally {
    delete process.env.EGGENT_VERSIONS_MAX_FILE_MB;
  }
});
await check("the editor does not write over a file that grew too large to keep while it was open", async () => {
  const file = put("grew-while-open.md", "short\n", DAY);
  fs.writeFileSync(file, "y".repeat(3000));
  process.env.EGGENT_VERSIONS_MAX_FILE_MB = "0.001";
  try {
    const response = await fileContentRoute.PUT(request("/api/files/content?project=shop&path=grew-while-open.md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "short, edited\n" }) }));
    assert.equal(response.status, 409);
    assert.equal(fs.readFileSync(file, "utf8").length, 3000);
  } finally {
    delete process.env.EGGENT_VERSIONS_MAX_FILE_MB;
  }
});
await check("a read-only file stays read-only: the save is refused, the file untouched", async () => {
  const file = put("frozen.md", "frozen\n");
  fs.chmodSync(file, 0o444);
  try {
    const response = await fileContentRoute.PUT(request("/api/files/content?project=shop&path=frozen.md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "thawed\n" }) }));
    assert.equal(response.status, 500);
    assert.equal(fs.readFileSync(file, "utf8"), "frozen\n");
  } finally {
    fs.chmodSync(file, 0o644);
  }
});
await check("deleting a file in the Files panel takes its history with it", async () => {
  const response = await filesRoute.DELETE(request("/api/files?project=shop&path=letter.md", { method: "DELETE" }));
  assert.equal(response.status, 200);
  assert.equal(await journalOf("letter.md"), null);
});
await check("a file's own history can be deleted; usage is reported and can be cleared", async () => {
  assert.equal((await historyRoute.DELETE(request("/api/files/versions?project=shop&path=README", { method: "DELETE" }))).status, 200);
  assert.equal(await journalOf("README"), null);
  const usage = await (await usageRoute.GET(request("/api/files/versions/usage"))).json();
  assert.equal(usage.available, true);
  assert.ok(usage.bytes > 0 && usage.files > 0 && usage.versions >= usage.files);
  const cleared = await (await usageRoute.POST(request("/api/files/versions/usage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clear" }) }))).json();
  assert.equal(cleared.files, 0);
  assert.equal(cleared.versions, 0);
});

console.log("\nIn a real turn\n");

const { createPiChatUIMessageStream, runPiAgentText } = await import("../src/lib/pi/chat-runner.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");
let chatNumber = 0;
async function newChat(title: string, projectId?: string): Promise<string> {
  chatNumber += 1;
  const id = `${String(chatNumber).padStart(8, "0")}-0000-4000-8000-00000000abcd`;
  await createChat(id, title, projectId);
  return id;
}
async function drain(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

await check("the agent's write and edit in one turn make one version, signed with the chat", async () => {
  const chat = await newChat("Notes", "shop");
  put("notes.md", "Old notes\n", 2 * DAY);
  await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "WRITE-THEN-EDIT please" });
  await settleFileVersionCaptures();
  const journal = await journalOf("notes.md");
  assert.deepEqual(journal?.versions.map((item) => item.by.kind), ["earlier", "agent"], JSON.stringify(journal?.versions));
  assert.equal(journal?.versions[1].by.chat, chat);
  assert.equal((await store.content("shop/notes.md", journal!.versions[1].n))?.toString(), "First line\nSecond line, edited\n");
  assert.equal((await store.content("shop/notes.md", journal!.versions[0].n))?.toString(), "Old notes\n");
});
await check("a file the agent's write creates gets no history: a history begins with a change", async () => {
  const chat = await newChat("New file", "shop");
  await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "WRITE-NEW please" });
  await settleFileVersionCaptures();
  assert.equal(fs.readFileSync(path.join(shopDir, "brand-new.md"), "utf8"), "made from nothing\n");
  assert.equal(await journalOf("brand-new.md"), null);
});
await check("files a command only creates get no history", async () => {
  const chat = await newChat("Report", "shop");
  await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "BASH-DOC please" });
  await settleFileVersionCaptures();
  assert.ok(fs.existsSync(path.join(shopDir, "report.md")));
  assert.equal(await journalOf("report.md"), null);
  assert.equal(await journalOf("data.json"), null);
});
await check("a command that only reads a file leaves no copy of it", async () => {
  put("read-only-notes.md", "just read\n", DAY);
  const chat = await newChat("Read", "shop");
  await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "BASH-READ please" });
  await settleFileVersionCaptures();
  assert.equal(await journalOf("read-only-notes.md"), null);
});
await check("a change the sync brings between two writes of one turn is kept", async () => {
  put("shared-draft.md", "original\n", DAY);
  const chat = await newChat("Two writes", "shop");
  await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "WRITE-SYNC-WRITE please" });
  await settleFileVersionCaptures();
  const journal = await journalOf("shared-draft.md");
  const texts: string[] = [];
  for (const item of journal!.versions) texts.push((await store.content("shop/shared-draft.md", item.n))?.toString() ?? "");
  assert.deepEqual(journal!.versions.map((item) => item.by.kind), ["earlier", "agent", "outside", "agent"]);
  assert.deepEqual(texts, ["original\n", "first\n", "from the laptop\n", "second\n"]);
});
await check("a file a command names is kept before the command changes it", async () => {
  put("plain.txt", "alpha\n", DAY);
  const chat = await newChat("Sed", "shop");
  await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "BASH-SED please" });
  await settleFileVersionCaptures();
  const journal = await journalOf("plain.txt");
  assert.deepEqual(journal?.versions.map((item) => item.by.kind), ["earlier", "agent"], JSON.stringify(journal?.versions));
  assert.equal((await store.content("shop/plain.txt", journal!.versions[0].n))?.toString(), "alpha\n");
  assert.equal(fs.readFileSync(path.join(shopDir, "plain.txt"), "utf8"), "beta\n");
});
await check("a data file gets versions from commands once somebody edited it by hand", async () => {
  await fileContentRoute.PUT(request("/api/files/content?project=shop&path=data.json", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "{\"a\":1,\"b\":true}" }) }));
  const chat = await newChat("Json", "shop");
  await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "BASH-JSON please" });
  await settleFileVersionCaptures();
  assert.deepEqual(await kinds("data.json"), ["earlier", "person", "agent"]);
});
await check("the open file and the selected lines reach the model with the message, and are not stored with it", async () => {
  const { describeOpenFile, parseOpenFile } = await import("../src/lib/files/open-file-context.ts");
  put("contract.md", "Intro\nterm 100\nEvery morning at 9 the courier calls.\n");
  const note = await describeOpenFile(parseOpenFile({ project: "shop", path: "contract.md", selection: { startLine: 2, endLine: 3, text: "term 100\nEvery morning at 9 the courier calls." }, unsaved: true })!);
  assert.ok(note);
  assert.match(note, /Open beside this chat: `contract\.md` in the project "Shop"/);
  assert.match(note, /lines 2-3/);
  assert.match(note, /not saved yet/);
  const chat = await newChat("Open file", "shop");
  requests.length = 0;
  await drain(createPiChatUIMessageStream({ chatId: chat, projectId: "shop", userMessage: "EDIT-CONTRACT make it 120", openFileNote: note }));
  await settleFileVersionCaptures();
  assert.ok(requests.some((item) => item.lastUser.includes("Open beside this chat") && item.lastUser.includes("Every morning at 9")), "the model was not told");
  const stored = (await getChat(chat))?.messages.find((message) => message.role === "user");
  assert.equal(stored?.content, "EDIT-CONTRACT make it 120");
  assert.equal(fs.readFileSync(path.join(shopDir, "contract.md"), "utf8"), "Intro\nterm 120\nEvery morning at 9 the courier calls.\n");
});
await check("no note for a file outside the scope, a credential, or a folder", async () => {
  const { describeOpenFile } = await import("../src/lib/files/open-file-context.ts");
  assert.equal(await describeOpenFile({ project: "shop", path: "../../agent/auth.json" }), null);
  assert.equal(await describeOpenFile({ project: "shop", path: ".env" }), null);
  assert.equal(await describeOpenFile({ project: "shop", path: "fresh" }), null);
});
if (subagentsExtension) {
  await check("what a helper writes is a version too, signed as the helper of the chat that started it", async () => {
    put("helper-notes.md", "before the helper\n", DAY);
    const chat = await newChat("Helper", "shop");
    await runPiAgentText({ chatId: chat, projectId: "shop", userMessage: "HELPER-WRITE please" });
    await settleFileVersionCaptures();
    const journal = await journalOf("helper-notes.md");
    assert.ok(journal, "the helper's file has no history");
    const last = journal.versions.at(-1);
    assert.equal(last?.by.kind, "agent");
    assert.equal(last?.by.helper, true);
    assert.equal(last?.by.chat, chat);
  });
} else {
  console.log("  skip  a helper's writes (no @tintinweb/pi-subagents: set EGGENT_SUBAGENTS_EXTENSIONS)");
}
await check("a helper's session finds the version hooks through the bridge file", async () => {
  const { ensureHelperToolsExtension, HELPER_TOOLS_FILE } = await import("../src/lib/pi/helper-tools.ts");
  ensureHelperToolsExtension(agentDir);
  const bridge = await import(path.join(agentDir, "extensions", HELPER_TOOLS_FILE));
  const events: string[] = [];
  bridge.default({ on: (event: string) => events.push(event), registerTool: () => undefined });
  for (const event of ["agent_start", "tool_call", "tool_result", "agent_end"]) assert.ok(events.includes(event), `${event} not hooked`);
});

console.log("\nThe agent's own command\n");

const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "bin", "eggent-history");
const runCli = (args: string[]) =>
  execFileSync(process.execPath, [cli, ...args], {
    cwd: shopDir,
    env: { ...process.env, EGGENT_VERSIONS_DIR: path.join(root, "data", "versions"), EGGENT_PROJECTS_DIR: projectsDir },
    encoding: "utf8",
  });

await check("it lists, shows and compares what the store keeps", async () => {
  const list = runCli(["list", "notes.md"]);
  assert.match(list, /History of shop\/notes\.md \(2 versions, newest first\)/);
  assert.match(list, new RegExp(`v2 .*the agent \\(chat 00000001`));
  assert.equal(runCli(["show", "notes.md", "1"]), "Old notes\n");
  const diff = runCli(["diff", "notes.md", "1", "2"]);
  assert.match(diff, /-Old notes/);
  assert.match(diff, /\+Second line, edited/);
  assert.match(runCli(["list", "never-touched.md"]), /no history yet/);
});
await check("a file that outgrew its history is not said to hold its newest version, and that version can be brought back", async () => {
  const file = put("outgrown.md", "kept\n", DAY);
  await capture.captureBefore(file);
  fs.writeFileSync(file, "kept, edited\n");
  await capture.captureAfter(file, { kind: "person" });
  fs.writeFileSync(file, "z".repeat(3000));
  const history = async () => (await (await historyRoute.GET(request("/api/files/versions?project=shop&path=outgrown.md"))).json()) as { unkept?: string; versions: Array<{ n: number }> };
  process.env.EGGENT_VERSIONS_MAX_FILE_MB = "0.001";
  try {
    const view = await history();
    assert.equal(view.unkept, "too-large");
    assert.deepEqual(view.versions.map((version) => version.n), [2, 1]);
    const list = runCli(["list", "outgrown.md"]);
    assert.doesNotMatch(list, /\(current\)/);
    assert.match(list, /has changed since v2/);
  } finally {
    delete process.env.EGGENT_VERSIONS_MAX_FILE_MB;
  }
  // Holding its newest version again, the file is said to.
  fs.writeFileSync(file, "kept, edited\n");
  assert.equal((await history()).unkept, undefined);
  assert.match(runCli(["list", "outgrown.md"]), /v2 .*\(current\)/);
  fs.rmSync(file);
  assert.match(runCli(["list", "outgrown.md"]), /not there any more; v2 is the last version kept/);
});
await check("it reads a document's text exactly as the screen does", async () => {
  const file = put("deal.docx", docx(["Πρώτο σημείο"], [["A", "B"]]));
  await capture.captureAfter(file, { kind: "upload" });
  fs.writeFileSync(file, docx(["Πρώτο σημείο, αλλαγμένο", "Δεύτερο σημείο"], [["A", "C"]]));
  await capture.captureAfter(file, { kind: "person" });
  for (const n of [1, 2]) {
    const screen = (await textModule.extractVersionText("deal.docx", (await store.content("shop/deal.docx", n))!)).text;
    assert.equal(runCli(["text", "deal.docx", String(n)]), screen.endsWith("\n") ? screen : `${screen}\n`);
  }
  assert.match(runCli(["diff", "deal.docx", "1"]), /\+Δεύτερο σημείο/);
});
await check("it reads a spreadsheet, a presentation and an OpenDocument text as the screen does", async () => {
  const samples: Array<[string, Buffer]> = [
    ["book.xlsx", makeZip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Orders &amp; stock" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Flour</t></si><si><r><t>Su</t></r><r><t>gar</t></r><rPh><t>hint</t></rPh></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>100</v></c><c r="C1" t="b"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>B1*2</f><v>200</v></c><c r="C2" t="inlineStr"><is><t>note</t></is></c></row></sheetData></worksheet>`,
    })],
    ["deck.pptx", makeZip({
      "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Title</a:t></a:r><a:br/><a:r><a:t>second line</a:t></a:r></a:p><a:p/></p:sld>`,
      "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>Next</a:t></a:r></a:p></p:sld>`,
    })],
    ["letter.odt", makeZip({
      "content.xml": `<office:document-content><text:h>Heading</text:h><text:p>One<text:tab/>two<text:s/>three<text:span> four</text:span></text:p><text:p/></office:document-content>`,
    })],
  ];
  for (const [name, data] of samples) {
    const file = put(name, data);
    await capture.captureAfter(file, { kind: "upload" });
    const n = (await journalOf(name))!.versions.at(-1)!.n;
    const screen = (await textModule.extractVersionText(name, data)).text;
    assert.notEqual(screen, "", name);
    assert.equal(runCli(["text", name, String(n)]), screen.endsWith("\n") ? screen : `${screen}\n`, name);
  }
});
await check("the agent is told the history exists and how to read it", () => {
  const guidance = service.fileHistoryGuidance();
  assert.match(guidance, /File history: once a file in a project has been changed/);
  assert.match(guidance, /`eggent-history list <file>`/);
  assert.match(service.historyCliDir() ?? "", /scripts\/bin$/);
});

console.log("\nThe ceiling (last: it trims every file's history)\n");

await check("over its ceiling the history lets go of the versions replaced longest ago, then of whole histories, never of a file", async () => {
  await projectStore.createProject({ id: "ceiling", name: "Ceiling", description: "", instructions: "x", memoryMode: "isolated" } as never);
  const dir = path.join(projectsDir, "ceiling");
  const big = (seed: string) => Array.from({ length: 4000 }, (_, index) => `${seed} ${index} ${Math.random()}`).join("\n");
  const files = ["a.md", "b.md"].map((name) => path.join(dir, name));
  for (const file of files) {
    fs.writeFileSync(file, big(`${file} one`));
    await capture.captureBefore(file);
    for (const round of ["two", "three"]) {
      fs.writeFileSync(file, big(`${file} ${round}`));
      await capture.captureAfter(file, { kind: "person" });
    }
  }
  const live = files.map((file) => fs.readFileSync(file, "utf8"));
  // Older than the moment a trim lets go of things, as it would be: the ceiling is checked a while after a write.
  await new Promise((resolve) => setTimeout(resolve, 5200));
  const before = await store.usage();
  // Room for about half of what is kept: the oldest versions go, the newest of each file stays.
  await store.trim(Math.floor(before.bytes / 2));
  const a = await store.journal("ceiling/a.md");
  const b = await store.journal("ceiling/b.md");
  assert.ok((a?.versions.length ?? 0) < 3 || (b?.versions.length ?? 0) < 3, "nothing was let go of");
  assert.ok((await store.usage()).bytes <= before.bytes / 2 + 4096);
  for (const journal of [a, b]) {
    if (journal) assert.equal((await store.content(journal.key, journal.versions.at(-1)!.n))?.toString(), fs.readFileSync(path.join(projectsDir, journal.key), "utf8"));
  }
  // Room for almost nothing: whole histories go, the files stay as they are.
  await store.trim(1);
  assert.equal(await store.journal("ceiling/a.md"), null);
  assert.equal(await store.journal("ceiling/b.md"), null);
  assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), live);
});
provider.close();
console.log(`\n${ran - failed} of ${ran} checks passed`);
process.exit(failed === 0 ? 0 : 1);
