import type { UIMessage } from "ai";
import type { ChatMessage, ChatMessagePart } from "@/lib/types";
import type { PiPendingInteraction } from "@/lib/pi/interaction-types";

/**
 * The stored chat as the screen draws it, and what the screen reads back out
 * of it. Shared by the workspace's own chat and the chat a guest of a shared
 * project sees, so both draw one conversation the same way.
 */

export function isPiInteraction(value: unknown): value is PiPendingInteraction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.runId === "string" &&
    typeof record.kind === "string" &&
    typeof record.title === "string" &&
    typeof record.status === "string"
  );
}

export function getLatestPendingInteraction(messages: UIMessage[]): PiPendingInteraction | null {
  const closedInteractionIds = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (let j = message.parts.length - 1; j >= 0; j -= 1) {
      const part = message.parts[j] as { type?: string; data?: unknown };
      if (part.type !== "data-piInteraction" || !isPiInteraction(part.data)) continue;
      if (part.data.status === "pending" && !closedInteractionIds.has(part.data.id)) {
        return part.data;
      }
      if (part.data.status !== "pending") {
        closedInteractionIds.add(part.data.id);
      }
    }
  }
  return null;
}

export function storedPartToUIPart(part: ChatMessagePart): UIMessage["parts"][number] | null {
  if (part.type === "text") {
    return { type: "text" as const, text: part.text };
  }

  return {
    type: `tool-${part.toolName}` as `tool-${string}`,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    state: part.status === "error" ? "output-error" as const : "output-available" as const,
    input: part.args,
    output: part.output ?? "",
  } as unknown as UIMessage["parts"][number];
}

/** Convert stored ChatMessage to UIMessage (parts format for useChat) */
export function chatMessagesToUIMessages(chatMessages: ChatMessage[]): UIMessage[] {
  const result: UIMessage[] = [];

  // Build a map of toolCallId -> tool result for pairing
  const toolResultMap = new Map<string, ChatMessage>();
  for (const m of chatMessages) {
    if (m.role === "tool" && m.toolCallId) {
      toolResultMap.set(m.toolCallId, m);
    }
  }

  for (const m of chatMessages) {
    if (m.role === "user") {
      result.push({
        id: m.id,
        role: "user",
        // Said to a turn while it worked: read where it stands, or marked as never read (see steer.ts).
        metadata: { createdAt: m.createdAt, ...(m.steer ? { steer: m.steer } : {}) },
        parts: [{ type: "text" as const, text: m.content }],
      });
    } else if (m.role === "assistant") {
      const parts: UIMessage["parts"] = [];

      if (m.parts?.length) {
        for (const storedPart of m.parts) {
          const uiPart = storedPartToUIPart(storedPart);
          if (uiPart) parts.push(uiPart);
          // A helper's progress travels as the same data part it streamed as, so
          // a reloaded chat draws its helpers exactly as they were watched.
          if (storedPart.type === "tool" && storedPart.subagent) {
            parts.push({
              type: "data-piSubagent",
              id: `pi-subagent-${storedPart.toolCallId}`,
              data: storedPart.subagent,
            } as UIMessage["parts"][number]);
          }
        }
      } else {
        // Legacy chats did not persist ordered parts. Keep the old fallback shape.
        if (m.toolCalls && m.toolCalls.length > 0) {
          for (const tc of m.toolCalls) {
            const toolResult = toolResultMap.get(tc.toolCallId);
            parts.push({
              type: `tool-${tc.toolName}` as `tool-${string}`,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              state: "output-available" as const,
              input: tc.args,
              output: toolResult?.toolResult ?? toolResult?.content ?? "",
            } as unknown as UIMessage["parts"][number]);
          }
        }

        if (m.content) {
          parts.push({ type: "text" as const, text: m.content });
        }
      }

      // Keep runtime stats in the message stream so the footer remains
      // populated after the live stream is replaced by stored chat history.
      if (m.piRuntimeStats) {
        parts.push({
          type: "data-piStats",
          id: `pi-stats-${m.id}`,
          data: m.piRuntimeStats,
        } as UIMessage["parts"][number]);
      }

      // The files this turn made, for the row under the answer.
      if (m.files?.length) {
        parts.push({
          type: "data-eggentFiles",
          id: `files-${m.id}`,
          data: m.files,
        } as UIMessage["parts"][number]);
      }

      // What the agent saved after this answer, once it had looked back over it.
      if (m.learned?.items?.length) {
        parts.push({
          type: "data-eggentLearned",
          id: `learned-${m.id}`,
          data: m.learned,
        } as UIMessage["parts"][number]);
      }

      // Replies that came to letters the agent sent from this chat.
      if (m.emailReplies?.length) {
        parts.push({
          type: "data-eggentEmailReplies",
          id: `email-replies-${m.id}`,
          data: m.emailReplies,
        } as UIMessage["parts"][number]);
      }

      // Only add message if it has content
      if (parts.length > 0) {
        result.push({
          id: m.id,
          role: "assistant",
          parts,
        });
      }
    }
    // Skip "tool" role messages - they are paired with assistant toolCalls above
  }

  return result;
}
