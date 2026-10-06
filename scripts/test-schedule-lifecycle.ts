/**
 * A schedule's timers, end to end: the real runtime, the real pi-subagents
 * extension, a stub provider.
 *
 * Two faults this exists for, both found on a workspace whose
 * schedules kept disappearing:
 *
 * - A disposed session's schedule went on firing. dispose() never tells the
 *   extensions the session is over, and pi-subagents stops its timers on
 *   session_shutdown alone, so the orphan went off on time, rewrote its store
 *   from disk and threw "extension ctx is stale" into the log.
 * - A reload stopped a session's schedules and armed nothing in their place
 *   when the session was bound with nothing but `mode` - which is every
 *   session restored at boot. Clearing and updating a job re-arm by reloading.
 *
 * Every job here asks for worktree isolation in a directory that is not a git
 * repository, so each firing reaches the spawn and fails there: no helper ever
 * runs, nothing is left in flight, and a firing is visible either as the
 * scheduler's own event (a live session) or as the stale-context error (an
 * orphan).
 *
 * Needs an installed copy of @tintinweb/pi-subagents. EGGENT_SUBAGENTS_EXTENSIONS
 * takes a comma-separated list of package directories; without it the usual
 * install locations are tried, and the test is skipped when none is there.
 * No network, no credential.
 *
 * Run with Node 22: npm run test:schedule-lifecycle
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { logExtensionError, ownsScheduleStore, shutdownSessionExtensions } from "../src/lib/pi/session-lifecycle.ts";

let failed = 0;
let ran = 0;
function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const PROVIDER = "stub";
const MODEL = "stub-model";
const INTERVAL_MS = 400;
const WATCH_MS = 1_600;

function extensionCandidates(): string[] {
  const fromEnv = (process.env.EGGENT_SUBAGENTS_EXTENSIONS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return [
    "/opt/eggent-pi-seed/node_modules/@tintinweb/pi-subagents",
    path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@tintinweb", "pi-subagents"),
  ].filter((candidate) => fs.existsSync(path.join(candidate, "package.json"))).slice(0, 1);
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const provider = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    res.write(chunk({ content: "ok" }));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-schedule-lifecycle-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "work");
fs.mkdirSync(agentDir);
fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    [PROVIDER]: {
      name: "Stub",
      baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      api: "openai-completions",
      models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 32768, maxTokens: 2048 }],
    },
  },
}, null, 2));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }, null, 2));

const runtime = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: path.join(agentDir, "models.json"),
});
const registry = new ModelRegistry(runtime);
await registry.refresh();
const model = registry.getAll().find((entry) => entry.provider === PROVIDER && entry.id === MODEL);

/** Every firing a live scheduler reports, by session tag and job. */
const firings: Array<{ tag: string; jobId: string; at: number }> = [];
/** What an orphaned timer throws when it goes off into a disposed session. */
const staleErrors: number[] = [];
const otherErrors: string[] = [];
const onStray = (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/ctx is stale/i.test(message)) staleErrors.push(Date.now());
  else otherErrors.push(message.slice(0, 200));
};
process.on("uncaughtException", onStray);
process.on("unhandledRejection", onStray);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}
const firingsOf = (tag: string, jobId: string, since = 0) =>
  firings.filter((entry) => entry.tag === tag && entry.jobId === jobId && entry.at >= since).length;
const staleSince = (since: number) => staleErrors.filter((at) => at >= since).length;

function job(id: string) {
  return {
    id,
    name: `job ${id}`,
    description: `job ${id}`,
    schedule: `${INTERVAL_MS}ms`,
    scheduleType: "interval",
    intervalMs: INTERVAL_MS,
    subagent_type: "general-purpose",
    prompt: "Say ok.",
    isolation: "worktree",
    enabled: true,
    createdAt: new Date().toISOString(),
    runCount: 0,
  };
}

const storeFile = (session: AgentSession) =>
  path.join(cwd, ".pi", "subagent-schedules", `${session.sessionId}.json`);

function writeStore(session: AgentSession, jobs: Array<ReturnType<typeof job>>): void {
  fs.mkdirSync(path.dirname(storeFile(session)), { recursive: true });
  fs.writeFileSync(storeFile(session), JSON.stringify({ version: 1, jobs }, null, 2));
}

async function openSession(
  extensionDir: string,
  tag: string,
  jobs: Array<ReturnType<typeof job>>,
  binding: "eggent" | "mode-only"
): Promise<AgentSession> {
  const listener = {
    name: `test-schedule-listener-${tag}`,
    factory: (pi: ExtensionAPI) => {
      pi.events.on("subagents:scheduled", (event: unknown) => {
        const record = event as { type?: string; jobId?: string };
        if ((record.type === "fired" || record.type === "error") && record.jobId) {
          firings.push({ tag, jobId: record.jobId, at: Date.now() });
        }
      });
    },
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [extensionDir],
    extensionFactories: [listener],
    noSkills: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  writeStore(session, jobs);
  // What session.ts binds - `mode` plus the error listener - against what a
  // session restored at boot used to get: `mode` alone.
  await session.bindExtensions(binding === "eggent" ? { mode: "rpc", onError: logExtensionError } : { mode: "rpc" });
  return session;
}

const candidates = extensionCandidates();
if (!candidates.length) {
  console.log("Schedule lifecycle: skipped - no copy of @tintinweb/pi-subagents found (set EGGENT_SUBAGENTS_EXTENSIONS).");
  process.exit(0);
}

for (const extensionDir of candidates) {
  const version = (JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf-8")) as { version?: string }).version;
  console.log(`Schedule lifecycle, pi-subagents ${version ?? "?"}\n`);

  // A clear takes one job out of the store and reloads the session that armed it.
  const kept = await openSession(extensionDir, `kept-${version}`, [job("k-1"), job("k-2")], "eggent");
  const bothFired = await waitFor(() => firingsOf(`kept-${version}`, "k-1") > 0 && firingsOf(`kept-${version}`, "k-2") > 0, 5_000);
  check("both jobs of a session fire", () => assert.ok(bothFired, JSON.stringify(firings)));
  writeStore(kept, [job("k-2")]);
  await kept.reload();
  const afterReload = Date.now();
  await sleep(WATCH_MS);
  check("after the reload the job taken out of the store is silent", () => {
    assert.equal(firingsOf(`kept-${version}`, "k-1", afterReload), 0);
  });
  check("...and the job left in it goes on firing", () => {
    assert.ok(firingsOf(`kept-${version}`, "k-2", afterReload) >= 2, String(firingsOf(`kept-${version}`, "k-2", afterReload)));
  });
  await shutdownSessionExtensions(kept);
  kept.dispose();

  // Why session.ts binds an error listener: with `mode` alone the SDK does not
  // emit session_start again after a reload, and nothing re-arms the schedule.
  const bare = await openSession(extensionDir, `bare-${version}`, [job("b-1")], "mode-only");
  const bareFired = await waitFor(() => firingsOf(`bare-${version}`, "b-1") > 0, 5_000);
  check("a session bound with mode alone fires before a reload", () => assert.ok(bareFired));
  await bare.reload();
  const afterBareReload = Date.now();
  await sleep(WATCH_MS);
  check("...and nothing after it: a reload re-arms only a session with more bindings", () => {
    assert.equal(firingsOf(`bare-${version}`, "b-1", afterBareReload), 0);
  });
  bare.dispose();

  // Shut down first, as session.ts now does for a session that owns a store.
  const released = await openSession(extensionDir, `released-${version}`, [job("r-1")], "eggent");
  await waitFor(() => firingsOf(`released-${version}`, "r-1") > 0, 5_000);
  check("a session that owns a schedule is recognised as one", () => assert.ok(ownsScheduleStore(released)));
  await shutdownSessionExtensions(released);
  released.dispose();
  const afterRelease = Date.now();
  const storeAtRelease = fs.readFileSync(storeFile(released), "utf-8");
  await sleep(WATCH_MS);
  check("shut down first, the schedule stops with the session", () => {
    assert.equal(staleSince(afterRelease), 0, "an orphaned timer went off");
    assert.equal(fs.readFileSync(storeFile(released), "utf-8"), storeAtRelease, "the store was rewritten after the session ended");
  });

  // The fault itself, last: the orphan goes on firing until the process ends.
  const orphaned = await openSession(extensionDir, `orphaned-${version}`, [job("o-1")], "eggent");
  await waitFor(() => firingsOf(`orphaned-${version}`, "o-1") > 0, 5_000);
  orphaned.dispose();
  const afterDispose = Date.now();
  const storeAtDispose = fs.readFileSync(storeFile(orphaned), "utf-8");
  await sleep(WATCH_MS);
  check("disposed alone, the timer goes on firing into the dead session", () => {
    assert.ok(staleSince(afterDispose) >= 1, "no stale-context error after dispose");
    assert.notEqual(fs.readFileSync(storeFile(orphaned), "utf-8"), storeAtDispose, "the orphan did not touch its store");
  });
}

check("nothing else went wrong", () => assert.deepEqual(otherErrors, []));

console.log(`\n${ran} checks, ${failed} failed`);
provider.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
