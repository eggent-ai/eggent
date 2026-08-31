/**
 * Checks that a turn can be watched by someone who was not there when it started.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-live-runs.ts
 *
 * The failure this replaces: a turn existed only inside the HTTP response that
 * started it. Click another chat and come back, and the stored conversation held
 * the opening message and nothing else - for however long the work took - while
 * the agent carried on writing into a connection nobody was reading.
 *
 * The delicate part is the join. A reader attaches by being handed everything so
 * far and then registered for the rest, and the two halves must not overlap in
 * either direction: a chunk arriving mid-attach must not land ahead of the
 * history it belongs after, and none may be dropped in between.
 */
import assert from "node:assert/strict";
import {
  attachToLiveRun,
  getLiveRun,
  listLiveRuns,
  startLiveRun,
  whenLiveRunFinished,
  type LiveRunChunk,
} from "../src/lib/pi/live-run.ts";

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

function textChunks(id: string, ...deltas: string[]): LiveRunChunk[] {
  return [
    { type: "text-start", id },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id, delta })),
  ];
}

/** What a reader would render: the concatenated text of everything it received. */
function renderedText(chunks: LiveRunChunk[]): string {
  return chunks
    .filter((chunk): chunk is Extract<LiveRunChunk, { type: "text-delta" }> => chunk.type === "text-delta")
    .map((chunk) => chunk.delta)
    .join("");
}

function collector() {
  const chunks: LiveRunChunk[] = [];
  let finished = false;
  return {
    chunks,
    get finished() {
      return finished;
    },
    reader: {
      onChunk: (chunk: LiveRunChunk) => {
        chunks.push(chunk);
      },
      onFinish: () => {
        finished = true;
      },
    },
  };
}

console.log("Watching a turn that is already going\n");

check("a late reader gets everything so far, then the rest, in one order", () => {
  const live = startLiveRun({ chatId: "chat-1", runId: "run-1", surface: "web" });
  for (const chunk of textChunks("t1", "Look", "ing ")) live.push(chunk);
  live.push({ type: "tool-input-available", toolCallId: "c1", toolName: "bash", input: {}, dynamic: true });
  live.push({ type: "tool-output-available", toolCallId: "c1", output: "ok", dynamic: true });

  const late = collector();
  const attached = attachToLiveRun("chat-1", late.reader);
  assert.ok(attached, "there is a run to attach to");
  assert.equal(attached.runId, "run-1");

  // Replayed before anything new: the tool call is already there.
  assert.equal(late.chunks.filter((c) => c.type === "tool-output-available").length, 1);

  live.push({ type: "text-delta", id: "t1", delta: "done" });
  live.push({ type: "text-end", id: "t1" });

  assert.equal(renderedText(late.chunks), "Looking done");
  const types = late.chunks.map((c) => c.type);
  assert.deepEqual(types.slice(-3), ["tool-output-available", "text-delta", "text-end"]);

  live.finish();
  assert.equal(late.finished, true, "a reader is told when the turn ends");
});

check("a token at a time replays as the same text", () => {
  const live = startLiveRun({ chatId: "chat-2", runId: "run-2", surface: "web" });
  const word = "the quick brown fox";
  live.push({ type: "text-start", id: "t1" });
  for (const character of word) live.push({ type: "text-delta", id: "t1", delta: character });

  const late = collector();
  attachToLiveRun("chat-2", late.reader);
  assert.equal(renderedText(late.chunks), word);
  // Folded on the way in, so the buffer grows with the answer and not with the
  // tokens it arrived in.
  assert.equal(
    late.chunks.filter((c) => c.type === "text-delta").length,
    1,
    "consecutive deltas of one text part are kept as one"
  );
  live.finish();
});

check("two text parts are not folded into each other", () => {
  const live = startLiveRun({ chatId: "chat-3", runId: "run-3", surface: "web" });
  live.push({ type: "text-start", id: "a" });
  live.push({ type: "text-delta", id: "a", delta: "one" });
  live.push({ type: "text-end", id: "a" });
  live.push({ type: "text-start", id: "b" });
  live.push({ type: "text-delta", id: "b", delta: "two" });

  const late = collector();
  attachToLiveRun("chat-3", late.reader);
  const deltas = late.chunks.filter(
    (c): c is Extract<LiveRunChunk, { type: "text-delta" }> => c.type === "text-delta"
  );
  assert.deepEqual(deltas.map((d) => [d.id, d.delta]), [["a", "one"], ["b", "two"]]);
  live.finish();
});

check("what one reader already saw is not replayed to it again", () => {
  const live = startLiveRun({ chatId: "chat-4", runId: "run-4", surface: "web" });
  const first = collector();
  attachToLiveRun("chat-4", first.reader);
  live.push({ type: "text-start", id: "t1" });
  live.push({ type: "text-delta", id: "t1", delta: "hello" });

  const second = collector();
  attachToLiveRun("chat-4", second.reader);
  live.push({ type: "text-delta", id: "t1", delta: " there" });

  assert.equal(renderedText(first.chunks), "hello there");
  assert.equal(renderedText(second.chunks), "hello there");
  assert.equal(first.chunks.length, 3, "the early reader saw each chunk once");
  live.finish();
});

check("a reader whose connection is gone does not take the run down with it", () => {
  const live = startLiveRun({ chatId: "chat-5", runId: "run-5", surface: "web" });
  const good = collector();
  attachToLiveRun("chat-5", {
    onChunk: () => {
      throw new Error("this connection is closed");
    },
    onFinish: () => {
      throw new Error("and so is this");
    },
  });
  attachToLiveRun("chat-5", good.reader);

  live.push({ type: "text-start", id: "t1" });
  live.push({ type: "text-delta", id: "t1", delta: "still here" });
  assert.equal(renderedText(good.chunks), "still here");

  live.finish();
  assert.equal(good.finished, true);
});

check("detaching stops delivery and leaves the turn running", () => {
  const live = startLiveRun({ chatId: "chat-6", runId: "run-6", surface: "web" });
  const watcher = collector();
  const attached = attachToLiveRun("chat-6", watcher.reader);
  assert.ok(attached);

  live.push({ type: "text-start", id: "t1" });
  attached.detach();
  live.push({ type: "text-delta", id: "t1", delta: "unseen" });

  assert.equal(renderedText(watcher.chunks), "");
  assert.ok(getLiveRun("chat-6"), "the turn is still going");

  // And it is still in the buffer for whoever comes next.
  const next = collector();
  attachToLiveRun("chat-6", next.reader);
  assert.equal(renderedText(next.chunks), "unseen");
  live.finish();
});

check("a finished turn offers nothing to attach to", () => {
  const live = startLiveRun({ chatId: "chat-7", runId: "run-7", surface: "web" });
  live.push({ type: "text-start", id: "t1" });
  live.finish();

  assert.equal(getLiveRun("chat-7"), null);
  assert.equal(attachToLiveRun("chat-7", collector().reader), null);
  // Nothing written after the end reaches anyone, and finishing twice is quiet.
  live.push({ type: "text-delta", id: "t1", delta: "late" });
  live.finish();
  assert.equal(getLiveRun("chat-7"), null);
});

/**
 * The question an agent asks lives only here.
 *
 * `persistAssistantMessage` stores text and tool calls; a pending question is
 * neither, so it exists in the stream and nowhere else. A reader that attaches
 * without being handed it sees a turn that is working and no way to answer it -
 * and since the turn is waiting for that answer, it never ends, and the screen
 * stays that way for as long as the person looks at it.
 */
check("a question already asked is replayed to whoever arrives next", () => {
  const live = startLiveRun({ chatId: "chat-ask", runId: "run-ask", surface: "web" });
  live.push({ type: "text-start", id: "t1" });
  live.push({ type: "text-delta", id: "t1", delta: "A few short questions." });
  live.push({ type: "tool-input-available", toolCallId: "c1", toolName: "eggent_ask_user", input: {}, dynamic: true });
  live.push({
    type: "data-piInteraction",
    id: "pi-interaction-q1",
    data: { id: "q1", runId: "run-ask", kind: "select", title: "Shall we start?", status: "pending" },
  });

  const late = collector();
  attachToLiveRun("chat-ask", late.reader);

  const question = late.chunks.find(
    (chunk): chunk is Extract<LiveRunChunk, { type: `data-${string}` }> =>
      chunk.type === "data-piInteraction"
  );
  assert.ok(question, "the pending question must be replayed");
  assert.equal((question.data as { status?: string }).status, "pending");
  // And in its place: after the text it belongs under, not before it.
  const types = late.chunks.map((chunk) => chunk.type);
  assert.ok(
    types.indexOf("data-piInteraction") > types.indexOf("text-delta"),
    "it must arrive after the message it interrupts"
  );
  live.finish();
});

check("a chat that is not working has no run", () => {
  assert.equal(getLiveRun("nobody"), null);
  assert.equal(attachToLiveRun("nobody", collector().reader), null);
});

check("only running turns are listed, and each chat appears once", () => {
  const a = startLiveRun({ chatId: "chat-8", runId: "run-8", surface: "web" });
  const b = startLiveRun({ chatId: "chat-9", runId: "run-9", surface: "external" });
  const listed = listLiveRuns().map((run) => run.chatId);
  assert.ok(listed.includes("chat-8") && listed.includes("chat-9"));

  a.finish();
  assert.ok(!listLiveRuns().some((run) => run.chatId === "chat-8"));
  assert.equal(listLiveRuns().find((run) => run.chatId === "chat-9")?.surface, "external");
  b.finish();
});

check("a new turn in the same chat retires the one before it", () => {
  const first = startLiveRun({ chatId: "chat-10", runId: "run-10", surface: "web" });
  const watcher = collector();
  attachToLiveRun("chat-10", watcher.reader);

  const second = startLiveRun({ chatId: "chat-10", runId: "run-11", surface: "web" });
  assert.equal(watcher.finished, true, "the old reader is released rather than left hanging");
  assert.equal(getLiveRun("chat-10")?.runId, "run-11");

  first.finish();
  assert.equal(getLiveRun("chat-10")?.runId, "run-11", "the loser must not evict the live one");
  second.finish();
  assert.equal(getLiveRun("chat-10"), null);
});

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Stopping a turn has to answer after the turn is written down, not before.
 * The caller reloads the conversation the moment the stop returns, and a reply
 * that beats the file to disk takes the half-written answer off the screen of
 * the person who just chose to keep it.
 */
await checkAsync("waiting for the end resolves when the turn ends", async () => {
  const live = startLiveRun({ chatId: "chat-11", runId: "run-12", surface: "web" });
  let resolved = false;
  const waiting = whenLiveRunFinished("chat-11").then(() => {
    resolved = true;
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false, "not while the turn is still going");

  live.finish();
  await waiting;
  assert.equal(resolved, true);
});

await checkAsync("waiting on a chat with nothing running returns at once", async () => {
  await whenLiveRunFinished("nobody");
  const live = startLiveRun({ chatId: "chat-12", runId: "run-13", surface: "web" });
  live.finish();
  await whenLiveRunFinished("chat-12");
});

await checkAsync("a run that never ends does not hold the caller forever", async () => {
  const live = startLiveRun({ chatId: "chat-13", runId: "run-14", surface: "web" });
  const started = Date.now();
  // The wait releases the event loop on purpose - a stop must never be the
  // reason a server refuses to shut down - so this test has to hold it open.
  const keepAlive = setInterval(() => {}, 10);
  await whenLiveRunFinished("chat-13", 60);
  clearInterval(keepAlive);
  assert.ok(Date.now() - started >= 50, "it did wait");
  assert.ok(getLiveRun("chat-13"), "and gave up rather than ending the run itself");
  live.finish();
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
