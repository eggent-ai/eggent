/**
 * A turn that stops to ask a question is written down at that moment, and
 * the final answer replaces it instead of landing beside it.
 *
 * Run with Node 22: npm run test:turn-checkpoint
 *
 * Six first launches in five days (2026-09-27..10-01) left a stored chat
 * holding only the person's own message: the agent had done the work and
 * asked a question, nobody answered, the workspace slept, and the work stayed
 * in a pi session nobody sees.
 */
import assert from "node:assert/strict";

const {
  checkpointToolMessageId,
  describeInteractionForTranscript,
  spliceAssistantTurn,
} = await import("../src/lib/pi/turn-checkpoint.ts");

type Message = Parameters<typeof spliceAssistantTurn>[0][number];

let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

const at = "2026-10-01T08:53:00.000Z";
const user: Message = { id: "u1", role: "user", content: "Go through the statements", createdAt: at };
const checkpoint = (id: string, text: string): Message[] => [
  { id, role: "assistant", content: text, createdAt: at, inProgress: true },
  { id: checkpointToolMessageId(id, "call-1"), role: "tool", content: "ok", createdAt: at, toolCallId: "call-1" },
];
const final: Message[] = [
  { id: "a-final", role: "assistant", content: "Done", createdAt: at },
  { id: "t-final", role: "tool", content: "ok", createdAt: at, toolCallId: "call-1" },
];

check("without a checkpoint the turn is appended", () => {
  const out = spliceAssistantTurn([user], undefined, final);
  assert.deepEqual(out.map((m) => m.id), ["u1", "a-final", "t-final"]);
});

check("a checkpoint and its tool messages are replaced, not kept beside the answer", () => {
  const out = spliceAssistantTurn([user, ...checkpoint("cp", "Did 19 steps")], "cp", final);
  assert.deepEqual(out.map((m) => m.id), ["u1", "a-final", "t-final"]);
  assert.ok(!out.some((m) => m.inProgress));
});

check("a second question in the same turn rewrites the checkpoint in place", () => {
  const first = spliceAssistantTurn([user], "cp", checkpoint("cp", "Question 1"));
  const second = spliceAssistantTurn(first, "cp", checkpoint("cp", "Question 2"));
  assert.equal(second.length, 3);
  assert.equal(second[1].content, "Question 2");
});

check("a message written after the checkpoint stays after the turn", () => {
  const steered: Message = { id: "u2", role: "user", content: "one more thing", createdAt: at };
  const out = spliceAssistantTurn([user, ...checkpoint("cp", "…"), steered], "cp", final);
  assert.deepEqual(out.map((m) => m.id), ["u1", "a-final", "t-final", "u2"]);
});

check("a checkpoint id that is gone falls back to appending", () => {
  const out = spliceAssistantTurn([user], "missing", final);
  assert.deepEqual(out.map((m) => m.id), ["u1", "a-final", "t-final"]);
});

check("another turn's messages are never taken for the checkpoint", () => {
  const other: Message = { id: "cpx", role: "assistant", content: "old", createdAt: at };
  const out = spliceAssistantTurn([user, other, ...checkpoint("cp", "…")], "cp", final);
  assert.deepEqual(out.map((m) => m.id), ["u1", "cpx", "a-final", "t-final"]);
});

check("the question reads as text once the card is gone", () => {
  const text = describeInteractionForTranscript({
    id: "i1",
    runId: "r1",
    kind: "select",
    status: "pending",
    title: "When was the petition accepted?",
    message: "The look-back periods count from that date",
    options: ["I know the date", " Not sure "],
    createdAt: at,
    updatedAt: at,
  });
  assert.equal(
    text,
    "**When was the petition accepted?**\nThe look-back periods count from that date\n- I know the date\n- Not sure"
  );
});

check("a message that repeats the title is not printed twice", () => {
  const text = describeInteractionForTranscript({
    id: "i2",
    runId: "r1",
    kind: "text",
    status: "pending",
    title: "What should the project be called?",
    message: "What should the project be called?",
    createdAt: at,
    updatedAt: at,
  });
  assert.equal(text, "**What should the project be called?**");
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
