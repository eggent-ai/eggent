/**
 * What the voice model on a call may do, and what it is told.
 *
 * The voice model only talks. Real work - files, the web, documents, letters -
 * is the agent's, so the voice model has two tools: `delegate`, which hands a
 * task to the ordinary agent in the open chat (a new turn, or a message added
 * to the turn already working, exactly as if the person had typed it), and
 * `status`, which says what that turn is doing. Everything here runs in the
 * browser and has no Node imports, so the screen and the tests read it alike.
 */

export interface VoiceToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const VOICE_TOOLS: VoiceToolDefinition[] = [
  {
    type: "function",
    name: "delegate",
    description:
      "Hand a task to the agent, who works in the open chat with every tool: files, the web, documents, letters, schedules. " +
      "Use it at once for anything that needs doing rather than saying - connecting a service or app, comparing, finding, writing, posting, sending, documents, schedules. " +
      "If the agent is already working, the task is added to what it is doing; if the agent asked the person a question on screen, this is the answer. " +
      "Write the task in the person's own words and language, complete enough to act on without the call.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the agent should do, in the person's words." },
      },
      required: ["task"],
    },
  },
  {
    type: "function",
    name: "status",
    description: "What the agent is doing right now in the chat: whether it is working, its current step and the latest thing it wrote.",
    parameters: { type: "object", properties: {} },
  },
];

/** A message of the open chat, flattened to what a voice model can use. */
export interface VoiceContextMessage {
  role: "user" | "assistant";
  text: string;
}

const RECENT_CHARS = 4000;
const MESSAGE_CHARS = 700;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The newest messages that fit, oldest first. */
export function recentForVoice(messages: VoiceContextMessage[], budget = RECENT_CHARS): VoiceContextMessage[] {
  const kept: VoiceContextMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = clip(messages[i].text, MESSAGE_CHARS);
    if (!text) continue;
    if (used + text.length > budget) break;
    kept.unshift({ role: messages[i].role, text });
    used += text.length;
  }
  return kept;
}

export interface VoiceInstructionsInput {
  /** The workspace interface language, a hint only: the call follows the person's language. */
  locale: string;
  projectName?: string | null;
  recent: VoiceContextMessage[];
}

export function buildVoiceInstructions(input: VoiceInstructionsInput): string {
  const lines = [
    "You are the voice of the person's AI employee in Eggent, on a live phone-style call. The employee behind you is a real agent with every tool of the workspace.",
    "Speak like a capable colleague on the phone: short sentences, one thought at a time, no lists, no markdown, no reading out links or file paths.",
    "Answer in the language the person speaks; if they switch, switch with them." +
      (input.locale ? ` Their interface is set to "${input.locale}", so start in that language until they speak.` : ""),
    "Any request that implies doing something - connect a service (Google, a CRM, a shop, a bank), compare prices, find, write, post to a channel, send a letter, make a document, schedule, remind - goes to the agent at once: call `delegate` with the task in the person's words, in the same turn, before saying anything else. Do not ask whether to do it and do not try to do it yourself; you cannot open files, browse, connect accounts or send anything.",
    "Right after delegating say one short line that you are on it (\"I'm on it\", or the same in the person's language) and keep the conversation going - ask what else, or what matters most. Never invent the result.",
    "Only answer by yourself what is a plain question or conversation that needs no tool.",
    "The agent's work appears in the chat on the person's screen - a connection card, a file, a table. When asked how it is going, or when the person seems to wait, call `status` and say what it shows in one or two sentences.",
    "Messages that start with \"[Agent update]\" come from the agent, not the person: tell the person briefly what changed and what they may need to do on screen (for example press the connect button).",
    "If something is unclear, ask one short question.",
  ];
  if (input.projectName) lines.push(`The chat belongs to the project "${clip(input.projectName, 80)}".`);
  if (input.recent.length) {
    lines.push("", "The chat so far (oldest first), for context only - do not read it out:");
    for (const message of input.recent) lines.push(`${message.role === "user" ? "Person" : "Agent"}: ${message.text}`);
  }
  return lines.join("\n");
}

/** What the summary at the end of a call is asked for. */
export function buildSummaryInstructions(): string {
  return [
    "The call is over. Write a short summary of it as plain text for the chat, in the language the call was held in:",
    "two to five short lines - what was discussed, what was handed to the agent, what is left open.",
    "No greeting, no heading, nothing that was not said on the call.",
  ].join(" ");
}

// --- the agent's turn, as the voice model is told it -----------------------

/** A message part as the chat screen holds it (the AI SDK's UI message part). */
export interface TurnPart {
  type: string;
  text?: string;
  state?: string;
  toolName?: string;
}

export interface TurnMessage {
  role: string;
  parts: TurnPart[];
}

export interface TurnStatus {
  running: boolean;
  /** Tools working right now. */
  doing: string[];
  /** The last few tools that finished. */
  done: string[];
  /** The end of the newest thing the agent wrote. */
  latestText: string;
  /** A question the agent put on screen and waits on, with its choices. */
  question?: { text: string; options?: string[] };
}

/** A question card as the chat holds it, reduced to what can be said aloud. */
export interface VoiceQuestion {
  id: string;
  title: string;
  message?: string;
  options?: string[];
}

export function questionForVoice(question: VoiceQuestion | null | undefined): TurnStatus["question"] {
  if (!question) return undefined;
  const text = [question.title, question.message].filter((part) => part && part.trim()).join(" - ").replace(/\s+/g, " ").trim().slice(0, 600);
  const options = (question.options ?? []).filter((option) => typeof option === "string" && option.trim()).slice(0, 8);
  return { text, ...(options.length ? { options } : {}) };
}

/** What the voice model is told when a question appears on screen. */
export function questionUpdate(question: VoiceQuestion): string {
  const said = questionForVoice(question)!;
  return `[Agent update] The agent asks the person on screen: ${said.text}${said.options ? ` Choices: ${said.options.join("; ")}.` : ""} Ask the person in a short sentence and pass their answer with \`delegate\`.`;
}

function toolNameOf(part: TurnPart): string | null {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  if (part.type.startsWith("tool-")) return part.toolName || part.type.slice(5);
  return null;
}

/** What the newest answer shows: the running tools, the finished ones, the latest words. */
export function describeTurn(messages: TurnMessage[], running: boolean, question?: VoiceQuestion | null): TurnStatus {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  const asked = questionForVoice(question);
  const status: TurnStatus = { running, doing: [], done: [], latestText: "", ...(asked ? { question: asked } : {}) };
  if (!last) return status;
  let text = "";
  for (const part of last.parts) {
    const tool = toolNameOf(part);
    if (tool) {
      if (part.state === "output-available" || part.state === "output-error") status.done.push(tool);
      else if (running) status.doing.push(tool);
    } else if (part.type === "text" && part.text) {
      text = part.text;
    }
  }
  status.done = status.done.slice(-3);
  const flat = text.replace(/\s+/g, " ").trim();
  status.latestText = flat.length > 500 ? `…${flat.slice(-499)}` : flat;
  return status;
}

/** The chat's messages as a voice model can use them: who said what, in words. */
export function voiceContextOf(messages: TurnMessage[]): VoiceContextMessage[] {
  const out: VoiceContextMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join(" ").trim();
    if (text) out.push({ role: message.role, text });
  }
  return out;
}

// --- running a tool call ---------------------------------------------------

export type DelegateResult = "started" | "added" | "answered";

export interface VoiceToolDeps {
  /** Starts a turn with this text, adds it to the turn already working, or answers the question it waits on. Answers which. */
  delegate(task: string): DelegateResult | Promise<DelegateResult>;
  /** What the turn in the open chat is doing. */
  turn(): TurnStatus;
}

const MAX_TASK_CHARS = 8000;

/**
 * One function call from the voice model, answered as the JSON its output
 * carries. A malformed call is answered with what was wrong, so the model can
 * say so rather than claim it was done.
 */
export async function runVoiceTool(name: string, rawArguments: string, deps: VoiceToolDeps): Promise<Record<string, unknown>> {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = rawArguments ? JSON.parse(rawArguments) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "The arguments were not JSON." };
  }
  if (name === "delegate") {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!task) return { ok: false, error: "No task was given." };
    if (task.length > MAX_TASK_CHARS) return { ok: false, error: "The task is too long to hand over by voice." };
    try {
      const how = await deps.delegate(task);
      return {
        ok: true,
        how,
        note: how === "answered"
          ? "This answered the question the agent was waiting on; it carries on. Tell the person in a few words."
          : how === "added"
            ? "Added to what the agent is already doing. Tell the person in a few words."
            : "The agent has started on it in the chat. Tell the person in a few words; do not invent the result.",
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The task could not be handed over." };
    }
  }
  if (name === "status") {
    const turn = deps.turn();
    return { ok: true, ...turn };
  }
  return { ok: false, error: `There is no tool called ${name}.` };
}

// --- nobody on the line ----------------------------------------------------

/**
 * A call costs money for every minute it is open, whoever is on it, so a call
 * nobody is in ends: 45 seconds with nothing said by either side brings a
 * spoken warning, and if the person still says nothing for 15 seconds after
 * it, the call ends - about a minute in all. Two minutes with the microphone
 * muted end it too; a muted microphone is silence on purpose, so only that
 * rule applies while it is muted.
 */
export const IDLE_WARN_MS = 45_000;
export const IDLE_GRACE_AFTER_WARNING_MS = 15_000;
export const MUTED_END_MS = 120_000;

export interface CallWatchInput {
  now: number;
  lastPersonAt: number;
  lastAgentAt: number;
  /** When the microphone was muted, if it is. */
  mutedSince: number | null;
  /** When the warning was given, if it has been since the person last spoke. */
  warnedAt: number | null;
}

export type CallWatch = "ok" | "warn" | "end-idle" | "end-muted";

export function watchCall(input: CallWatchInput): CallWatch {
  if (input.mutedSince !== null) return input.now - input.mutedSince >= MUTED_END_MS ? "end-muted" : "ok";
  if (input.warnedAt !== null) {
    if (input.lastPersonAt > input.warnedAt) return "ok";
    return input.now - input.warnedAt >= IDLE_GRACE_AFTER_WARNING_MS ? "end-idle" : "ok";
  }
  return input.now - Math.max(input.lastPersonAt, input.lastAgentAt) >= IDLE_WARN_MS ? "warn" : "ok";
}

/** What the voice model is asked to say when the line has gone quiet. */
export const IDLE_WARNING_NOTE =
  "[Call note - not from the person] The person has said nothing for a while. In one short sentence, in their language, ask whether they are still there and say you will hang up in a few seconds if not; the agent's results will stay in the chat.";

/** What the voice model is asked to say before the call ends for money or time. */
export function endingNote(reason: "balance" | "time"): string {
  const why = reason === "balance" ? "the balance for calls has run out" : "the call has reached its time limit";
  return `[Call note - not from the person] The call is ending now because ${why}. Say so in one short sentence in the person's language, mention that the agent's work stays in the chat, and say goodbye.`;
}

// --- the call's record -----------------------------------------------------

export interface VoiceTranscriptLine {
  role: "user" | "agent";
  text: string;
}

/** "02:04" for 124 seconds; hours only past the first one. */
export function formatCallLength(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const MAX_LINES = 400;
const MAX_LINE_CHARS = 4000;

/** A transcript sent by the page, kept to its shape: two roles, plain text, bounded. */
export function cleanTranscript(value: unknown): VoiceTranscriptLine[] {
  if (!Array.isArray(value)) return [];
  const lines: VoiceTranscriptLine[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const text = (item as { text?: unknown }).text;
    if ((role !== "user" && role !== "agent") || typeof text !== "string") continue;
    const trimmed = text.trim().slice(0, MAX_LINE_CHARS);
    if (!trimmed) continue;
    lines.push({ role, text: trimmed });
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}
