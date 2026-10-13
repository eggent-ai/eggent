import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey, MessageValues } from "@/i18n/messages";
import { clearActiveRun, joinActiveRun, registerActiveRun, type AbortableRun } from "@/lib/pi/active-runs";
import { attachToLiveRun, startLiveRun, type LiveRunChunk } from "@/lib/pi/live-run";
import { isRemoteHome, localNode, remoteEnabled, settleWaitMs } from "@/lib/remote/config";
import { getChat } from "@/lib/storage/chat-store";
import { readChatHead, waitForCover } from "@/lib/remote/head";
import { errorFromResponse, listDevices, relayJson, relayRequest } from "@/lib/remote/relay-client";
import { readSseData } from "@/lib/remote/sse";
import {
  cleanHead,
  REMOTE_HEADERS,
  RemoteError,
  type ChatHead,
  type ChatHome,
} from "@/lib/remote/types";
import type { ChatContextMode } from "@/lib/types";

/**
 * A chat that runs on the other side, typed into on this one.
 *
 * The message is handed over, the answer comes back as the other side's own
 * stream, and from the screen's point of view nothing is different: the same
 * run registry, the same replayable buffer, the same stop button. What differs
 * is who writes the chat down. The side that runs the turn writes it - the
 * messages, the agent's record, the files - and this side only relays. Two
 * writers on one conversation is how a synced chat loses a message, so this
 * side stays out of the file until the other side's copy arrives through the
 * ordinary sync.
 */

export interface HandedOverTurn {
  chatId: string;
  home: ChatHome;
  message: string;
  projectId?: string;
  contextMode?: ChatContextMode;
  /** A path inside the project. An absolute one names this computer's disk and means nothing over there. */
  currentPath?: string;
  chatTitle?: string;
}

type Translator = (key: MessageKey, values?: MessageValues) => string;

/**
 * Where a question that arrived on the stream has to be answered.
 *
 * Written by the chat route and read by the route that takes the answer, which
 * Next compiles separately: a plain module-level map would be two maps.
 */
const INTERACTIONS_KEY = "__EGGENT_REMOTE_INTERACTIONS__";
const MAX_REMEMBERED_INTERACTIONS = 200;

function interactionHomes(): Map<string, ChatHome> {
  const holder = globalThis as typeof globalThis & { [INTERACTIONS_KEY]?: Map<string, ChatHome> };
  if (!holder[INTERACTIONS_KEY]) holder[INTERACTIONS_KEY] = new Map<string, ChatHome>();
  return holder[INTERACTIONS_KEY];
}

function interactionKey(runId: string, interactionId: string): string {
  return `${runId}:${interactionId}`;
}

/** The side a question came from, when it did not come from this one. */
export function remoteInteractionHome(runId: string, interactionId: string): ChatHome | null {
  return interactionHomes().get(interactionKey(runId, interactionId)) ?? null;
}

function rememberInteraction(runId: string, interactionId: string, home: ChatHome): void {
  const homes = interactionHomes();
  if (homes.size >= MAX_REMEMBERED_INTERACTIONS) {
    const oldest = homes.keys().next().value;
    if (oldest !== undefined) homes.delete(oldest);
  }
  homes.set(interactionKey(runId, interactionId), home);
}

/** A question card on the stream has to be answered on the side that asked it. */
function rememberQuestion(chunk: LiveRunChunk, home: ChatHome): void {
  const part = chunk as { type?: unknown; data?: unknown };
  if (part.type !== "data-piInteraction" || !part.data || typeof part.data !== "object") return;
  const interaction = part.data as { id?: unknown; runId?: unknown; status?: unknown };
  if (typeof interaction.id === "string" && typeof interaction.runId === "string" && interaction.status === "pending") {
    rememberInteraction(interaction.runId, interaction.id, home);
  }
}

/**
 * Chats this side has handed over, for as long as their file may not be here.
 *
 * A chat that starts on the other side exists only there until the sync brings
 * it, and the screen sends its next message with the chat's id and nothing
 * else. Looked up in the stored chats alone, it would read as a chat that does
 * not exist, be created here, and run on the wrong side.
 */
const HANDOVERS_KEY = "__EGGENT_REMOTE_HANDOVERS__";
const HANDOVER_MEMORY_MS = 15 * 60_000;

function handOvers(): Map<string, { home: ChatHome; until: number }> {
  const holder = globalThis as typeof globalThis & { [HANDOVERS_KEY]?: Map<string, { home: ChatHome; until: number }> };
  if (!holder[HANDOVERS_KEY]) holder[HANDOVERS_KEY] = new Map();
  return holder[HANDOVERS_KEY];
}

function rememberHandOver(chatId: string, home: ChatHome): void {
  const entries = handOvers();
  const now = Date.now();
  for (const [id, entry] of entries) if (entry.until < now) entries.delete(id);
  entries.set(chatId, { home, until: now + HANDOVER_MEMORY_MS });
}

/** This side no longer thinks the chat is on the other side: the handover did not happen, or the person moved it. */
export function forgetHandOver(chatId: string): void {
  handOvers().delete(chatId);
}

/** Where a chat that has no file here was handed to, when this side handed it over lately. */
export function recallHandOver(chatId: string): ChatHome | null {
  const entry = handOvers().get(chatId);
  if (!entry) return null;
  if (entry.until < Date.now()) {
    handOvers().delete(chatId);
    return null;
  }
  return entry.home;
}

/** Where a chat lives when that is not here and this install can reach it; null in every other case. */
export async function storedRemoteHome(chatId: string): Promise<ChatHome | null> {
  if (!remoteEnabled()) return null;
  const chat = await getChat(chatId);
  return chat && isRemoteHome(chat.home) ? chat.home : null;
}

/** What the person calls the other side. */
export async function whereLabel(home: ChatHome, t: Translator): Promise<string> {
  if (home === "cloud") return t("remote.where.cloud");
  if (localNode() === "cloud") {
    try {
      const device = (await listDevices()).find((candidate) => candidate.node === home);
      if (device) return device.name;
    } catch {
      // The name is a courtesy; the failure it is attached to is what matters.
    }
  }
  return t("remote.where.yourComputer");
}

export function remoteFailureMessage(error: RemoteError, t: Translator, where: string): string {
  switch (error.code) {
    case "offline":
      return error.home === "cloud"
        ? t("remote.error.offlineCloud")
        : t("remote.error.offlineDevice", { where });
    case "denied":
      return t("remote.error.denied", { where });
    case "not-ready":
      return t("remote.error.notReady", { where });
    case "not-synced":
      return t("remote.error.notSynced", { where });
    case "busy":
      return t("remote.error.busy");
    case "timeout":
      return t("remote.error.timeout", { where });
    case "disabled":
      return t("remote.error.disabled");
    default:
      return t("remote.error.failed", { where, reason: error.message });
  }
}

/** The answer to a request that could not be handed over: JSON the chat screen can act on. */
export async function remoteFailureResponse(error: unknown, home: ChatHome): Promise<Response> {
  const failure = error instanceof RemoteError ? error : new RemoteError("failed", error instanceof Error ? error.message : String(error), { home });
  const t = await getServerTranslator();
  const where = await whereLabel(home, t);
  console.warn(`[remote] could not hand the turn to ${home}: ${failure.code} - ${failure.message}`);
  return Response.json(
    { error: remoteFailureMessage(failure, t, where), code: failure.code, home },
    { status: failure.status }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  });
}

function handoverHeaders(home: ChatHome, title?: string): Record<string, string> {
  const from = localNode();
  return {
    [REMOTE_HEADERS.relayed]: "1",
    ...(from ? { [REMOTE_HEADERS.from]: from } : {}),
    ...(title ? { [REMOTE_HEADERS.title]: encodeURIComponent(title.slice(0, 120)) } : {}),
    "content-type": "application/json",
    // Which side this is for; the receiving end ignores it, and the log shows it.
    "x-eggent-to": home,
  };
}

function forwardBody(turn: HandedOverTurn, message: string, head?: ChatHead): string {
  const currentPath = turn.currentPath && !/^([A-Za-z]:)?[\\/]/.test(turn.currentPath) ? turn.currentPath : undefined;
  return JSON.stringify({
    chatId: turn.chatId,
    message,
    // Where this side stands with the chat; the other side holds the turn until it has that much too.
    ...(head ? { expectHead: head } : {}),
    projectId: turn.projectId ?? "none",
    ...(turn.contextMode ? { contextMode: turn.contextMode } : {}),
    ...(currentPath ? { currentPath } : {}),
  });
}

/** The few words the screen shows when a message was folded into a run that was already going. */
function noticeStream(text: string, chatId: string): Response {
  const stream = createUIMessageStream<UIMessage>({
    execute: ({ writer }) => {
      const id = `pi-text-${crypto.randomUUID()}`;
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
    },
  });
  return createUIMessageStreamResponse({ stream, headers: { "X-Chat-Id": chatId } });
}

/**
 * A handed-over turn from the moment it is asked for.
 *
 * It is registered as the chat's running turn before the other side has said a
 * word, because that is when it can be stopped from nowhere else: the other side
 * may wait half a minute for the chat to arrive, or for its owner to agree, or
 * for its workspace to wake, and a stop pressed in that time has to reach a
 * turn, not an empty registry - or the turn starts the moment it is ready and
 * does what the person had just asked it not to.
 *
 * Messages that arrive in the meantime are kept and go out once the other side
 * has a turn to put them in; sent earlier they would start a second one.
 */
interface Handover {
  readonly runId: string;
  /** Cancels the request to the other side, whether or not it has answered yet. */
  readonly abort: AbortController;
  readonly state: { streaming: boolean; stopRequested: boolean; opened: boolean };
  /** The other side has answered with a stream: what was kept for it goes out. */
  opened(): void;
  /** Nothing is running here for this turn any more. */
  release(): void;
}

function beginHandedOver(input: {
  chatId: string;
  home: ChatHome;
  surface: "web" | "external";
  steer: (text: string) => Promise<void>;
  /** How long a stop may take before the other side's stream is let go of. */
  stopGraceMs?: number;
}): Handover {
  const { chatId, home } = input;
  const runId = crypto.randomUUID();
  const abort = new AbortController();
  const state = { streaming: true, stopRequested: false, opened: false };
  const kept: Array<{ text: string; resolve: () => void; reject: (error: unknown) => void }> = [];

  // The other side registers its run a moment after it receives the request, so
  // a stop that is asked for straight away can arrive before there is anything
  // to stop. Ask again for a few seconds; the first answer that says it stopped
  // something ends it.
  const stopRemote = async () => {
    const deadline = Date.now() + (state.opened ? 8000 : 3000);
    for (;;) {
      try {
        const answer = await relayJson<{ stopped?: boolean }>(home, {
          method: "POST",
          path: `/api/chat/${encodeURIComponent(chatId)}/stop`,
          headers: handoverHeaders(home),
          body: "{}",
        });
        if (answer.stopped) return;
      } catch (error) {
        console.warn(`[remote] could not pass a stop to ${home}:`, error instanceof Error ? error.message : error);
        return;
      }
      // A turn that is over has nothing left to stop.
      if (Date.now() >= deadline || (!state.streaming && state.opened)) return;
      await sleep(500);
    }
  };

  const requestStop = () => {
    if (state.stopRequested) return;
    state.stopRequested = true;
    for (const entry of kept.splice(0)) entry.reject(new Error("The turn was stopped."));
    void stopRemote();
    // Before the other side has answered there is no stream to wait on: the
    // request is let go of at once, which also withdraws it if it has not started.
    if (!state.opened) abort.abort();
    // A stop the other side does not act on must not hold this side for ever:
    // after a while the stream is let go of and the turn ends here.
    const grace = setTimeout(() => {
      if (state.streaming) abort.abort();
    }, input.stopGraceMs ?? 20_000);
    if (typeof grace === "object" && grace && "unref" in grace) grace.unref();
  };

  const run: AbortableRun = {
    get isStreaming() {
      return state.streaming;
    },
    async abort() {
      requestStop();
    },
    steer: (text) => {
      if (state.stopRequested) return Promise.reject(new Error("The turn was stopped."));
      if (state.opened) return input.steer(text);
      return new Promise<void>((resolve, reject) => kept.push({ text, resolve, reject }));
    },
  };
  registerActiveRun(chatId, { session: run, runId, surface: input.surface, requestStop });

  return {
    runId,
    abort,
    state,
    opened() {
      state.opened = true;
      for (const entry of kept.splice(0)) input.steer(entry.text).then(entry.resolve, entry.reject);
    },
    release() {
      state.streaming = false;
      for (const entry of kept.splice(0)) entry.reject(new Error("The turn did not start."));
      clearActiveRun(chatId, runId);
    },
  };
}

/**
 * The part of a handed-over turn that is the same whoever asked: the other
 * side's stream is copied into this side's replayable buffer as it arrives (so
 * stop, steer and a second tab find it), and the turn is not over until the
 * stored chat has come back.
 *
 * `onChunk` is one more reader of the buffer, for the caller that wants to see
 * the chunks go by - the browser's response, or a messenger collecting text.
 */
interface DriveInput {
  chatId: string;
  home: ChatHome;
  projectId?: string;
  surface: "web" | "external";
  upstream: ReadableStream<Uint8Array>;
  onChunk: (chunk: LiveRunChunk) => void;
  /** What a stream that ends without being finished is told as; asked for only if that happens. */
  lostText: () => Promise<string>;
}

interface DriveResult {
  completed: boolean;
  stopRequested: boolean;
}

async function driveHandedOver(handover: Handover, input: DriveInput): Promise<DriveResult> {
  const { chatId, home } = input;
  const { runId, state } = handover;

  const live = startLiveRun({ chatId, runId, projectId: input.projectId ?? null, surface: input.surface, home });
  attachToLiveRun(chatId, { onChunk: input.onChunk, onFinish: () => {} });

  let completed = false;
  try {
    try {
      for await (const data of readSseData(input.upstream)) {
        if (data === "[DONE]") {
          completed = true;
          break;
        }
        let chunk: LiveRunChunk;
        try {
          chunk = JSON.parse(data) as LiveRunChunk;
        } catch {
          continue;
        }
        rememberQuestion(chunk, home);
        live.push(chunk);
      }
    } catch (error) {
      if (!state.stopRequested) console.warn(`[remote] the stream from ${home} broke:`, error instanceof Error ? error.message : error);
    } finally {
      handover.release();
    }

    if (completed) {
      await settleLocalCopy(chatId, home);
    } else if (!state.stopRequested) {
      // The turn belongs to the chat, not to the connection, so it may well
      // be running still. Say what is known; the answer arrives with the sync.
      live.push({ type: "error", errorText: await input.lostText() });
    }
  } finally {
    live.finish();
    rememberHandOver(chatId, home);
  }
  return { completed, stopRequested: state.stopRequested };
}

/** What it takes to start a handed-over request, shared by the browser's turn and a messenger's. */
async function openHandedOver(
  turn: HandedOverTurn,
  handover: Handover,
  options: { interactive: boolean; message: string }
): Promise<{ upstream: Response; chatBefore: number | null }> {
  const head = await readChatHead(turn.chatId);
  const headers = { ...handoverHeaders(turn.home, turn.chatTitle), ...(options.interactive ? {} : { [REMOTE_HEADERS.interactive]: "0" }) };
  const upstream = await relayRequest(turn.home, {
    method: "POST",
    path: "/api/chat",
    headers,
    body: forwardBody(turn, options.message, head),
    // Its own signal: letting go of the other side's stream has to be possible
    // without the caller's request being the thing that ends.
    signal: handover.abort.signal,
  });
  if (!upstream.ok || !upstream.body) throw await errorFromResponse(upstream, turn.home);
  const before = Number(upstream.headers.get(REMOTE_HEADERS.chatBefore));
  return { upstream, chatBefore: Number.isInteger(before) && before >= 0 ? before : null };
}

/**
 * A message for a turn that is already running over there.
 *
 * It says so: if that turn has ended in the meantime the other side answers that
 * nothing is running, and the caller starts a turn of its own with the message
 * (see `joinActiveRun`) - rather than the other side starting one that nobody
 * is watching and the person being told their message was taken into account.
 */
function steerer(turn: HandedOverTurn, interactive: boolean): (text: string) => Promise<void> {
  return async (text: string) => {
    const response = await relayRequest(turn.home, {
      method: "POST",
      path: "/api/chat",
      headers: {
        ...handoverHeaders(turn.home, turn.chatTitle),
        ...(interactive ? {} : { [REMOTE_HEADERS.interactive]: "0" }),
        [REMOTE_HEADERS.steer]: "1",
      },
      body: forwardBody(turn, text),
    });
    // The answer is only the receiving side's "got it"; the turn it joined is
    // the one this side is already relaying.
    if (!response.ok) throw await errorFromResponse(response, turn.home);
    void response.body?.cancel().catch(() => undefined);
  };
}

/**
 * Whether a turn is running in this chat on the other side, or null when the
 * other side cannot be asked. For the moments a chat is about to be moved: a
 * side that only looks at its own registry would take a chat away from a turn
 * that is mid-way over there.
 */
export async function remoteTurnRunning(chatId: string, home: ChatHome): Promise<boolean | null> {
  if (!remoteEnabled()) return null;
  try {
    const head = await relayJson<{ running?: unknown }>(home, {
      method: "GET",
      path: `/api/chat/${encodeURIComponent(chatId)}/head`,
      headers: handoverHeaders(home),
      signal: AbortSignal.timeout(8000),
    });
    return head.running === true;
  } catch {
    return null;
  }
}

/**
 * Run a turn on the other side and relay it.
 *
 * Returns before the turn is over: the response is the stream. A request that
 * could not be handed over at all is answered here, as JSON, before any stream
 * exists, so the screen can offer the person what to do instead.
 */
export async function runHandedOverTurn(turn: HandedOverTurn): Promise<Response> {
  const { chatId, home } = turn;

  // A message that arrives while this chat already has a turn going is for that
  // turn: the same rule as on the side that runs it, and the handed-over run is
  // registered like any other so the rule finds it.
  const joined = await joinActiveRun(chatId, turn.message);
  if (joined) {
    const t = await getServerTranslator();
    return noticeStream(joined === "stopped" ? t("external.run.stopped") : t("external.run.steered"), chatId);
  }

  const handover = beginHandedOver({ chatId, home, surface: "web", steer: steerer(turn, true) });
  let opened: Awaited<ReturnType<typeof openHandedOver>>;
  try {
    opened = await openHandedOver(turn, handover, { interactive: true, message: turn.message });
  } catch (error) {
    handover.release();
    const t = await getServerTranslator();
    // Stopped before it started: that is the answer, not a failure to hand it over.
    if (handover.state.stopRequested) return noticeStream(t("external.run.stopped"), chatId);
    // Nothing was handed over, so nothing is remembered as having been: the memory
    // is made only once the other side has answered (below), and a refusal does not
    // undo what an earlier message of the same chat left.
    return remoteFailureResponse(error, home);
  }
  rememberHandOver(chatId, home);
  handover.opened();

  const t = await getServerTranslator();
  const upstreamBody = opened.upstream.body as ReadableStream<Uint8Array>;

  const stream = createUIMessageStream<UIMessage>({
    async execute({ writer }) {
      await driveHandedOver(handover, {
        chatId,
        home,
        projectId: turn.projectId,
        surface: "web",
        upstream: upstreamBody,
        onChunk: (chunk) => writer.write(chunk),
        lostText: async () => t("remote.error.lost", { where: await whereLabel(home, t) }),
      });
    },
    onError: (error) => (error instanceof Error ? error.message : String(error)) || "remote turn failed",
  });

  return createUIMessageStreamResponse({ stream, headers: { "X-Chat-Id": chatId } });
}

/** What a messenger's turn that ran on the other side comes to. */
export interface HandedOverTextResult {
  /** Everything the model wrote, in order. */
  text: string;
  /** What it wrote last: the answer, without the narration before it. */
  finalText: string;
  stopped: boolean;
  /**
   * How many messages the chat held on the side that ran the turn before it
   * began. This side's copy may be behind, so what the turn wrote is found from
   * there and not from its own count.
   */
  chatBefore: number | null;
}

/** A progress report, in the shape a messenger's draft is built from. */
export type HandedOverProgress =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; phase: "start" | "end" }
  | { type: "helpers"; running: number; total: number };

/**
 * Run a messenger's turn on the other side.
 *
 * The other side runs it as it runs any turn and streams it the way it streams
 * to a screen; this reads that stream into what a messenger needs - the text, the
 * answer, what is happening - and returns when the turn is over and its chat is
 * here. It throws, with a reason fit to be said to the person, when the turn
 * could not be handed over or the other side's turn failed.
 */
export async function runHandedOverText(
  turn: HandedOverTurn,
  onProgress?: (event: HandedOverProgress) => void
): Promise<HandedOverTextResult> {
  const { chatId, home } = turn;
  const t = await getServerTranslator();

  const handover = beginHandedOver({ chatId, home, surface: "external", steer: steerer(turn, false) });
  let opened: Awaited<ReturnType<typeof openHandedOver>>;
  try {
    opened = await openHandedOver(turn, handover, { interactive: false, message: turn.message });
  } catch (error) {
    handover.release();
    // Stopped before it started: nothing to report but that.
    if (handover.state.stopRequested) return { text: "", finalText: "", stopped: true, chatBefore: null };
    const failure = error instanceof RemoteError ? error : new RemoteError("failed", error instanceof Error ? error.message : String(error), { home });
    const where = await whereLabel(home, t);
    console.warn(`[remote] could not hand the turn to ${home}: ${failure.code} - ${failure.message}`);
    // The one way out a messenger has: bring the chat back to the side that is reading it.
    const hint = ["offline", "denied", "not-ready", "timeout"].includes(failure.code) ? ` ${t("remote.error.hintHere")}` : "";
    throw new Error(`${remoteFailureMessage(failure, t, where)}${hint}`);
  }
  rememberHandOver(chatId, home);
  handover.opened();

  let text = "";
  let messageText = "";
  let finalText = "";
  let failure: string | null = null;
  const toolNames = new Map<string, string>();
  const helperStates = new Map<string, string>();

  const report = (event: HandedOverProgress) => {
    try {
      onProgress?.(event);
    } catch (error) {
      console.warn("A progress listener failed:", error);
    }
  };

  const result = await driveHandedOver(handover, {
    chatId,
    home,
    projectId: turn.projectId,
    surface: "external",
    upstream: opened.upstream.body as ReadableStream<Uint8Array>,
    lostText: async () => t("remote.error.lost", { where: await whereLabel(home, t) }),
    onChunk: (chunk) => {
      const part = chunk as { type?: string; id?: string; delta?: string; toolCallId?: string; toolName?: string; errorText?: string; data?: { id?: string; status?: string } };
      switch (part.type) {
        case "text-start":
          messageText = "";
          break;
        case "text-delta":
          if (typeof part.delta === "string") {
            text += part.delta;
            messageText += part.delta;
            report({ type: "text", delta: part.delta });
          }
          break;
        case "text-end":
          if (messageText.trim()) finalText = messageText;
          break;
        case "tool-input-available":
          if (part.toolCallId && part.toolName) {
            toolNames.set(part.toolCallId, part.toolName);
            report({ type: "tool", name: part.toolName, phase: "start" });
          }
          break;
        case "tool-output-available":
        case "tool-output-error":
          if (part.toolCallId) report({ type: "tool", name: toolNames.get(part.toolCallId) ?? "tool", phase: "end" });
          break;
        case "data-piSubagent":
          if (part.data?.id) {
            helperStates.set(part.data.id, String(part.data.status ?? ""));
            const running = [...helperStates.values()].filter((status) => status === "running").length;
            report({ type: "helpers", running, total: helperStates.size });
          }
          break;
        case "error":
          failure = part.errorText ?? "The turn failed.";
          break;
        default:
          break;
      }
    },
  });

  if (failure && !result.stopRequested) throw new Error(failure);
  return { text, finalText, stopped: result.stopRequested, chatBefore: opened.chatBefore };
}

/**
 * Hold the screen until this side's stored chat shows the turn that just ran.
 *
 * The screen reloads the stored chat the moment a turn ends and replaces what it
 * shows with it. If the chat has not arrived by then, that reload would take
 * the answer the person has just read off the screen. So the turn is not
 * over, from here, until the other side's copy is - or until patience runs out,
 * and then the answer appears when it does.
 */
async function settleLocalCopy(chatId: string, home: ChatHome): Promise<void> {
  let want: ChatHead | null = null;
  try {
    want = cleanHead(
      await relayJson<unknown>(home, {
        method: "GET",
        path: `/api/chat/${encodeURIComponent(chatId)}/head`,
        headers: handoverHeaders(home),
        signal: AbortSignal.timeout(10_000),
      })
    );
  } catch (error) {
    console.warn(`[remote] could not ask ${home} where the chat stands:`, error instanceof Error ? error.message : error);
  }
  if (!want) return;
  const gaps = await waitForCover(chatId, want, { timeoutMs: settleWaitMs() });
  if (gaps.length > 0) {
    console.warn(`[remote] chat ${chatId.slice(0, 8)} from ${home} had not arrived after ${Math.round(settleWaitMs() / 1000)}s (${gaps.join(", ")} missing)`);
  }
}

/** Answer a question card that belongs to a turn running on the other side. */
export async function forwardInteractionResponse(
  runId: string,
  interactionId: string,
  body: { value?: unknown; cancel?: boolean }
): Promise<Response | null> {
  const home = remoteInteractionHome(runId, interactionId);
  if (!home) return null;
  try {
    const response = await relayRequest(home, {
      method: "POST",
      path: `/api/pi-runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/respond`,
      headers: { [REMOTE_HEADERS.relayed]: "1", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return new Response(text, { status: response.status, headers: { "content-type": "application/json" } });
  } catch (error) {
    return remoteFailureResponse(error, home);
  }
}
