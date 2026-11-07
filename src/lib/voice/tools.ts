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
      "Write the task in the person's own words and language, complete enough to act on without the call. " +
      "Add nothing they did not say: no conditions (such as \"without sending\"), no service to take something from, no guesses about where an address or a file is. The agent knows the workspace and finds those itself. " +
      "When the person adds to or corrects the task you have just passed on (a name they had not said yet, \"no, call it X\", \"and also...\"), pass only the correction with amends set to true - never the whole task again as a new one, or the agent does it twice.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the agent should do, in the person's words; for a correction, only what changes." },
        amends: { type: "boolean", description: "True when this corrects or completes the task passed on just before, rather than being a new task." },
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
    "Any request that implies doing something - connect a service or an app, compare prices, find, write, post to a channel, send a letter, make a document, schedule, remind - goes to the agent at once: call `delegate` with the task in the person's words, in the same turn, before saying anything else. Do not ask whether to do it and do not try to do it yourself; you cannot open files, browse, connect accounts or send anything.",
    "Pass the request as the person said it. Do not add conditions they did not set, and do not decide how it is done or where something comes from. If they said \"write\", do not add \"without sending\"; if they said \"send it to me\", do not add where their address comes from.",
    "Do not ask the person for things the agent may already know - their own email address, their accounts, their files. The agent has its own mailbox and sends a letter to the person without being given an address. Delegate, and let the agent ask on screen if it really needs something.",
    "Right after delegating say one short line that you are on it (\"I'm on it\", or the same in the person's language) and keep the conversation going - ask what else, or what matters most. Never invent the result.",
    "If the person goes on about the task you just passed on - finishes the sentence, names what they had not named, changes their mind - that is a correction to the same task: call `delegate` with only the correction and `amends: true`. One thing asked for is one task, however many breaths it took to say.",
    "Only answer by yourself what is a plain question or conversation that needs no tool.",
    "The agent's work appears in the chat on the person's screen - a connection card, a file, a table. When asked how it is going, or when the person seems to wait, call `status` and say what it shows in one or two sentences.",
    "Messages that start with \"[Agent update]\" come from the agent, not the person: tell the person briefly what changed and what they may need to do on screen (for example press the connect button).",
    "If an update only repeats what you have just said or asked, do not say it again: one or two words are enough.",
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

// --- the provider's own shapes ---------------------------------------------

/**
 * Which session shape the provider speaks, as the deployment says: "openai-ga"
 * is the OpenAI Realtime GA shape (voice and turn detection inside `audio`);
 * "flat" has both at the top of the session.
 */
export type VoiceProtocol = "openai-ga" | "flat";

export interface SessionInput {
  protocol: VoiceProtocol;
  voice: string;
  instructions: string;
  /** How long a pause ends the person's turn. */
  silenceMs: number;
  /** How loud a sound has to be to count as speech, 0..1: higher ignores more of the room. */
  threshold?: number;
  /** The provider's model for writing down what the person says, when it needs one named. */
  transcriptionModel?: string | null;
}

const PCM = { type: "audio/pcm", rate: 24000 };

/** The session.update that opens a call. */
export function sessionUpdate(input: SessionInput): Record<string, unknown> {
  if (input.protocol === "openai-ga") {
    return {
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions: input.instructions,
        audio: {
          input: { format: PCM, turn_detection: { type: "server_vad", threshold: input.threshold ?? 0.5, silence_duration_ms: input.silenceMs } },
          output: { format: PCM, voice: input.voice },
        },
        tools: VOICE_TOOLS,
      },
    };
  }
  return {
    type: "session.update",
    session: {
      voice: input.voice,
      instructions: input.instructions,
      turn_detection: { type: "server_vad", silence_duration_ms: input.silenceMs, ...(input.threshold ? { threshold: input.threshold } : {}) },
      reasoning: { effort: "none" },
      audio: {
        input: { format: PCM, ...(input.transcriptionModel ? { transcription: { model: input.transcriptionModel } } : {}) },
        output: { format: PCM },
      },
      tools: VOICE_TOOLS,
    },
  };
}

/**
 * How long a pause ends the person's turn, as the person chooses it in the call
 * panel. Shorter pauses kept cutting people off: at 500 ms a sentence with two
 * commas started several replies, and on a live call an unhurried
 * speaker was still cut in three times at 1000 ms - the operator's call is two
 * and a half seconds for "normal". Each choice adds its length to the wait for
 * the answer. A choice is stored by name, so one saved on the old scale lands
 * on this one.
 */
export type AnswerPace = "fast" | "normal" | "calm";
export const PACE_MS: Record<AnswerPace, number> = { fast: 1500, normal: 2500, calm: 3500 };

export function isAnswerPace(value: unknown): value is AnswerPace {
  return value === "fast" || value === "normal" || value === "calm";
}

/** Changes only the pause during a call: the provider keeps its voice and instructions. */
export function turnDetectionUpdate(protocol: VoiceProtocol, silenceMs: number, threshold = 0.5): Record<string, unknown> {
  const turnDetection = { type: "server_vad", threshold, silence_duration_ms: silenceMs };
  if (protocol === "openai-ga") {
    return { type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: turnDetection } } } };
  }
  return { type: "session.update", session: { turn_detection: { type: "server_vad", silence_duration_ms: silenceMs } } };
}

/**
 * A function call in an event, whichever way the provider announces it: by
 * `response.function_call_arguments.done`, by the finished output item, or
 * both. They carry the same call id, so a caller that sees both runs it once.
 */
export function functionCallOf(event: Record<string, unknown>): { name: string; callId: string; arguments: string } | null {
  if (event.type === "response.function_call_arguments.done") {
    const callId = String(event.call_id || "");
    return callId ? { name: String(event.name || ""), callId, arguments: typeof event.arguments === "string" ? event.arguments : "" } : null;
  }
  if (event.type === "response.output_item.done") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type !== "function_call") return null;
    const callId = String(item.call_id || "");
    return callId ? { name: String(item.name || ""), callId, arguments: typeof item.arguments === "string" ? item.arguments : "" } : null;
  }
  return null;
}

// --- the microphone while the agent speaks --------------------------------

/**
 * Without headphones the agent's own voice comes back through the microphone,
 * the provider takes it for the person, stops its answer and answers itself
 * (measured: one question, eleven replies). The browser's echo
 * cancellation does not reliably know about sound played by the page itself, so
 * while our answer plays the microphone goes up only when it is clearly louder
 * than what we are playing - a person talking over the answer is - and stays
 * open for half a second once it is, so their words are not cut into pieces.
 * Outside our playback everything goes up as it is.
 */
export const GATE_FLOOR = 0.02;
export const GATE_RATIO = 0.8;
export const GATE_HOLD_MS = 500;

export interface MicGateInput {
  now: number;
  /** Whether our answer is playing, or has just stopped (its echo still in the room). */
  playing: boolean;
  /** Loudness of this microphone frame and of what we are playing, as RMS 0..1. */
  micRms: number;
  outRms: number;
  /** Until when the gate is held open by speech that already got through. */
  openUntil: number;
}

export function gateMic(input: MicGateInput): { pass: boolean; openUntil: number } {
  if (!input.playing) return { pass: true, openUntil: input.openUntil };
  if (input.now < input.openUntil) return { pass: true, openUntil: input.openUntil };
  if (input.micRms > Math.max(GATE_FLOOR, input.outRms * GATE_RATIO)) return { pass: true, openUntil: input.now + GATE_HOLD_MS };
  return { pass: false, openUntil: input.openUntil };
}

/** Loudness of a frame, as root mean square. */
export function rmsOf(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// --- who has the floor -----------------------------------------------------

/**
 * A voice model delivers an answer far faster than it is played (measured on
 * Yandex: 6.5 s of speech in 0.1 s), so "the response is done" says nothing
 * about the agent having finished speaking. Asking for another answer in that
 * gap made one sentence from the person start three replies, each cutting off
 * the one before it. Nothing we start ourselves - the reply to a tool, an
 * update from the agent - starts until the voice has finished and the person
 * is not talking; an update also leaves a moment for the person to answer what
 * they just heard. The provider's own answer to the person is not held back.
 */
/** After the voice stops: the person's moment to answer before an update is said. */
export const AFTER_VOICE_QUIET_MS = 2000;
/** After the person stops: the provider's own answer is on its way. */
export const PERSON_STOPPED_HOLD_MS = 1500;
/** A person "still talking" for longer than this is a lost end-of-speech event. */
export const PERSON_SPEAKING_MAX_MS = 60_000;

export interface FloorInput {
  now: number;
  /** An answer is being generated, or our audio is still playing. */
  voiceBusy: boolean;
  /** When the voice was last busy. */
  voiceBusyAt: number;
  personSpeakingSince: number | null;
  personStoppedAt: number | null;
  /** How long the voice must have been quiet. */
  quietMs: number;
}

export function mayTakeFloor(input: FloorInput): boolean {
  if (input.voiceBusy) return false;
  if (input.personSpeakingSince !== null && input.now - input.personSpeakingSince < PERSON_SPEAKING_MAX_MS) return false;
  if (input.personStoppedAt !== null && input.now - input.personStoppedAt < PERSON_STOPPED_HOLD_MS) return false;
  return input.now - input.voiceBusyAt >= input.quietMs;
}

/**
 * Whether a finished tool call needs an answer of its own. A task handed over
 * in a response that already spoke has been acknowledged: asking again only
 * says "on it" a second time. A failed call and `status` have news to tell.
 */
export function answerAfterTool(input: { name: string; ok: boolean; spoke: boolean }): boolean {
  return !(input.name === "delegate" && input.ok && input.spoke);
}

/**
 * Whether the agent's finished turn is put in the conversation without being
 * said. The voice has just asked the person something and the agent only wrote
 * words (no tool ran, no question card): that is usually the same question, and
 * saying it talks over the answer. The voice knows it for its next reply.
 */
export function tellQuietly(input: { voiceAsked: boolean; agentUsedTools: boolean; questionOnScreen: boolean }): boolean {
  return input.voiceAsked && !input.agentUsedTools && !input.questionOnScreen;
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

// --- one task said in several breaths ---------------------------------------

/**
 * A person who pauses mid-request, or corrects it ("no, call it X"), must not
 * get the work done twice: on a live call "create a project" was handed over,
 * the rest of the sentence came nine seconds later as a fuller request, and
 * the agent made two projects. A delegate is a correction of the last one when
 * the voice model says so (`amends`) while that task is still running or ended
 * a moment ago, or - whatever the model said - when it comes within a few
 * seconds of the last one and repeats most of its words.
 */
export const AMEND_WINDOW_MS = 30_000;
export const REPEAT_WINDOW_MS = 15_000;

export interface LastDelegate {
  task: string;
  at: number;
  /** When the turn it started (or joined) ended; null while it runs. */
  endedAt: number | null;
}

/** Words by their first five letters: an inflected language changes a word's ending, not its stem. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter((word) => word.length > 2).map((word) => word.slice(0, 5));
}

/** How much of the earlier task the new one repeats, 0..1. */
export function overlapOf(earlier: string, later: string): number {
  const before = new Set(words(earlier));
  if (before.size === 0) return 0;
  const after = new Set(words(later));
  let shared = 0;
  for (const word of before) if (after.has(word)) shared += 1;
  return shared / before.size;
}

export function isAmendment(input: { task: string; amends: boolean; last: LastDelegate | null; now: number }): boolean {
  const last = input.last;
  if (!last) return false;
  const recent = last.endedAt === null || input.now - last.endedAt <= AMEND_WINDOW_MS;
  if (input.amends && recent) return true;
  return input.now - last.at <= REPEAT_WINDOW_MS && recent && overlapOf(last.task, input.task) >= 0.5;
}

// --- running a tool call ---------------------------------------------------

export type DelegateResult = "started" | "added" | "answered" | "amended";

export interface VoiceToolDeps {
  /**
   * Starts a turn with this text, adds it to the turn already working, or
   * answers the question it waits on. Answers which. `amends` is set when the
   * voice model says the text corrects the task passed on just before.
   */
  delegate(task: string, amends: boolean): DelegateResult | Promise<DelegateResult>;
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
      const how = await deps.delegate(task, args.amends === true);
      return {
        ok: true,
        how,
        note: how === "amended"
          ? "Passed on as a correction to the task already handed over, not as a new one. Tell the person in a few words that you have passed it on."
          : how === "answered"
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
