/**
 * Approvals of file versions, from the workspace's side.
 *
 * A stand-in for the approvals service answers the way the real one does and
 * records what it was sent; the routes the screens call, the watch that voids
 * a round when its file changes, the agent's tool and what the agent is told
 * are all driven through the real code - the last through the real runner,
 * against a stub model, reading the system prompt it is sent.
 *
 * The rule under test is the strict one: any change to a file that is on
 * approval, or approved, is reported, whichever way the change came - through
 * the history, behind its back, by deleting the file - and the agent has no
 * way to decide in the person's name.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:approvals
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-approvals-"));
process.chdir(root);
const projectsDir = path.join(root, "data", "projects");
fs.mkdirSync(path.join(projectsDir, "skills"), { recursive: true });

const { crc32 } = await import("../src/lib/skills/zip-reader.ts");
const sha = (data: Buffer | string) => createHash("sha256").update(typeof data === "string" ? Buffer.from(data) : data).digest("hex");

// ---- a stand-in for the approvals service ---------------------------------------

const TOKEN = "eggw_test_token";
type Step = { position: number; person: { id: string; name: string; role: string; gone: boolean }; state: string; current: boolean; comment: string | null; decidedAt: string | null; viaAgent: boolean };
type Round = { round: number; versionN: number | null; sha256: string; size: number; mime: string; fileName: string; note: string | null; sentByAgent: boolean; status: string; createdAt: string; closedAt: string | null; voidedAt: string | null; steps: Step[]; data: Buffer };
type Stored = { id: string; fileKey: string | null; fileName: string; author: { id: string; name: string; role: string; gone: boolean }; status: string; currentRound: number; rounds: Round[] };

const PEOPLE = [
  { id: "acme-boris", name: "Boris", role: "member", gone: false, about: "Runs purchasing" },
  { id: "acme-anna", name: "Anna Petrova", role: "member", gone: false, about: null },
];
const ME = { id: "acme", name: "Ilia", role: "owner", gone: false };
const service = {
  sends: [] as Array<Record<string, unknown>>,
  decisions: [] as Array<Record<string, unknown>>,
  outdated: [] as Array<{ id: string; round: number; sha: string }>,
  cancels: [] as string[],
  unauthorized: 0,
  inCompany: true,
};
const approvals = new Map<string, Stored>();
let nextId = 1;
const newId = () => `aaaaaaaa-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
const personOf = (id: string) => ({ ...(PEOPLE.find((person) => person.id === id) ?? { id, name: id, role: "member", gone: true }), about: undefined });

// One approval from Boris waiting for this workspace's decision.
const INBOUND = newId();
approvals.set(INBOUND, {
  id: INBOUND,
  fileKey: null,
  fileName: "offer.docx",
  author: { id: "acme-boris", name: "Boris", role: "member", gone: false },
  status: "active",
  currentRound: 2,
  rounds: [],
});

function view(stored: Stored) {
  const latest = stored.rounds[0];
  const waiting = stored.status === "active" ? latest?.steps.find((step) => step.state === "pending") : undefined;
  const mine = stored.author.id === ME.id;
  return {
    id: stored.id,
    fileName: stored.fileName,
    fileKey: mine ? stored.fileKey : null,
    author: stored.author,
    mine,
    status: stored.status,
    currentRound: stored.currentRound,
    superseded: false,
    createdAt: latest?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    waitingFor: waiting ? waiting.person : null,
    myTurn: Boolean(waiting && waiting.person.id === ME.id),
    rounds: stored.rounds.map(({ data: _data, ...round }) => ({ ...round, steps: round.steps.map((step) => ({ ...step, current: step === waiting })) })),
  };
}

function makeRound(input: { round: number; data: Buffer; fileName: string; mime: string; versionN: number | null; note: string | null; agent: boolean; chain: string[] }): Round {
  return {
    round: input.round,
    versionN: input.versionN,
    sha256: sha(input.data),
    size: input.data.length,
    mime: input.mime,
    fileName: input.fileName,
    note: input.note,
    sentByAgent: input.agent,
    status: "active",
    createdAt: new Date().toISOString(),
    closedAt: null,
    voidedAt: null,
    data: input.data,
    steps: input.chain.map((id, position) => ({
      position,
      person: id === ME.id ? ME : (({ about: _about, ...person }) => person)(personOf(id)),
      state: "pending",
      current: false,
      comment: null,
      decidedAt: null,
      viaAgent: false,
    })),
  };
}
const inbound = approvals.get(INBOUND)!;
inbound.rounds = [
  makeRound({ round: 2, data: Buffer.from(docxOf(["Offer, second draft", "Terms on request"])), fileName: "offer.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", versionN: 5, note: "Look at the terms", agent: false, chain: [ME.id] }),
  { ...makeRound({ round: 1, data: Buffer.from(docxOf(["Offer, first draft"])), fileName: "offer.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", versionN: 3, note: null, agent: false, chain: [ME.id] }), status: "rejected" },
];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => resolve(body));
  });
}

const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const route = url.pathname.replace(/^\/api\/approvals/, "") || "/";
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    service.unauthorized += 1;
    json({ error: "no", code: "unauthorized" }, 401);
    return;
  }
  if (!service.inCompany) {
    json({ error: "This workspace is not in a company, so there is nobody to approve anything.", code: "notInCompany" }, 403);
    return;
  }
  const mine = [...approvals.values()].filter((stored) => stored.author.id === ME.id);
  if (route === "/counts") {
    json({ waiting: [...approvals.values()].filter((stored) => view(stored).myTurn).length, returned: mine.filter((stored) => stored.status === "rejected").length });
    return;
  }
  if (route === "/people") {
    json({ me: ME, company: { id: "acme", name: "ACME" }, people: PEOPLE });
    return;
  }
  if (route === "/" && req.method === "GET") {
    const key = url.searchParams.get("key");
    const box = url.searchParams.get("box");
    const list = key !== null
      ? mine.filter((stored) => stored.fileKey === key && stored.status !== "cancelled")
      : box === "sent"
        ? mine
        : [...approvals.values()].filter((stored) => view(stored).myTurn);
    json({ approvals: list.map(view), counts: { waiting: 1, returned: 0 } });
    return;
  }
  if (route === "/send" && req.method === "POST") {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    service.sends.push(body);
    const data = Buffer.from(String(body.data || ""), "base64");
    const chain = (body.approvers as string[]) || [];
    const unknown = chain.find((id) => !PEOPLE.some((person) => person.id === id));
    if (unknown) {
      json({ error: "There is nobody like that in the company.", code: "noPerson" }, 404);
      return;
    }
    let stored = mine.find((entry) => entry.fileKey === body.key && entry.status !== "cancelled");
    const round = makeRound({ round: 1, data, fileName: String(body.fileName), mime: String(body.mime || "application/octet-stream"), versionN: typeof body.versionN === "number" ? body.versionN : null, note: (body.note as string) || null, agent: body.author === "agent", chain });
    if (stored) {
      const latest = stored.rounds[0];
      if (stored.status === "active" && latest.sha256 === round.sha256 && latest.steps.map((step) => step.person.id).join() === chain.join()) {
        json({ error: "This version is already on approval with these people.", code: "alreadyOnApproval" }, 409);
        return;
      }
      if (stored.status === "active") latest.status = latest.sha256 === round.sha256 ? "cancelled" : "outdated";
      round.round = stored.currentRound + 1;
      stored.currentRound = round.round;
      stored.status = "active";
      stored.rounds.unshift(round);
    } else {
      stored = { id: newId(), fileKey: String(body.key), fileName: String(body.fileName), author: ME, status: "active", currentRound: 1, rounds: [round] };
      approvals.set(stored.id, stored);
    }
    json({ approval: view(stored) });
    return;
  }
  const match = /^\/([0-9a-f-]{36})(?:\/(decide|cancel|outdated|rounds\/(\d+)\/file))?$/.exec(route);
  const stored = match ? approvals.get(match[1]) : undefined;
  if (!match || !stored) {
    json({ error: "There is no such approval.", code: "noApproval" }, 404);
    return;
  }
  const [, , action, roundText] = match;
  if (!action) {
    json({ approval: view(stored) });
    return;
  }
  if (roundText) {
    const round = stored.rounds.find((entry) => entry.round === Number(roundText));
    if (!round) {
      json({ error: "There is no such version in this approval.", code: "noRound" }, 404);
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "x-approval-file-name": encodeURIComponent(round.fileName),
      "x-approval-file-type": round.mime,
      "x-approval-file-sha256": round.sha256,
      ...(round.versionN ? { "x-approval-version": String(round.versionN) } : {}),
    });
    res.end(round.data);
    return;
  }
  const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
  const latest = stored.rounds[0];
  if (action === "decide") {
    service.decisions.push({ id: stored.id, ...body });
    if (body.decision === "reject" && !String(body.comment || "").trim()) {
      json({ error: "Say what to change: a version is returned with a comment.", code: "commentRequired" }, 400);
      return;
    }
    if (Number(body.round) !== stored.currentRound) {
      json({ error: "A newer version was sent since you opened this one: look at it before deciding.", code: "staleRound" }, 409);
      return;
    }
    const step = latest.steps.find((entry) => entry.state === "pending");
    if (!step || step.person.id !== ME.id) {
      json({ error: "It is not your turn to decide on this version.", code: "notYourTurn" }, 403);
      return;
    }
    step.state = body.decision === "reject" ? "rejected" : "approved";
    step.comment = (body.comment as string) || null;
    step.viaAgent = body.author === "agent";
    if (body.decision === "reject" || !latest.steps.some((entry) => entry.state === "pending")) {
      stored.status = body.decision === "reject" ? "rejected" : "approved";
      latest.status = stored.status;
    }
    json({ approval: view(stored) });
    return;
  }
  if (action === "cancel") {
    service.cancels.push(stored.id);
    stored.status = "cancelled";
    json({ approval: view(stored) });
    return;
  }
  // outdated
  const report = { id: stored.id, round: Number(body.round), sha: String(body.sha || "") };
  service.outdated.push(report);
  if ((stored.status === "active" || stored.status === "approved") && report.round === stored.currentRound && report.sha !== latest.sha256) {
    if (stored.status === "active") latest.status = "outdated";
    latest.voidedAt = new Date().toISOString();
    stored.status = "outdated";
  }
  json({ approval: view(stored) });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const approvalsUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}/api/approvals`;

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
delete process.env.EGGENT_APPROVALS_API_URL;
delete process.env.EGGENT_MAIL_API_URL;
process.env.EGGENT_USAGE_API_TOKEN = TOKEN;

const { createEggentPiTools } = await import("../src/lib/pi/eggent-tools.ts");
const projectStore = await import("../src/lib/storage/project-store.ts");
const capture = await import("../src/lib/files/versions/capture.ts");
const storeModule = await import("../src/lib/files/versions/store.ts");
const watch = await import("../src/lib/approvals/watch.ts");
const { createSessionToken } = await import("../src/lib/auth/session.ts");
const summaryRoute = await import("../src/app/api/approvals/summary/route.ts");
const fileRoute = await import("../src/app/api/approvals/file/route.ts");
const sendRoute = await import("../src/app/api/approvals/send/route.ts");
const detailRoute = await import("../src/app/api/approvals/[id]/route.ts");
const decideRoute = await import("../src/app/api/approvals/[id]/decide/route.ts");
const cancelRoute = await import("../src/app/api/approvals/[id]/cancel/route.ts");
const roundFileRoute = await import("../src/app/api/approvals/[id]/rounds/[round]/file/route.ts");
const roundTextRoute = await import("../src/app/api/approvals/[id]/rounds/[round]/text/route.ts");
const { runPiAgentText } = await import("../src/lib/pi/chat-runner.ts");

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
function docxOf(paragraphs: string[]): Buffer {
  return makeZip({
    "word/document.xml": `<?xml version="1.0"?><w:document><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
  });
}

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
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type ToolLike = { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> };
async function toolsFor(options: Record<string, unknown> = {}): Promise<Map<string, ToolLike>> {
  const { tools } = await createEggentPiTools({ chatId: "chat-1", scopeId: "shop", projectId: "shop", cwd: shopDir, ...options });
  return new Map((tools as unknown as ToolLike[]).map((tool) => [tool.name, tool]));
}
async function runTool(tools: Map<string, ToolLike>, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = tools.get("eggent_approvals");
  if (!tool) throw new Error("no eggent_approvals tool");
  const result = await tool.execute("call-1", input, undefined, undefined, undefined);
  return JSON.parse(result.content.map((part) => part.text ?? "").join("")) as Record<string, unknown>;
}

console.log("Without the service\n");

await check("a workspace with no approvals service has no tool, no section and no watch", async () => {
  assert.ok(!(await toolsFor()).has("eggent_approvals"));
  const summary = (await (await summaryRoute.GET(request("/api/approvals/summary"))).json()) as { enabled: boolean };
  assert.equal(summary.enabled, false);
  put("plan.md", "a plan\n");
  const file = (await (await fileRoute.GET(request("/api/approvals/file?project=shop&path=plan.md"))).json()) as { enabled: boolean };
  assert.equal(file.enabled, false);
  watch.startApprovalsWatch();
  assert.equal(service.sends.length + service.outdated.length, 0);
});

process.env.EGGENT_APPROVALS_API_URL = approvalsUrl;
watch.startApprovalsWatch();

console.log("\nSending a file\n");

await check("every route needs the session and this workspace's own page, and a write needs JSON", async () => {
  assert.equal((await summaryRoute.GET(request("/api/approvals/summary", { cookie: false }))).status, 401);
  const body = { project: "shop", path: "plan.md", approvers: ["acme-boris"] };
  assert.equal((await sendRoute.POST(request("/api/approvals/send", { method: "POST", body, headers: { "content-type": "text/plain" } }))).status, 415);
  assert.equal((await sendRoute.POST(request("/api/approvals/send", { method: "POST", body, headers: { origin: "https://other.example.test", "sec-fetch-site": "same-site" } }))).status, 403);
  assert.equal((await decideRoute.POST(request(`/api/approvals/${INBOUND}/decide`, { method: "POST", body: { round: 2, decision: "approve" }, cookie: false }), params({ id: INBOUND }))).status, 401);
  assert.equal(service.sends.length + service.decisions.length, 0);
});

const contractPath = put("deals/contract.md", "# Contract\n\nTerm: 12 months.\n");
let contractId = "";
await check("a file goes as it is now, under its path in the projects folder, with its version kept in its history", async () => {
  const response = await sendRoute.POST(request("/api/approvals/send", { method: "POST", body: { project: "shop", path: "deals/contract.md", approvers: ["acme-boris", "acme-anna"], note: "Check the term" } }));
  assert.equal(response.status, 200, await response.clone().text());
  const sent = service.sends.at(-1)!;
  assert.equal(sent.key, "shop/deals/contract.md");
  assert.equal(sent.fileName, "contract.md");
  assert.equal(Buffer.from(String(sent.data), "base64").toString("utf-8"), "# Contract\n\nTerm: 12 months.\n");
  assert.deepEqual(sent.approvers, ["acme-boris", "acme-anna"]);
  assert.equal(sent.author, "person");
  assert.equal(sent.note, "Check the term");
  assert.equal(sent.versionN, 1, "the version sent is in the file's history now, and named by its number");
  const journal = await storeModule.getVersionStore().journal("shop/deals/contract.md");
  assert.equal(journal?.versions.at(-1)?.sha, sha("# Contract\n\nTerm: 12 months.\n"));
  contractId = ((await response.json()) as { approval: { id: string } }).approval.id;
  assert.ok(watch.watchedApprovalKeys().includes("shop/deals/contract.md"), "the file is watched from now on");
});
await check("a file outside the folder, a credential, a missing, empty or too large file is not sent", async () => {
  const before = service.sends.length;
  const refuse = async (filePath: string, status: number, code: string) => {
    const response = await sendRoute.POST(request("/api/approvals/send", { method: "POST", body: { project: "shop", path: filePath, approvers: ["acme-boris"] } }));
    assert.equal(response.status, status, filePath);
    assert.equal(((await response.json()) as { code: string }).code, code, filePath);
  };
  fs.writeFileSync(path.join(root, "data", "secret.txt"), "outside\n");
  await refuse("../../secret.txt", 403, "outside");
  put(".env", "API_KEY=sk-test\n");
  await refuse(".env", 400, "sensitive");
  await refuse("nothing-here.md", 404, "missing");
  put("empty.md", "");
  await refuse("empty.md", 400, "empty");
  const big = put("big.bin", "");
  fs.truncateSync(big, 20 * 1024 * 1024 + 1);
  await refuse("big.bin", 413, "tooLarge");
  // A link is not a plain file, wherever it points.
  fs.symlinkSync(path.join(root, "data", "secret.txt"), path.join(shopDir, "link.txt"));
  await refuse("link.txt", 400, "notFile");
  const nobody = await sendRoute.POST(request("/api/approvals/send", { method: "POST", body: { project: "shop", path: "plan.md", approvers: [] } }));
  assert.equal(nobody.status, 400);
  assert.equal(service.sends.length, before, "a refused file reached the service");
});

console.log("\nAny change voids the round\n");

await check("a change the history records is reported within moments, with what the file holds now", async () => {
  const before = service.outdated.length;
  fs.writeFileSync(contractPath, "# Contract\n\nTerm: 24 months.\n");
  await capture.captureAfter(contractPath, { kind: "person" });
  await wait(2_200);
  const report = service.outdated.slice(before).find((entry) => entry.id === contractId);
  assert.ok(report, "the change was not reported");
  assert.equal(report.round, 1);
  assert.equal(report.sha, sha("# Contract\n\nTerm: 24 months.\n"));
  assert.equal(approvals.get(contractId)!.status, "outdated");
  assert.ok(!watch.watchedApprovalKeys().includes("shop/deals/contract.md"), "a voided round is not watched any more");
});
await check("the new version goes as a new round from the file's screen, and is watched again", async () => {
  const response = await sendRoute.POST(request("/api/approvals/send", { method: "POST", body: { project: "shop", path: "deals/contract.md", approvers: ["acme-boris", "acme-anna"] } }));
  assert.equal(response.status, 200);
  const approval = ((await response.json()) as { approval: { id: string; currentRound: number; status: string } }).approval;
  assert.equal(approval.id, contractId);
  assert.equal(approval.currentRound, 2);
  assert.equal(approval.status, "active");
  assert.equal(service.sends.at(-1)!.versionN, 2);
  assert.ok(watch.watchedApprovalKeys().includes("shop/deals/contract.md"));
});
await check("the agent is told when the file open beside the chat is on approval, and not about any other file", async () => {
  const { describeOpenFile } = await import("../src/lib/files/open-file-context.ts");
  const onApproval = await describeOpenFile({ project: "shop", path: "deals/contract.md" } as never);
  assert.match(String(onApproval), /It is on approval with the company's people, or approved: any change to it voids that/);
  const other = await describeOpenFile({ project: "shop", path: "plan.md" } as never);
  assert.ok(other && !other.includes("on approval"), "a file on no approval was said to be on one");
});
await check("a file the history keeps nothing of (a PDF), changed behind everybody's back, is caught by the minute's look", async () => {
  const pdf = put("deals/terms.pdf", "%PDF-1.4 terms v1");
  const response = await sendRoute.POST(request("/api/approvals/send", { method: "POST", body: { project: "shop", path: "deals/terms.pdf", approvers: ["acme-anna"] } }));
  const approval = ((await response.json()) as { approval: { id: string } }).approval;
  assert.equal(service.sends.at(-1)!.versionN, undefined, "a PDF has no version number");
  assert.equal(service.sends.at(-1)!.mime, "application/pdf");
  await watch.approvalsWatchTick();
  const before = service.outdated.length;
  await watch.approvalsWatchTick();
  assert.equal(service.outdated.length, before, "an unchanged file was reported");
  fs.writeFileSync(pdf, "%PDF-1.4 terms v2");
  await watch.approvalsWatchTick();
  const report = service.outdated.slice(before).find((entry) => entry.id === approval.id);
  assert.ok(report, "the change was not caught");
  assert.equal(report.sha, sha("%PDF-1.4 terms v2"));
  assert.equal(approvals.get(approval.id)!.status, "outdated");
});
await check("an approved file that is deleted is reported as gone, and the approval no longer stands", async () => {
  const memo = put("memo.md", "Memo\n");
  const sent = await sendRoute.POST(request("/api/approvals/send", { method: "POST", body: { project: "shop", path: "memo.md", approvers: ["acme-boris"] } }));
  const id = ((await sent.json()) as { approval: { id: string } }).approval.id;
  const stored = approvals.get(id)!;
  stored.rounds[0].steps[0].state = "approved";
  stored.status = "approved";
  stored.rounds[0].status = "approved";
  await watch.refreshWatchedApprovals();
  assert.ok(watch.watchedApprovalKeys().includes("shop/memo.md"), "an approved file is watched too");
  fs.rmSync(memo);
  const before = service.outdated.length;
  await watch.approvalsWatchTick();
  const report = service.outdated.slice(before).find((entry) => entry.id === id);
  assert.ok(report, "the deletion was not reported");
  assert.equal(report.sha, "");
  assert.ok(approvals.get(id)!.rounds[0].voidedAt);
});
await check("opening the file's approval reports a change nobody has seen yet before showing anything", async () => {
  const draft = put("draft.md", "Draft one\n");
  await sendRoute.POST(request("/api/approvals/send", { method: "POST", body: { project: "shop", path: "draft.md", approvers: ["acme-boris"] } }));
  fs.writeFileSync(draft, "Draft two\n");
  const response = await fileRoute.GET(request("/api/approvals/file?project=shop&path=draft.md"));
  const status = (await response.json()) as { enabled: boolean; approval: { status: string }; changedSinceSent: boolean; current: { sha256: string; versionN: number | null } };
  assert.equal(status.enabled, true);
  assert.equal(status.approval.status, "outdated", "a changed file was shown as on approval");
  assert.equal(status.changedSinceSent, true);
  assert.equal(status.current.sha256, sha("Draft two\n"));
});
await check("the approval's own page does the same for the author", async () => {
  const notes = put("notes.md", "Notes v1\n");
  const sent = await sendRoute.POST(request("/api/approvals/send", { method: "POST", body: { project: "shop", path: "notes.md", approvers: ["acme-anna"] } }));
  const id = ((await sent.json()) as { approval: { id: string } }).approval.id;
  fs.writeFileSync(notes, "Notes v2\n");
  const response = await detailRoute.GET(request(`/api/approvals/${id}`), params({ id }));
  assert.equal(((await response.json()) as { approval: { status: string } }).approval.status, "outdated");
});

console.log("\nDeciding, and taking back\n");

await check("the person's decision goes as theirs, for the round on the screen; a return needs a comment", async () => {
  const bare = await decideRoute.POST(request(`/api/approvals/${INBOUND}/decide`, { method: "POST", body: { round: 2, decision: "reject", comment: "" } }), params({ id: INBOUND }));
  assert.equal(bare.status, 400);
  assert.equal(((await bare.json()) as { code: string }).code, "commentRequired");
  const malformed = await decideRoute.POST(request(`/api/approvals/${INBOUND}/decide`, { method: "POST", body: { decision: "approve" } }), params({ id: INBOUND }));
  assert.equal(malformed.status, 400, "a decision without its round was sent on");
  const response = await decideRoute.POST(request(`/api/approvals/${INBOUND}/decide`, { method: "POST", body: { round: 2, decision: "approve", comment: "Fine" } }), params({ id: INBOUND }));
  assert.equal(response.status, 200);
  const sent = service.decisions.at(-1)!;
  assert.equal(sent.author, "person");
  assert.equal(sent.round, 2);
  assert.equal(sent.comment, "Fine");
  const bad = await decideRoute.POST(request("/api/approvals/not-an-id/decide", { method: "POST", body: { round: 1, decision: "approve" } }), params({ id: "not-an-id" }));
  assert.equal(bad.status, 404);
});
await check("the version a round was sent with comes back byte for byte, shown only when a browser can show it safely", async () => {
  const docx = await roundFileRoute.GET(request(`/api/approvals/${INBOUND}/rounds/2/file?inline=1`), params({ id: INBOUND, round: "2" }));
  assert.equal(docx.status, 200);
  assert.match(docx.headers.get("content-disposition") || "", /^attachment; filename="offer.docx"; filename\*=UTF-8''offer\.docx$/);
  assert.equal(Buffer.from(await docx.arrayBuffer()).toString("hex"), approvals.get(INBOUND)!.rounds[0].data.toString("hex"));
  const terms = [...approvals.values()].find((stored) => stored.fileName === "terms.pdf")!;
  const pdf = await roundFileRoute.GET(request(`/api/approvals/${terms.id}/rounds/1/file?inline=1`), params({ id: terms.id, round: "1" }));
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-security-policy") || "", /^sandbox/);
});
await check("a document's text is read out of it, so two rounds can be compared", async () => {
  const response = await roundTextRoute.GET(request(`/api/approvals/${INBOUND}/rounds/1/text`), params({ id: INBOUND, round: "1" }));
  const text = (await response.json()) as { kind: string; text: string };
  assert.equal(text.kind, "extracted");
  assert.match(text.text, /Offer, first draft/);
});
await check("taking a version back reaches the service and stops the watch", async () => {
  const sheet = put("sheet.md", "Sheet\n");
  void sheet;
  const sent = await sendRoute.POST(request("/api/approvals/send", { method: "POST", body: { project: "shop", path: "sheet.md", approvers: ["acme-boris"] } }));
  const id = ((await sent.json()) as { approval: { id: string } }).approval.id;
  assert.ok(watch.watchedApprovalKeys().includes("shop/sheet.md"));
  const response = await cancelRoute.POST(request(`/api/approvals/${id}/cancel`, { method: "POST", body: {} }), params({ id }));
  assert.equal(response.status, 200);
  assert.deepEqual(service.cancels.at(-1), id);
  assert.ok(!watch.watchedApprovalKeys().includes("shop/sheet.md"));
});

console.log("\nThe agent\n");

let tools = new Map<string, ToolLike>();
await check("the agent has the tool with the service, not inside a project's visit, and has no way to decide", async () => {
  tools = await toolsFor();
  assert.ok(tools.has("eggent_approvals"));
  assert.ok(!(await toolsFor({ visit: { parentChatId: "other" } })).has("eggent_approvals"));
  const schema = JSON.stringify(tools.get("eggent_approvals")!.parameters);
  for (const word of ["decide", "approve", "reject"]) assert.ok(!schema.includes(`"${word}"`), `the tool offers ${word}`);
});
await check("send finds people by name, keeps their order and goes as the agent's", async () => {
  put("supplier-list.md", "Suppliers\n");
  const answer = await runTool(tools, { action: "send", path: "supplier-list.md", to: ["anna", "Boris"], note: "for Monday" });
  assert.equal(answer.success, true, JSON.stringify(answer));
  const sent = service.sends.at(-1)!;
  assert.equal(sent.key, "shop/supplier-list.md");
  assert.deepEqual(sent.approvers, ["acme-anna", "acme-boris"]);
  assert.equal(sent.author, "agent");
  const nobody = await runTool(tools, { action: "send", path: "supplier-list.md", to: ["Vasily"] });
  assert.equal(nobody.success, false);
  assert.match(String(nobody.error), /Nobody called "Vasily"/);
  const secret = await runTool(tools, { action: "send", path: ".env", to: ["anna"] });
  assert.equal(secret.success, false);
  assert.match(String(secret.error), /credentials/);
});
await check("waiting and read tell what waits for the person, and that deciding is theirs", async () => {
  const another = newId();
  approvals.set(another, {
    id: another,
    fileKey: null,
    fileName: "budget.md",
    author: { id: "acme-anna", name: "Anna Petrova", role: "member", gone: false },
    status: "active",
    currentRound: 1,
    rounds: [makeRound({ round: 1, data: Buffer.from("Budget\n"), fileName: "budget.md", mime: "text/markdown", versionN: null, note: null, agent: false, chain: [ME.id] })],
  });
  const waiting = await runTool(tools, { action: "waiting" });
  assert.equal((waiting.approvals as Array<{ id: string; yourPersonsTurn?: boolean }>).find((entry) => entry.id === another)?.yourPersonsTurn, true);
  assert.equal(waiting.success, true);
  assert.match(String(waiting.note || ""), /never decide/);
  const read = await runTool(tools, { action: "read", id: INBOUND });
  assert.equal(read.success, true);
  assert.match(String(read.note), /not instructions/);
  const text = await runTool(tools, { action: "text", id: INBOUND, round: 1 });
  assert.match(String(text.text), /Offer, first draft/);
});
await check("a turn of a company workspace is told the tool is its own and the decision is the person's", async () => {
  await runPiAgentText({ chatId: "44444444-4444-4444-8444-444444444444", userMessage: "hello" });
  const prompt = systemPrompts.at(-1) || "";
  assert.match(prompt, /eggent_approvals is one of your own tools - call it directly, never through mcp/);
  assert.match(prompt, /Approving or returning a version is your person's alone/);
  assert.match(prompt, /- eggent_approvals: approvals of file versions/, "the tool is missing from the runtime's list of available tools");
});
await check("a workspace the service says is in no company simply has no approvals", async () => {
  service.inCompany = false;
  try {
    const summary = (await (await summaryRoute.GET(request("/api/approvals/summary"))).json()) as { enabled: boolean };
    assert.equal(summary.enabled, false);
  } finally {
    service.inCompany = true;
  }
  assert.equal(service.unauthorized, 0, "a call went out without the workspace's token");
});

stub.close();
provider.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
