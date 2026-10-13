import { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { getActiveRun } from "@/lib/pi/active-runs";
import { getLiveRun } from "@/lib/pi/live-run";
import { localNode, remoteEnabled, switchWaitMs } from "@/lib/remote/config";
import { waitForCover } from "@/lib/remote/head";
import { forgetHandOver, recallHandOver, remoteChatState, remoteFailureMessage, whereLabel } from "@/lib/remote/proxy-turn";
import { stampAfter } from "@/lib/remote/stamp";
import { listDevices } from "@/lib/remote/relay-client";
import { isDeviceHome, parseHome, RemoteError, type ChatHome } from "@/lib/remote/types";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";

async function refuse(error: RemoteError, home: ChatHome | undefined): Promise<Response> {
  const t = await getServerTranslator();
  const where = home ? await whereLabel(home, t) : t("remote.where.yourComputer");
  return Response.json(
    { error: remoteFailureMessage(error, t, where), code: error.code, ...(home ? { home } : {}) },
    { status: error.status }
  );
}

/**
 * Choose where a chat runs: this side, or the other one.
 *
 * Switching is the person's explicit act and nothing else does it. A switch to
 * a computer is refused unless that computer could take the chat right now, so
 * the screen never offers a place that would only fail on the first message.
 * A chat that does not exist yet has nothing to store: the choice rides on its
 * first message instead, and this answers that it is fine.
 */
export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));

  if (!remoteEnabled()) return refuse(new RemoteError("disabled", "Handing chats over is not set up here."), undefined);
  const me = localNode()!;

  const body = (await req.json().catch(() => ({}))) as { chatId?: unknown; home?: unknown };
  const clearing = body.home === null;
  const home = clearing ? null : parseHome(body.home);
  if (!clearing && !home) return jsonError("home must be \"cloud\", a device, or null", 400);

  // A computer has exactly one other place. Two computers talk through the workspace, never to each other.
  if (home && me !== "cloud" && home !== "cloud" && home !== me) {
    return jsonError("A computer can only hand a chat to the cloud", 400);
  }

  const chatId = typeof body.chatId === "string" ? body.chatId : "";

  if (home && home !== me) {
    try {
      const devices = await listDevices(req.signal);
      if (isDeviceHome(home)) {
        const device = devices.find((candidate) => candidate.node === home);
        if (!device || !device.online || !device.accept) throw new RemoteError("offline", "That computer is not available.", { home });
        if (!device.historyShared) throw new RemoteError("not-ready", "That computer does not share its chat history.", { home });
      }
    } catch (error) {
      const failure = error instanceof RemoteError ? error : new RemoteError("offline", error instanceof Error ? error.message : String(error), { home });
      return refuse(failure, home);
    }
  }

  if (!chatId) return Response.json({ ok: true, home, stored: false });
  const chat = await getChat(chatId);
  if (!chat) {
    // A chat this side handed over a moment ago and has not got back yet lives over
    // there and nowhere else. Moving it from here would let the next message start
    // a chat of the same name on this side: two chats, two agent sessions, one id.
    const handedTo = recallHandOver(chatId);
    if (handedTo && handedTo !== home) {
      return refuse(new RemoteError("not-synced", "The chat has not come back from where it was started yet.", { home: me }), me);
    }
    forgetHandOver(chatId);
    return Response.json({ ok: true, home, stored: false });
  }

  if (getActiveRun(chatId) || getLiveRun(chatId)) {
    return refuse(new RemoteError("busy", "This chat is working right now.", { home: home ?? undefined }), home ?? undefined);
  }

  if ((chat.home ?? null) === home) return Response.json({ ok: true, home, stored: true });

  // A turn on the other side is the chat working too, and nothing here can see it:
  // moving the chat under it would put a second agent in the same conversation.
  const otherSide: ChatHome | null =
    me !== "cloud" ? "cloud" : isDeviceHome(chat.home) ? chat.home : home && isDeviceHome(home) ? home : null;
  const other = otherSide ? await remoteChatState(chatId, otherSide) : null;
  if (other?.running) {
    return refuse(new RemoteError("busy", "This chat is working right now.", { home: home ?? undefined }), home ?? undefined);
  }
  if (other) {
    // This side is about to write the file. It has to hold what the other side
    // wrote first, or the move is written over a copy that is behind - and the
    // next turn here runs without the exchange the other side just had.
    const gaps = await waitForCover(chatId, other.head, { timeoutMs: switchWaitMs(), signal: req.signal });
    if (gaps.length > 0) {
      return refuse(new RemoteError("not-synced", "The chat has not arrived here yet.", { home: me }), me);
    }
  }
  forgetHandOver(chatId);

  if (home) chat.home = home;
  else delete chat.home;
  // The newer copy wins when the two sides' files are joined, so a switch has to be newer than the file it changes.
  chat.updatedAt = stampAfter(chat.updatedAt);
  await saveChat(chat);
  return Response.json({ ok: true, home, stored: true });
}
