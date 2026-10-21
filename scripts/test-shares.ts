/**
 * Files shared with the company's people, from the workspace's side.
 *
 * A stand-in for the sharing service answers the way the real one does - it
 * reads this workspace's own shared files from its folder, as the host reads
 * the owner's - and records what it was sent. The routes the screens call,
 * the frame a shared page is shown in, the watch that reports a change, the
 * history that names a colleague's change, the agent's tool and what the
 * agent is told are all driven through the real code.
 *
 * The rules under test: a file is shared only from this workspace's folder
 * and never one that holds credentials; a shared page is served sandboxed,
 * under a key good for that share only; a change made from the screen lands
 * only on the version it was made on; a file anybody may change has its
 * content kept in its history first; and the agent cannot change a
 * colleague's file.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:shares
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-shares-"));
process.chdir(root);
const projectsDir = path.join(root, "data", "projects");
fs.mkdirSync(path.join(projectsDir, "skills"), { recursive: true });

const sha = (data: Buffer | string) => createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
const { crc32 } = await import("../src/lib/skills/zip-reader.ts");

/** A zip of stored entries: enough for a document's parts. */
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

// ---- a stand-in for the sharing service ---------------------------------------------

const TOKEN = "eggw_test_token";
type Role = "view" | "comment" | "edit";
type Comment = { id: string; author: { id: string; name: string; gone: boolean }; viaAgent: boolean; mine: boolean; body: string; quote: string | null; anchor: unknown; replyTo: string | null; resolved: null | { at: string; by: string }; createdAt: string };
type Stored = {
  id: string;
  /** This workspace's own file, by its path under the projects folder; null for one shared with it. */
  key: string | null;
  fileName: string;
  owner: { id: string; name: string };
  people: Map<string, Role>;
  /** A colleague's file, as their workspace holds it, and what lies beside it. */
  data?: Buffer;
  assets?: Record<string, Buffer>;
  comments: Comment[];
};

const ME = { id: "acme", name: "Ilia", role: "owner", gone: false };
const PEOPLE = [
  { id: "acme-boris", name: "Boris", role: "member", gone: false, about: "Runs purchasing" },
  { id: "acme-anna", name: "Anna Petrova", role: "member", gone: false, about: null },
];
const service = {
  shares: [] as Array<Record<string, unknown>>,
  touches: [] as string[],
  writes: [] as Array<{ id: string; baseSha: string; data: string }>,
  comments: [] as Array<Record<string, unknown>>,
  assets: [] as Array<{ id: string; path: string }>,
  seen: [] as string[],
  stops: [] as string[],
  edits: new Map<string, Array<{ sha256: string; by: string; at: string }>>(),
  unauthorized: 0,
};
const stored = new Map<string, Stored>();
let nextId = 1;
const newId = () => `bbbbbbbb-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
const nameOf = (id: string) => (id === ME.id ? ME.name : PEOPLE.find((person) => person.id === id)?.name ?? id);

const PAGE = '<!doctype html>\n<html>\n<head>\n  <link rel="stylesheet" href="css/site.css">\n</head>\n<body>\n  <h1>Fresh bread</h1>\n  <p class="lead">Order before 9 am.</p>\n  <script>window.ran = 1</script>\n</body>\n</html>\n';
const NOTES = "# Notes from Boris\n\nThe schedule is attached.\n";
const DOCX = makeZip({ "word/document.xml": '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Supply agreement</w:t></w:r></w:p></w:body></w:document>' });
const inbound = (fileName: string, data: Buffer, role: Role, assets: Record<string, Buffer> = {}) => {
  const id = newId();
  stored.set(id, { id, key: null, fileName, owner: { id: "acme-boris", name: "Boris" }, people: new Map([[ME.id, role]]), data, assets, comments: [] });
  return id;
};
const PAGE_EDIT = inbound("index.html", Buffer.from(PAGE), "edit", { "css/site.css": Buffer.from("h1 { color: brown }"), "img/a.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
const PAGE_COMMENT = inbound("offer.html", Buffer.from(PAGE), "comment");
const PAGE_VIEW = inbound("menu.html", Buffer.from(PAGE), "view");
const NOTES_ID = inbound("notes.md", Buffer.from(NOTES), "edit");
const DOCX_ID = inbound("agreement.docx", DOCX, "comment");
const PNG_ID = inbound("photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), "view");
const BIN_ID = inbound("blob.bin", Buffer.from([1, 0, 2, 0, 3]), "view");

function ownData(entry: Stored): Buffer | null {
  if (!entry.key) return entry.data ?? null;
  const full = path.join(projectsDir, ...entry.key.split("/"));
  try {
    return fs.lstatSync(full).isFile() ? fs.readFileSync(full) : null;
  } catch {
    return null;
  }
}

function view(entry: Stored) {
  const mine = entry.owner.id === ME.id;
  return {
    id: entry.id,
    fileName: entry.fileName,
    fileKey: mine ? entry.key : null,
    owner: { id: entry.owner.id, name: entry.owner.name, role: "owner", gone: false },
    mine,
    myRole: mine ? "owner" : entry.people.get(ME.id) ?? "view",
    people: [...entry.people].map(([id, role]) => ({ id, name: nameOf(id), role, gone: false })),
    unresolved: entry.comments.filter((comment) => !comment.resolved && !comment.replyTo).length,
    unseen: !mine && !service.seen.includes(entry.id),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => resolve(body));
  });
}

const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const route = url.pathname.replace(/^\/api\/file-shares/, "") || "/";
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const file = (name: string, data: Buffer, mime = "application/octet-stream") => {
    res.writeHead(200, { "content-type": "application/octet-stream", "x-share-file-name": encodeURIComponent(name), "x-share-file-type": mime, "x-share-file-sha256": sha(data) });
    res.end(data);
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    service.unauthorized += 1;
    json({ error: "no", code: "unauthorized" }, 401);
    return;
  }
  const mine = [...stored.values()].filter((entry) => entry.owner.id === ME.id);
  if (route === "/people") return json({ me: ME, company: { id: "acme", name: "ACME" }, people: PEOPLE });
  if (route === "/counts") return json({ withMe: 7, unseen: 7 - service.seen.length, openOnMine: 0 });
  if (route === "/" && req.method === "GET") {
    const key = url.searchParams.get("key");
    if (key !== null) return json({ share: (() => { const found = mine.find((entry) => entry.key === key); return found ? view(found) : null; })() });
    return json({ mine: mine.map(view), withMe: [...stored.values()].filter((entry) => entry.owner.id !== ME.id).map(view) });
  }
  if (route === "/edits") return json({ edits: service.edits.get(url.searchParams.get("key") || "") ?? [] });
  if (route === "/touch" && req.method === "POST") {
    const body = JSON.parse(await readBody(req)) as { key?: string };
    service.touches.push(String(body.key));
    return json({ changed: true });
  }
  if (route === "/share" && req.method === "POST") {
    const body = JSON.parse(await readBody(req)) as { key: string; fileName: string; people: Array<{ id: string; role: Role }> };
    service.shares.push(body as unknown as Record<string, unknown>);
    if (body.people.some((person) => !PEOPLE.some((entry) => entry.id === person.id))) return json({ error: "There is nobody by that id in the company.", code: "noPerson" }, 404);
    let entry = mine.find((candidate) => candidate.key === body.key);
    if (!entry) {
      entry = { id: newId(), key: body.key, fileName: body.fileName, owner: { id: ME.id, name: ME.name }, people: new Map(), comments: [] };
      stored.set(entry.id, entry);
    }
    entry.people = new Map(body.people.map((person) => [person.id, person.role]));
    return json({ share: view(entry) });
  }
  const match = /^\/([0-9a-f-]{36})(?:\/(content|asset|seen|stop|comments)(?:\/([0-9a-f-]{36})\/(resolve|delete))?)?$/.exec(route);
  const entry = match ? stored.get(match[1]) : undefined;
  if (!match || !entry) return json({ error: "There is no such shared file.", code: "noShare" }, 404);
  const [, id, action, commentId, commentAction] = match;
  const role = entry.owner.id === ME.id ? "owner" : entry.people.get(ME.id);
  if (!action) {
    const data = ownData(entry);
    return json({ share: view(entry), file: { exists: Boolean(data), sha256: data ? sha(data) : null, size: data?.length ?? 0, mime: "text/plain", modifiedAt: null } });
  }
  if (action === "content" && req.method === "GET") {
    const data = ownData(entry);
    if (!data) return json({ error: "The file is not there any more.", code: "noFile" }, 410);
    const mime = { ".png": "image/png", ".md": "text/markdown", ".html": "text/html", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }[path.extname(entry.fileName)] ?? "application/octet-stream";
    return file(entry.fileName, data, mime);
  }
  if (action === "content" && req.method === "POST") {
    const body = JSON.parse(await readBody(req)) as { baseSha: string; data: string };
    service.writes.push({ id, baseSha: body.baseSha, data: Buffer.from(body.data, "base64").toString("utf8") });
    if (role !== "edit") return json({ error: "This file is shared with you to read, not to change.", code: "readOnly" }, 403);
    const current = ownData(entry);
    if (!current || body.baseSha !== sha(current)) return json({ error: "The file has changed since you opened it.", code: "changed" }, 409);
    entry.data = Buffer.from(body.data, "base64");
    return json({ sha256: sha(entry.data), size: entry.data.length });
  }
  if (action === "asset") {
    const relative = url.searchParams.get("path") || "";
    service.assets.push({ id, path: relative });
    const asset = entry.assets?.[relative];
    if (!asset || !/\.html?$/.test(entry.fileName)) return json({ error: "There is no such file beside the page.", code: "noFile" }, 404);
    return file(relative.split("/").pop() || relative, asset, relative.endsWith(".css") ? "text/css" : "image/png");
  }
  if (action === "seen") {
    service.seen.push(id);
    return json({ ok: true });
  }
  if (action === "stop") {
    if (role !== "owner") return json({ error: "Only the owner of the file can do that.", code: "notOwner" }, 403);
    service.stops.push(id);
    stored.delete(id);
    return json({ ok: true });
  }
  if (action === "comments" && !commentId && req.method === "GET") return json({ comments: entry.comments });
  if (action === "comments" && !commentId) {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    service.comments.push({ id, ...body });
    if (role === "view") return json({ error: "This file is shared with you to read only.", code: "cannotComment" }, 403);
    const comment: Comment = {
      id: newId(),
      author: { id: ME.id, name: ME.name, gone: false },
      viaAgent: body.author === "agent",
      mine: true,
      body: String(body.body || ""),
      quote: typeof body.quote === "string" ? body.quote : null,
      anchor: body.anchor ?? null,
      replyTo: typeof body.replyTo === "string" ? body.replyTo : null,
      resolved: null,
      createdAt: new Date().toISOString(),
    };
    entry.comments.push(comment);
    return json({ comment });
  }
  const comment = entry.comments.find((candidate) => candidate.id === commentId);
  if (!comment) return json({ error: "There is no such comment.", code: "noComment" }, 404);
  if (commentAction === "resolve") {
    const body = JSON.parse(await readBody(req)) as { resolved?: boolean };
    comment.resolved = body.resolved === false ? null : { at: new Date().toISOString(), by: ME.name };
    return json({ comment });
  }
  entry.comments = entry.comments.filter((candidate) => candidate.id !== commentId && candidate.replyTo !== commentId);
  return json({ ok: true });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const sharesUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}/api/file-shares`;

// ---- a stub model, to read what the agent is told ---------------------------------

const PROVIDER = "stub";
const MODEL = "stub-model";
const systemPrompts: string[] = [];
const provider = http.createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  const payload = JSON.parse((await readBody(req)) || "{}") as { messages?: Array<{ role?: string; content?: unknown }> };
  const system = (payload.messages ?? []).find((message) => message.role === "system" || message.role === "developer");
  systemPrompts.push(typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? ""));
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk({ role: "assistant" }));
  res.write(chunk({ content: "ok" }));
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    [PROVIDER]: {
      name: "Stub",
      baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      api: "openai-completions",
      models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 16384, maxTokens: 2048 }],
    },
  },
}));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";
process.env.EGGENT_TURN_WATCHDOG = "off";
delete process.env.EGGENT_SHARES_API_URL;
delete process.env.EGGENT_APPROVALS_API_URL;
delete process.env.EGGENT_MAIL_API_URL;
process.env.EGGENT_USAGE_API_TOKEN = TOKEN;

const { createEggentPiTools } = await import("../src/lib/pi/eggent-tools.ts");
const projectStore = await import("../src/lib/storage/project-store.ts");
const capture = await import("../src/lib/files/versions/capture.ts");
const storeModule = await import("../src/lib/files/versions/store.ts");
const view_ = await import("../src/lib/files/versions/view.ts");
const watch = await import("../src/lib/shares/watch.ts");
const pageToken = await import("../src/lib/files/page-token.ts");
const { createSessionToken } = await import("../src/lib/auth/session.ts");
const { middleware } = await import("../src/middleware.ts");
const summaryRoute = await import("../src/app/api/shares/summary/route.ts");
const listRoute = await import("../src/app/api/shares/route.ts");
const fileRoute = await import("../src/app/api/shares/file/route.ts");
const shareRoute = await import("../src/app/api/shares/share/route.ts");
const stopRoute = await import("../src/app/api/shares/[id]/stop/route.ts");
const textRoute = await import("../src/app/api/shares/[id]/text/route.ts");
const contentRoute = await import("../src/app/api/shares/[id]/content/route.ts");
const linkRoute = await import("../src/app/api/shares/[id]/page-link/route.ts");
const elementRoute = await import("../src/app/api/shares/[id]/page-element/route.ts");
const editRoute = await import("../src/app/api/shares/[id]/page-edit/route.ts");
const printRoute = await import("../src/app/api/shares/[id]/print/route.ts");
const commentsRoute = await import("../src/app/api/shares/[id]/comments/route.ts");
const resolveRoute = await import("../src/app/api/shares/[id]/comments/[comment]/resolve/route.ts");
const deleteRoute = await import("../src/app/api/shares/[id]/comments/[comment]/delete/route.ts");
const sharedPageRoute = await import("../src/app/api/shares/page/[token]/[...path]/route.ts");
const projectPageRoute = await import("../src/app/api/files/page/[token]/[...path]/route.ts");
const { runPiAgentText } = await import("../src/lib/pi/chat-runner.ts");

await projectStore.createProject({ id: "shop", name: "Shop", description: "", instructions: "Shop rules.", memoryMode: "isolated" } as never);
const shopDir = path.join(projectsDir, "shop");
const put = (relative: string, content: string | Buffer) => {
  const full = path.join(shopDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
};

const session = await createSessionToken("tester", false);
const request = (url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: boolean } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    headers: {
      ...(init.cookie === false ? {} : { cookie: `eggent_auth=${session}` }),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const pageParams = (token: string, segments: string[]) => ({ params: Promise.resolve({ token, path: segments }) });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type ToolLike = { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> };
async function toolsFor(options: Record<string, unknown> = {}): Promise<Map<string, ToolLike>> {
  const { tools } = await createEggentPiTools({ chatId: "chat-1", scopeId: "shop", projectId: "shop", cwd: shopDir, ...options });
  return new Map((tools as unknown as ToolLike[]).map((tool) => [tool.name, tool]));
}
async function runTool(tools: Map<string, ToolLike>, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = tools.get("eggent_shares");
  if (!tool) throw new Error("no eggent_shares tool");
  const result = await tool.execute("call-1", input, undefined, undefined, undefined);
  return JSON.parse(result.content.map((part) => part.text ?? "").join("")) as Record<string, unknown>;
}
async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
/** The path a link names, split the way the router hands it to the route. */
function routeParams(url: string): { token: string; path: string[]; search: string } {
  const parsed = new URL(url, "http://localhost");
  const [, , , , token, ...rest] = parsed.pathname.split("/");
  return { token, path: rest, search: parsed.search };
}

console.log("Without the service\n");

await check("a workspace with no sharing service has no tool, no section, no watch, and its routes say so", async () => {
  assert.ok(!(await toolsFor()).has("eggent_shares"));
  assert.equal((await body<{ enabled: boolean }>(await summaryRoute.GET(request("/api/shares/summary")))).enabled, false);
  put("plan.md", "a plan\n");
  assert.equal((await body<{ enabled: boolean }>(await fileRoute.GET(request("/api/shares/file?project=shop&path=plan.md")))).enabled, false);
  const list = await listRoute.GET(request("/api/shares"));
  assert.equal(list.status, 503);
  assert.equal((await body<{ code: string }>(list)).code, "notConfigured");
  watch.startSharesWatch();
  await watch.sharesWatchTick({ refresh: true });
  assert.equal(service.shares.length + service.touches.length, 0);
});

process.env.EGGENT_SHARES_API_URL = sharesUrl;
watch.startSharesWatch();

console.log("\nSharing a file\n");

await check("every route needs the session and this workspace's own page, and a write needs JSON", async () => {
  assert.equal((await summaryRoute.GET(request("/api/shares/summary", { cookie: false }))).status, 401);
  const input = { project: "shop", path: "plan.md", people: [{ id: "acme-boris", role: "view" }] };
  assert.equal((await shareRoute.POST(request("/api/shares/share", { method: "POST", body: input, headers: { "content-type": "text/plain" } }))).status, 415);
  assert.equal((await shareRoute.POST(request("/api/shares/share", { method: "POST", body: input, headers: { origin: "https://other.example.test", "sec-fetch-site": "same-site" } }))).status, 403);
  assert.equal((await editRoute.POST(request(`/api/shares/${PAGE_EDIT}/page-edit`, { method: "POST", body: { sha: "x", edits: [] }, cookie: false }), params({ id: PAGE_EDIT }))).status, 401);
  assert.equal((await contentRoute.POST(request(`/api/shares/${NOTES_ID}/content`, { method: "POST", body: { baseSha: "x", text: "y" }, headers: { origin: "https://other.example.test", "sec-fetch-site": "same-site" } }), params({ id: NOTES_ID }))).status, 403);
  assert.equal((await commentsRoute.POST(request(`/api/shares/${NOTES_ID}/comments`, { method: "POST", body: { body: "hi" }, cookie: false }), params({ id: NOTES_ID }))).status, 401);
  assert.equal(service.shares.length + service.writes.length + service.comments.length, 0, "nothing reached the service");
  // The frame's own route has no session to ask for: its key is the credential.
  // A last segment with a dot in it skips the sign-in anyway (open issue 2): the rule is checked on one without.
  const passed = await middleware(new NextRequest("http://localhost/api/shares/page/x.y/README"));
  assert.equal(passed.headers.get("x-middleware-next"), "1");
  const stopped = await middleware(new NextRequest("http://localhost/api/shares"));
  assert.notEqual(stopped.headers.get("x-middleware-next"), "1", "every other sharing route is behind the sign-in");
});

const CONTRACT = "# Contract\n\nTerm: 12 months.\n";
put("deals/contract.md", CONTRACT);
let contractId = "";
await check("a file is shared under its path in the projects folder; anybody who may change it has its content kept in its history first", async () => {
  const response = await shareRoute.POST(request("/api/shares/share", { method: "POST", body: { project: "shop", path: "deals/contract.md", people: [{ id: "acme-boris", role: "edit" }] } }));
  assert.equal(response.status, 200, await response.clone().text());
  const sent = service.shares.at(-1)!;
  assert.equal(sent.key, "shop/deals/contract.md");
  assert.equal(sent.fileName, "contract.md");
  assert.deepEqual(sent.people, [{ id: "acme-boris", role: "edit" }]);
  assert.ok(!("data" in sent), "the file itself is never sent: the service reads it where it is");
  contractId = (await body<{ share: { id: string } }>(response)).share.id;
  const journal = await storeModule.getVersionStore().journal("shop/deals/contract.md");
  assert.equal(journal?.versions.at(-1)?.sha, sha(CONTRACT), "what it held is in its history before a colleague can change it");
  assert.equal(journal?.versions.at(-1)?.by.kind, "earlier");
  assert.ok(watch.watchedSharedKeys().includes("shop/deals/contract.md"), "and it is watched from now on");
  const status = await body<{ enabled: boolean; share: { id: string; people: unknown[] } | null }>(await fileRoute.GET(request("/api/shares/file?project=shop&path=deals/contract.md")));
  assert.equal(status.share?.id, contractId);
});
await check("sharing to look at it only does not start a history; a file not in the folder, a credential, a missing file or a bad role is refused here", async () => {
  put("schedule.md", "dates\n");
  const viewOnly = await shareRoute.POST(request("/api/shares/share", { method: "POST", body: { project: "shop", path: "schedule.md", people: [{ id: "acme-anna", role: "view" }] } }));
  assert.equal(viewOnly.status, 200);
  assert.equal(await storeModule.getVersionStore().journal("shop/schedule.md"), null);
  const before = service.shares.length;
  put(".env", "KEY=secret\n");
  const refusals: Array<[unknown, number, string]> = [
    [{ project: "shop", path: ".env", people: [{ id: "acme-boris", role: "view" }] }, 400, "sensitive"],
    [{ project: "shop", path: "../../outside.md", people: [{ id: "acme-boris", role: "view" }] }, 403, "outside"],
    [{ project: "shop", path: "nothing.md", people: [{ id: "acme-boris", role: "view" }] }, 404, "missing"],
    [{ project: "shop", path: "plan.md", people: [{ id: "acme-boris", role: "owner" }] }, 400, "badRole"],
    [{ project: "shop", path: "plan.md", people: [{ id: "", role: "view" }] }, 400, "badRole"],
  ];
  for (const [input, status, code] of refusals) {
    const response = await shareRoute.POST(request("/api/shares/share", { method: "POST", body: input }));
    assert.equal(response.status, status, JSON.stringify(input));
    assert.equal((await body<{ code: string }>(response)).code, code);
  }
  assert.equal(service.shares.length, before, "none of them reached the service");
  const status = await body<{ current: { sensitive: boolean }; share: unknown }>(await fileRoute.GET(request("/api/shares/file?project=shop&path=.env")));
  assert.equal(status.current.sensitive, true);
  assert.equal(status.share, null);
});

console.log("\nWhat changes is reported, and who changed it is named\n");

await check("a change the history records is reported for a shared file and for no other", async () => {
  service.touches.length = 0;
  const contract = path.join(shopDir, "deals/contract.md");
  await capture.captureBefore(contract);
  await capture.writeFileInside(contract, "# Contract\n\nTerm: 24 months.\n", shopDir);
  await capture.captureAfter(contract, { kind: "person" });
  put("plan.md", "a new plan\n");
  await capture.captureBefore(path.join(shopDir, "plan.md"));
  await capture.captureAfter(path.join(shopDir, "plan.md"), { kind: "person" });
  await wait(2200);
  assert.deepEqual(service.touches, ["shop/deals/contract.md"]);
});
await check("a shared file the history keeps nothing of is reported when it changes on disk", async () => {
  put("scan.pdf", "%PDF-1.4 first");
  assert.equal((await shareRoute.POST(request("/api/shares/share", { method: "POST", body: { project: "shop", path: "scan.pdf", people: [{ id: "acme-anna", role: "view" }] } }))).status, 200);
  await watch.sharesWatchTick();
  service.touches.length = 0;
  await watch.sharesWatchTick();
  assert.deepEqual(service.touches, [], "nothing moved, nothing reported");
  await wait(20);
  put("scan.pdf", "%PDF-1.4 second, longer");
  await watch.sharesWatchTick();
  assert.deepEqual(service.touches, ["shop/scan.pdf"]);
});
await check("a colleague's change, written by the host, is named in the history under their name", async () => {
  const contract = path.join(shopDir, "deals/contract.md");
  // A change that came another way first - the sync - is seen from outside too, and is nobody's.
  fs.writeFileSync(contract, "# Contract\n\nTerm: 30 months.\n");
  await capture.checkTracked("shop/deals/contract.md");
  const theirs = "# Contract\n\nTerm: 36 months.\n";
  fs.writeFileSync(contract, theirs);
  service.edits.set("shop/deals/contract.md", [{ sha256: sha(theirs), by: "Boris", at: new Date().toISOString() }]);
  const { view } = await view_.historyOf("shop", "deals/contract.md");
  const newest = view.versions[0];
  assert.equal(newest.by.kind, "outside");
  assert.equal(newest.sharedBy, "Boris");
  assert.equal(view.versions[1].by.kind, "outside", "the sync's change is in the history too");
  assert.ok(view.versions.slice(1).every((version) => !version.sharedBy), "only the version they wrote");
});

console.log("\nA shared page, shown in its frame\n");

await check("a shared page is served sandboxed under a key good for that share only, with the files beside it", async () => {
  const link = await body<{ url: string }>(await linkRoute.GET(request(`/api/shares/${PAGE_EDIT}/page-link`), params({ id: PAGE_EDIT })));
  assert.match(link.url, /^\/api\/shares\/page\/[^/]+\/index\.html$/);
  const target = routeParams(link.url);
  const page = await sharedPageRoute.GET(new NextRequest(`http://localhost${link.url}`), pageParams(target.token, target.path));
  assert.equal(page.status, 200);
  assert.equal(await page.text(), PAGE);
  const policy = page.headers.get("content-security-policy") || "";
  assert.match(policy, /^sandbox allow-scripts/);
  assert.match(policy, /connect-src 'none'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  service.assets.length = 0;
  const css = await sharedPageRoute.GET(new NextRequest(`http://localhost/api/shares/page/${target.token}/css/site.css`), pageParams(target.token, ["css", "site.css"]));
  assert.equal(css.status, 200);
  assert.equal(await css.text(), "h1 { color: brown }");
  assert.deepEqual(service.assets, [{ id: PAGE_EDIT, path: "css/site.css" }], "asked of that share and nothing else");
  const missing = await sharedPageRoute.GET(new NextRequest(`http://localhost/api/shares/page/${target.token}/secret.md`), pageParams(target.token, ["secret.md"]));
  assert.equal(missing.status, 404);
});
await check("a key for one of this workspace's own folders is no key for a share, nor the other way round, nor an expired one", async () => {
  const own = pageToken.mintPageToken("shop");
  assert.equal((await sharedPageRoute.GET(new NextRequest("http://localhost/x"), pageParams(own, ["index.html"]))).status, 403);
  const shared = pageToken.mintSharePageToken(PAGE_EDIT, "index.html");
  assert.equal((await projectPageRoute.GET(new NextRequest("http://localhost/x"), pageParams(shared, ["deals", "contract.md"]))).status, 403);
  const old = pageToken.mintSharePageToken(PAGE_EDIT, "index.html", Date.now() - 60 * 60_000);
  assert.equal((await sharedPageRoute.GET(new NextRequest("http://localhost/x"), pageParams(old, ["index.html"]))).status, 403);
  const forged = `${shared.split(".")[0]}.${"A".repeat(43)}`;
  assert.equal((await sharedPageRoute.GET(new NextRequest("http://localhost/x"), pageParams(forged, ["index.html"]))).status, 403);
});
await check("the page is marked for pointing as far as the role goes: words to change with edit, pointing only with comment, nothing with view", async () => {
  const modeOf = async (id: string) => {
    const link = await body<{ url: string }>(await linkRoute.GET(request(`/api/shares/${id}/page-link?mode=edit`), params({ id })));
    return new URL(link.url, "http://localhost").searchParams.get("eggent");
  };
  assert.equal(await modeOf(PAGE_EDIT), "edit");
  assert.equal(await modeOf(PAGE_COMMENT), "pick");
  assert.equal(await modeOf(PAGE_VIEW), null);
  const link = await body<{ url: string }>(await linkRoute.GET(request(`/api/shares/${PAGE_COMMENT}/page-link?mode=edit`), params({ id: PAGE_COMMENT })));
  const target = routeParams(link.url);
  const page = await sharedPageRoute.GET(new NextRequest(`http://localhost${link.url}`), pageParams(target.token, target.path));
  const text = await page.text();
  assert.match(text, /const EDIT = false;/, "pointing, without changing words");
  assert.match(text, /data-eggent-el="\d+"/);
  assert.match(page.headers.get("content-security-policy") || "", /script-src 'nonce-/, "the page's own scripts are off");
  assert.equal((await linkRoute.GET(request(`/api/shares/${NOTES_ID}/page-link`), params({ id: NOTES_ID }))).status, 400, "only a page is shown this way");
});
await check("a block picked on a shared page is read from the file it was shown from, or the page is shown again", async () => {
  const block = await elementRoute.GET(request(`/api/shares/${PAGE_EDIT}/page-element?sha=${sha(PAGE)}&el=4`), params({ id: PAGE_EDIT }));
  assert.equal(block.status, 200);
  const found = await body<{ label: string; source: string; startLine: number }>(block);
  assert.equal(found.label, "h1");
  assert.equal(found.source, "<h1>Fresh bread</h1>");
  assert.equal(found.startLine, 7);
  assert.equal((await elementRoute.GET(request(`/api/shares/${PAGE_EDIT}/page-element?sha=stale&el=4`), params({ id: PAGE_EDIT }))).status, 409);
});
await check("words changed on a shared page are written onto the version they were changed on, and on no other", async () => {
  service.writes.length = 0;
  const edits = [{ el: 4, slot: 0, was: "Fresh bread", text: "Warm bread" }];
  const stale = await editRoute.POST(request(`/api/shares/${PAGE_EDIT}/page-edit`, { method: "POST", body: { sha: "stale", edits } }), params({ id: PAGE_EDIT }));
  assert.equal(stale.status, 409);
  assert.equal(service.writes.length, 0, "a page shown from an older file writes nothing");
  assert.equal((await editRoute.POST(request(`/api/shares/${PAGE_EDIT}/page-edit`, { method: "POST", body: { sha: sha(PAGE), edits: [{ el: "4" }] } }), params({ id: PAGE_EDIT }))).status, 400);
  const response = await editRoute.POST(request(`/api/shares/${PAGE_EDIT}/page-edit`, { method: "POST", body: { sha: sha(PAGE), edits } }), params({ id: PAGE_EDIT }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(service.writes.length, 1);
  assert.equal(service.writes[0].baseSha, sha(PAGE));
  assert.equal(service.writes[0].data, PAGE.replace("Fresh bread", "Warm bread"), "only those characters changed");
  // Somebody it is shared with to comment is refused by the service, in its own words.
  const refused = await editRoute.POST(request(`/api/shares/${PAGE_COMMENT}/page-edit`, { method: "POST", body: { sha: sha(PAGE), edits } }), params({ id: PAGE_COMMENT }));
  assert.equal(refused.status, 403);
  assert.equal((await body<{ code: string }>(refused)).code, "readOnly");
});

console.log("\nA shared file on its screen\n");

await check("a shared file is shown as text, as a document's words, as a picture, or for download", async () => {
  const kinds: Array<[string, string]> = [[NOTES_ID, "text"], [PAGE_VIEW, "text"], [DOCX_ID, "extracted"], [PNG_ID, "image"], [BIN_ID, "binary"]];
  for (const [id, kind] of kinds) {
    const content = await body<{ kind: string; text?: string; sha256: string }>(await textRoute.GET(request(`/api/shares/${id}/text`), params({ id })));
    assert.equal(content.kind, kind, id);
    if (id === DOCX_ID) assert.match(content.text || "", /Supply agreement/);
    if (id === NOTES_ID) assert.equal(content.sha256, sha(NOTES));
  }
  const inline = await contentRoute.GET(request(`/api/shares/${PNG_ID}/content?inline=1`), params({ id: PNG_ID }));
  assert.equal(inline.headers.get("content-type"), "image/png");
  assert.match(inline.headers.get("content-security-policy") || "", /^sandbox/);
  const saved = await contentRoute.GET(request(`/api/shares/${BIN_ID}/content?inline=1`), params({ id: BIN_ID }));
  assert.match(saved.headers.get("content-disposition") || "", /^attachment/, "a kind the browser should not open is saved");
});
await check("text changed from the screen is saved onto the version it was read at, or refused when the file moved on", async () => {
  service.writes.length = 0;
  const saved = await contentRoute.POST(request(`/api/shares/${NOTES_ID}/content`, { method: "POST", body: { baseSha: sha(NOTES), text: `${NOTES}One more line.\n` } }), params({ id: NOTES_ID }));
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal(service.writes[0].data, `${NOTES}One more line.\n`);
  const again = await contentRoute.POST(request(`/api/shares/${NOTES_ID}/content`, { method: "POST", body: { baseSha: sha(NOTES), text: "overwrite" } }), params({ id: NOTES_ID }));
  assert.equal(again.status, 409);
  assert.equal((await body<{ code: string }>(again)).code, "changed");
  assert.equal((await contentRoute.POST(request(`/api/shares/${NOTES_ID}/content`, { method: "POST", body: { text: "no base" } }), params({ id: NOTES_ID }))).status, 400);
});
await check("a shared file is printed: a page by its printing copy, other text by the print view", async () => {
  const page = await printRoute.GET(request(`/api/shares/${PAGE_VIEW}/print`), params({ id: PAGE_VIEW }));
  assert.equal(page.status, 302);
  assert.match(page.headers.get("location") || "", /^\/api\/shares\/page\/[^/]+\/menu\.html\?eggent=print$/);
  const notes = await printRoute.GET(request(`/api/shares/${NOTES_ID}/print`), params({ id: NOTES_ID }));
  assert.equal(notes.headers.get("location"), `/print?share=${NOTES_ID}`);
});
await check("comments go in the person's name, on a piece of the file when one is picked, and are resolved and deleted through the service", async () => {
  service.comments.length = 0;
  const posted = await commentsRoute.POST(request(`/api/shares/${PAGE_COMMENT}/comments`, {
    method: "POST",
    body: { body: "Seven days, not five", quote: "<h1>Fresh bread</h1>", anchor: { startLine: 7, endLine: 7, label: "h1" }, replyTo: "not-an-id", author: "agent" },
  }), params({ id: PAGE_COMMENT }));
  assert.equal(posted.status, 200, await posted.clone().text());
  const sent = service.comments.at(-1)!;
  assert.equal(sent.author, "person", "a comment from the screen is the person's, whatever the request says");
  assert.equal(sent.quote, "<h1>Fresh bread</h1>");
  assert.deepEqual(sent.anchor, { startLine: 7, endLine: 7, label: "h1" });
  assert.ok(!("replyTo" in sent), "an id that is not one is dropped");
  const comment = (await body<{ comment: { id: string } }>(posted)).comment.id;
  const reply = await commentsRoute.POST(request(`/api/shares/${PAGE_COMMENT}/comments`, { method: "POST", body: { body: "Agreed", replyTo: comment } }), params({ id: PAGE_COMMENT }));
  assert.equal(reply.status, 200);
  assert.equal(service.comments.at(-1)!.replyTo, comment);
  const resolved = await resolveRoute.POST(request(`/api/shares/${PAGE_COMMENT}/comments/${comment}/resolve`, { method: "POST", body: { resolved: true } }), params({ id: PAGE_COMMENT, comment }));
  assert.ok((await body<{ comment: { resolved: unknown } }>(resolved)).comment.resolved);
  assert.equal((await deleteRoute.POST(request(`/api/shares/${PAGE_COMMENT}/comments/${comment}/delete`, { method: "POST", body: {} }), params({ id: PAGE_COMMENT, comment }))).status, 200);
  const left = await body<{ comments: unknown[] }>(await commentsRoute.GET(request(`/api/shares/${PAGE_COMMENT}/comments`), params({ id: PAGE_COMMENT })));
  assert.equal(left.comments.length, 0, "the thread went with its reply");
  const viewer = await commentsRoute.POST(request(`/api/shares/${PNG_ID}/comments`, { method: "POST", body: { body: "Nice" } }), params({ id: PNG_ID }));
  assert.equal(viewer.status, 403, "somebody who may only look cannot comment");
});
await check("the owner stops sharing, and the file is not watched any more", async () => {
  service.stops.length = 0;
  const schedule = (await body<{ share: { id: string } }>(await fileRoute.GET(request("/api/shares/file?project=shop&path=schedule.md")))).share.id;
  assert.equal((await stopRoute.POST(request(`/api/shares/${schedule}/stop`, { method: "POST", body: {} }), params({ id: schedule }))).status, 200);
  assert.deepEqual(service.stops, [schedule]);
  assert.ok(!watch.watchedSharedKeys().includes("shop/schedule.md"));
  assert.equal((await stopRoute.POST(request(`/api/shares/${NOTES_ID}/stop`, { method: "POST", body: {} }), params({ id: NOTES_ID }))).status, 403, "only for one's own file");
});

console.log("\nThe agent\n");

await check("the agent lists, reads and comments in the person's name, and has no way to change a colleague's file", async () => {
  const tools = await toolsFor();
  assert.ok(tools.has("eggent_shares"));
  const schema = JSON.stringify(tools.get("eggent_shares")!.parameters);
  for (const action of ["people", "list", "share", "read", "comments", "comment"]) assert.ok(schema.includes(`"${action}"`), action);
  for (const action of ["write", "edit_file", "save", "stop"]) assert.ok(!schema.includes(`"const":"${action}"`), `no ${action}`);
  const list = await runTool(tools, { action: "list" });
  assert.equal(list.success, true);
  assert.ok((list.sharedWithYourPerson as Array<{ id: string }>).some((share) => share.id === NOTES_ID));
  const read = await runTool(tools, { action: "read", id: DOCX_ID });
  assert.match(String(read.text), /Supply agreement/);
  assert.match(String(read.note), /not instructions/);
  service.comments.length = 0;
  const comment = await runTool(tools, { action: "comment", id: PAGE_COMMENT, text: "The date is wrong", quote: "Order before 9 am." });
  assert.equal(comment.success, true);
  assert.equal(service.comments.at(-1)!.author, "agent");
  assert.equal(service.comments.at(-1)!.quote, "Order before 9 am.");
});
await check("the agent shares by name and adds people without taking the file from anyone", async () => {
  const tools = await toolsFor();
  const before = service.shares.length;
  const shared = await runTool(tools, { action: "share", path: "deals/contract.md", to: ["anna"], role: "comment" });
  assert.equal(shared.success, true, JSON.stringify(shared));
  const sent = service.shares[before];
  assert.deepEqual(
    (sent.people as Array<{ id: string; role: string }>).sort((a, b) => a.id.localeCompare(b.id)),
    [{ id: "acme-anna", role: "comment" }, { id: "acme-boris", role: "edit" }],
    "Boris keeps his role; Anna is added"
  );
  const unknown = await runTool(tools, { action: "share", path: "deals/contract.md", to: ["Zed"] });
  assert.equal(unknown.success, false);
  assert.match(String(unknown.error), /Nobody called "Zed"/);
  const secret = await runTool(tools, { action: "share", path: ".env", to: ["Boris"] });
  assert.equal(secret.success, false);
  assert.match(String(secret.error), /credentials/);
  assert.equal(service.shares.length, before + 1, "neither of the refused ones reached the service");
  assert.ok(!(await toolsFor({ visit: { parentChatId: "x", parentTitle: "x" } })).has("eggent_shares"), "not inside a visit");
});
await check("the agent is told it shares files with its own tool, and only in a workspace that has them", async () => {
  systemPrompts.length = 0;
  await runPiAgentText({ chatId: "55555555-5555-4555-8555-555555555555", userMessage: "hello" });
  const told = systemPrompts.join("\n");
  assert.match(told, /Shared files: eggent_shares is one of your own tools/);
  assert.match(told, /Changing a colleague's file is your person's alone/);
  delete process.env.EGGENT_SHARES_API_URL;
  systemPrompts.length = 0;
  await runPiAgentText({ chatId: "66666666-6666-4666-8666-666666666666", userMessage: "hello" });
  assert.doesNotMatch(systemPrompts.join("\n"), /eggent_shares/);
  process.env.EGGENT_SHARES_API_URL = sharesUrl;
});

stub.close();
provider.close();
console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
