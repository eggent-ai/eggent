import fs from "fs/promises";
import { chatFileIdentity, getChat } from "@/lib/storage/chat-store";
import { getChatFiles } from "@/lib/storage/chat-files-store";
import { findChatSessionFile } from "@/lib/pi/session-files";
import type { ChatHead } from "@/lib/remote/types";

/**
 * How far a chat has got on this side, and whether this side has got as far as
 * the other one.
 *
 * Files travel between a workspace and a computer on their own schedule, a few
 * seconds behind a write on a good day. A turn handed over before its chat has
 * arrived would run on a conversation that is missing its latest messages - or,
 * worse, start a conversation of its own beside the one that exists. So the
 * side that hands a turn over says what it has, and the side that receives it
 * checks it holds that, or something later, before it lets the agent in.
 *
 * "Later" matters: the receiving side is often ahead (the person typed on a
 * stale screen), and ahead is fine. Only "missing" is not.
 */

const TAIL_START_BYTES = 16 * 1024;
const TAIL_MAX_BYTES = 64 * 1024 * 1024;
/** Beyond this the whole file is not read to look for one id. */
const SEARCH_MAX_BYTES = 256 * 1024 * 1024;

/** The id of the last entry in the agent's record of a chat, read from the end of the file. */
export async function readSessionLeaf(file: string): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    let window = TAIL_START_BYTES;
    for (;;) {
      const start = Math.max(0, size - window);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf-8").split("\n");
      // Unless the window starts at the top of the file, its first line is cut
      // somewhere in the middle and cannot be told from a whole one.
      const firstWhole = start === 0 ? 0 : 1;
      for (let index = lines.length - 1; index >= firstWhole; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as { type?: unknown; id?: unknown };
          // The header names the session, not a point in it.
          if (entry.type === "session") continue;
          if (typeof entry.id === "string" && entry.id) return entry.id;
        } catch {
          // A line still being written; the one before it is the last whole one.
        }
      }
      if (start === 0 || window >= TAIL_MAX_BYTES) return null;
      window *= 4;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Whether the agent's record holds an entry with this id. */
export async function sessionHasEntry(file: string, entryId: string): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return false;
  }
  if (stat.size > SEARCH_MAX_BYTES) return false;
  try {
    const text = await fs.readFile(file, "utf-8");
    return text.includes(`"id":${JSON.stringify(entryId)}`);
  } catch {
    return false;
  }
}

/**
 * Names the file sync never carries: a Mac that opened the folder in Finder has
 * a `.DS_Store` here that the other side will never get, and a head that listed
 * it would be waited for until patience ran out, on every message. The same
 * names the folder's ignore list holds, and the temporary files the sync itself
 * makes while a file is arriving.
 */
const NEVER_SYNCED = /^(\.DS_Store|\.stversions|\.stfolder|\.stignore|Thumbs\.db|desktop\.ini|\.syncthing\..*\.tmp|~syncthing~.*\.tmp|.*\.sync-conflict-.*)$/;

/** What is attached to the chat here, newest names last, as many as a head carries. */
async function attachedFiles(chatId: string): Promise<ChatHead["files"]> {
  try {
    const files = await getChatFiles(chatId);
    return files
      .filter((file) => !NEVER_SYNCED.test(file.name))
      .map((file) => ({ name: file.name, size: file.size }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 64);
  } catch {
    return [];
  }
}

export async function readChatHead(chatId: string): Promise<ChatHead> {
  const chat = await getChat(chatId);
  const messages = chat?.messages ?? [];
  const file = findChatSessionFile(chatId);
  return {
    messages: messages.length,
    lastMessageId: messages.length > 0 ? messages[messages.length - 1].id : null,
    sessionLeaf: file ? await readSessionLeaf(file) : null,
    updatedAt: chat?.updatedAt ?? null,
    files: await attachedFiles(chatId),
  };
}

export type CoverGap = "chat" | "session" | "files";

/** What an earlier look found, so a file that has not changed is not read again. */
interface Memo {
  chat?: { identity: string | null; found: boolean };
  session?: { identity: string | null; found: boolean };
}

/**
 * Whether every attachment the head names is here, whole. Compared by name and
 * size, which is what a file still arriving is not: it is either absent or
 * short.
 */
async function hasAttachments(chatId: string, want: ChatHead["files"]): Promise<boolean> {
  if (want.length === 0) return true;
  const held = new Map((await attachedFiles(chatId)).map((file) => [file.name, file.size]));
  return want.every((file) => held.get(file.name) === file.size);
}

async function fileIdentity(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** Which parts of `want` this side does not hold yet. Empty means it is covered. */
export async function chatGaps(chatId: string, want: ChatHead, memo: Memo = {}): Promise<CoverGap[]> {
  const gaps: CoverGap[] = [];
  if (want.lastMessageId || want.updatedAt) {
    const identity = await chatFileIdentity(chatId);
    if (!memo.chat || memo.chat.identity !== identity) {
      const chat = identity ? await getChat(chatId) : null;
      // The last message is here, and so is the file's latest change (a switch adds no message).
      const hasMessage = !want.lastMessageId || Boolean(chat?.messages.some((message) => message.id === want.lastMessageId));
      const isCurrent = !want.updatedAt || (chat ? !(Date.parse(chat.updatedAt) < Date.parse(want.updatedAt)) : false);
      memo.chat = { identity, found: hasMessage && isCurrent };
    }
    if (!memo.chat.found) gaps.push("chat");
  }
  if (want.sessionLeaf) {
    const file = findChatSessionFile(chatId);
    const identity = file ? await fileIdentity(file) : null;
    if (!memo.session || memo.session.identity !== identity) {
      memo.session = { identity, found: Boolean(file && (await sessionHasEntry(file, want.sessionLeaf))) };
    }
    if (!memo.session.found) gaps.push("session");
  }
  if (want.files.length > 0 && !(await hasAttachments(chatId, want.files))) gaps.push("files");
  return gaps;
}

export interface WaitForCoverOptions {
  timeoutMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Wait for the files to arrive. Resolves with what is still missing: empty when
 * the chat is covered, otherwise the parts that never showed up in time.
 */
export async function waitForCover(chatId: string, want: ChatHead, options: WaitForCoverOptions): Promise<CoverGap[]> {
  const interval = options.intervalMs ?? 400;
  const deadline = Date.now() + options.timeoutMs;
  const memo: Memo = {};
  let gaps = await chatGaps(chatId, want, memo);
  while (gaps.length > 0 && Date.now() < deadline && !options.signal?.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now())));
      if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    });
    gaps = await chatGaps(chatId, want, memo);
  }
  return gaps;
}
