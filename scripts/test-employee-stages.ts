/**
 * An employee's stages: what the model sends becomes what the screen draws,
 * and nothing the screen cannot draw gets through.
 *
 * Run with Node 22:
 *   node --experimental-strip-types --import ./scripts/alias-loader-register.mjs scripts/test-employee-stages.ts
 */
import assert from "node:assert/strict";
import { foldStages, isPending, normalizeStage, stageFromToolOutput } from "../src/lib/employees/stage.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

check("a stage needs an id of letters, digits, - or _", () => {
  assert.equal(normalizeStage({ title: "No id" }), null);
  assert.equal(normalizeStage({ id: "../x", title: "Bad" }), null);
  assert.equal(normalizeStage({ id: "Search", title: "Поиск" })?.id, "search");
});

check("an unknown status counts as running; done and warn are kept", () => {
  assert.equal(normalizeStage({ id: "a", status: "whatever" })?.status, "running");
  assert.equal(normalizeStage({ id: "a", status: "warn" })?.status, "warn");
});

check("a verdict may come as a string or an object, tone only from the three", () => {
  assert.deepEqual(normalizeStage({ id: "a", verdict: "Тебя нет в поиске" })?.verdict, { text: "Тебя нет в поиске" });
  assert.deepEqual(normalizeStage({ id: "a", verdict: { text: "ok", tone: "loud" } })?.verdict, { text: "ok", tone: undefined });
});

check("a table without rows or columns is dropped, long ones are cut", () => {
  assert.equal(normalizeStage({ id: "a", table: { columns: ["A"], rows: [] } })?.table, undefined);
  const rows = Array.from({ length: 50 }, (_, i) => [String(i)]);
  assert.equal(normalizeStage({ id: "a", table: { columns: ["A"], rows } })?.table?.rows.length, 30);
});

check("the plan draws the stages ahead greyed out, in order, and a started one leaves the plan", () => {
  const board = foldStages([
    { id: "site", title: "Сайт", status: "running", plan: [{ id: "site", title: "Сайт" }, { id: "search", title: "Поиск" }, { id: "plan", title: "Что делать" }] },
  ]);
  assert.deepEqual(board.stages.map((s) => s.id), ["site", "search", "plan"]);
  assert.equal(isPending(board.stages[0]), false);
  assert.equal(isPending(board.stages[1]), true);
  assert.equal(board.currentId, "site");
});

check("a later call for the same stage updates it and keeps what it does not repeat", () => {
  const board = foldStages([
    { id: "site", title: "Сайт", status: "running", detail: "Открываю", image: "shots/site.png" },
    { id: "site", status: "done", verdict: { text: "Сервис ремонта iPhone" } },
  ]);
  assert.equal(board.stages.length, 1);
  assert.equal(board.stages[0].status, "done");
  assert.equal(board.stages[0].image, "shots/site.png");
  assert.equal(board.stages[0].title, "Сайт");
  assert.equal(board.stages[0].verdict?.text, "Сервис ремонта iPhone");
});

check("the current stage is the last one touched", () => {
  const board = foldStages([{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "a", status: "done" }]);
  assert.equal(board.currentId, "a");
});

check("a finished stage is read back from the tool's own result, in either shape", () => {
  const text = JSON.stringify({ success: true, stage: { id: "law", title: "Закон", status: "done", verdict: { text: "ст. 333" } } });
  assert.equal(stageFromToolOutput(text)?.id, "law");
  assert.equal(stageFromToolOutput({ content: [{ type: "text", text }] })?.verdict?.text, "ст. 333");
  assert.equal(stageFromToolOutput("not json"), null);
  assert.equal(stageFromToolOutput({ content: [] }), null);
});

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
