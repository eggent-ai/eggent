/**
 * A picture a tool handed to the model stays out of the stored chat, and an
 * unchanged chat is not downloaded again.
 *
 * Run with Node 22: npm run test:chat-media
 *
 * The runtime's `read` tool returns an image as base64 so the model can see
 * it, and the chat store kept that result twice. One conversation in which the
 * agent looked at four pictures it had drawn weighed 13 MB for 40 messages,
 * and the chat page fetched all of it on every open and every background sync:
 * seven to eleven seconds of an empty transcript each time.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The chat store resolves data/ from the working directory when it loads.
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-chat-media-"));
process.chdir(workdir);

const { withoutInlineImages } = await import("../src/lib/storage/chat-media.ts");
const { getChat, saveChat } = await import("../src/lib/storage/chat-store.ts");
const { matchesIfNoneMatch, weakEtag } = await import("../src/lib/etag.ts");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

// A real PNG header, then enough base64 to be a picture.
const PICTURE = "iVBORw0KGgoAAAANSUhEUgAABgAAAAQACAIAAAC" + "A".repeat(200_000);
const readResult = () => ({
  content: [
    { type: "text", text: "Read image file [image/png]" },
    { type: "image", data: PICTURE, mimeType: "image/png" },
  ],
});

function chatWithPictures(id: string) {
  return {
    id,
    title: "Pictures",
    projectId: "site-articles",
    createdAt: "2026-09-25T09:00:00.000Z",
    updatedAt: "2026-09-25T09:10:00.000Z",
    messages: [
      {
        id: "u1",
        role: "user" as const,
        content: "Draw four and look at them",
        createdAt: "2026-09-25T09:00:00.000Z",
        attachments: [{ name: "brief.png", type: "image/png", url: "data:image/png;base64," + "B".repeat(1000) }],
      },
      {
        id: "a1",
        role: "assistant" as const,
        content: "Here they are.",
        createdAt: "2026-09-25T09:10:00.000Z",
        toolCalls: [{ toolCallId: "t1", toolName: "read", args: { path: "generated-images/one.png" } }],
        parts: [
          { type: "tool" as const, toolCallId: "t1", toolName: "read", args: { path: "generated-images/one.png" }, output: readResult(), status: "completed" as const },
        ],
      },
      {
        id: "tool1",
        role: "tool" as const,
        content: "Read image file [image/png]",
        createdAt: "2026-09-25T09:10:00.000Z",
        toolName: "read",
        toolCallId: "t1",
        toolResult: readResult(),
      },
    ],
  };
}

console.log("the picture bytes are dropped, and only they are:");
const original = chatWithPictures("c1");
const before = JSON.stringify(original);
const stripped = withoutInlineImages(original);
await check("no copy of the picture is left, on the tool message or the timeline", () => {
  assert.doesNotMatch(JSON.stringify(stripped), /AAAAAAAAAAAAAAAAAAAA/);
});
await check("the block keeps its type and says roughly how large it was", () => {
  const block = (stripped.messages[2].toolResult as { content: Array<Record<string, unknown>> }).content[1];
  assert.equal(block.type, "image");
  assert.equal(block.mimeType, "image/png");
  assert.equal(block.omitted, true);
  assert.equal(block.data, undefined);
  assert.ok(Math.abs((block.bytes as number) - (PICTURE.length * 3) / 4) < 4);
});
await check("the text the tool returned beside it stays", () => {
  const output = (stripped.messages[1].parts?.[0] as { output: { content: Array<{ text?: string }> } }).output;
  assert.equal(output.content[0].text, "Read image file [image/png]");
});
await check("a picture the person attached is not touched", () => {
  assert.deepEqual(stripped.messages[0], original.messages[0]);
});
await check("the chat it was given is not changed", () => {
  assert.equal(JSON.stringify(original), before);
});
await check("a chat with nothing to drop comes back as the same object", () => {
  const plain = { id: "p", messages: [{ role: "assistant", parts: [{ type: "image", url: "/x.png" }, { type: "image", data: "short", mimeType: "image/png" }] }] };
  assert.equal(withoutInlineImages(plain), plain);
});
await check("dropping twice is dropping once", () => {
  assert.deepEqual(withoutInlineImages(stripped), stripped);
});
await check("what is left is a fraction of what there was", () => {
  assert.ok(JSON.stringify(stripped).length * 50 < before.length, `${JSON.stringify(stripped).length} of ${before.length}`);
});

console.log("\nthe store:");
await check("a save writes no picture to disk", async () => {
  await saveChat(chatWithPictures("c2"));
  const onDisk = fs.readFileSync(path.join(workdir, "data", "chats", "c2.json"), "utf-8");
  assert.doesNotMatch(onDisk, /AAAAAAAAAAAAAAAAAAAA/);
  assert.ok(onDisk.length < 10_000, `${onDisk.length} bytes`);
});
await check("a chat saved before this is read without its pictures, and the file is left alone", async () => {
  const file = path.join(workdir, "data", "chats", "c3.json");
  fs.writeFileSync(file, JSON.stringify(chatWithPictures("c3")));
  const sizeBefore = fs.statSync(file).size;
  const chat = await getChat("c3");
  assert.ok(chat);
  assert.doesNotMatch(JSON.stringify(chat), /AAAAAAAAAAAAAAAAAAAA/);
  assert.equal(chat.messages.length, 3);
  assert.equal(fs.statSync(file).size, sizeBefore);
});

console.log("\nrevalidation:");
await check("equal bodies give equal tags, and different bodies different ones", () => {
  assert.equal(weakEtag("a"), weakEtag("a"));
  assert.notEqual(weakEtag("a"), weakEtag("b"));
  assert.match(weakEtag("a"), /^W\/"[^"]+"$/);
});
await check("If-None-Match is compared weakly, in a list, and * matches", () => {
  const tag = weakEtag("body");
  assert.equal(matchesIfNoneMatch(tag, tag), true);
  assert.equal(matchesIfNoneMatch(tag.slice(2), tag), true);
  assert.equal(matchesIfNoneMatch(`W/"other", ${tag}`, tag), true);
  assert.equal(matchesIfNoneMatch("*", tag), true);
  assert.equal(matchesIfNoneMatch(weakEtag("other"), tag), false);
  assert.equal(matchesIfNoneMatch(null, tag), false);
  assert.equal(matchesIfNoneMatch("", tag), false);
});

console.log("\nthe history route:");
const { GET } = await import("../src/app/api/chat/history/route.ts");
// Next ships no exports map, so plain Node wants the file name.
const { NextRequest } = await import("next/server.js");
const ask = (headers: Record<string, string> = {}) =>
  GET(new NextRequest("http://workspace.example.test/api/chat/history?id=c3", { headers }));
const first = await ask();
const firstBody = await first.text();
const tag = first.headers.get("etag") || "";
await check("the open chat arrives without its pictures, with a validator", () => {
  assert.equal(first.status, 200);
  assert.doesNotMatch(firstBody, /AAAAAAAAAAAAAAAAAAAA/);
  assert.equal(JSON.parse(firstBody).messages.length, 3);
  assert.match(tag, /^W\//);
  assert.match(first.headers.get("cache-control") || "", /no-cache/);
});
const again = await ask({ "if-none-match": tag });
await check("asked again with that validator, an unchanged chat is a 304 and no body", async () => {
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
});
const changed = await getChat("c3");
changed!.messages.push({ id: "u2", role: "user", content: "One more", createdAt: "2026-09-25T09:20:00.000Z" });
await saveChat(changed!);
const afterChange = await ask({ "if-none-match": tag });
await check("once the chat changes, the same question gets the new chat", async () => {
  assert.equal(afterChange.status, 200);
  assert.notEqual(afterChange.headers.get("etag"), tag);
  assert.equal(JSON.parse(await afterChange.text()).messages.length, 4);
});

fs.rmSync(workdir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
