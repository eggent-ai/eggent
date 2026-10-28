/**
 * Checks the limits a deployment's usage provider may set on scheduled tasks.
 *
 * Run with Node 22: npm run test:schedule-limits
 *
 * A recurring task wakes the workspace and starts a model turn every time it
 * fires, so a deployment may say how many such tasks a workspace keeps and how
 * often each runs. What must hold, whatever the numbers:
 *
 * - without a provider (a workspace on its own server) there are no limits;
 * - a refusal is the provider's own sentence and link, never a reason of ours;
 * - one-time reminders are not counted, though no more than 20 may wait at once;
 * - only what is being added is judged: a task already on is never switched
 *   off, and its wording can always be changed.
 *
 * The rules are tested on their own, then through the real schedule manager
 * against tasks on disk and a stand-in provider over HTTP.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Real path: the project store resolves against process.cwd(), which macOS reports under /private.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "eggent-schedule-limits-")));
await fs.mkdir(path.join(root, "data", "projects"), { recursive: true });
process.chdir(root);
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
delete process.env.EGGENT_USAGE_API_URL;
delete process.env.EGGENT_USAGE_API_TOKEN;

const limitsModule = await import("../src/lib/pi/schedule-limits.ts");
const { judgeScheduleChange, scheduleGapMs, scheduleLimitRefusal, MAX_PENDING_ONE_TIME } = limitsModule;
const { parseUsageSnapshot, clearUsageSnapshotCache } = await import("../src/lib/usage/usage-provider.ts");
const { checkNewScheduleLimits, managePiSchedules, workspaceScheduleJobs } = await import("../src/lib/pi/schedule-host.ts");
// The same stand-in the schedule manager is given for the project store.
const { createProject } = await import("./stubs/project-store.ts");

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

const HOUR = 60 * 60_000;
const LIMITS = {
  schedules: 2,
  scheduleMinMinutes: 60,
  notes: {
    schedules: "Two recurring tasks are included here.",
    scheduleMinMinutes: "Here a task runs at most once an hour.",
  },
  manage: { url: "https://account.example.test/limits", label: "Options" },
};
const daily = (id: string, extra: Record<string, unknown> = {}) => ({ id, schedule: "0 0 9 * * *", scheduleType: "cron", enabled: true, ...extra });
const later = (id: string, hours = 2) => ({ id, schedule: new Date(Date.now() + hours * HOUR).toISOString(), scheduleType: "once", enabled: true });

console.log("The rules\n");

await check("a cron's gap is its shortest one, not its first", () => {
  assert.equal(scheduleGapMs({ schedule: "0 */30 * * * *", scheduleType: "cron" }), 30 * 60_000);
  assert.equal(scheduleGapMs({ schedule: "0 0,5 9 * * *", scheduleType: "cron" }), 5 * 60_000);
  assert.equal(scheduleGapMs({ schedule: "0 0 9 * * *", scheduleType: "cron" }), 24 * HOUR);
  assert.equal(scheduleGapMs({ schedule: "30m", scheduleType: "interval", intervalMs: 30 * 60_000 }), 30 * 60_000);
  assert.equal(scheduleGapMs({ schedule: "+10m", scheduleType: "once" }), null);
  assert.equal(scheduleGapMs({ schedule: "not a cron", scheduleType: "cron" }), null);
});

await check("no limits, no refusals", () => {
  const others = [daily("a"), daily("b"), daily("c")];
  for (const limits of [null, undefined, {}]) {
    assert.equal(judgeScheduleChange({ limits, others, after: { schedule: "0 * * * * *", scheduleType: "cron" }, timingChanged: true }), null);
  }
});

await check("a new recurring task past the count is refused, and a one-time one is not", () => {
  const others = [daily("a"), daily("b")];
  assert.equal(judgeScheduleChange({ limits: LIMITS, others, after: daily("new"), timingChanged: true }), "schedules");
  assert.equal(judgeScheduleChange({ limits: LIMITS, others, after: later("soon"), timingChanged: true }), null);
  assert.equal(judgeScheduleChange({ limits: LIMITS, others: [daily("a")], after: daily("new"), timingChanged: true }), null);
});

await check("tasks that are off, and one-time ones, take no place", () => {
  const others = [daily("a"), daily("b", { enabled: false }), later("c"), later("d")];
  assert.equal(judgeScheduleChange({ limits: LIMITS, others, after: daily("new"), timingChanged: true }), null);
});

await check("more often than the interval is refused, at it or less often is not", () => {
  const judge = (schedule: string, scheduleType = "cron", intervalMs?: number) =>
    judgeScheduleChange({ limits: LIMITS, others: [], after: { schedule, scheduleType, intervalMs }, timingChanged: true });
  assert.equal(judge("0 */30 * * * *"), "scheduleMinMinutes");
  assert.equal(judge("0 0,5 9 * * *"), "scheduleMinMinutes", "twice in five minutes is five minutes apart");
  assert.equal(judge("30m", "interval", 30 * 60_000), "scheduleMinMinutes");
  assert.equal(judge("0 0 * * * *"), null);
  assert.equal(judge("60m", "interval", HOUR), null);
});

await check(`no more than ${MAX_PENDING_ONE_TIME} one-time tasks wait at once`, () => {
  const waiting = Array.from({ length: MAX_PENDING_ONE_TIME }, (_, index) => later(`r${index}`));
  assert.equal(judgeScheduleChange({ limits: LIMITS, others: waiting, after: later("one-more"), timingChanged: true }), "pendingOnce");
  assert.equal(judgeScheduleChange({ limits: LIMITS, others: waiting.slice(1), after: later("one-more"), timingChanged: true }), null);
  const past = waiting.map((job) => ({ ...job, schedule: new Date(Date.now() - HOUR).toISOString() }));
  assert.equal(judgeScheduleChange({ limits: LIMITS, others: past, after: later("one-more"), timingChanged: true }), null, "fired ones do not wait");
  assert.equal(
    judgeScheduleChange({ limits: LIMITS, others: waiting.slice(1), before: waiting[0], after: later("r0", 5), timingChanged: true }),
    null,
    "moving one that already waits adds nothing"
  );
});

await check("a task already on is judged only on a new timing", () => {
  const over = [daily("a"), daily("b"), daily("c")];
  // Wording changed, nothing else: allowed however far over the count the workspace is.
  assert.equal(judgeScheduleChange({ limits: LIMITS, others: over, before: daily("d"), after: daily("d"), timingChanged: false }), null);
  // A new daily time for it: still one task, still allowed.
  assert.equal(judgeScheduleChange({ limits: LIMITS, others: over, before: daily("d"), after: daily("d", { schedule: "0 0 18 * * *" }), timingChanged: true }), null);
  // Made to run every ten minutes: refused.
  assert.equal(
    judgeScheduleChange({ limits: LIMITS, others: over, before: daily("d"), after: daily("d", { schedule: "0 */10 * * * *" }), timingChanged: true }),
    "scheduleMinMinutes"
  );
  // A task that ran too often before the limit existed keeps doing so while its words change.
  const frequent = daily("e", { schedule: "0 */5 * * * *" });
  assert.equal(judgeScheduleChange({ limits: LIMITS, others: [], before: frequent, after: frequent, timingChanged: false }), null);
});

await check("switching a task back on is judged like adding it", () => {
  const paused = daily("p", { enabled: false });
  assert.equal(judgeScheduleChange({ limits: LIMITS, others: [daily("a"), daily("b")], before: paused, after: { ...paused, enabled: true }, timingChanged: false }), "schedules");
  assert.equal(judgeScheduleChange({ limits: LIMITS, others: [daily("a")], before: paused, after: { ...paused, enabled: true }, timingChanged: false }), null);
  const pausedFrequent = daily("q", { enabled: false, schedule: "0 */5 * * * *" });
  assert.equal(
    judgeScheduleChange({ limits: LIMITS, others: [], before: pausedFrequent, after: { ...pausedFrequent, enabled: true }, timingChanged: false }),
    "scheduleMinMinutes"
  );
  // Switching one off is never refused.
  assert.equal(judgeScheduleChange({ limits: LIMITS, others: [daily("a"), daily("b"), daily("c")], before: daily("d"), after: daily("d", { enabled: false }), timingChanged: false }), null);
});

await check("the refusal is the provider's sentence and link, or the number said plainly", () => {
  assert.equal(scheduleLimitRefusal("schedules", LIMITS), "Two recurring tasks are included here. Options: https://account.example.test/limits");
  assert.equal(scheduleLimitRefusal("scheduleMinMinutes", LIMITS), "Here a task runs at most once an hour. Options: https://account.example.test/limits");
  const bare = scheduleLimitRefusal("scheduleMinMinutes", { scheduleMinMinutes: 15 });
  assert.match(bare, /at most once every 15 minutes/);
  assert.match(scheduleLimitRefusal("schedules", { schedules: 5 }), /at most 5 recurring tasks/);
  assert.match(scheduleLimitRefusal("pendingOnce", LIMITS), /At most 20 one-time tasks/);
  assert.doesNotMatch(scheduleLimitRefusal("pendingOnce", LIMITS), /example\.test/, "the one-time cap is not the provider's to explain");
});

console.log("\nReading the provider's snapshot\n");

await check("limits are read, and a snapshot that has only limits is still a snapshot", () => {
  const snapshot = parseUsageSnapshot({ limits: { ...LIMITS, extra: "dropped" } });
  assert.deepEqual(snapshot?.limits, LIMITS);
});

await check("a limit that is not a sane number is no limit", () => {
  const snapshot = parseUsageSnapshot({
    meters: [{ id: "ai", label: "AI", used: 1, limit: 2 }],
    limits: { schedules: -1, scheduleMinMinutes: 0, notes: { schedules: "ignored" } },
  });
  assert.equal(snapshot?.limits, undefined);
  assert.equal(parseUsageSnapshot({ meters: [{ id: "ai", label: "AI", used: 1, limit: 2 }], limits: { schedules: "5" } })?.limits, undefined);
  assert.equal(parseUsageSnapshot({ limits: { schedules: 2.7 } })?.limits?.schedules, 2);
  assert.equal(parseUsageSnapshot({ limits: { schedules: 0 } })?.limits?.schedules, 0, "none allowed is a limit too");
});

await check("the link must be http(s), and falls back to the snapshot's own", () => {
  const own = parseUsageSnapshot({
    manage: { url: "https://account.example.test/home", label: "Account" },
    limits: { schedules: 3, manage: { url: "javascript:alert(1)", label: "x" } },
  });
  assert.deepEqual(own?.limits?.manage, { url: "https://account.example.test/home", label: "Account" });
  const notes = parseUsageSnapshot({ limits: { schedules: 3, notes: { schedules: `  ${"long ".repeat(100)} ` } } });
  assert.equal(notes?.limits?.notes?.schedules?.length, 300);
});

console.log("\nThrough the schedule manager\n");

// The stand-in provider: whatever `served` holds is the snapshot.
let served: unknown = { meters: [{ id: "ai", label: "AI", used: 1, limit: 2 }] };
const provider = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(served));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/usage`;
function serve(snapshot: unknown): void {
  served = snapshot;
  clearUsageSnapshotCache();
}

const orchestratorStore = path.join(root, "data", "projects", ".pi", "subagent-schedules", "chat-o.json");
await createProject({ id: "flats", name: "Flats", description: "", instructions: "", memoryMode: "global" });
const projectDir = path.join(root, "data", "projects", "flats");
const projectStore = path.join(projectDir, ".pi", "subagent-schedules", "chat-p.json");

async function seed(file: string, jobs: Array<Record<string, unknown>>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, jobs }, null, 2));
}
const jobsIn = async (file: string) => JSON.parse(await fs.readFile(file, "utf-8")).jobs as Array<Record<string, unknown>>;

/** The live scheduler of the project's store, as a turn in its own chat holds it. */
const projectSession = {
  sessionId: "chat-p",
  sessionManager: { getSessionId: () => "chat-p", getCwd: () => projectDir },
  isIdle: true,
  async reload() {},
};

await seed(orchestratorStore, [daily("morning")]);
await seed(projectStore, [daily("flats-hourly", { schedule: "0 0 * * * *" }), daily("flats-paused", { enabled: false })]);

await check("without a provider nothing is limited", async () => {
  assert.equal(await checkNewScheduleLimits("0 */5 * * * *"), null);
  const result = await managePiSchedules({ action: "update", scope: "all", jobId: "flats-paused", enabled: true, currentSession: projectSession as never }) as Record<string, unknown>;
  assert.equal(result.updated, true, JSON.stringify(result));
  await managePiSchedules({ action: "update", scope: "all", jobId: "flats-paused", enabled: false, currentSession: projectSession as never });
});

process.env.EGGENT_USAGE_API_URL = providerUrl;

await check("a provider that sets no limits limits nothing", async () => {
  serve({ meters: [{ id: "ai", label: "AI", used: 1, limit: 2 }] });
  assert.equal(await checkNewScheduleLimits("0 */5 * * * *"), null);
});

serve({ meters: [{ id: "ai", label: "AI", used: 1, limit: 2 }], manage: { url: "https://account.example.test/home", label: "Account" }, limits: LIMITS });

await check("a new task is counted against every chat and project in the workspace", async () => {
  assert.equal((await workspaceScheduleJobs()).length, 3);
  const refusal = await checkNewScheduleLimits("0 0 18 * * *");
  assert.equal(refusal, "Two recurring tasks are included here. Options: https://account.example.test/limits");
});

await check("a new task more often than the interval is refused with the provider's words", async () => {
  assert.equal(await checkNewScheduleLimits("30m"), "Here a task runs at most once an hour. Options: https://account.example.test/limits");
});

await check("a one-time reminder is still accepted", async () => {
  assert.equal(await checkNewScheduleLimits("+10m"), null);
});

await check("switching a paused task back on is refused past the count, and it stays off", async () => {
  const result = await managePiSchedules({ action: "update", scope: "current", cwd: projectDir, jobId: "flats-paused", enabled: true, currentSession: projectSession as never }) as Record<string, unknown>;
  assert.equal(result.updated, false, JSON.stringify(result));
  assert.equal(result.limited, "schedules");
  assert.equal(result.error, "Two recurring tasks are included here. Options: https://account.example.test/limits");
  assert.equal((await jobsIn(projectStore)).find((job) => job.id === "flats-paused")?.enabled, false);
});

await check("a task already on can be reworded and retimed within the interval", async () => {
  const reworded = await managePiSchedules({ action: "update", scope: "all", jobId: "flats-hourly", prompt: "Check the flats.", currentSession: projectSession as never }) as Record<string, unknown>;
  assert.equal(reworded.updated, true, JSON.stringify(reworded));
  const retimed = await managePiSchedules({ action: "update", scope: "all", jobId: "flats-hourly", schedule: "0 0 */2 * * *", currentSession: projectSession as never }) as Record<string, unknown>;
  assert.equal(retimed.updated, true, JSON.stringify(retimed));
});

await check("but not made to run more often than the interval", async () => {
  const result = await managePiSchedules({ action: "update", scope: "all", jobId: "flats-hourly", schedule: "0 */15 * * * *", currentSession: projectSession as never }) as Record<string, unknown>;
  assert.equal(result.updated, false, JSON.stringify(result));
  assert.equal(result.limited, "scheduleMinMinutes");
  assert.equal((await jobsIn(projectStore)).find((job) => job.id === "flats-hourly")?.schedule, "0 0 */2 * * *");
});

await check("tasks over a limit that shrank are left running, and can still be reworded", async () => {
  serve({ meters: [{ id: "ai", label: "AI", used: 1, limit: 2 }], limits: { ...LIMITS, schedules: 1 } });
  const result = await managePiSchedules({ action: "update", scope: "all", jobId: "flats-hourly", prompt: "Check the flats again.", currentSession: projectSession as never }) as Record<string, unknown>;
  assert.equal(result.updated, true, JSON.stringify(result));
  const enabled = (await workspaceScheduleJobs()).filter((job) => job.enabled !== false).map((job) => job.id).sort();
  assert.deepEqual(enabled, ["flats-hourly", "morning"]);
});

await check("twenty waiting reminders are the most", async () => {
  serve({ meters: [{ id: "ai", label: "AI", used: 1, limit: 2 }], limits: LIMITS });
  await seed(path.join(root, "data", "projects", ".pi", "subagent-schedules", "chat-r.json"),
    Array.from({ length: MAX_PENDING_ONE_TIME }, (_, index) => later(`reminder-${index}`)));
  assert.match(String(await checkNewScheduleLimits("+10m")), /At most 20 one-time tasks/);
});

await check("a provider that cannot be reached limits nothing", async () => {
  process.env.EGGENT_USAGE_API_URL = "http://127.0.0.1:9/usage";
  clearUsageSnapshotCache();
  assert.equal(await checkNewScheduleLimits("0 */5 * * * *"), null);
});

provider.close();
process.chdir(os.tmpdir());
await fs.rm(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
