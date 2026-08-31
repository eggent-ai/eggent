import { createUIMessageStreamResponse } from "ai";
import { NextRequest } from "next/server";
import { createPiChatUIMessageStream } from "@/lib/pi/chat-runner";
import { createChat, getChat } from "@/lib/storage/chat-store";
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

    // Create chat if needed
    let resolvedChatId = chatId;
    if (!resolvedChatId) {
      resolvedChatId = crypto.randomUUID();
      await createChat(resolvedChatId, t("api.chat.newTitle"), projectId);
    } else {
      const existing = await getChat(resolvedChatId);
      if (!existing) {
        await createChat(resolvedChatId, t("api.chat.newTitle"), projectId);
      }
    }

    const resolvedCurrentPath = typeof currentPath === "string" ? currentPath : undefined;

    if (process.env.EGGENT_AGENT_BACKEND !== "legacy") {
      // Deliberately not `req.signal`: a turn belongs to the chat, not to the
      // connection that started it. Tying the two together meant closing the tab
      // threw the work away, and it is stopped explicitly now - through the stop
      // button, which posts to this chat's stop endpoint, or a stop word.
      const stream = createPiChatUIMessageStream({
        chatId: resolvedChatId,
        userMessage: message,
        projectId,
        cwd: resolvedCurrentPath,
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
