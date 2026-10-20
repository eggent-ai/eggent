import type { ProducedGroup } from "@/lib/files/produced-shape";

/**
 * The task board: work handed to the agent as cards, each one carried out in a
 * conversation of its own.
 *
 * A card is a chat with a place in a queue. Its id is the id of that chat, so
 * the conversation is the card's whole record - what it was asked, what it ran,
 * what it answered - and opening it is opening the chat, where the person can
 * keep talking to the agent about that one piece of work. What the card adds is
 * what a chat does not have: a column, an order, the cards it waits for, and a
 * host that starts it when its turn comes and reads how each run ended.
 *
 * The status is set by the host from how the run ended, never by the model
 * calling a tool to say it is finished. Waiting for a model to report its own
 * completion is the weak point of agent queues - models end with text as often
 * as with the tool - and here the end of the turn already is the report.
 *
 * Client-safe: no Node imports.
 */

/**
 * Where a card is. Five columns, in the order work moves through them.
 *
 * - inbox: written down, not started. Everything the agent proposes lands here
 *   and waits for the person; nothing in it ever starts by itself.
 * - queued: will start when there is room and every card it waits for is done.
 * - running: a turn is working in its chat right now.
 * - waiting: stopped for the person - a question, a failure, a stop, a review.
 * - done: finished; its last answer is the result.
 */
export type CardStatus = "inbox" | "queued" | "running" | "waiting" | "done";

export const CARD_STATUSES: readonly CardStatus[] = ["inbox", "queued", "running", "waiting", "done"];

/** Why a card is waiting for the person. */
export type WaitingReason =
  /** The agent asked something it cannot decide; the question is on the card. */
  | "question"
  /** The run ended with an error, after the automatic retry. */
  | "failed"
  /** The run went quiet for too long and was given up on. */
  | "stalled"
  /** Somebody stopped it. */
  | "stopped"
  /** The model service refused (spent balance, closed workspace): the whole board is paused. */
  | "refused"
  /** Finished, and the card asked to be checked before it counts as done. */
  | "review"
  /** The server restarted under it more than once in a row. */
  | "interrupted";

export interface CardWaiting {
  reason: WaitingReason;
  /** What the person is shown: the error, the refusal in the service's words. */
  detail?: string;
  at: string;
}

/** A question the agent put on the card instead of to nobody. */
export interface CardQuestion {
  text: string;
  kind: "choice" | "confirm" | "free_text";
  options?: string[];
  placeholder?: string;
  askedAt: string;
}

/** What the card's work came to: its last answer, and the files it made. */
export interface CardResult {
  text: string;
  truncated?: boolean;
  files?: ProducedGroup[];
  at: string;
}

/** How one run of a card ended. */
export type CardRunOutcome = "done" | "question" | "failed" | "stalled" | "stopped" | "refused" | "interrupted";

export interface CardRun {
  id: string;
  /** board = started by the board; web/external = somebody wrote in the card's chat. */
  surface: "board" | "web" | "external";
  startedAt: string;
  endedAt?: string;
  outcome?: CardRunOutcome;
  detail?: string;
}

/**
 * The message the card's next run starts with, when it is not the task itself:
 * the person's answer to a question, or the board saying to carry on.
 */
export interface CardNext {
  kind: "answer" | "continue" | "retry";
  text: string;
}

export interface BoardCard {
  /** Also the id of the card's chat. */
  id: string;
  title: string;
  /** The task, as the person (or the agent proposing it) wrote it. */
  body: string;
  /** The project it runs in; absent for the orchestrator. */
  projectId?: string;
  status: CardStatus;
  /** Order inside its column, smallest first. The queue starts the first card it can. */
  position: number;
  /** Cards this one waits for: it starts only once every one of them is done. */
  after?: string[];
  /** Who wrote it down. A card the agent proposed waits in the inbox for the person. */
  createdBy: "person" | "agent";
  /** The chat it was proposed from, when the agent proposed it. */
  createdFrom?: { chatId: string; title?: string };
  /** Stop in "waiting" for a look when finished, instead of going straight to done. */
  review?: boolean;
  waiting?: CardWaiting;
  question?: CardQuestion;
  next?: CardNext;
  result?: CardResult;
  /** The most recent runs, newest last. */
  runs: CardRun[];
  /** Failed runs in a row, for the one automatic retry. */
  failures: number;
  /** Restarts under it in a row, for the automatic resume. */
  interruptions: number;
  /** A retry after a failure waits until then. */
  retryAt?: string;
  /** Out of the done column, still kept. */
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
}

/** The board as a whole: whether it may start anything. */
export interface BoardState {
  /**
   * Set when the model service refused a card's run. Every card after it would
   * be refused the same way, so nothing more starts until the person says so.
   */
  paused?: { reason: "refused"; detail?: string; at: string; cardId?: string };
}

/** What the board page reads. */
export interface BoardSnapshot {
  cards: BoardCard[];
  state: BoardState;
  /** Card ids with a turn in their chat right now, and since when. */
  live: Record<string, { startedAt: number; question: boolean }>;
  limits: { running: number; perProject: number };
}

/** The badge on the sidebar's board entry. */
export interface BoardSummary {
  waiting: number;
  running: number;
  queued: number;
  paused: boolean;
}

export const MAX_TITLE_CHARS = 140;
export const MAX_BODY_CHARS = 20_000;
/** A card's result as kept on the card; the whole answer is in its chat. */
export const MAX_RESULT_CHARS = 8_000;
export const MAX_RUNS_KEPT = 20;
export const MAX_AFTER = 20;
