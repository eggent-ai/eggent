import type { PiPendingInteraction } from "@/lib/pi/interaction-types";
import type { ChatMessage } from "@/lib/types";

/**
 * A turn that stops to ask the person something is written down at that
 * moment, not only when it ends.
 *
 * It used to reach the stored chat only at the end, and a turn waiting on a
 * question has no end until somebody answers. Whoever left at the question -
 * which is most people on their first card - came back after the workspace
 * slept to a chat holding their own message and nothing else, while the work
 * sat in the pi session where nobody can see it: a finished video, a 19-step
 * analysis of bank statements, six first launches in five days.
 *
 * The checkpoint is replaced in place when the turn ends, so a turn that is
 * answered leaves one message, not two.
 */

/** Tool messages written beside a checkpoint carry its id, so replacing it removes them too. */
export function checkpointToolMessageId(checkpointId: string, toolCallId: string): string {
  return `${checkpointId}:tool:${toolCallId}`;
}

/**
 * Puts `next` where the checkpoint `replaceId` stood, or at the end when there
 * is none. Position matters: anything written after the checkpoint (a message
 * steered in from another tab) stays after the turn it interrupted.
 */
export function spliceAssistantTurn(
  messages: ChatMessage[],
  replaceId: string | undefined,
  next: ChatMessage[]
): ChatMessage[] {
  if (!replaceId) return [...messages, ...next];
  const belongs = (message: ChatMessage) =>
    message.id === replaceId || message.id.startsWith(`${replaceId}:`);
  const at = messages.findIndex(belongs);
  if (at === -1) return [...messages, ...next];
  const kept = messages.filter((message) => !belongs(message));
  return [...kept.slice(0, at), ...next, ...kept.slice(at)];
}

/**
 * The question as the transcript shows it once the card is gone. A card lives
 * only in the stream, so without this a reloaded chat ends on whatever the agent
 * said before asking - often nothing - and the person cannot tell they were
 * asked anything. A typed reply in the composer is still a valid answer.
 */
export function describeInteractionForTranscript(interaction: PiPendingInteraction): string {
  const title = interaction.title?.trim() ?? "";
  const message = interaction.message?.trim() ?? "";
  const lines: string[] = [];
  if (title) lines.push(`**${title}**`);
  if (message && message !== title) lines.push(message);
  for (const option of interaction.options ?? []) {
    const text = option.trim();
    if (text) lines.push(`- ${text}`);
  }
  return lines.join("\n");
}
