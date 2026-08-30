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

const { managePiSchedules } = await import("../src/lib/pi/schedule-host.ts");
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

console.log(`\n${ran} checks, ${failed} failed`);
await fs.rm(workDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
