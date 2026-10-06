/**
 * Checks what an update to a scheduled task is allowed to change.
 *
 * Run with Node 22:
 *   EGGENT_TEST_STUBS=lib/storage/project-store node --experimental-strip-types \
 *     --import ./scripts/alias-loader-register.mjs scripts/test-schedule-update.ts
 *
 * Only the timing could be changed, so asking to reword a daily reminder got
 * "the tool can only change the time of an existing schedule" - true of the
 * tool, useless to the person, and the work then had to be deleted and made
 * again from scratch.
 *
 * Two things matter beyond the text landing in the file: the execution
 * directive has to survive (without it a fired job re-schedules itself instead
 * of working), and editing the text must not move the clock - re-parsing a
 * stored "+10m" would push a one-shot ten minutes into the future every time
 * somebody fixed a typo.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-schedule-update-"));
await fs.mkdir(path.join(workDir, "data", "projects"), { recursive: true });
process.chdir(workDir);

const { managePiSchedules, retainPiScheduleSession, takeRetainedPiScheduleSession } = await import("../src/lib/pi/schedule-host.ts");
const { SCHEDULE_EXECUTION_MARKER } = await import("../src/lib/pi/schedule-policy.ts");

const storeDir = path.join(workDir, ".pi", "subagent-schedules");
const storePath = path.join(storeDir, "chat-1.json");

/** A live scheduler session is required before an update is accepted. */
function fakeSession() {
  let reloads = 0;
  return {
    get reloads() {
      return reloads;
    },
    sessionId: "chat-1",
    sessionManager: {
      getSessionId: () => "chat-1",
      getCwd: () => workDir,
    },
    async reload() {
      reloads += 1;
    },
  };
}

async function seed(job: Record<string, unknown>): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ jobs: [job] }, null, 2));
}

const readJob = async () => JSON.parse(await fs.readFile(storePath, "utf-8")).jobs[0];

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("Updating a scheduled task\n");

const BASE = {
  id: "job-1",
  name: "Evening reminder",
  schedule: "0 40 21 * * *",
  scheduleType: "cron",
  subagent_type: "general-purpose",
  prompt: `${SCHEDULE_EXECUTION_MARKER} do not reschedule\n\nScheduled work:\nSend the single most important task.`,
  enabled: true,
  nextRun: "2099-01-01T00:00:00.000Z",
};

await check("the instructions can be changed on their own", async () => {
  await seed({ ...BASE });
  const session = fakeSession();
  const result = await managePiSchedules({
    action: "update",
    scope: "current",
    cwd: workDir,
    jobId: "job-1",
    prompt: "Send between one and three unfinished tasks.",
    currentSession: session as never,
  });
  assert.equal((result as { updated?: boolean }).updated, true, JSON.stringify(result));
  const job = await readJob();
  assert.match(job.prompt, /between one and three/);
  assert.ok(!/single most important/.test(job.prompt), "the old text must be gone, not appended");
  assert.ok(job.prompt.startsWith(SCHEDULE_EXECUTION_MARKER), "the execution directive must survive");
  // Updating from inside the turn that asked for it defers the re-arm: reloading
  // a session mid-turn would disrupt the very conversation doing the asking.
  // retainPiScheduleSession() drains the request when the turn ends, and until
  // it does the live scheduler still holds the old text.
  assert.equal((result as { rearmed?: unknown }).rearmed, "after_current_turn");
  assert.equal(session.reloads, 0, "not while the turn is still running");
});

await check("changing the text leaves the timing exactly as it was", async () => {
  await seed({ ...BASE, schedule: "+10m", scheduleType: "once", nextRun: "2099-01-01T00:00:00.000Z" });
  await managePiSchedules({
    action: "update", scope: "current", cwd: workDir, jobId: "job-1",
    prompt: "New wording.", currentSession: fakeSession() as never,
  });
  const job = await readJob();
  assert.equal(job.schedule, "+10m", "a relative one-shot must not be re-parsed into ten minutes from now");
  assert.equal(job.nextRun, "2099-01-01T00:00:00.000Z");
  assert.equal(job.scheduleType, "once");
});

await check("the timing can still be changed on its own", async () => {
  await seed({ ...BASE });
  await managePiSchedules({
    action: "update", scope: "current", cwd: workDir, jobId: "job-1",
    schedule: "0 0 9 * * *", currentSession: fakeSession() as never,
  });
  const job = await readJob();
  assert.equal(job.schedule, "0 0 9 * * *");
  assert.match(job.prompt, /single most important/, "the instructions must be left alone");
});

await check("both at once", async () => {
  await seed({ ...BASE });
  await managePiSchedules({
    action: "update", scope: "current", cwd: workDir, jobId: "job-1",
    schedule: "0 0 9 * * *", prompt: "Something else entirely.", currentSession: fakeSession() as never,
  });
  const job = await readJob();
  assert.equal(job.schedule, "0 0 9 * * *");
  assert.match(job.prompt, /Something else entirely/);
});

await check("an update that asks for nothing is refused", async () => {
  await seed({ ...BASE });
  await assert.rejects(
    () => managePiSchedules({ action: "update", scope: "current", cwd: workDir, jobId: "job-1", currentSession: fakeSession() as never }),
    /new schedule, new prompt, or both/
  );
});

await check("the directive is not stacked when text is edited twice", async () => {
  await seed({ ...BASE });
  for (const text of ["First rewrite.", "Second rewrite."]) {
    await managePiSchedules({
      action: "update", scope: "current", cwd: workDir, jobId: "job-1",
      prompt: text, currentSession: fakeSession() as never,
    });
  }
  const job = await readJob();
  const occurrences = job.prompt.split(SCHEDULE_EXECUTION_MARKER).length - 1;
  assert.equal(occurrences, 1, `directive repeated ${occurrences} times`);
  assert.match(job.prompt, /Second rewrite/);
});

await check("clearing with a job id removes that job only", async () => {
  await fs.mkdir(storeDir, { recursive: true });
  const other = { ...BASE, id: "job-2", name: "Weekly cleanup" };
  await fs.writeFile(storePath, JSON.stringify({ jobs: [{ ...BASE }, other] }, null, 2));
  const result = await managePiSchedules({
    action: "clear", scope: "current", cwd: workDir, jobId: "job-1", currentSession: fakeSession() as never,
  });
  assert.equal((result as { count?: number }).count, 1, JSON.stringify(result));
  const jobs = JSON.parse(await fs.readFile(storePath, "utf-8")).jobs;
  assert.deepEqual(jobs.map((job: { id: string }) => job.id), ["job-2"]);
});

await check("clearing an unknown job id removes nothing and says so", async () => {
  await seed({ ...BASE });
  const result = await managePiSchedules({
    action: "clear", scope: "current", cwd: workDir, jobId: "nope", currentSession: fakeSession() as never,
  });
  assert.equal((result as { count?: number }).count, 0);
  assert.match(String((result as { error?: string }).error), /not found/);
  assert.equal((await readJob()).id, "job-1");
});

await check("clearing without a job id still removes everything in scope", async () => {
  await seed({ ...BASE });
  await managePiSchedules({ action: "clear", scope: "current", cwd: workDir, currentSession: fakeSession() as never });
  assert.deepEqual(JSON.parse(await fs.readFile(storePath, "utf-8")).jobs, []);
});

// What the live schedulers are told after a clear. Every chat's schedules
// share their project's directory - on one workspace all nine chats sat in the
// orchestrator's - and the Delete button clears with scope=all and no session
// of its own. A clear used to dispose every retained session in the directory:
// the other chats' jobs stayed listed and never fired again.
// process.cwd(), not workDir: the temporary directory is a symlink on some
// systems, and the host compares the directory the project store reports.
const orchestratorDir = path.join(process.cwd(), "data", "projects");
const orchestratorStores = path.join(orchestratorDir, ".pi", "subagent-schedules");

function retainedSession(sessionId: string) {
  const state = { reloads: 0, disposed: 0 };
  return {
    state,
    sessionId,
    isIdle: true,
    sessionManager: {
      getSessionId: () => sessionId,
      getCwd: () => orchestratorDir,
      getLeafId: () => null,
    },
    subscribe: () => () => undefined,
    async reload() {
      state.reloads += 1;
    },
    dispose() {
      state.disposed += 1;
    },
  };
}

async function seedChat(sessionId: string, ids: string[]): Promise<void> {
  await fs.mkdir(orchestratorStores, { recursive: true });
  const jobs = ids.map((id) => ({ ...BASE, id, name: `Job ${id}` }));
  await fs.writeFile(path.join(orchestratorStores, `${sessionId}.json`), JSON.stringify({ version: 1, jobs }, null, 2));
}

const chatJobs = async (sessionId: string) =>
  (JSON.parse(await fs.readFile(path.join(orchestratorStores, `${sessionId}.json`), "utf-8")).jobs as Array<{ id: string }>)
    .map((job) => job.id);

const pressDelete = (jobId: string) => managePiSchedules({ action: "clear", scope: "all", jobId });

await check("the Delete button re-arms the chat that held the job and leaves the others alone", async () => {
  await seedChat("chat-a", ["a-1", "a-2"]);
  await seedChat("chat-b", ["b-1"]);
  const a = retainedSession("chat-a");
  const b = retainedSession("chat-b");
  assert.equal(await retainPiScheduleSession({ chatId: "chat-a", session: a as never }), true);
  assert.equal(await retainPiScheduleSession({ chatId: "chat-b", session: b as never }), true);

  const result = await pressDelete("a-1");
  assert.equal((result as { count?: number }).count, 1, JSON.stringify(result));
  assert.deepEqual(await chatJobs("chat-a"), ["a-2"]);
  assert.deepEqual(await chatJobs("chat-b"), ["b-1"], "another chat's job must survive");
  assert.deepEqual(a.state, { reloads: 1, disposed: 0 }, "the chat that held it re-reads its store");
  assert.deepEqual(b.state, { reloads: 0, disposed: 0 }, "the other chat's scheduler is not touched");
});

await check("a chat whose last job goes is let go", async () => {
  await seedChat("chat-c", ["c-1"]);
  await seedChat("chat-d", ["d-1"]);
  const c = retainedSession("chat-c");
  const d = retainedSession("chat-d");
  await retainPiScheduleSession({ chatId: "chat-c", session: c as never });
  await retainPiScheduleSession({ chatId: "chat-d", session: d as never });
  await pressDelete("c-1");
  assert.deepEqual(await chatJobs("chat-c"), []);
  assert.deepEqual(c.state, { reloads: 0, disposed: 1 });
  assert.deepEqual(d.state, { reloads: 0, disposed: 0 });
});

await check("the turn that asked is re-armed when it ends, not under itself", async () => {
  await seedChat("chat-e", ["e-1", "e-2"]);
  const e = retainedSession("chat-e");
  await managePiSchedules({ action: "clear", scope: "all", jobId: "e-1", currentSession: e as never });
  assert.equal(e.state.reloads, 0);
  await retainPiScheduleSession({ chatId: "chat-e", session: e as never });
  assert.equal(e.state.reloads, 1);
  assert.deepEqual(await chatJobs("chat-e"), ["e-2"]);
});

await check("a chat in the middle of its own turn is re-armed when that turn ends", async () => {
  await seedChat("chat-f", ["f-1", "f-2"]);
  const f = retainedSession("chat-f");
  await retainPiScheduleSession({ chatId: "chat-f", session: f as never });
  assert.equal(takeRetainedPiScheduleSession("chat-f"), f as never);
  await pressDelete("f-1");
  assert.equal(f.state.reloads, 0, "not from under the turn");
  await retainPiScheduleSession({ chatId: "chat-f", session: f as never });
  assert.equal(f.state.reloads, 1);
});

await check("a scheduled run in progress is not cut off: the reload waits for it", async () => {
  await seedChat("chat-g", ["g-1", "g-2"]);
  const g = retainedSession("chat-g");
  await retainPiScheduleSession({ chatId: "chat-g", session: g as never });
  g.isIdle = false;
  await pressDelete("g-1");
  assert.equal(g.state.reloads, 0);
  g.isIdle = true;
  // The retained session is looked after every five seconds.
  await new Promise((resolve) => setTimeout(resolve, 5_600));
  assert.equal(g.state.reloads, 1);
  assert.equal(g.state.disposed, 0);
});

console.log(`\n${ran} checks, ${failed} failed`);
await fs.rm(workDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
