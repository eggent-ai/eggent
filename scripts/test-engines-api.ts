/**
 * The part of engines a person reaches from the settings screen and from the
 * other side of a pair: which programs this computer offers, setting a project
 * onto one (and the first-use confirmation that has to come first), signing in,
 * the trial request, and what a computer says when the cloud hands it a chat
 * that its program cannot take.
 *
 * Drives the real handlers and the real session guard. The program is a fake
 * one; nothing here starts a process or reaches a network.
 *
 * Run with Node 22:
 *   npm run test:engines-api
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-engines-api-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_AUTH_SECRET = "engines-api-test-secret-0123456789abcdef";
process.env.EGGENT_LEARNING = "off";
process.env.EGGENT_ENGINE_PROBE_TIMEOUT_MS = "600";
process.env.TMPDIR = root;
fs.mkdirSync(path.join(root, "data", "projects", "skills"), { recursive: true });

const registry = await import("../src/lib/engines/registry.ts");
const service = await import("../src/lib/engines/service.ts");
const store = await import("../src/lib/engines/store.ts");
const projectStore = await import("../src/lib/storage/project-store.ts");
const { getResolvedPiRuntimeModel } = await import("../src/lib/pi/config-store.ts");
const { learnFromTurn } = await import("../src/lib/learning/review.ts");
const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const { NextRequest } = await import("next/server.js");
const enginesRoute = await import("../src/app/api/engines/route.ts");
const choiceRoute = await import("../src/app/api/engines/choice/route.ts");
const loginRoute = await import("../src/app/api/engines/[id]/login/route.ts");
const probeRoute = await import("../src/app/api/engines/[id]/probe/route.ts");
const { prepareRelayedTurn } = await import("../src/lib/remote/executing.ts");
const { remoteFailureMessage } = await import("../src/lib/remote/proxy-turn.ts");
const { RemoteError } = await import("../src/lib/remote/types.ts");
const { parseHandoverFailure, canRunHereInstead } = await import("../src/lib/remote/client.ts");
const { translate } = await import("../src/i18n/messages.ts");

import type { Engine, EngineRunRequest, EngineRunResult } from "../src/lib/engines/host-types.ts";
import type { EngineStatus } from "../src/lib/engines/types.ts";

const ORIGIN = "https://workspace.example.test";
const ownerSession = await createSessionToken("owner@example.test", false);
const stockSession = await createSessionToken("admin", true);

interface RequestOptions {
  cookie?: string | null;
  origin?: string | null;
  site?: string;
  contentType?: string | null;
  body?: unknown;
  method?: string;
}
function request(pathname: string, options: RequestOptions = {}) {
  const headers = new Headers();
  const cookie = options.cookie === undefined ? ownerSession : options.cookie;
  if (cookie) headers.set("cookie", `${AUTH_COOKIE_NAME}=${cookie}`);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.set("origin", origin);
  headers.set("host", new URL(ORIGIN).host);
  if (options.site) headers.set("sec-fetch-site", options.site);
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  if (contentType && method !== "GET") headers.set("content-type", contentType);
  return new NextRequest(`${ORIGIN}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body),
  });
}
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (response: Response) => (await response.json().catch(() => null)) as Record<string, any> | null;

console.log("Where the list comes from\n");

await check("with no engines module the list is empty and the screens stay out of sight", async () => {
  assert.equal(await registry.enginesAvailable(), false);
  const response = await enginesRoute.GET(request("/api/engines"));
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { available: false, engines: [], choice: null, consents: {} });
});
await check("a choice cannot name a program nobody registered", async () => {
  await projectStore.createProject({ id: "p1", name: "One", description: "", instructions: "", memoryMode: "isolated" } as never);
  const outcome = await service.applyEngineChoice("p1", { engine: "fake", confirm: true });
  assert.deepEqual(outcome, { ok: false, status: 404, code: "engine" });
});

// A host module, loaded the way the app's is.
const hostFile = path.join(root, "host.mjs");
fs.writeFileSync(hostFile, `
export function register(api) {
  api.registerEngine({
    id: "hosted",
    label: "Hosted Code",
    models: () => [{ id: "", label: "Default" }],
    status: async () => ({ state: "ready" }),
    startLogin: async () => ({ done: Promise.resolve({ state: "ready" }), cancel() {} }),
    run: async () => ({ ok: true, text: "hi" }),
  });
}
`);
await check("a module that cannot be loaded is reported and leaves the list as it was", async () => {
  registry.resetEnginesForTest();
  process.env.EGGENT_ENGINES_MODULE = path.join(root, "missing.mjs");
  assert.deepEqual(await registry.listEngines(), []);
  assert.ok(registry.enginesLoadError(), "the failure was not kept");
  assert.equal((await json(await enginesRoute.GET(request("/api/engines"))))?.available, false);
});
await check("a module that exports no register function is reported too", async () => {
  registry.resetEnginesForTest();
  const bad = path.join(root, "bad.mjs");
  fs.writeFileSync(bad, "export const nothing = 1;\n");
  process.env.EGGENT_ENGINES_MODULE = bad;
  assert.deepEqual(await registry.listEngines(), []);
  assert.match(registry.enginesLoadError() ?? "", /no register function/);
});
await check("the host's module registers its programs once, through the neutral door", async () => {
  registry.resetEnginesForTest();
  process.env.EGGENT_ENGINES_MODULE = hostFile;
  const engines = await registry.listEngines();
  assert.deepEqual(engines.map((engine) => engine.id), ["hosted"]);
  assert.equal(registry.enginesLoadError(), null);
  assert.equal((await registry.listEngines()).length, 1, "loaded twice");
});
await check("an engine id that could not be a file name or a provider id is refused", () => {
  for (const id of ["Bad Id", "../x", "", "a".repeat(40)]) {
    assert.throws(() => registry.registerEngine({ ...({} as Engine), id }), /not a short lowercase name/, id);
  }
});

// The fake the rest of the checks use.
registry.resetEnginesForTest();
delete process.env.EGGENT_ENGINES_MODULE;
const runs: EngineRunRequest[] = [];
let status: EngineStatus = { state: "ready", version: "1.2.3", account: "Max" };
let loginGate: { resolve: (value: EngineStatus) => void; cancelled: boolean } | null = null;
let hang = false;
const fake: Engine = {
  id: "fake",
  label: "Fake Code",
  models: () => [{ id: "", label: "Default" }, { id: "fast", label: "Fast" }],
  status: async () => status,
  startLogin: async () => {
    const gate = { resolve: (_value: EngineStatus) => {}, cancelled: false };
    const done = new Promise<EngineStatus>((resolve) => {
      gate.resolve = resolve;
    });
    loginGate = gate;
    return { done, cancel: () => { gate.cancelled = true; gate.resolve(status); } };
  },
  run: async (req): Promise<EngineRunResult> => {
    runs.push(req);
    if (hang) {
      await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, stopped: true, text: "" };
    }
    return { ok: true, text: "OK" };
  },
};
registry.registerEngine(fake);

console.log("\nSetting a project onto a program\n");

await check("the state lists the program with its models, its status and no choice yet", async () => {
  const state = await service.engineState("p1");
  assert.equal(state.available, true);
  assert.equal(state.engines.length, 1);
  assert.equal(state.engines[0].label, "Fake Code");
  assert.deepEqual(state.engines[0].models.map((model) => model.id), ["", "fast"]);
  assert.equal(state.engines[0].status.state, "ready");
  assert.equal(state.choice, null);
});
await check("a program offered as an experiment is marked so for the screens, and one that is not is not", async () => {
  registry.registerEngine({ ...fake, id: "trial", label: "Trial Code", experimental: true });
  const state = await service.engineState("p1", { fresh: true });
  assert.equal(state.engines.find((engine) => engine.id === "trial")?.experimental, true);
  assert.equal(state.engines.find((engine) => engine.id === "fake")?.experimental, undefined);
  registry.unregisterEngine("trial");
});
await check("a program cannot be switched on until the person has confirmed the first-use sheet", async () => {
  const outcome = await service.applyEngineChoice("p1", { engine: "fake" });
  assert.deepEqual(outcome, { ok: false, status: 409, code: "consent-required" });
  assert.equal(await store.readEngineChoice("p1"), null, "nothing may be written without it");
});
await check("confirmed, it is set with project access and the time the person said yes", async () => {
  const outcome = await service.applyEngineChoice("p1", { engine: "fake", confirm: true });
  assert.ok(outcome.ok && outcome.choice);
  if (!outcome.ok || !outcome.choice) return;
  assert.equal(outcome.choice.engine, "fake");
  assert.equal(outcome.choice.access, "project");
  assert.equal(outcome.choice.model, "");
  assert.ok(outcome.choice.consentAt && !Number.isNaN(Date.parse(outcome.choice.consentAt)));
});
await check("changing the model or the access later keeps the confirmation it already has", async () => {
  const before = (await store.readEngineChoice("p1"))!;
  const outcome = await service.applyEngineChoice("p1", { engine: "fake", model: "fast", access: "full" });
  assert.ok(outcome.ok && outcome.choice);
  if (!outcome.ok || !outcome.choice) return;
  assert.equal(outcome.choice.model, "fast");
  assert.equal(outcome.choice.access, "full");
  assert.equal(outcome.choice.consentAt, before.consentAt);
});
await check("another program is a new question, even for a project that has said yes to this one", async () => {
  registry.registerEngine({ ...fake, id: "other", label: "Other Code" });
  const outcome = await service.applyEngineChoice("p1", { engine: "other" });
  assert.deepEqual(outcome, { ok: false, status: 409, code: "consent-required" });
  assert.equal((await store.readEngineChoice("p1"))?.engine, "fake", "the refused change must not undo the old choice");
  registry.unregisterEngine("other");
});
await check("a model the program does not list is refused, and so are a project or a program that do not exist", async () => {
  assert.deepEqual(await service.applyEngineChoice("p1", { engine: "fake", model: "nope", confirm: true }), { ok: false, status: 400, code: "model" });
  assert.deepEqual(await service.applyEngineChoice("ghost", { engine: "fake", confirm: true }), { ok: false, status: 404, code: "project" });
  assert.deepEqual(await service.applyEngineChoice("p1", { engine: "ghost", confirm: true }), { ok: false, status: 404, code: "engine" });
});
await check("an access level nobody defined is ignored: a project keeps its own, a new choice gets the narrow one", async () => {
  await service.applyEngineChoice("p1", { engine: "fake", access: "everything" });
  assert.equal((await store.readEngineChoice("p1"))?.access, "full", "an unknown level keeps the level the project had");
  await service.applyEngineChoice(null, { engine: "fake", access: "everything", confirm: true });
  assert.equal((await store.readEngineChoice(null))?.access, "project");
  await service.applyEngineChoice(null, { engine: null });
});
await check("the orchestrator is a scope of its own", async () => {
  const outcome = await service.applyEngineChoice(null, { engine: "fake", model: "fast", confirm: true });
  assert.ok(outcome.ok);
  assert.equal((await store.readEngineChoice(null))?.model, "fast");
  assert.equal((await store.readEngineChoice("p1"))?.model, "fast");
  await service.applyEngineChoice(null, { engine: null });
  assert.equal(await store.readEngineChoice(null), null);
  assert.ok(await store.readEngineChoice("p1"), "turning the orchestrator off must not touch a project");
});
await check("what the project is labelled with follows its program, and says no tokens are counted", async () => {
  const stats = await getResolvedPiRuntimeModel("p1");
  assert.deepEqual(stats.model, { provider: "Fake Code", id: "fast", name: "Fast" });
  assert.equal(stats.engine, true);
  assert.equal(stats.context, undefined);
});
await check("a yes is remembered after the program is turned off, so turning it on again needs no sheet", async () => {
  const before = (await store.readEngineChoice("p1"))!;
  assert.ok(before.consentAt);
  assert.deepEqual(await service.applyEngineChoice("p1", { engine: null }), { ok: true, choice: null });
  const state = await service.engineState("p1");
  assert.equal(state.choice, null);
  assert.equal(state.consents.fake, before.consentAt, "the screen is told which programs are already confirmed");
  const again = await service.applyEngineChoice("p1", { engine: "fake", model: "fast" });
  assert.ok(again.ok && again.choice?.consentAt === before.consentAt);
  assert.deepEqual(await service.engineState("other-project").then((s) => s.consents), {}, "a yes belongs to the project it was given for");
});
await check("a change is announced to the open chats, so the footer and the note follow at once", async () => {
  const seen: Array<{ topic: string; projectId?: string | null; reason?: string }> = [];
  const { subscribeUiSyncEvents } = await import("../src/lib/realtime/event-bus.ts");
  const stop = subscribeUiSyncEvents((event) => seen.push(event));
  await service.applyEngineChoice("p1", { engine: null });
  await service.applyEngineChoice("p1", { engine: "fake" });
  stop();
  assert.equal(seen.filter((event) => event.topic === "projects" && event.projectId === "p1" && event.reason === "engine_changed").length, 2);
});
await check("turning it off puts the project back on a model", async () => {
  const outcome = await service.applyEngineChoice("p1", { engine: null });
  assert.deepEqual(outcome, { ok: true, choice: null });
  assert.equal(await store.readEngineChoice("p1"), null);
  const stats = await getResolvedPiRuntimeModel("p1");
  assert.notEqual(stats.engine, true);
});
await check("deleting a project forgets what it was set to, so a new project of that name starts clean", async () => {
  await service.applyEngineChoice("p1", { engine: "fake", confirm: true });
  assert.ok(await store.readEngineChoice("p1"));
  assert.equal(await projectStore.deleteProject("p1"), true);
  assert.equal(await store.readEngineChoice("p1"), null);
  assert.deepEqual(await store.readEngineConsents("p1"), {}, "a new project of that name must not inherit the old project's yes");
  await projectStore.createProject({ id: "p1", name: "One", description: "", instructions: "", memoryMode: "isolated" } as never);
});

console.log("\nA turn on a program does not feed the look-back that learns from turns\n");

await check("a turn done by a program is not handed to the learning look-back", () => {
  const turn = {
    chatId: "c1",
    userMessage: "remember that I like short answers",
    assistantText: "ok",
    tools: [],
    startedAt: new Date().toISOString(),
  };
  assert.equal(learnFromTurn({ ...turn, model: { provider: "engine-fake", id: "default" } }), false);
  assert.equal(learnFromTurn({ ...turn, model: { provider: "openai", id: "x" } }), true, "other turns are untouched");
});

console.log("\nSigning in\n");

await check("signing in is started once, shown while it waits, and forgotten when it ends", async () => {
  status = { state: "signed-out" };
  registry.forgetEngineStatus("fake");
  assert.equal(await service.startEngineLogin("fake"), "started");
  assert.equal(await service.startEngineLogin("fake"), "running", "a second press must not open a second browser");
  assert.equal((await service.engineState(null)).engines[0].loggingIn, true);
  status = { state: "ready", version: "1.2.3", account: "Max" };
  loginGate!.resolve(status);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = await service.engineState(null);
  assert.equal(after.engines[0].loggingIn, undefined);
  assert.equal(after.engines[0].status.state, "ready", "the status shown must be looked at again once signed in");
});
await check("a look at the status that began before a sign-in ended is not the answer after it", async () => {
  // The program reports "signed out" slowly; the person finishes signing in while that look is under way.
  let signedIn = false;
  let begun: () => void = () => {};
  const looking = new Promise<void>((resolve) => {
    begun = resolve;
  });
  let slowOnce = true;
  const slow: Engine = {
    ...fake,
    id: "slow",
    label: "Slow Code",
    status: async () => {
      const seen: EngineStatus = signedIn ? { state: "ready", version: "1.2.3", account: "Max" } : { state: "signed-out" };
      if (slowOnce) {
        slowOnce = false;
        begun();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return seen;
    },
  };
  registry.registerEngine(slow);
  const before = registry.engineInfo("slow", { fresh: true });
  await looking;
  signedIn = true;
  registry.forgetEngineStatus("slow");
  const stale = await before;
  assert.equal(stale?.status.state, "signed-out", "the look that began earlier answers for itself");
  const after = await registry.engineInfo("slow");
  assert.equal(after?.status.state, "ready", "...but must not be remembered over what happened since");
  registry.unregisterEngine("slow");
});
await check("giving up a sign-in clears it", async () => {
  assert.equal(await service.startEngineLogin("fake"), "started");
  assert.equal(service.cancelEngineLogin("fake"), true);
  assert.equal(loginGate!.cancelled, true);
  assert.equal(service.cancelEngineLogin("fake"), false);
  assert.equal((await service.engineState(null)).engines[0].loggingIn, undefined);
});
await check("a program nobody registered has no sign-in", async () => {
  assert.equal(await service.startEngineLogin("ghost"), "unknown");
});

console.log("\nThe trial request\n");

await check("it asks the program for one word in an empty folder of its own and leaves nothing behind", async () => {
  runs.length = 0;
  const result = await service.probeEngine("fake", "");
  assert.ok(result?.ok);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.ephemeral, true, "a trial must not leave a session of the program's own");
  assert.equal(run.access, "project");
  assert.equal(run.brief, "");
  assert.equal(run.sessionId, null);
  assert.ok(!path.resolve(run.cwd).startsWith(path.join(root, "data")), "it must not run inside the workspace");
  assert.ok(!fs.existsSync(run.cwd), "its folder was not removed");
});
await check("a program that is not signed in is not started for it", async () => {
  status = { state: "signed-out" };
  registry.forgetEngineStatus("fake");
  runs.length = 0;
  const result = await service.probeEngine("fake", "");
  assert.equal(runs.length, 0);
  assert.equal(result?.ok, false);
  assert.equal(result?.error?.code, "signed-out");
  status = { state: "ready", version: "1.2.3", account: "Max" };
  registry.forgetEngineStatus("fake");
});
await check("a program that never answers is stopped", async () => {
  hang = true;
  const started = Date.now();
  const result = await service.probeEngine("fake", "");
  hang = false;
  assert.equal(result?.ok, false);
  assert.equal(result?.error?.code, "timeout");
  assert.ok(Date.now() - started < 5000);
  assert.ok(runs.at(-1)!.signal.aborted);
});
await check("a program nobody registered has no trial", async () => {
  assert.equal(await service.probeEngine("ghost", ""), null);
});

console.log("\nThe routes\n");

await check("the list is answered with what the screen needs", async () => {
  const body = await json(await enginesRoute.GET(request("/api/engines?project=p1")));
  assert.equal(body?.available, true);
  assert.equal(body?.engines?.[0]?.id, "fake");
  assert.equal(body?.choice, null);
  const orchestrator = await json(await enginesRoute.GET(request("/api/engines?project=none")));
  assert.equal(orchestrator?.choice, null);
});
await check("changing a choice needs a session of this site, written as JSON", async () => {
  const body = { project: "p1", engine: "fake", confirm: true };
  assert.equal((await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body, cookie: null }))).status, 401);
  assert.equal((await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body, cookie: stockSession }))).status, 401);
  for (const origin of ["https://evil.example.test", "null"]) {
    assert.equal((await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body, origin }))).status, 403, origin);
  }
  assert.equal((await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body, site: "cross-site" }))).status, 403);
  assert.equal((await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body, contentType: "text/plain" }))).status, 415);
  assert.equal(await store.readEngineChoice("p1"), null, "none of those may have changed anything");
});
await check("a body that names no program is refused, and one that needs the confirmation says so", async () => {
  assert.equal((await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body: "not json" }))).status, 400);
  assert.equal((await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body: { project: "p1" } }))).status, 400);
  const response = await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body: { project: "p1", engine: "fake" } }));
  assert.equal(response.status, 409);
  assert.equal((await json(response))?.error, "consent-required");
});
await check("confirmed, the choice is saved and the answer shows it", async () => {
  const response = await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body: { project: "p1", engine: "fake", model: "fast", access: "project", confirm: true } }));
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body?.choice?.engine, "fake");
  assert.equal(body?.choice?.model, "fast");
  const list = await json(await enginesRoute.GET(request("/api/engines?project=p1")));
  assert.equal(list?.choice?.engine, "fake");
});
await check("a program is turned off with null, and a model it lacks is a 400", async () => {
  const bad = await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body: { project: "p1", engine: "fake", model: "nope", confirm: true } }));
  assert.equal(bad.status, 400);
  const off = await choiceRoute.PUT(request("/api/engines/choice", { method: "PUT", body: { project: "p1", engine: null } }));
  assert.equal(off.status, 200);
  assert.equal((await json(off))?.choice, null);
});
await check("signing in and the trial request need the same guard", async () => {
  assert.equal((await loginRoute.POST(request("/api/engines/fake/login", { method: "POST", body: {}, cookie: null }), idParams("fake"))).status, 401);
  assert.equal((await loginRoute.POST(request("/api/engines/fake/login", { method: "POST", body: {}, origin: "https://evil.example.test" }), idParams("fake"))).status, 403);
  assert.equal((await probeRoute.POST(request("/api/engines/fake/probe", { method: "POST", body: {}, cookie: null }), idParams("fake"))).status, 401);
  assert.equal((await probeRoute.POST(request("/api/engines/fake/probe", { method: "POST", body: "x", contentType: "text/plain" }), idParams("fake"))).status, 415);
});
await check("the login route starts it, and a second press and a cancel are told apart", async () => {
  const first = await loginRoute.POST(request("/api/engines/fake/login", { method: "POST", body: {} }), idParams("fake"));
  assert.deepEqual(await json(first), { started: true, already: false });
  const second = await loginRoute.POST(request("/api/engines/fake/login", { method: "POST", body: {} }), idParams("fake"));
  assert.deepEqual(await json(second), { started: true, already: true });
  const cancel = await loginRoute.DELETE(request("/api/engines/fake/login", { method: "DELETE", body: {} }), idParams("fake"));
  assert.deepEqual(await json(cancel), { cancelled: true });
  const unknown = await loginRoute.POST(request("/api/engines/ghost/login", { method: "POST", body: {} }), idParams("ghost"));
  assert.equal(unknown.status, 404);
});
await check("the trial route answers with what the program said", async () => {
  const ok = await probeRoute.POST(request("/api/engines/fake/probe", { method: "POST", body: {} }), idParams("fake"));
  assert.equal(ok.status, 200);
  assert.deepEqual(await json(ok), { ok: true, text: "OK" });
  const unknown = await probeRoute.POST(request("/api/engines/ghost/probe", { method: "POST", body: {} }), idParams("ghost"));
  assert.equal(unknown.status, 404);
});

console.log("\nWhen the cloud hands a chat to a computer whose program cannot take it\n");

process.env.EGGENT_REMOTE_NODE = "device:AAAAAAA-BBBBBBB";
process.env.EGGENT_REMOTE_RELAY_URL = "http://127.0.0.1:9";
process.env.EGGENT_REMOTE_RELAY_TOKEN = "test-token";
process.env.EGGENT_REMOTE_COVER_WAIT_SECONDS = "1";

function relayed(extra: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/chat`, { method: "POST", headers: { "x-eggent-relayed": "1", "x-eggent-from": "cloud", ...extra } });
}
await check("a project set to a program that is signed out is refused, with the reason and the way out", async () => {
  await service.applyEngineChoice("p1", { engine: "fake", confirm: true });
  status = { state: "signed-out" };
  registry.forgetEngineStatus("fake");
  const prep = await prepareRelayedTurn(relayed(), { chatId: "c-1", projectId: "p1" });
  assert.equal(prep.ok, false);
  if (prep.ok) return;
  assert.equal(prep.response.status, 409);
  const body = await json(prep.response);
  assert.equal(body?.code, "engine");
  assert.equal(body?.home, "cloud");
  assert.match(String(body?.error), /Fake Code is not signed in/);
  assert.doesNotMatch(String(body?.error), /can't run this chat/, "the side that asked puts the computer's name in front");
});
await check("the side that asked says it in its own words, with the name of that computer", async () => {
  const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate("en", key, values);
  const failure = new RemoteError("engine", "Fake Code is not signed in there.", { home: "device:AAAAAAA-BBBBBBB" });
  const text = remoteFailureMessage(failure, t, "Ilia's Mac");
  assert.match(text, /^Ilia's Mac can't run this chat right now\. Fake Code is not signed in there\./);
  assert.match(text, /run this chat here instead/);
});
await check("the screen offers to run it on this side instead", () => {
  const failure = parseHandoverFailure(new Error(JSON.stringify({ error: "x", code: "engine", home: "cloud" })));
  assert.ok(failure);
  assert.equal(failure!.code, "engine");
  assert.equal(canRunHereInstead(failure!), true);
});
await check("a project that is not on a program is not asked about one", async () => {
  await projectStore.createProject({ id: "p2", name: "Two", description: "", instructions: "", memoryMode: "isolated" } as never);
  const prep = await prepareRelayedTurn(relayed(), { chatId: "c-2", projectId: "p2" });
  // It goes on to wait for files it was never told about; what matters is that it was not the program that stopped it.
  if (!prep.ok) assert.notEqual((await json(prep.response))?.code, "engine");
});
await check("once the program is back, the same chat is let in", async () => {
  status = { state: "ready", version: "1.2.3", account: "Max" };
  registry.forgetEngineStatus("fake");
  const prep = await prepareRelayedTurn(relayed(), { chatId: "c-3", projectId: "p1" });
  if (!prep.ok) assert.notEqual((await json(prep.response))?.code, "engine");
});

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
