/**
 * The search over a shared project (src/lib/kb).
 *
 * Every format is read and found again by what it says; an index follows its
 * files - a changed file is read again and only it, a deleted one leaves -
 * and works by words alone when there is nothing to embed with. A stub stands
 * in for the gateway's embeddings, so meaning is tested without the network.
 * And the boundary: nothing a public share may not open - `.env`, credentials,
 * the owner's notes, skills, hidden folders, links out - is ever indexed or
 * returned, and the index itself is invisible.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:kb
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

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

for (const name of ["EGGENT_AI_MODEL_BASE_URL", "EGGENT_USAGE_API_URL", "EGGENT_MANAGED_AI_TOKEN", "EGGENT_USAGE_API_TOKEN"]) delete process.env[name];

// The stub embeddings: words hashed into a few buckets, with one pair of
// synonyms put in the same bucket - so a question in other words finds a
// passage, which no ranking of the words could.
const DIMS = 32;
const SYNONYMS: Record<string, string> = { holiday: "vacation", holidays: "vacation", vacations: "vacation" };
const embedRequests: Array<{ inputs: string[]; auth: string | undefined; model: unknown }> = [];
let embedStatus = 200;
function stubVector(text: string): number[] {
  const vector = new Array(DIMS).fill(0);
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    const word = SYNONYMS[raw] ?? raw;
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % DIMS] += 1;
  }
  return vector;
}
const gateway = http.createServer((req, res) => {
  let body = "";
  req.on("data", (part) => {
    body += String(part);
  });
  req.on("end", () => {
    const payload = JSON.parse(body || "{}") as { input?: string[]; model?: unknown };
    embedRequests.push({ inputs: payload.input ?? [], auth: req.headers.authorization, model: payload.model });
    if (req.url !== "/v1/embeddings" || embedStatus !== 200) {
      res.writeHead(req.url !== "/v1/embeddings" ? 404 : embedStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: (payload.input ?? []).map((text, index) => ({ index, embedding: stubVector(text) })).reverse() }));
  });
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-kb-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "auth.json"), "{}");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXTERNAL_API_TOKEN = "warm-test-token";

const { crc32 } = await import("../src/lib/skills/zip-reader.ts");
const { createProject } = await import("../src/lib/storage/project-store.ts");
const { refreshKbIndex, warmKbIndex } = await import("../src/lib/kb/index.ts");
const { searchKb } = await import("../src/lib/kb/search.ts");
const { createPublicShareTools, PUBLIC_SHARE_TOOL_NAMES } = await import("../src/lib/pi/public-share.ts");
const capture = await import("../src/lib/files/versions/capture.ts");
const warmRoute = await import("../src/app/api/external/kb/warm/route.ts");

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

/** A PDF with one line of text on each page. */
function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects[pageIds[index]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`;
    objects[pageIds[index] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const project = await createProject({ id: "handbook", memoryMode: "isolated", name: "Handbook", description: "Company handbook", instructions: "" });
const dir = path.join(root, "data", "projects", project.id);
const put = (relative: string, content: string | Buffer) => {
  const full = path.join(dir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
};
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-kb-outside-"));
fs.writeFileSync(path.join(outside, "secret.md"), "OUTSIDE-SECRET kiwi\n");

// Long enough that the passage about parking is not the first one.
const filler = Array.from({ length: 30 }, (_, index) => `Rule ${index + 1}: keep the kitchen tidy and the lights off at night.`).join("\n");
put("notes.md", `# Office\n\nThe office opens at nine.\n\n${filler}\n\nParking is behind the building, ask for the code.\n`);
put("hr/policy.docx", makeZip({
  "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Leave policy</w:t></w:r></w:p><w:p><w:r><w:t>Every employee has 28 vacation days a year.</w:t></w:r></w:p></w:body></w:document>`,
}));
put("finance/rates.xlsx", makeZip({
  "xl/workbook.xml": `<workbook><sheets><sheet name="Tariffs" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Consulting hour</t></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>150</v></c></row></sheetData></worksheet>`,
}));
put("deck.pptx", makeZip({
  "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Welcome aboard</a:t></a:r></a:p></p:sld>`,
  "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>Our mission: quokka logistics</a:t></a:r></a:p></p:sld>`,
}));
put("letter.odt", makeZip({ "content.xml": `<office:document-content><text:p>Dear partner, the warehouse moved to Elm street.</text:p></office:document-content>` }));
put("manual.pdf", makePdf(["Safety first", "Fire exits are marked in green"]));
put("README", "Read me: the wiki lives in this folder.\n");
// What a public share may not see, each carrying a word the search is asked for.
put(".env", "API_KEY=ENV-SECRET kiwi\n");
put("credentials.json", "{\"key\":\"CRED-SECRET kiwi\"}\n");
put("memory.md", "OWNER-NOTE kiwi\n");
put("hr/learned.md", "LEARNED-NOTE kiwi\n");
put("skills/x/SKILL.md", "SKILL-NOTE kiwi\n");
put("docs/.hidden/x.md", "HIDDEN-NOTE kiwi\n");
put(".kb/planted.md", "PLANTED-NOTE kiwi\n");
put("keys/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY----- KEY-SECRET kiwi\n");
put("blob.bin", Buffer.from([0, 1, 2, 3, 107, 105, 119, 105]));
fs.symlinkSync(outside, path.join(dir, "link-out"));
fs.symlinkSync(path.join(outside, "secret.md"), path.join(dir, "linked.md"));

const SECRETS = /ENV-SECRET|CRED-SECRET|OWNER-NOTE|LEARNED-NOTE|SKILL-NOTE|HIDDEN-NOTE|PLANTED-NOTE|KEY-SECRET|OUTSIDE-SECRET/;
const top = async (query: string) => (await searchKb(dir, query)).passages[0];

console.log("Every format, found by what it says\n");

const firstStats = await warmKbIndex(dir);
await check("the index holds the project's readable files and nothing to embed with", () => {
  assert.equal(firstStats.files, 7, JSON.stringify(firstStats));
  assert.equal(firstStats.embedded, 0);
  assert.ok(firstStats.chunks >= 8);
});
for (const [label, query, file, place] of [
  ["markdown, by its line", "parking behind building", "notes.md", /^line (?!1$)\d+$/],
  ["a Word document, by its paragraph", "vacation days", "hr/policy.docx", /^paragraph 1$/],
  ["a spreadsheet, by its sheet", "consulting hour", "finance/rates.xlsx", /^Tariffs$/],
  ["a presentation, by its slide", "quokka logistics", "deck.pptx", /^Slide 2$/],
  ["an OpenDocument text", "warehouse Elm street", "letter.odt", /^paragraph 1$/],
  ["a PDF, by its page", "fire exits green", "manual.pdf", /^page 2$/],
  ["a file with no extension", "wiki folder", "README", /^line 1$/],
] as const) {
  await check(label, async () => {
    const hit = await top(query);
    assert.ok(hit, `nothing found for "${query}"`);
    assert.equal(hit.file, file);
    assert.match(hit.place, place);
  });
}
await check("a passage's line is the line it starts on in the file", async () => {
  const hit = await top("parking behind building");
  const line = Number(hit.place.replace("line ", ""));
  const lines = fs.readFileSync(path.join(dir, "notes.md"), "utf8").split("\n");
  assert.equal(lines[line - 1].trim(), hit.text.split("\n")[0].trim());
});
await check("a word in another form is found (vacation / vacations)", async () => {
  assert.equal((await top("vacations"))?.file, "hr/policy.docx");
});
await check("words only: a question in other words finds nothing, and nothing fails", async () => {
  const result = await searchKb(dir, "holiday");
  assert.equal(result.mode, "words");
  assert.equal(result.passages.length, 0);
});

console.log("\nThe boundary\n");

await check("nothing a public share may not open is indexed", () => {
  const stored = fs.readFileSync(path.join(dir, ".kb", "chunks.json"), "utf8");
  assert.ok(!SECRETS.test(stored), `the index holds ${stored.match(SECRETS)?.[0]}`);
  for (const name of [".env", "credentials.json", "memory.md", "hr/learned.md", "skills/x/SKILL.md", "docs/.hidden/x.md", ".kb/planted.md", "keys/id_rsa", "blob.bin", "linked.md", "link-out/secret.md", ".kb/chunks.json"]) {
    assert.ok(!stored.includes(`"${name}"`), `${name} is in the index`);
  }
});
await check("nothing a public share may not open is returned", async () => {
  const result = await searchKb(dir, "kiwi secret note");
  for (const passage of result.passages) assert.ok(!SECRETS.test(passage.text), `returned ${passage.file}`);
});
await check("the index does not index itself", async () => {
  const again = await warmKbIndex(dir);
  assert.deepEqual(again, firstStats);
});
await check("the index has no file history", () => {
  assert.equal(capture.isVersionablePath("handbook/.kb/chunks.json"), false);
  assert.equal(capture.isVersionablePath("handbook/notes.md"), true);
});

console.log("\nFollowing the files\n");

await check("a changed file is read again", async () => {
  put("notes.md", "# Office\n\nThe office opens at ten now.\n\nBicycles go in the courtyard.\n");
  const hit = await top("bicycles courtyard");
  assert.equal(hit?.file, "notes.md");
  assert.ok(!(await searchKb(dir, "parking")).passages.some((passage) => passage.file === "notes.md"), "the old text is still found");
});
await check("a deleted file leaves the index", async () => {
  fs.rmSync(path.join(dir, "letter.odt"));
  const result = await searchKb(dir, "warehouse Elm street");
  assert.ok(!result.passages.some((passage) => passage.file === "letter.odt"));
  assert.equal(result.stats.files, 6);
});
await check("one build at a time: two at once are the same build", async () => {
  put("extra.md", "Extra page about lanterns.\n");
  const [a, b] = [refreshKbIndex(dir), refreshKbIndex(dir)];
  assert.equal(a, b);
  assert.equal(await a, await b);
});

console.log("\nMeaning, through the gateway\n");

process.env.EGGENT_AI_MODEL_BASE_URL = gatewayUrl;
process.env.EGGENT_MANAGED_AI_TOKEN = "eggw_test-token";
await check("with the gateway, every passage is embedded once, with the workspace's credential and no model named", async () => {
  const stats = await warmKbIndex(dir);
  assert.equal(stats.embedded, stats.chunks);
  assert.ok(embedRequests.length > 0);
  assert.ok(embedRequests.every((request) => request.auth === "Bearer eggw_test-token"));
  assert.ok(embedRequests.every((request) => request.model === undefined), "the request named a model");
  assert.equal(embedRequests.reduce((sum, request) => sum + request.inputs.length, 0), stats.chunks);
  assert.ok(fs.statSync(path.join(dir, ".kb", "vectors.f32")).size === stats.chunks * DIMS * 4);
});
await check("a question in other words finds the passage by meaning", async () => {
  const result = await searchKb(dir, "holiday");
  assert.equal(result.mode, "meaning");
  assert.equal(result.passages[0]?.file, "hr/policy.docx");
});
await check("an unchanged project embeds nothing but the question", async () => {
  embedRequests.length = 0;
  await searchKb(dir, "lanterns");
  assert.equal(embedRequests.length, 1);
  assert.deepEqual(embedRequests[0].inputs, ["lanterns"]);
});
await check("a changed file is the only one embedded again", async () => {
  embedRequests.length = 0;
  put("extra.md", "Extra page about paper lanterns and candles.\n");
  await refreshKbIndex(dir);
  const inputs = embedRequests.flatMap((request) => request.inputs);
  assert.ok(inputs.length >= 1 && inputs.every((input) => input.startsWith("extra.md\n")), inputs.join(" | "));
});
await check("vectors survive a restart: read back from the folder, not made again", async () => {
  (globalThis as unknown as { __eggentKbIndexes: Map<string, unknown> }).__eggentKbIndexes.clear();
  embedRequests.length = 0;
  const stats = await warmKbIndex(dir);
  assert.equal(stats.embedded, stats.chunks);
  assert.equal(embedRequests.length, 0);
});
await check("a gateway that refuses leaves the words to answer, without an error", async () => {
  embedStatus = 402;
  put("late.md", "A late note about umbrellas.\n");
  const result = await searchKb(dir, "umbrellas");
  assert.equal(result.passages[0]?.file, "late.md");
  assert.ok(result.stats.embedded < result.stats.chunks);
  embedStatus = 200;
  (globalThis as unknown as { __eggentKbEmbedCooldown: Map<string, number> }).__eggentKbEmbedCooldown.clear();
  const healed = await warmKbIndex(dir);
  assert.equal(healed.embedded, healed.chunks, "the passages left out are embedded once the gateway answers");
});
await check("still nothing held back is indexed or embedded", () => {
  assert.ok(!SECRETS.test(fs.readFileSync(path.join(dir, ".kb", "chunks.json"), "utf8")));
});

console.log("\nThe tool and the warm-up route\n");

await check("kb_search is one of a public share's tools", async () => {
  assert.ok(PUBLIC_SHARE_TOOL_NAMES.includes("kb_search"));
  const tools = await createPublicShareTools(dir);
  const tool = tools.find((candidate) => candidate.name === "kb_search");
  assert.ok(tool);
  const run = tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>;
  const text = (await run("call-1", { query: "fire exits" }, undefined, undefined, undefined)).content.map((part) => part.text ?? "").join("\n");
  assert.match(text, /manual\.pdf \(page 2\)/);
  const leak = (await run("call-2", { query: "kiwi secret" }, undefined, undefined, undefined)).content.map((part) => part.text ?? "").join("\n");
  assert.ok(!SECRETS.test(leak), leak);
});
const warm = (body: unknown, token?: string) => warmRoute.POST(new Request("http://localhost/api/external/kb/warm", {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}) as never);
await check("the route answers files, chunks and embedded for the external token", async () => {
  const response = await warm({ projectId: "handbook" }, "warm-test-token");
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, number>;
  assert.deepEqual(Object.keys(body).sort(), ["chunks", "embedded", "files"]);
  assert.ok(body.files > 0 && body.chunks > 0 && body.embedded === body.chunks);
});
await check("the route refuses without the token, and a project that is not one", async () => {
  assert.equal((await warm({ projectId: "handbook" })).status, 401);
  assert.equal((await warm({ projectId: "handbook" }, "wrong-token-xxxx")).status, 401);
  assert.equal((await warm({ projectId: "../agent" }, "warm-test-token")).status, 400);
  assert.equal((await warm({ projectId: "none" }, "warm-test-token")).status, 400);
  assert.equal((await warm({ projectId: "nobody" }, "warm-test-token")).status, 404);
});

gateway.close();
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
