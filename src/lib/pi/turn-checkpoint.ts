import type { PiPendingInteraction } from "@/lib/pi/interaction-types";
import type { PiRuntimeStats, PiToolRecord } from "@/lib/pi/types";
import type { ProducedGroup } from "@/lib/files/produced-shape";
import type { ChatMessage, ChatMessagePart } from "@/lib/types";

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
 * is none. Position matters: anything written after the checkpoint stays after
 * the turn it interrupted.
 *
 * A message said to this turn while it worked (`runId`, see steer.ts) is written
 * down at the end of the chat when it is sent, before the turn has an answer
 * stored. The turn goes in front of the first of them: one still waiting stays
 * after the answer so far, and one the agent has read is part of `next` and is
 * moved into it.
 */
export function spliceAssistantTurn(
  messages: ChatMessage[],
  replaceId: string | undefined,
  next: ChatMessage[],
  runId?: string
): ChatMessage[] {
  const nextIds = new Set(next.map((message) => message.id));
  const belongs = (message: ChatMessage) =>
    nextIds.has(message.id) ||
    (replaceId !== undefined && (message.id === replaceId || message.id.startsWith(`${replaceId}:`)));
  const at = messages.findIndex(
    (message) => belongs(message) || (runId !== undefined && message.steer?.runId === runId)
  );
  const kept = messages.filter((message) => !belongs(message));
  if (at === -1) return [...kept, ...next];
  const keptBefore = messages.slice(0, at).filter((message) => !belongs(message)).length;
  return [...kept.slice(0, keptBefore), ...next, ...kept.slice(keptBefore)];
}

/** The turn as it runs: its text, its tool calls, and where a message said to it was read. */
export type TurnTimelinePart = ChatMessagePart | { type: "steer"; messageId: string };

/** A message said to the turn that the agent read, as the stored chat needs it. */
export interface ReadSteer {
  messageId: string;
  text: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface TurnBlockInput {
  /** The first answer's id; the ones after a message said to the turn hang off it. */
  baseId: string;
  /** Written while the turn still runs: every answer carries `inProgress`, tool messages a derived id. */
  checkpoint: boolean;
  now: string;
  /** The whole answer's text, used as it is when nobody said anything to the turn. */
  assistantText: string;
  parts: TurnTimelinePart[];
  /** The calls that have finished; one still running is not written down. */
  tools: PiToolRecord[];
  runtimeStats?: PiRuntimeStats;
  files?: ProducedGroup[];
  runId?: string;
  steers?: ReadonlyMap<string, ReadSteer>;
  /** How a call is written down: its arguments, and its result as text. */
  describeTool: (tool: PiToolRecord) => { args: Record<string, unknown>; content: string };
}

function textOfParts(parts: ChatMessagePart[]): string {
  return parts
    .filter((part): part is Extract<ChatMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * The messages a turn is stored as.
 *
 * One answer and its tool results, as always - unless the person said something
 * while it worked. Then it is cut where the agent read each message: the answer
 * up to there, the person's words, the answer after. Read top to bottom, the
 * chat says what happened in the order it happened; the agent's own record (the
 * runtime session) has the message at the same point.
 */
export function buildTurnBlock(input: TurnBlockInput): ChatMessage[] {
  const completed = input.tools.filter((tool) => tool.status !== "running");
  const toolsById = new Map(completed.map((tool) => [tool.toolCallId, tool]));
  const segments: Array<{ steerBefore?: string; parts: ChatMessagePart[] }> = [{ parts: [] }];
  for (const part of input.parts) {
    if (part.type === "steer") {
      segments.push({ steerBefore: part.messageId, parts: [] });
      continue;
    }
    segments[segments.length - 1].parts.push(part);
  }

  // A call the timeline does not show still belongs to the turn: it goes with the last answer.
  const placed = new Set(
    input.parts.flatMap((part) => (part.type === "tool" ? [part.toolCallId] : []))
  );
  const unplaced = completed.filter((tool) => !placed.has(tool.toolCallId));

  const single = segments.length === 1;
  const written: ChatMessage[] = [];
  segments.forEach((segment, index) => {
    if (segment.steerBefore) {
      const steer = input.steers?.get(segment.steerBefore);
      if (steer) {
        written.push({
          id: steer.messageId,
          role: "user",
          content: steer.text,
          createdAt: steer.createdAt,
          ...(input.runId
            ? { steer: { runId: input.runId, state: "delivered" as const, ...(steer.deliveredAt ? { deliveredAt: steer.deliveredAt } : {}) } }
            : {}),
        });
      }
    }

    const last = index === segments.length - 1;
    const segmentTools = [
      ...segment.parts.flatMap((part) => (part.type === "tool" && toolsById.has(part.toolCallId) ? [toolsById.get(part.toolCallId)!] : [])),
      ...(last ? unplaced : []),
    ];
    const content = single ? input.assistantText : textOfParts(segment.parts);
    const carriesTurn = last && (Boolean(input.runtimeStats) || Boolean(input.files?.length));
    if (!content.trim() && segmentTools.length === 0 && !carriesTurn) return;

    const id = index === 0 ? input.baseId : `${input.baseId}:seg:${index}`;
    written.push({
      id,
      role: "assistant",
      content,
      createdAt: input.now,
      toolCalls: segmentTools.map((tool) => ({
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        args: input.describeTool(tool).args,
      })),
      parts: segment.parts,
      ...(last && input.runtimeStats ? { piRuntimeStats: input.runtimeStats } : {}),
      ...(last && input.files?.length ? { files: input.files } : {}),
      ...(input.checkpoint ? { inProgress: true } : {}),
    });
    for (const tool of segmentTools) {
      written.push({
        id: input.checkpoint ? checkpointToolMessageId(input.baseId, tool.toolCallId) : crypto.randomUUID(),
        role: "tool",
        content: input.describeTool(tool).content,
        createdAt: input.now,
        toolName: tool.toolName,
        toolCallId: tool.toolCallId,
        toolResult: tool.output,
      });
    }
  });
  return written;
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
