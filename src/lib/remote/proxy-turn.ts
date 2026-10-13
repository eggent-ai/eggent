import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey, MessageValues } from "@/i18n/messages";
import { clearActiveRun, joinActiveRun, registerActiveRun, type AbortableRun } from "@/lib/pi/active-runs";
import { attachToLiveRun, startLiveRun, type LiveRunChunk } from "@/lib/pi/live-run";
import { localNode, settleWaitMs } from "@/lib/remote/config";
import { readChatHead, waitForCover } from "@/lib/remote/head";
import { errorFromResponse, listDevices, relayJson, relayRequest } from "@/lib/remote/relay-client";
import { readSseData } from "@/lib/remote/sse";
import {
  encodeHead,
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

function handoverHeaders(home: ChatHome, head: ChatHead | null, title?: string): Record<string, string> {
  const from = localNode();
  return {
    [REMOTE_HEADERS.relayed]: "1",
    ...(from ? { [REMOTE_HEADERS.from]: from } : {}),
    ...(head ? { [REMOTE_HEADERS.expectHead]: encodeHead(head) } : {}),
    ...(title ? { [REMOTE_HEADERS.title]: encodeURIComponent(title.slice(0, 120)) } : {}),
    "content-type": "application/json",
    // Which side this is for; the receiving end ignores it, and the log shows it.
    "x-eggent-to": home,
  };
}

function forwardBody(turn: HandedOverTurn, message: string): string {
  const currentPath = turn.currentPath && !/^([A-Za-z]:)?[\\/]/.test(turn.currentPath) ? turn.currentPath : undefined;
  return JSON.stringify({
    chatId: turn.chatId,
    message,
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
 * Run a turn on the other side and relay it.
 *
 * Returns before the turn is over: the response is the stream. A request that
 * could not be handed over at all is answered here, as JSON, before any stream
 * exists, so the screen can offer the person what to do instead.
 */
export async function runHandedOverTurn(turn: HandedOverTurn): Promise<Response> {
  const { chatId, home } = turn;
  rememberHandOver(chatId, home);

  // A message that arrives while this chat already has a turn going is for that
  // turn: the same rule as on the side that runs it, and the handed-over run is
  // registered like any other so the rule finds it.
  const joined = await joinActiveRun(chatId, turn.message);
  if (joined) {
    const t = await getServerTranslator();
    return noticeStream(joined === "stopped" ? t("external.run.stopped") : t("external.run.steered"), chatId);
  }

  const head = await readChatHead(chatId);
  const headers = handoverHeaders(home, head, turn.chatTitle);

  let upstream: Response;
  try {
    upstream = await relayRequest(home, { method: "POST", path: "/api/chat", headers, body: forwardBody(turn, turn.message) });
    if (!upstream.ok || !upstream.body) throw await errorFromResponse(upstream, home);
  } catch (error) {
    return remoteFailureResponse(error, home);
  }

  const t = await getServerTranslator();
  const where = await whereLabel(home, t);
  const runId = crypto.randomUUID();
  const upstreamBody = upstream.body;

  const state = {
    streaming: true,
    stopRequested: false,
  };

  // The other side registers its run a moment after it receives the request, so
  // a stop that is asked for straight away can arrive before there is anything
  // to stop. Ask again for a few seconds; the first answer that says it stopped
  // something ends it.
  const stopRemote = async () => {
    const deadline = Date.now() + 8000;
    while (state.streaming && Date.now() < deadline) {
      try {
        const answer = await relayJson<{ stopped?: boolean }>(home, {
          method: "POST",
          path: `/api/chat/${encodeURIComponent(chatId)}/stop`,
          headers: handoverHeaders(home, null),
          body: "{}",
        });
        if (answer.stopped) return;
      } catch (error) {
        console.warn(`[remote] could not pass a stop to ${home}:`, error instanceof Error ? error.message : error);
        return;
      }
      await sleep(500);
    }
  };

  const run: AbortableRun = {
    get isStreaming() {
      return state.streaming;
    },
    async abort() {
      state.stopRequested = true;
      await stopRemote();
    },
    async steer(text: string) {
      const response = await relayRequest(home, {
        method: "POST",
        path: "/api/chat",
        headers: handoverHeaders(home, null, turn.chatTitle),
        body: forwardBody(turn, text),
      });
      // The answer is only the receiving side's "got it"; the turn it joined is
      // the one this side is already relaying.
      if (!response.ok) throw await errorFromResponse(response, home);
      void response.body?.cancel().catch(() => undefined);
    },
  };

  const stream = createUIMessageStream<UIMessage>({
    async execute({ writer }) {
      const live = startLiveRun({ chatId, runId, projectId: turn.projectId ?? null, surface: "web" });
      registerActiveRun(chatId, {
        session: run,
        runId,
        surface: "web",
        requestStop: () => {
          state.stopRequested = true;
          void stopRemote();
        },
      });
      attachToLiveRun(chatId, { onChunk: (chunk) => writer.write(chunk), onFinish: () => {} });

      let completed = false;
      try {
        try {
          for await (const data of readSseData(upstreamBody)) {
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
          console.warn(`[remote] the stream from ${home} broke:`, error instanceof Error ? error.message : error);
        } finally {
          state.streaming = false;
          clearActiveRun(chatId, runId);
        }

        if (completed) {
          await settleLocalCopy(chatId, home);
        } else {
          // The turn belongs to the chat, not to the connection, so it may well
          // be running still. Say what is known; the answer arrives with the sync.
          live.push({ type: "error", errorText: t("remote.error.lost", { where }) });
        }
      } finally {
        live.finish();
        rememberHandOver(chatId, home);
      }
    },
    onError: (error) => (error instanceof Error ? error.message : String(error)) || "remote turn failed",
  });

  return createUIMessageStreamResponse({ stream, headers: { "X-Chat-Id": chatId } });
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
    want = await relayJson<ChatHead>(home, {
      method: "GET",
      path: `/api/chat/${encodeURIComponent(chatId)}/head`,
      headers: handoverHeaders(home, null),
      signal: AbortSignal.timeout(10_000),
    });
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
