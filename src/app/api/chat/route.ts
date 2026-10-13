import { createUIMessageStreamResponse } from "ai";
import { NextRequest } from "next/server";
import { createPiChatUIMessageStream } from "@/lib/pi/chat-runner";
import { createChat, getChat } from "@/lib/storage/chat-store";
import type { ChatContextMode } from "@/lib/types";
import { isRemoteHome, localNode, remoteEnabled } from "@/lib/remote/config";
import { ensureChatHomeIsHere, prepareRelayedTurn } from "@/lib/remote/executing";
import { recallHandOver, runHandedOverTurn } from "@/lib/remote/proxy-turn";
import { parseHome, REMOTE_HEADERS, type ChatHome } from "@/lib/remote/types";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n/messages";

export const maxDuration = 300; // 5 min max for long agent runs

function formatChatStreamError(error: unknown, t: (key: MessageKey, values?: Record<string, string | number | boolean | null | undefined>) => string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) {
    return t("api.error.generationAfterTools");
  }
  const short = compact.length > 220 ? `${compact.slice(0, 220)}...` : compact;
  return t("api.error.generationAfterToolsDetails", { details: short });
}

function parseContextMode(value: unknown): ChatContextMode | undefined {
  return value === "plain" || value === "files" || value === "full" ? value : undefined;
}

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const body = await req.json();
    const { chatId, currentPath } = body;
    const projectId = typeof body.projectId === "string" && body.projectId.trim() && body.projectId !== "none"
      ? body.projectId.trim()
      : undefined;
    let message: string | undefined = body.message;

    // Support AI SDK's DefaultChatTransport format which sends a `messages` array
    if (!message && Array.isArray(body.messages)) {
      const lastUserMsg = [...body.messages]
        .reverse()
        .find((m: Record<string, unknown>) => m.role === "user");
      if (lastUserMsg) {
        if (typeof lastUserMsg.content === "string") {
          message = lastUserMsg.content;
        } else if (Array.isArray(lastUserMsg.parts)) {
          message = lastUserMsg.parts
            .filter((p: Record<string, unknown>) => p.type === "text")
            .map((p: Record<string, string>) => p.text)
            .join("");
        }
      }
    }

    if (!message || typeof message !== "string") {
      return Response.json(
        { error: t("api.error.messageRequired") },
        { status: 400 }
      );
    }

    // The context mode is the chat's, not the request's: it is settled by
    // whoever opened the chat and every later message inherits it. Trusting the
    // field on each message would let a second tab - or a client that simply
    // forgot it - silently send the next turn of a light chat with the whole
    // workspace attached again.
    const requestedContextMode = parseContextMode(body.contextMode);
    // A new chat can be started somewhere other than where it is typed. Once the
    // chat exists its own home decides, and the request's is ignored.
    const requestedHome = parseHome(body.home);

    // A turn the other side handed over: it runs here, whatever the chat says
    // about where it lives, once the files it needs have arrived.
    let relayedFrom: ChatHome | undefined;
    let joiningRun = false;
    if (req.headers.get(REMOTE_HEADERS.relayed) === "1") {
      const prep = await prepareRelayedTurn(req, {
        chatId: typeof chatId === "string" && chatId ? chatId : undefined,
        projectId,
      });
      if (!prep.ok) return prep.response;
      relayedFrom = prep.from;
      joiningRun = prep.joining;
    }

    // Create chat if needed
    let resolvedChatId: string = typeof chatId === "string" && chatId ? chatId : crypto.randomUUID();
    let contextMode: ChatContextMode | undefined;
    let handOverTo: ChatHome | null = null;
    let chatTitle: string | undefined;
    const existing = typeof chatId === "string" && chatId ? await getChat(resolvedChatId) : null;
    if (existing) {
      contextMode = existing.contextMode;
      chatTitle = existing.title;
      if (!relayedFrom && isRemoteHome(existing.home)) handOverTo = existing.home;
    } else {
      contextMode = requestedContextMode;
      const recalled = !relayedFrom && typeof chatId === "string" && chatId ? recallHandOver(resolvedChatId) : null;
      if (!relayedFrom && isRemoteHome(recalled)) {
        // Started over there a moment ago; its file has not come back yet.
        handOverTo = recalled;
      } else if (!relayedFrom && isRemoteHome(requestedHome)) {
        // Created over there; the file comes back through the sync.
        handOverTo = requestedHome;
      } else {
        const here = remoteEnabled() ? localNode() : null;
        const home = relayedFrom ? here : requestedHome && requestedHome === here ? requestedHome : null;
        await createChat(resolvedChatId, t("api.chat.newTitle"), projectId, contextMode, home ?? undefined);
      }
    }
    if (relayedFrom && !joiningRun) await ensureChatHomeIsHere(resolvedChatId);

    const resolvedCurrentPath = typeof currentPath === "string" ? currentPath : undefined;

    if (handOverTo) {
      return await runHandedOverTurn({
        chatId: resolvedChatId,
        home: handOverTo,
        message,
        projectId,
        contextMode,
        currentPath: resolvedCurrentPath,
        chatTitle,
      });
    }

    if (process.env.EGGENT_AGENT_BACKEND !== "legacy") {
      // Deliberately not `req.signal`: a turn belongs to the chat, not to the
      // connection that started it. Tying the two together meant closing the tab
      // threw the work away, and it is stopped explicitly now - through the stop
      // button, which posts to this chat's stop endpoint, or a stop word.
      const stream = createPiChatUIMessageStream({
        chatId: resolvedChatId,
        userMessage: message,
        projectId,
        chatContextMode: contextMode,
        cwd: resolvedCurrentPath,
        ...(relayedFrom ? { remote: { servedFor: relayedFrom } } : {}),
      });

      return createUIMessageStreamResponse({
        stream,
        headers: {
          "X-Chat-Id": resolvedChatId,
        },
      });
    }

    // Optional legacy fallback: set EGGENT_AGENT_BACKEND=legacy.
    const { runAgent } = await import("@/lib/agent/agent");
    const result = await runAgent({
      chatId: resolvedChatId,
      userMessage: message,
      projectId,
      currentPath: resolvedCurrentPath,
    });

    return result.toUIMessageStreamResponse({
      headers: {
        "X-Chat-Id": resolvedChatId,
      },
      onError: (error) => {
        console.error("Chat stream response error:", error);
        return formatChatStreamError(error, t);
      },
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : t("api.error.internal"),
      },
      { status: 500 }
    );
  }
}
