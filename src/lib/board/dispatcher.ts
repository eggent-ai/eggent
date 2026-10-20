import path from "path";
import { getServerTranslator } from "@/i18n/server";
import { getActiveRun, stopActiveRun } from "@/lib/pi/active-runs";
import { runPiAgentText } from "@/lib/pi/chat-runner";
import { listPendingInteractions } from "@/lib/pi/pending-interactions";
import { subscribeUiSyncEvents } from "@/lib/realtime/event-bus";
import { createChat, getChat, saveChat } from "@/lib/storage/chat-store";
import { getWorkDir } from "@/lib/storage/project-store";
import {
  applyRunStart,
  firstMessage,
  pickCardsToStart,
  scopeOf,
  type RunEnd,
  type StartLimits,
} from "@/lib/board/logic";
import { getCard, listCards, readBoardState, updateCard } from "@/lib/board/store";
import { finishCardRun } from "@/lib/board/runs";
import { boardRunsHere, cardHome, cardRunsOnComputer, cardStartedHere } from "@/lib/board/place";
import { localNode } from "@/lib/remote/config";
import { remoteChatState } from "@/lib/remote/proxy-turn";
import { stampAfter } from "@/lib/remote/stamp";
import { listDevices } from "@/lib/remote/relay-client";
import { isDeviceHome, type ChatHome } from "@/lib/remote/types";
import type { BoardCard } from "@/lib/board/types";

/**
 * The host that carries the board out: it starts the next card when there is
 * room, runs it as an ordinary turn in the card's chat, and reads how it ended.
 *
 * A card's run is `runPiAgentText` and nothing of its own - the same runner a
 * messenger's message gets - so it is registered as the chat's running turn,
 * watched for going quiet, stoppable from the chat, the board and a stop word
 * alike, saved as it goes, and visible live to whoever opens the chat. The
 * pipelines this replaces ran each step in a session of their own that none of
 * that could reach, and a restart left them "running" for ever.
 *
 * One process per workspace, so the running set is kept here, on globalThis
 * like every registry that routes and the boot hook must share.
 */

const STATE_KEY = "__EGGENT_BOARD_DISPATCHER__";

interface RunningCard {
  runId: string;
  startedAt: number;
  scope: string;
  /** Set when the run is being stopped because it put a question on the card. */
  questionAsked?: boolean;
}

interface DispatcherState {
  started: boolean;
  running: Map<string, RunningCard>;
  passTimer: ReturnType<typeof setTimeout> | null;
  passing: boolean;
  passAgain: boolean;
  tick: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
}

function dispatcherState(): DispatcherState {
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: DispatcherState };
  if (!holder[STATE_KEY]) {
    holder[STATE_KEY] = {
      started: false,
      running: new Map(),
      passTimer: null,
      passing: false,
      passAgain: false,
      tick: null,
      unsubscribe: null,
    };
  }
  return holder[STATE_KEY];
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/**
 * How many cards run at once.
 *
 * Three across the board, one per project, unless the operator says otherwise.
 * A card runs unattended, so how many run together is how fast a balance can go
 * before anyone looks; a running turn adds roughly 100-250 MB to a workspace
 * that idles at about 250 MB, on a box shared with every other workspace; and
 * two agents in one project work in one folder, where each can overwrite what
 * the other is writing without knowing it is there.
 */
export function boardLimits(env: Record<string, string | undefined> = process.env): StartLimits {
  return {
    running: positiveInt(env.EGGENT_BOARD_MAX_RUNNING, 3, 20),
    perProject: positiveInt(env.EGGENT_BOARD_MAX_PER_PROJECT, 1, 20),
  };
}

export function boardEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.EGGENT_BOARD?.trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

/** Cards with a turn in their chat right now, by project: the board's own and anybody else's. */
function liveScopes(cards: BoardCard[]): Map<string, number> {
  const state = dispatcherState();
  const live = new Map<string, number>();
  for (const card of cards) {
    if (!state.running.has(card.id) && !getActiveRun(card.id)) continue;
    const scope = scopeOf(card);
    live.set(scope, (live.get(scope) ?? 0) + 1);
  }
  return live;
}

/** A card says it is running, and nothing is: the server stopped under it, or a turn ended without a word. */
/** How long a run that says it started is given to show up before it counts as gone: a minute. */
function orphanGraceMs(env: Record<string, string | undefined> = process.env): number {
  const seconds = Number(env.EGGENT_BOARD_ORPHAN_GRACE_SECONDS);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3_600) * 1000 : 60_000;
}

async function isOrphanedRun(card: BoardCard, now: number, asked: Map<ChatHome, boolean>): Promise<boolean> {
  if (card.status !== "running") return false;
  if (dispatcherState().running.has(card.id) || getActiveRun(card.id)) return false;
  const open = [...card.runs].reverse().find((run) => !run.endedAt);
  // A turn somebody just started registers a moment after it says so; give it that moment.
  if (open && now - Date.parse(open.startedAt) <= orphanGraceMs()) return false;
  // A run on a computer - somebody wrote in the card's chat there - is that computer's to know
  // about, so it is asked. One that cannot be reached is given the benefit of the doubt: the
  // turn may be going on behind a shut lid, and Stop still closes the card from here.
  if (open?.node && isDeviceHome(open.node) && open.node !== localNode()) {
    if (asked.get(open.node) === false) return false;
    const there = await remoteChatState(card.id, open.node);
    if (!there) asked.set(open.node, false);
    return there !== null && !there.running;
  }
  return true;
}

/** Where a parent card's file is, from wherever the child works. */
function absoluteFilePath(project: string, relativePath: string): string {
  return path.join(getWorkDir(project === "none" ? null : project), relativePath);
}

/**
 * The chat a card's run writes into, made on its first run. In a pair it lives
 * where the card runs, so a message typed into it on the other side is handed
 * here - and a card moved to this side brings its chat along on its next run:
 * this side is the one about to write it.
 */
async function ensureCardChat(card: BoardCard): Promise<void> {
  const home = cardHome(card) ?? undefined;
  const existing = await getChat(card.id);
  if (existing) {
    if (existing.boardCard && (existing.home ?? undefined) === home) return;
    await saveChat({
      ...existing,
      boardCard: true,
      ...(home ? { home } : {}),
      // The newer copy wins when the two sides' files are joined: a move must be newer than what it changes.
      ...((existing.home ?? undefined) !== home ? { updatedAt: stampAfter(existing.updatedAt) } : {}),
    });
    return;
  }
  const chat = await createChat(card.id, card.title, card.projectId, undefined, home);
  await saveChat({ ...chat, boardCard: true });
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 600) || "unknown error";
}

/** One card's run, start to finish. Never throws: whatever happens ends up on the card. */
async function runCard(cardId: string): Promise<void> {
  const state = dispatcherState();
  if (state.running.has(cardId) || getActiveRun(cardId)) return;
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const placeholder: RunningCard = { runId, startedAt: Date.now(), scope: "none" };
  state.running.set(cardId, placeholder);

  let end: RunEnd = { runId, outcome: "failed", detail: "the run did not start" };
  let started: BoardCard | null = null;
  try {
    let message = "";
    let firstRun = false;
    started = await updateCard(
      cardId,
      (current) => {
        if (current.status !== "queued" || current.archived) return null;
        firstRun = current.runs.length === 0 && !current.next;
        message = current.next?.text ?? "";
        // Checked again on the card as it is now: somebody may have just moved it.
        if (!cardStartedHere(current)) return null;
        const node = cardHome(current) ?? undefined;
        return applyRunStart(current, { id: runId, surface: "board", startedAt, ...(node ? { node } : {}) });
      },
      "card_started"
    );
    if (!started || started.status !== "running" || started.runs[started.runs.length - 1]?.id !== runId) {
      state.running.delete(cardId);
      return;
    }
    placeholder.scope = scopeOf(started);

    const t = await getServerTranslator();
    if (!message) {
      if (firstRun) {
        const parents = (await Promise.all((started.after ?? []).map((id) => getCard(id)))).filter(
          (parent): parent is BoardCard => parent !== null
        );
        message = firstMessage(started, parents, {
          parents: t("board.message.parents"),
          files: t("board.message.files"),
          filePath: absoluteFilePath,
        });
      } else {
        message = t("board.next.continue");
      }
    }

    await ensureCardChat(started);
    // Somebody started a turn in the card's chat while this one was getting ready: theirs goes on.
    if (getActiveRun(cardId)) {
      state.running.delete(cardId);
      await updateCard(cardId, (current) => ({ ...current, runs: current.runs.filter((run) => run.id !== runId) }));
      return;
    }

    const outcome: NonNullable<Parameters<typeof runPiAgentText>[0]["outcome"]> = {};
    const reply = await runPiAgentText({
      chatId: cardId,
      userMessage: message,
      projectId: started.projectId,
      runId,
      // This runner reads how the run ended itself; the card must not also follow it as somebody else's turn.
      boardRun: true,
      // A card that lives on a computer runs there: its chat lives there (ensureCardChat), and the
      // turn is handed over through the relay and that computer's consent, as any of its chats is.
      allowHandover: cardRunsOnComputer(started),
      outcome,
    });
    // The turn stops itself at a question it put on the card (the runner does it, on whichever side ran it).
    placeholder.questionAsked = Boolean(outcome.question);
    end = outcome.question
      ? { runId, outcome: "question", question: outcome.question }
      : outcome.refused
        ? { runId, outcome: "refused", detail: outcome.refusalText }
        : outcome.stalled
          ? { runId, outcome: "stalled", detail: reply.slice(-300) }
          : outcome.stopped
            ? { runId, outcome: "stopped" }
            : { runId, outcome: "done", finalText: outcome.finalText || reply, files: outcome.files };
  } catch (error) {
    const remoteCode = (error as { remoteCode?: unknown })?.remoteCode;
    if (started && typeof remoteCode === "string" && NOT_STARTED_CODES.has(remoteCode)) {
      // The computer could not take it - away, not ready, busy, its copy of the chat not there yet:
      // the card never started, so it goes back to the queue as it was and waits for the computer.
      forgetReachableComputers();
      await updateCard(cardId, (current) => ({
        ...current,
        status: current.status === "running" ? "queued" : current.status,
        runs: current.runs.filter((run) => run.id !== runId),
      }), "card_not_started").catch(() => null);
      console.log(`[board] card ${cardId.slice(0, 8)} waits for ${cardHome(started)}: ${remoteCode}`);
      started = null;
    } else {
      // A computer that said no is not asked again by itself: the card waits for the person.
      end = { runId, outcome: "failed", detail: describeError(error), ...(remoteCode === "denied" ? { noRetry: true } : {}) };
    }
  } finally {
    if (started) {
      try {
        await finishCardRun(cardId, end, "board");
      } catch (error) {
        console.error(`[board] could not record how card ${cardId.slice(0, 8)} ended:`, error);
      }
      console.log(`[board] card ${cardId.slice(0, 8)} ${end.outcome}${end.detail ? `: ${end.detail.slice(0, 160)}` : ""}`);
    }
    state.running.delete(cardId);
    kickBoard();
  }
}

/** Why a computer could not take a card that leaves the card as if it had never been started. */
const NOT_STARTED_CODES = new Set(["offline", "not-ready", "timeout", "busy", "not-synced"]);

/** The computers that can take a card right now, asked of the control plane at most every 20 seconds. */
const DEVICES_KEY = "__EGGENT_BOARD_DEVICES__";

function forgetReachableComputers(): void {
  const holder = globalThis as typeof globalThis & { [DEVICES_KEY]?: unknown };
  delete holder[DEVICES_KEY];
}
async function reachableComputers(cards: BoardCard[]): Promise<Set<ChatHome>> {
  const wanted = cards.some((card) => card.status === "queued" && !card.archived && cardStartedHere(card) && cardRunsOnComputer(card));
  if (!wanted) return new Set();
  const holder = globalThis as typeof globalThis & { [DEVICES_KEY]?: { at: number; online: Set<ChatHome> } };
  const cached = holder[DEVICES_KEY];
  if (cached && Date.now() - cached.at < 20_000) return cached.online;
  let online = new Set<ChatHome>();
  try {
    const devices = await listDevices(AbortSignal.timeout(10_000));
    online = new Set(devices.filter((device) => device.online && device.accept && device.historyShared).map((device) => device.node));
  } catch (error) {
    console.warn("[board] could not ask which computers are online:", error instanceof Error ? error.message : error);
  }
  holder[DEVICES_KEY] = { at: Date.now(), online };
  return online;
}

/** Look at the board once: settle what nothing is running, start what may start. */
async function pass(): Promise<void> {
  const state = dispatcherState();
  if (state.passing) {
    state.passAgain = true;
    return;
  }
  state.passing = true;
  try {
    do {
      state.passAgain = false;
      const now = Date.now();
      // A computer in a pair shows the board and carries nothing out: the cloud does.
      if (!boardRunsHere()) continue;
      const cards = (await listCards()).filter(cardStartedHere);
      const asked = new Map<ChatHome, boolean>();
      for (const card of cards) {
        if (await isOrphanedRun(card, now, asked)) await finishCardRun(card.id, { outcome: "interrupted" }, "board");
      }
      const board = await readBoardState();
      if (board.paused || !boardEnabled()) continue;
      const fresh = await listCards();
      const reachable = await reachableComputers(fresh);
      // A card that lives on a computer waits in the queue while that computer cannot take it.
      const ownFresh = fresh.filter((card) => cardStartedHere(card) && (!cardRunsOnComputer(card) || reachable.has(cardHome(card) as ChatHome)));
      // Every card stays in view for what others wait for; only those this side can start now are picked.
      const picked = pickCardsToStart(fresh, {
        limits: boardLimits(),
        liveByScope: liveScopes(fresh),
        now,
        exclude: new Set([...state.running.keys(), ...fresh.filter((card) => !ownFresh.includes(card)).map((card) => card.id)]),
      });
      for (const card of picked) void runCard(card.id);
    } while (state.passAgain);
  } catch (error) {
    console.error("[board] a pass over the board failed:", error);
  } finally {
    state.passing = false;
  }
}

/** Look at the board again soon. Calls in quick succession are one look. */
export function kickBoard(delayMs = 50): void {
  const state = dispatcherState();
  if (state.passTimer) return;
  state.passTimer = setTimeout(() => {
    state.passTimer = null;
    void pass();
  }, delayMs);
  (state.passTimer as { unref?: () => void }).unref?.();
}

/**
 * Begin carrying the board out. Called once at boot; again is harmless.
 *
 * Any change to a card is a reason to look - a card queued, a card done that
 * others waited for - and a slow tick covers the rest: a retry whose time has
 * come, a turn that ended somewhere that said nothing.
 */
export function startBoardDispatcher(): void {
  const state = dispatcherState();
  if (state.started) return;
  state.started = true;
  state.unsubscribe = subscribeUiSyncEvents((event) => {
    if (event.topic === "board") kickBoard();
  });
  state.tick = setInterval(() => kickBoard(), 20_000);
  (state.tick as { unref?: () => void }).unref?.();
  kickBoard(0);
}

/** For tests: stop looking at the board. */
export function stopBoardDispatcher(): void {
  const state = dispatcherState();
  state.unsubscribe?.();
  state.unsubscribe = null;
  if (state.tick) clearInterval(state.tick);
  state.tick = null;
  if (state.passTimer) clearTimeout(state.passTimer);
  state.passTimer = null;
  state.started = false;
}

/** Whether the board's own runner is working on this card. */
export function boardIsRunning(cardId: string): boolean {
  return dispatcherState().running.has(cardId);
}

/** Card ids with a turn in their chat, for the board page: and whether that turn is waiting on a question. */
export function liveCards(cards: BoardCard[]): Record<string, { startedAt: number; question: boolean }> {
  const state = dispatcherState();
  const live: Record<string, { startedAt: number; question: boolean }> = {};
  for (const card of cards) {
    const active = getActiveRun(card.id);
    const own = state.running.get(card.id);
    if (!active && !own) continue;
    const question = active ? listPendingInteractions(active.runId).some((interaction) => interaction.status === "pending") : false;
    live[card.id] = { startedAt: active?.startedAt ?? own?.startedAt ?? Date.now(), question };
  }
  return live;
}

/** Stop a card's run, wherever it was started from. */
export async function stopCard(cardId: string): Promise<boolean> {
  if (!getActiveRun(cardId)) return false;
  await stopActiveRun(cardId);
  return true;
}
