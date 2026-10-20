import { getServerTranslator } from "@/i18n/server";
import { applyRunEnd, applyRunStart, DEFAULT_RUN_END_POLICY, type RunEnd, type RunEndPolicy } from "@/lib/board/logic";
import { getCard, updateBoardState, updateCard } from "@/lib/board/store";
import type { BoardCard, CardQuestion, CardRun } from "@/lib/board/types";
import { localNode, remoteEnabled } from "@/lib/remote/config";
import type { ChatHome } from "@/lib/remote/types";

/**
 * What a run does to its card when it starts and when it ends, wherever the run
 * came from: the board's own runner, or a person writing in the card's chat
 * from the web or a messenger.
 *
 * Kept apart from the runner on purpose. The chat runners call in here, and the
 * board's runner calls the chat runners; with these two in one module each
 * would load the other.
 */

async function runEndTexts() {
  const t = await getServerTranslator();
  return {
    retry: (detail?: string) => t("board.next.retry", { error: detail?.slice(0, 300) || t("board.next.unknownError") }),
    resume: t("board.next.resume"),
  };
}

/** How long a failed card waits before its one retry: a minute, unless the operator says otherwise. */
function runEndPolicy(env: Record<string, string | undefined> = process.env): RunEndPolicy {
  const seconds = Number(env.EGGENT_BOARD_RETRY_SECONDS);
  return {
    ...DEFAULT_RUN_END_POLICY,
    ...(Number.isFinite(seconds) && seconds >= 0 ? { retryDelayMs: Math.min(seconds, 3_600) * 1000 } : {}),
  };
}

/** Write how a run ended onto its card, and pause the board when the service refused it. */
export async function finishCardRun(cardId: string, end: RunEnd, surface: CardRun["surface"]): Promise<BoardCard | null> {
  const texts = await runEndTexts();
  const policy = runEndPolicy();
  const card = await updateCard(
    cardId,
    (current) => applyRunEnd(current, end, { now: new Date(), texts, surface, policy }),
    `card_${end.outcome}`
  );
  if (card && end.outcome === "refused") {
    await updateBoardState((state) => ({
      ...state,
      paused: { reason: "refused", ...(end.detail ? { detail: end.detail } : {}), at: new Date().toISOString(), cardId },
    }));
  }
  return card;
}

/**
 * A turn starting in a card's chat that the board did not start: somebody wrote
 * there. The card shows it is being worked on, and what that turn comes to is
 * the card's new state - an answer typed in the chat resolves the question, a
 * follow-up on a finished card updates its result.
 *
 * Quiet for a chat that is not a card, which is every other chat: one file that
 * does not exist is looked for and nothing else happens.
 */
async function noteCardTurnStarted(chatId: string, runId: string, surface: "web" | "external", node: ChatHome | undefined): Promise<boolean> {
  try {
    const card = await getCard(chatId);
    if (!card) return false;
    const started = await updateCard(
      chatId,
      // Whatever the card was waiting for, the person is dealing with it in its chat now.
      (current) => applyRunStart({ ...current, question: undefined }, { id: runId, surface, startedAt: new Date().toISOString(), ...(node ? { node } : {}) }),
      "card_started"
    );
    return Boolean(started);
  } catch (error) {
    console.warn(`[board] could not mark card ${chatId.slice(0, 8)} as running:`, error);
    return false;
  }
}

async function noteCardTurnEnded(chatId: string, end: RunEnd, surface: "web" | "external"): Promise<void> {
  try {
    const card = await getCard(chatId);
    if (!card) return;
    // The run this turn opened, and no other: a card the board picked up meanwhile is the board's.
    if (end.runId && !card.runs.some((run) => run.id === end.runId && !run.endedAt)) return;
    await finishCardRun(chatId, end, surface);
  } catch (error) {
    console.warn(`[board] could not record how card ${chatId.slice(0, 8)} ended:`, error);
  }
}

/**
 * Put the agent's question on its card, for a run nobody is watching. True when
 * it is there: the card is working and the question is now what it waits on.
 */
export async function putQuestionOnCard(cardId: string, question: Omit<CardQuestion, "askedAt">): Promise<boolean> {
  try {
    const card = await updateCard(
      cardId,
      (current) => (current.status === "running" ? { ...current, question: { ...question, askedAt: new Date().toISOString() } } : null),
      "card_question"
    );
    return Boolean(card?.question && card.status === "running");
  } catch (error) {
    console.warn(`[board] could not put a question on card ${cardId.slice(0, 8)}:`, error);
    return false;
  }
}

export interface CardTurn {
  /** Say how the turn ended. Only the first call counts; later ones are ignored. */
  end: (end: Omit<RunEnd, "runId">) => void;
}

/**
 * Follow a turn in a chat that may be a card. The end waits for the start to be
 * written, so the two land on the card in the order they happened even when the
 * turn is over before the first write is.
 *
 * In a pair the side that runs a turn follows it, as it writes the chat: the
 * run is marked with that side, which is how the cloud knows to ask the computer
 * about a run it does not hold itself. `node` names the side when it is not this
 * one - a turn this side handed over and follows from its stream.
 */
export function trackCardTurn(chatId: string, runId: string, surface: "web" | "external", node?: ChatHome): CardTurn {
  const where = node ?? (remoteEnabled() ? localNode() ?? undefined : undefined);
  const begun = noteCardTurnStarted(chatId, runId, surface, where);
  let ended = false;
  return {
    end(end) {
      if (ended) return;
      ended = true;
      void begun.then((isCard) => (isCard ? noteCardTurnEnded(chatId, { ...end, runId }, surface) : undefined));
    },
  };
}
