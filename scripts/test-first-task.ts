/**
 * A first task rides in the sign-in link and starts exactly once.
 *
 * Run with Node 22:
 *   node --experimental-strip-types --import ./scripts/alias-loader-register.mjs scripts/test-first-task.ts
 *
 * The link is the one thing a stranger could also craft, so what it may carry
 * is narrow: a skill name of the shape the skills directory allows, and a
 * short brief. Storage is the browser's, faked here with a plain map.
 */
import assert from "node:assert/strict";
import { FIRST_TASK_BRIEF_MAX, parseFirstTask, rememberFirstTask, takeFirstTask } from "../src/lib/first-task.ts";

const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  sessionStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  },
};

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

check("reads the skill and the brief next to the sign-in token", () => {
  const task = parseFirstTask("#handoff=abc&start=first-document&brief=slides+about+our+caf%C3%A9");
  assert.deepEqual(task, { skill: "first-document", brief: "slides about our café" });
});
check("a link without a skill carries no task", () => {
  assert.equal(parseFirstTask("#handoff=abc"), null);
  assert.equal(parseFirstTask("#handoff=abc&brief=hello"), null);
});
check("a skill name that could leave the skills directory is refused", () => {
  assert.equal(parseFirstTask("#start=..%2Fetc"), null);
  assert.equal(parseFirstTask("#start=Skill%20Name"), null);
  assert.equal(parseFirstTask("#start=-x"), null);
});
check("the brief is one line and capped", () => {
  const long = encodeURIComponent(`a\n\nb ${"x".repeat(2000)}`);
  const task = parseFirstTask(`#start=daily-digest&brief=${long}`);
  assert.ok(task);
  assert.equal(task.brief.length, FIRST_TASK_BRIEF_MAX);
  assert.ok(task.brief.startsWith("a b "));
});
check("a broken escape does not throw", () => {
  assert.deepEqual(parseFirstTask("#start=rival-table&brief=%E0%A4%A"), { skill: "rival-table", brief: "" });
});
check("a remembered task is handed out once", () => {
  rememberFirstTask({ skill: "rival-table", brief: "coffee shops" });
  assert.deepEqual(takeFirstTask(), { skill: "rival-table", brief: "coffee shops" });
  assert.equal(takeFirstTask(), null);
});
check("an old task does not start itself", () => {
  store.set("eggent-first-task", JSON.stringify({ skill: "rival-table", brief: "", at: Date.now() - 60 * 60 * 1000 }));
  assert.equal(takeFirstTask(), null);
  assert.equal(store.size, 0);
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
