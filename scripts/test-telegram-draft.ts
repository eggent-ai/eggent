/**
 * Checks the Telegram draft that shows an answer while it is being written.
 *
 * Run with Node 22: npm run test:telegram-draft
 *
 * What has to hold is mostly about order and silence: the first thing on screen
 * is the "Thinking…" placeholder, pieces of text arrive coalesced and never go
 * backwards, markup Telegram refuses falls back to plain words, a rate limit is
 * waited out, a quiet stretch does not let the draft expire, nothing is sent
 * after stop() - including an update that was already on its way when stop()
 * was called, which would otherwise sit under the finished message - and a chat
 * where drafts are refused hands over to the old indicator exactly once.
 *
 * Given a status, the draft says what is happening until the answer starts -
 * "Thinking…", or a line for the tool that is running - instead of the empty
 * placeholder some clients draw as a tiny bubble of dots.
 */
import assert from "node:assert/strict";

const { startDraftStream, draftTail, toolActivity } = await import("../src/lib/telegram/draft-stream.ts");

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Body = Record<string, unknown>;

function recorder(behaviour: (body: Body, index: number) => Promise<void> | void = () => undefined) {
  const bodies: Body[] = [];
  const send = async (body: Body) => {
    const index = bodies.length;
    bodies.push(body);
    await behaviour(body, index);
  };
  return { bodies, send };
}

const format = (markdown: string) => `<b>${markdown}</b>`;
const text = (event: string) => ({ type: "text" as const, delta: event });

await check("the first thing on screen is the Thinking placeholder, sent without waiting for text", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, throttleMs: 30, refreshMs: 10_000 });
  await sleep(5);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].text, "");
  assert.equal(bodies[0].chat_id, 7);
  assert.ok(typeof bodies[0].draft_id === "number" && (bodies[0].draft_id as number) > 0);
  await draft.stop();
});

await check("pieces arriving together go out as one update carrying all of them, in the same draft", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, throttleMs: 40, refreshMs: 10_000 });
  for (const piece of ["Hel", "lo", "! ", "How ", "can I help?"]) draft.onProgress(text(piece));
  await sleep(120);
  await draft.stop();
  const updates = bodies.slice(1);
  assert.equal(updates.length, 1, `updates: ${updates.length}`);
  assert.equal(updates[0].text, "<b>Hello! How can I help?</b>");
  assert.equal(updates[0].parse_mode, "HTML");
  assert.equal(updates[0].draft_id, bodies[0].draft_id);
});

await check("text keeps growing on screen and never goes backwards", async () => {
  const { bodies, send } = recorder(() => sleep(15));
  const draft = startDraftStream({ chatId: 7, send, format: (m) => m, throttleMs: 20, refreshMs: 10_000 });
  let written = "";
  for (let i = 0; i < 12; i += 1) {
    const piece = `word${i} `;
    written += piece;
    draft.onProgress(text(piece));
    await sleep(9);
  }
  await sleep(150);
  await draft.stop();
  const shown = bodies.slice(1).map((body) => String(body.text));
  assert.ok(shown.length >= 2, `only ${shown.length} updates`);
  for (let i = 1; i < shown.length; i += 1) {
    assert.ok(shown[i].startsWith(shown[i - 1]), `update ${i} went backwards`);
  }
  assert.equal(shown[shown.length - 1], written.trimStart());
});

await check("markup Telegram refuses is sent again as plain words", async () => {
  const { bodies, send } = recorder((body) => {
    if (body.parse_mode === "HTML") throw new Error("Bad Request: can't parse entities: unclosed tag");
  });
  const draft = startDraftStream({ chatId: 7, send, format, throttleMs: 10, refreshMs: 10_000 });
  draft.onProgress(text("**half"));
  await sleep(60);
  await draft.stop();
  const last = bodies[bodies.length - 1];
  assert.equal(last.text, "**half");
  assert.equal(last.parse_mode, undefined);
});

await check("a rate limit is waited out instead of hammered", async () => {
  let limited = false;
  const { bodies, send } = recorder((body) => {
    if (body.text !== "" && !limited) {
      limited = true;
      throw new Error("Too Many Requests: retry after 1");
    }
  });
  const draft = startDraftStream({ chatId: 7, send, format, throttleMs: 10, refreshMs: 10_000 });
  draft.onProgress(text("one"));
  await sleep(300);
  const duringPause = bodies.length;
  assert.equal(duringPause, 2, `sends before the pause ended: ${duringPause}`);
  await sleep(900);
  await draft.stop();
  assert.equal(bodies[bodies.length - 1].text, "<b>one</b>");
});

await check("a quiet stretch re-sends the draft so it does not expire", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, throttleMs: 10, refreshMs: 120 });
  draft.onProgress(text("thinking"));
  await sleep(400);
  await draft.stop();
  const same = bodies.filter((body) => body.text === "<b>thinking</b>");
  assert.ok(same.length >= 2, `sent ${same.length} times`);
});

await check("nothing goes out after stop(), and stop() waits for an update already on its way", async () => {
  let release: () => void = () => undefined;
  const { bodies, send } = recorder((body) =>
    body.text === "" ? undefined : new Promise<void>((resolve) => { release = resolve; })
  );
  const draft = startDraftStream({ chatId: 7, send, format, throttleMs: 5, refreshMs: 10_000 });
  draft.onProgress(text("almost"));
  await sleep(30);
  let stopped = false;
  const stopping = draft.stop().then(() => { stopped = true; });
  draft.onProgress(text(" done"));
  await sleep(20);
  assert.equal(stopped, false, "stop() returned while an update was still in flight");
  release();
  await stopping;
  const count = bodies.length;
  await sleep(60);
  assert.equal(bodies.length, count);
  assert.ok(!bodies.some((body) => String(body.text).includes("done")));
});

await check("a chat that refuses drafts hands over to the old indicator, once", async () => {
  let handedOver = 0;
  const { bodies, send } = recorder(() => {
    throw new Error("Bad Request: method is not available");
  });
  const draft = startDraftStream({ chatId: 7, send, format, throttleMs: 5, refreshMs: 50, onUnavailable: () => { handedOver += 1; } });
  draft.onProgress(text("something"));
  await sleep(150);
  await draft.stop();
  assert.equal(handedOver, 1);
  assert.equal(bodies.length, 1, "kept trying after being refused");
});

await check("a long answer shows the part being written", () => {
  const long = "a".repeat(5000) + "END";
  const tail = draftTail(long);
  assert.ok(tail.startsWith("…"));
  assert.ok(tail.endsWith("END"));
  assert.ok(tail.length <= 3801);
  assert.equal(draftTail("  short"), "short");
});

const status = {
  thinking: "Thinking…",
  tool: (name: string) => ({ web_search: "Searching…", fetch_content: "Reading…" } as Record<string, string>)[name],
};
const tool = (name: string, phase: "start" | "end") => ({ type: "tool" as const, name, phase });
const shown = (bodies: Body[]) => bodies.map((body) => String(body.text));

await check("with a status, the first draft says Thinking in italics instead of being empty", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, status, throttleMs: 10, refreshMs: 10_000 });
  await sleep(5);
  await draft.stop();
  assert.equal(bodies[0].text, "<i>Thinking…</i>");
  assert.equal(bodies[0].parse_mode, "HTML");
});

await check("a running tool shows its line, and Thinking comes back when it ends", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, status, throttleMs: 10, refreshMs: 10_000 });
  await sleep(20);
  draft.onProgress(tool("web_search", "start"));
  await sleep(40);
  draft.onProgress(tool("web_search", "end"));
  await sleep(40);
  await draft.stop();
  assert.deepEqual(shown(bodies), ["<i>Thinking…</i>", "<i>Searching…</i>", "<i>Thinking…</i>"]);
  assert.ok(bodies.every((body) => body.draft_id === bodies[0].draft_id));
});

await check("with tools inside tools the latest shows, then the one before it", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, status, throttleMs: 10, refreshMs: 10_000 });
  await sleep(20);
  draft.onProgress(tool("web_search", "start"));
  await sleep(40);
  draft.onProgress(tool("fetch_content", "start"));
  await sleep(40);
  draft.onProgress(tool("fetch_content", "end"));
  await sleep(40);
  await draft.stop();
  assert.deepEqual(shown(bodies), ["<i>Thinking…</i>", "<i>Searching…</i>", "<i>Reading…</i>", "<i>Searching…</i>"]);
});

await check("a tool with no line of its own keeps the line under it", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, status, throttleMs: 10, refreshMs: 10_000 });
  await sleep(20);
  draft.onProgress(tool("web_search", "start"));
  await sleep(40);
  draft.onProgress(tool("something_else", "start"));
  await sleep(40);
  await draft.stop();
  assert.deepEqual(shown(bodies), ["<i>Thinking…</i>", "<i>Searching…</i>"]);
});

await check("once the answer starts, it is all the draft shows", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, status, throttleMs: 10, refreshMs: 10_000 });
  await sleep(20);
  draft.onProgress(text("Here is"));
  await sleep(40);
  draft.onProgress(tool("web_search", "start"));
  await sleep(40);
  draft.onProgress(tool("web_search", "end"));
  draft.onProgress(text(" the answer"));
  await sleep(40);
  await draft.stop();
  assert.deepEqual(shown(bodies), ["<i>Thinking…</i>", "<b>Here is</b>", "<b>Here is the answer</b>"]);
});

await check("whitespace before a tool call does not count as the answer starting", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, status, throttleMs: 10, refreshMs: 10_000 });
  await sleep(20);
  draft.onProgress(text("\n\n"));
  draft.onProgress(tool("web_search", "start"));
  await sleep(40);
  await draft.stop();
  assert.deepEqual(shown(bodies), ["<i>Thinking…</i>", "<i>Searching…</i>"]);
});

await check("a status line is escaped, and plain words stand in if Telegram refuses it", async () => {
  const { bodies, send } = recorder((body) => {
    if (body.parse_mode === "HTML" && String(body.text).includes("&lt;")) throw new Error("Bad Request: can't parse entities");
  });
  const odd = { thinking: "Thinking…", tool: () => "Reading <site> & more…" };
  const draft = startDraftStream({ chatId: 7, send, format, status: odd, throttleMs: 10, refreshMs: 10_000 });
  await sleep(20);
  draft.onProgress(tool("anything", "start"));
  await sleep(40);
  await draft.stop();
  assert.equal(bodies[1].text, "<i>Reading &lt;site&gt; &amp; more…</i>");
  assert.equal(bodies[bodies.length - 1].text, "Reading <site> & more…");
  assert.equal(bodies[bodies.length - 1].parse_mode, undefined);
});

const withHelpers = {
  ...status,
  helpers: (running: number, total: number) => `Helpers: ${running} of ${total} still going…`,
};
const helpers = (running: number, total: number) => ({ type: "helpers" as const, running, total });

await check("while helpers work, the draft says how many are still going instead of one tool", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, status: withHelpers, throttleMs: 10, refreshMs: 10_000 });
  await sleep(20);
  draft.onProgress(tool("Agent", "start"));
  draft.onProgress(helpers(2, 2));
  await sleep(40);
  draft.onProgress(helpers(1, 2));
  await sleep(40);
  draft.onProgress(helpers(0, 2));
  draft.onProgress(tool("Agent", "end"));
  await sleep(40);
  await draft.stop();
  assert.deepEqual(shown(bodies), [
    "<i>Thinking…</i>",
    "<i>Helpers: 2 of 2 still going…</i>",
    "<i>Helpers: 1 of 2 still going…</i>",
    "<i>Thinking…</i>",
  ]);
});

await check("the helper line stays under an answer that has already started, and leaves with them", async () => {
  const { bodies, send } = recorder();
  const draft = startDraftStream({ chatId: 7, send, format, status: withHelpers, throttleMs: 10, refreshMs: 10_000 });
  await sleep(20);
  draft.onProgress(text("Asking two helpers"));
  await sleep(40);
  draft.onProgress(helpers(2, 2));
  await sleep(40);
  draft.onProgress(helpers(0, 2));
  draft.onProgress(text(". Done"));
  await sleep(40);
  await draft.stop();
  assert.deepEqual(shown(bodies), [
    "<i>Thinking…</i>",
    "<b>Asking two helpers</b>",
    "<b>Asking two helpers</b>\n\n<i>Helpers: 2 of 2 still going…</i>",
    "<b>Asking two helpers. Done</b>",
  ]);
});

await check("tools are grouped by what the person sees, whatever the case of the name", () => {
  assert.equal(toolActivity("web_search"), "search");
  assert.equal(toolActivity("fetch_content"), "page");
  assert.equal(toolActivity("read"), "files");
  assert.equal(toolActivity("bash"), "command");
  assert.equal(toolActivity("Agent"), "helper");
  assert.equal(toolActivity("mcp"), "service");
  assert.equal(toolActivity("eggent_generate_image"), "image");
  assert.equal(toolActivity("telegram_send_file"), "send");
  assert.equal(toolActivity("eggent_memory_save"), "work");
});

console.log(`\n${ran - failed}/${ran} checks passed`);
if (failed > 0) process.exit(1);
process.exit(0);
