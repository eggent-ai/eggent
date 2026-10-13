/**
 * A chat file that arrives from somewhere else is announced to the screen; one
 * this process wrote itself is not announced twice.
 *
 * Run with Node 22:  npm run test:chats-watcher
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-chats-watcher-"));
process.chdir(root);

const { startChatsWatcher } = await import("../src/lib/storage/chats-watcher.ts");
const { createChat, saveChat, getChat } = await import("../src/lib/storage/chat-store.ts");
const { subscribeUiSyncEvents } = await import("../src/lib/realtime/event-bus.ts");

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

startChatsWatcher();
const events: Array<{ chatId?: string; reason?: string; projectId?: string | null }> = [];
subscribeUiSyncEvents((event) => events.push({ chatId: event.chatId, reason: event.reason, projectId: event.projectId }));

const chatsDir = path.join(root, "data", "chats");

await check("a chat file that appears from outside is announced with its project", async () => {
  const id = "from-sync-1";
  fs.writeFileSync(path.join(chatsDir, `${id}.json`), JSON.stringify({
    id, title: "Arrived", projectId: "shop", messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  await sleep(900);
  const seen = events.filter((event) => event.chatId === id);
  assert.equal(seen.length, 1, JSON.stringify(seen));
  assert.equal(seen[0].reason, "chat_synced");
  assert.equal(seen[0].projectId, "shop");
});

await check("several writes to one file in a moment are one announcement", async () => {
  const id = "from-sync-2";
  const file = path.join(chatsDir, `${id}.json`);
  const body = JSON.stringify({ id, title: "Burst", messages: [], createdAt: "x", updatedAt: "x" });
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(file, body);
    await sleep(40);
  }
  await sleep(900);
  assert.equal(events.filter((event) => event.chatId === id).length, 1);
});

await check("a write this process made is announced once, by the store, not again by the watcher", async () => {
  const id = "ours-1";
  await createChat(id, "Ours");
  const chat = await getChat(id);
  assert.ok(chat);
  chat.title = "Ours, renamed";
  await saveChat(chat);
  await sleep(900);
  const seen = events.filter((event) => event.chatId === id);
  assert.ok(seen.length >= 2, "the store announced nothing");
  assert.ok(seen.every((event) => event.reason === "chat_saved"), JSON.stringify(seen));
});

await check("a chat file removed from outside is announced as deleted", async () => {
  const id = "from-sync-3";
  const file = path.join(chatsDir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, title: "Gone", messages: [], createdAt: "x", updatedAt: "x" }));
  await sleep(700);
  events.length = 0;
  fs.rmSync(file);
  await sleep(900);
  assert.deepEqual(events.filter((event) => event.chatId === id).map((event) => event.reason), ["chat_deleted"]);
});

await check("temporary files of a writer are not chats", async () => {
  events.length = 0;
  fs.writeFileSync(path.join(chatsDir, ".syncthing.tmp-1.json.tmp"), "{}");
  fs.writeFileSync(path.join(chatsDir, "notes.txt"), "x");
  await sleep(700);
  assert.equal(events.length, 0, JSON.stringify(events));
});

console.log(`\n${ran - failed}/${ran} passed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
