/**
 * A confirm card that carries its own buttons must read them as yes, then no.
 *
 * Run with Node 22:
 *   node --experimental-strip-types --import ./scripts/alias-loader-register.mjs scripts/test-confirm-options.ts
 *
 * The first button ("Go") reached the server as a string, was compared with a
 * list of affirmatives it is not in, and became a refusal: the agent answered
 * "stopped" to the person who had just agreed. "Decide for me" on the same card
 * went the same way - its marker is no affirmative either.
 */
import assert from "node:assert/strict";
import { DEFER_INTERACTION_ANSWER } from "../src/lib/pi/interaction-types.ts";
import { createPendingInteraction, respondToPendingInteraction } from "../src/lib/pi/pending-interactions.ts";

let failed = 0;
async function ask(options: string[] | undefined, value: string | boolean): Promise<unknown> {
  let seen: { id: string; runId: string } | undefined;
  const answer = createPendingInteraction({
    runId: "run-1", kind: "confirm", title: "Start?", options,
    onUpdate: (interaction: { id: string; runId: string }) => { seen ??= interaction; },
  } as never);
  assert.ok(seen, "the card must be announced");
  respondToPendingInteraction("run-1", seen.id, { value } as never);
  return answer;
}
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

await check("the first button is yes", async () => assert.equal(await ask(["Go", "Not now"], "Go"), true));
await check("the second button is no", async () => assert.equal(await ask(["Go", "Not now"], "Not now"), false));
await check("plain Yes/No buttons still work", async () => {
  assert.equal(await ask(undefined, true), true);
  assert.equal(await ask(undefined, false), false);
});
await check("a typed affirmative still counts without options", async () => assert.equal(await ask(undefined, "yes"), true));
await check("handing the decision back is passed on, not read as no", async () => {
  assert.equal(await ask(["Go", "Not now"], DEFER_INTERACTION_ANSWER), DEFER_INTERACTION_ANSWER);
  assert.equal(await ask(undefined, DEFER_INTERACTION_ANSWER), DEFER_INTERACTION_ANSWER);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
