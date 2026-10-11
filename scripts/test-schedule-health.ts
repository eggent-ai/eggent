/**
 * How a scheduled task's run of bad days is counted, and what the person is told.
 *
 * Pure rules first - what one more run does to the record - then the file they
 * are kept in. No network, no model. Run with Node 22:
 *   npm run test:schedule-health
 */
import assert from "node:assert/strict";
import fs from "node:fs";
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-schedule-health-"));
process.chdir(root);

const health = await import("../src/lib/pi/schedule-health.ts");
const runState = await import("../src/lib/pi/scheduled-run-state.ts");
const { judgeRun, healthLimits, recordRunOutcome, readJobHealth, forgetJobHealth, resetScheduleHealth, healthKey } = health;

const limits = { pauseAfterRefused: 3, pauseAfterFailed: 5 };
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 6, minutes));

console.log("What one more run does\n");

await check("a run that went well clears the record", () => {
  const verdict = judgeRun({ kind: "refused", streak: 2, lastAt: at(0).toISOString() }, "ok", { hasReport: true, limits });
  assert.equal(verdict.health.kind, null);
  assert.equal(verdict.health.streak, 0);
  assert.equal(verdict.pause, false);
  assert.equal(verdict.delivery, "report");
});

await check("the first refusal is delivered as the report it is", () => {
  const verdict = judgeRun(undefined, "refused", { hasReport: true, detail: "Limit reached", limits, now: at(1) });
  assert.equal(verdict.health.streak, 1);
  assert.equal(verdict.delivery, "report");
  assert.equal(verdict.pause, false);
});

await check("the second is kept quietly - the person has been told", () => {
  const first = judgeRun(undefined, "refused", { hasReport: true, limits, now: at(1) });
  const second = judgeRun(first.health, "refused", { hasReport: true, limits, now: at(2) });
  assert.equal(second.health.streak, 2);
  assert.equal(second.delivery, "silent");
  assert.equal(second.pause, false);
});

await check("the third pauses the task and says so", () => {
  let verdict = judgeRun(undefined, "refused", { hasReport: true, limits, now: at(1) });
  verdict = judgeRun(verdict.health, "refused", { hasReport: true, limits, now: at(2) });
  verdict = judgeRun(verdict.health, "refused", { hasReport: true, detail: "Still refused", limits, now: at(3) });
  assert.equal(verdict.pause, true);
  assert.equal(verdict.delivery, "pause-notice");
  assert.equal(verdict.health.streak, 3);
  assert.equal(verdict.health.detail, "Still refused");
});

await check("a failure with no report of its own is announced, one with a report is not", () => {
  assert.equal(judgeRun(undefined, "failed", { hasReport: false, limits }).delivery, "notice");
  assert.equal(judgeRun(undefined, "failed", { hasReport: true, limits }).delivery, "report");
});

await check("failures take five before the task is paused", () => {
  let verdict = judgeRun(undefined, "failed", { hasReport: false, limits });
  for (let run = 2; run <= 4; run += 1) {
    verdict = judgeRun(verdict.health, "failed", { hasReport: false, limits });
    assert.equal(verdict.pause, false, `paused at ${run}`);
    assert.equal(verdict.delivery, "silent");
  }
  verdict = judgeRun(verdict.health, "failed", { hasReport: false, limits });
  assert.equal(verdict.pause, true);
  assert.equal(verdict.delivery, "pause-notice");
});

await check("a different kind of trouble starts its own count", () => {
  let verdict = judgeRun(undefined, "refused", { hasReport: true, limits });
  verdict = judgeRun(verdict.health, "refused", { hasReport: true, limits });
  verdict = judgeRun(verdict.health, "failed", { hasReport: true, limits });
  assert.equal(verdict.health.kind, "failed");
  assert.equal(verdict.health.streak, 1);
  assert.equal(verdict.pause, false);
});

await check("a good run in the middle breaks the streak", () => {
  let verdict = judgeRun(undefined, "refused", { hasReport: true, limits });
  verdict = judgeRun(verdict.health, "refused", { hasReport: true, limits });
  verdict = judgeRun(verdict.health, "ok", { hasReport: true, limits });
  verdict = judgeRun(verdict.health, "refused", { hasReport: true, limits });
  assert.equal(verdict.health.streak, 1);
  assert.equal(verdict.pause, false);
});

await check("what went wrong is kept short and on one line", () => {
  const detail = `Limit reached.\n\n${"word ".repeat(400)}`;
  const verdict = judgeRun(undefined, "refused", { hasReport: true, detail, limits });
  assert.ok(verdict.health.detail && verdict.health.detail.length <= 600, `kept ${verdict.health.detail?.length}`);
  assert.ok(!verdict.health.detail!.includes("\n"));
});

await check("the limits can be set in the environment, and nonsense falls back", () => {
  assert.deepEqual(healthLimits({}), { pauseAfterRefused: 3, pauseAfterFailed: 5 });
  assert.deepEqual(healthLimits({ EGGENT_SCHEDULE_PAUSE_AFTER_REFUSED: "2", EGGENT_SCHEDULE_PAUSE_AFTER_FAILED: "8" }), { pauseAfterRefused: 2, pauseAfterFailed: 8 });
  assert.deepEqual(healthLimits({ EGGENT_SCHEDULE_PAUSE_AFTER_REFUSED: "0", EGGENT_SCHEDULE_PAUSE_AFTER_FAILED: "many" }), { pauseAfterRefused: 3, pauseAfterFailed: 5 });
});

console.log("\nThe record on disk\n");

const key = healthKey("session-1", "job-1");
const file = path.join(root, "data", "schedules", "health.json");

await check("a refusal is written to the machine's own data folder", async () => {
  await recordRunOutcome(key, "refused", { hasReport: true, detail: "Limit reached", limits });
  await recordRunOutcome(key, "refused", { hasReport: true, limits });
  const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(stored.jobs[key].streak, 2);
  assert.equal(stored.jobs[key].kind, "refused");
});

await check("it survives a restart", async () => {
  resetScheduleHealth();
  assert.equal((await readJobHealth(key))?.streak, 2);
  const third = await recordRunOutcome(key, "refused", { hasReport: true, limits });
  assert.equal(third.pause, true, "the count did not carry over");
});

await check("a good run removes the entry rather than leaving a zero", async () => {
  await recordRunOutcome(key, "ok", { hasReport: true, limits });
  assert.equal(await readJobHealth(key), undefined);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).jobs[key], undefined);
});

await check("a good run for a task never seen writes nothing", async () => {
  const before = fs.readFileSync(file, "utf-8");
  await recordRunOutcome(healthKey("session-9", "job-9"), "ok", { hasReport: true, limits });
  assert.equal(fs.readFileSync(file, "utf-8"), before);
});

await check("a resumed or deleted task is forgotten", async () => {
  await recordRunOutcome(key, "failed", { hasReport: false, limits });
  assert.ok(await readJobHealth(key));
  await forgetJobHealth(key);
  assert.equal(await readJobHealth(key), undefined);
});

console.log("\nSessions in a scheduled run\n");

await check("a session is in a run from mark to unmark", () => {
  assert.equal(runState.isScheduledRunSessionId("s-1"), false);
  runState.markScheduledRunSession("s-1");
  assert.equal(runState.isScheduledRunSessionId("s-1"), true);
  runState.unmarkScheduledRunSession("s-1");
  assert.equal(runState.isScheduledRunSessionId("s-1"), false);
});

await check("nothing is in a run by default, and nothing missing is", () => {
  assert.equal(runState.isScheduledRunSessionId(undefined), false);
  assert.equal(runState.isScheduledRunSessionId(""), false);
  assert.equal(runState.isScheduledRunSessionId(null), false);
});

process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
