/**
 * Checks that one external session holds one conversation.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-session-chat.ts
 *
 * A session used to keep a chat per project, which split a single Telegram
 * thread into several hidden ones: asking to file something in a project moved
 * the conversation there, so the assistant no longer knew what had just been
 * said, and coming back resumed the older thread while everything said in the
 * project stayed behind. Both threads carry the same title, and a messenger has
 * no chat list, so there was no way to even notice it.
 *
 * Sessions recorded before the change still have the split map, so the first
 * read has to pick one of them rather than start over.
 */
import assert from "node:assert/strict";
import { sessionChatId, setSessionChatId, type ExternalSession } from "../src/lib/storage/external-session-store.ts";

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

function session(over: Partial<ExternalSession> = {}): ExternalSession {
  return {
    id: "s1",
    activeProjectId: null,
    activeChatId: null,
    activeChats: {},
    currentPaths: {},
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...over,
  };
}

console.log("One session, one conversation\n");

check("a fresh session has no chat yet", () => {
  assert.equal(sessionChatId(session()), null);
});

check("the chat set is the chat read back", () => {
  const s = session();
  setSessionChatId(s, "chat-1");
  assert.equal(sessionChatId(s), "chat-1");
});

check("the chat does not change when the project does", () => {
  const s = session();
  setSessionChatId(s, "chat-1");
  s.activeProjectId = "todo";
  assert.equal(sessionChatId(s), "chat-1", "moving into a project must not start a new thread");
  s.activeProjectId = null;
  assert.equal(sessionChatId(s), "chat-1", "and coming back must not resume an older one");
});

check("a split session carries over the project it was last in", () => {
  // The exact shape found on disk: the person was working in a project when
  // they stopped, so that is the conversation to continue.
  const s = session({
    activeProjectId: "todo",
    activeChats: { __global__: "chat-global", todo: "chat-todo" },
  });
  assert.equal(sessionChatId(s), "chat-todo");
});

check("a split session with no project falls back to the orchestrator's", () => {
  const s = session({ activeChats: { __global__: "chat-global", todo: "chat-todo" } });
  assert.equal(sessionChatId(s), "chat-global");
});

check("a split session whose project chat is gone still finds one", () => {
  const s = session({ activeProjectId: "missing", activeChats: { todo: "chat-todo" } });
  assert.equal(sessionChatId(s), "chat-todo");
});

check("carrying over happens once, then the single chat wins", () => {
  const s = session({ activeProjectId: "todo", activeChats: { __global__: "chat-global", todo: "chat-todo" } });
  setSessionChatId(s, sessionChatId(s)!);
  s.activeProjectId = null;
  assert.equal(sessionChatId(s), "chat-todo", "the legacy map must not pull it back");
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
