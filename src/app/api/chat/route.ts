import { NextRequest } from "next/server";
import { runAgent } from "@/lib/agent/agent";
import { createChat, getChat } from "@/lib/storage/chat-store";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";

export const maxDuration = 300; // 5 min max for long agent runs

export async function POST(req: NextRequest) {
  try {
    await ensureCronSchedulerStarted();
    const body = await req.json();
    const { chatId, projectId, currentPath } = body;
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

    // Run agent and return streaming response
    const result = await runAgent({
      chatId: resolvedChatId,
      userMessage: message,
      projectId,
      currentPath: typeof currentPath === "string" ? currentPath : undefined,
    });

    return result.toUIMessageStreamResponse({
      headers: {
        "X-Chat-Id": resolvedChatId,
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
