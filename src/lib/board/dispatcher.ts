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
function isOrphanedRun(card: BoardCard, now: number): boolean {
  if (card.status !== "running") return false;
  if (dispatcherState().running.has(card.id) || getActiveRun(card.id)) return false;
  const open = [...card.runs].reverse().find((run) => !run.endedAt);
  // A turn somebody just started registers a moment after it says so; give it that moment.
  return !open || now - Date.parse(open.startedAt) > 60_000;
}

/** Where a parent card's file is, from wherever the child works. */
function absoluteFilePath(project: string, relativePath: string): string {
  return path.join(getWorkDir(project === "none" ? null : project), relativePath);
}

/** The chat a card's run writes into, made on its first run. */
async function ensureCardChat(card: BoardCard): Promise<void> {
  const existing = await getChat(card.id);
  if (existing) {
    if (!existing.boardCard) await saveChat({ ...existing, boardCard: true });
    return;
  }
  const chat = await createChat(card.id, card.title, card.projectId);
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
        return applyRunStart(current, { id: runId, surface: "board", startedAt });
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
      outcome,
      onSessionEvent: (event) => {
        const record = event as { type?: unknown; toolName?: unknown; result?: { details?: { onCard?: unknown } } };
        if (record.type !== "tool_execution_end" || record.toolName !== "eggent_ask_user") return;
        if (record.result?.details?.onCard !== true) return;
        // The question is on the card; nobody here can answer it, so the run ends where it is.
        placeholder.questionAsked = true;
        void stopActiveRun(cardId).catch(() => undefined);
      },
    });
    end = placeholder.questionAsked
      ? { runId, outcome: "question" }
      : outcome.refused
        ? { runId, outcome: "refused", detail: outcome.refusalText }
        : outcome.stalled
          ? { runId, outcome: "stalled", detail: reply.slice(-300) }
          : outcome.stopped
            ? { runId, outcome: "stopped" }
            : { runId, outcome: "done", finalText: outcome.finalText || reply, files: outcome.files };
  } catch (error) {
    end = placeholder.questionAsked ? { runId, outcome: "question" } : { runId, outcome: "failed", detail: describeError(error) };
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
      const cards = await listCards();
      for (const card of cards) {
        if (isOrphanedRun(card, now)) await finishCardRun(card.id, { outcome: "interrupted" }, "board");
      }
      const board = await readBoardState();
      if (board.paused || !boardEnabled()) continue;
      const fresh = await listCards();
      const picked = pickCardsToStart(fresh, {
        limits: boardLimits(),
        liveByScope: liveScopes(fresh),
        now,
        exclude: new Set(state.running.keys()),
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
