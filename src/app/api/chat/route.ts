import { createUIMessageStreamResponse } from "ai";
import { NextRequest } from "next/server";
import { createPiChatUIMessageStream } from "@/lib/pi/chat-runner";
import { createChat, getChat } from "@/lib/storage/chat-store";

export const maxDuration = 300; // 5 min max for long agent runs

function formatChatStreamError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Generation failed after tool execution. Please retry.";
  }
  const short = compact.length > 220 ? `${compact.slice(0, 220)}...` : compact;
  return `Generation failed after tool execution: ${short}`;
}

export async function POST(req: NextRequest) {
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
        { error: "Message is required" },
        { status: 400 }
      );
    }

    // Create chat if needed
    let resolvedChatId = chatId;
    if (!resolvedChatId) {
      resolvedChatId = crypto.randomUUID();
      await createChat(resolvedChatId, "New Chat", projectId);
    } else {
      const existing = await getChat(resolvedChatId);
      if (!existing) {
        await createChat(resolvedChatId, "New Chat", projectId);
      }
    }

    const resolvedCurrentPath = typeof currentPath === "string" ? currentPath : undefined;

    if (process.env.EGGENT_AGENT_BACKEND !== "legacy") {
      const stream = createPiChatUIMessageStream({
        chatId: resolvedChatId,
        userMessage: message,
        projectId,
        cwd: resolvedCurrentPath,
        abortSignal: req.signal,
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
        return formatChatStreamError(error);
      },
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
