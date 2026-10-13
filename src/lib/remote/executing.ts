import { getServerTranslator } from "@/i18n/server";
import { getActiveRun } from "@/lib/pi/active-runs";
import { coverWaitMs, isRemoteHome, localNode, remoteEnabled } from "@/lib/remote/config";
import { stampAfter } from "@/lib/remote/stamp";
import { waitForCover } from "@/lib/remote/head";
import { whereLabel, remoteFailureMessage } from "@/lib/remote/proxy-turn";
import {
  parseHome,
  REMOTE_HEADERS,
  RemoteError,
  type ChatHead,
  type ChatHome,
} from "@/lib/remote/types";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { getProject } from "@/lib/storage/project-store";

/**
 * The side that runs a turn somebody else's screen is showing.
 *
 * Before the agent is let in, this side checks it can do the job properly: that
 * the conversation it was asked to continue is all here, and the project it
 * belongs to. Files arrive on their own schedule, so the check waits for them -
 * a few seconds is the ordinary case - and refuses, with the reason, when they
 * do not come.
 */

export type RelayedPrep =
  | { ok: true; from: ChatHome; joining: boolean }
  | { ok: false; response: Response };

async function refusal(error: RemoteError, from: ChatHome | undefined): Promise<RelayedPrep> {
  const t = await getServerTranslator();
  const where = from ? await whereLabel(from, t) : t("remote.where.yourComputer");
  return {
    ok: false,
    response: Response.json(
      { error: remoteFailureMessage(error, t, where), code: error.code, ...(from ? { home: from } : {}) },
      { status: error.status }
    ),
  };
}

function waitUntil(check: () => Promise<boolean>, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      if (await check()) return true;
      if (Date.now() >= deadline || signal?.aborted) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 400);
        if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
      });
    }
  })();
}

export async function prepareRelayedTurn(
  req: Request,
  input: { chatId?: string; projectId?: string; head?: ChatHead | null }
): Promise<RelayedPrep> {
  if (!remoteEnabled()) return refusal(new RemoteError("disabled", "Handing chats over is not set up here."), undefined);

  const from = parseHome(req.headers.get(REMOTE_HEADERS.from));
  if (!from || from === localNode()) {
    return refusal(new RemoteError("failed", "A handed-over turn has to say which side it comes from.", { status: 400 }), undefined);
  }

  // A message for a turn that is already running here is not a new turn: it
  // steers that one, and what it needs is the run, not the files.
  if (input.chatId && getActiveRun(input.chatId)) return { ok: true, from, joining: true };

  // A message that was only meant for a turn that was running, sent a moment too
  // late: that turn is over, and what it asked is not a new turn for nobody to watch.
  if (req.headers.get(REMOTE_HEADERS.steer) === "1") {
    return refusal(new RemoteError("not-running", "No turn is running in this chat to join.", { home: from }), from);
  }

  const want = input.head ?? null;

  // The sender's copy of the chat is older than this side's, and this side's says the
  // chat lives somewhere else: the person moved it a moment ago and the sender has not
  // heard. Running the turn here would undo the move without a word.
  if (input.chatId && want?.updatedAt) {
    const mine = await getChat(input.chatId);
    if (mine && isRemoteHome(mine.home) && Date.parse(mine.updatedAt) > Date.parse(want.updatedAt)) {
      return refusal(new RemoteError("moved", "This chat was moved in the meantime.", { home: mine.home }), from);
    }
  }

  if (input.chatId && want) {
    const gaps = await waitForCover(input.chatId, want, { timeoutMs: coverWaitMs(), signal: req.signal });
    if (gaps.length > 0) {
      console.warn(`[remote] chat ${input.chatId.slice(0, 8)} from ${from} had not arrived (${gaps.join(", ")} missing)`);
      return refusal(new RemoteError("not-synced", "The chat has not arrived yet.", { home: from }), from);
    }
  }

  if (input.projectId) {
    const projectId = input.projectId;
    const found = await waitUntil(async () => Boolean(await getProject(projectId)), coverWaitMs(), req.signal);
    if (!found) {
      return refusal(new RemoteError("not-synced", "The project has not arrived yet.", { home: from }), from);
    }
  }

  // The sender gave up while this side was getting ready - it pressed stop, or its
  // patience ran out. The files may well have arrived in the same moment, and
  // starting the turn now would run what the person had just taken back.
  if (req.signal.aborted) {
    return refusal(new RemoteError("failed", "The request was withdrawn before the turn started.", { home: from }), from);
  }

  return { ok: true, from, joining: false };
}

/**
 * Record on the chat that it runs here.
 *
 * The person switched it on the other side, and that write travels here as a
 * file like any other - possibly after this side has already rewritten its own,
 * older copy. Saying it again when the turn arrives means a copy that has not
 * caught up cannot turn the switch back.
 */
export async function ensureChatHomeIsHere(chatId: string): Promise<void> {
  const me = localNode();
  if (!me) return;
  const chat = await getChat(chatId);
  if (!chat || chat.home === me) return;
  chat.home = me;
  chat.updatedAt = stampAfter(chat.updatedAt);
  await saveChat(chat);
}
