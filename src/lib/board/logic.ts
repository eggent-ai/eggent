import type { ProducedGroup } from "@/lib/files/produced-shape";
import {
  MAX_RESULT_CHARS,
  MAX_RUNS_KEPT,
  type BoardCard,
  type CardQuestion,
  type CardRun,
  type CardRunOutcome,
  type CardStatus,
} from "@/lib/board/types";

/**
 * The board's rules, with no file or clock of their own: which card starts
 * next, what a finished run does to its card, what a card's first message says.
 * Pure, so the screen and the host read a card the same way, and so every rule
 * can be checked without running an agent.
 *
 * Client-safe: no Node imports.
 */

/** The cards a card still waits for: those it names that exist and are not done. */
export function waitingFor(card: BoardCard, byId: Map<string, BoardCard>): BoardCard[] {
  if (!card.after?.length) return [];
  return card.after
    .map((id) => byId.get(id))
    .filter((parent): parent is BoardCard => Boolean(parent) && parent!.status !== "done");
}

/**
 * Whether naming `after` for card `id` would make a circle - A after B after A -
 * in which no card of the circle could ever start.
 */
export function wouldCycle(cards: BoardCard[], id: string, after: string[]): boolean {
  const edges = new Map<string, string[]>();
  for (const card of cards) edges.set(card.id, card.after ?? []);
  edges.set(id, after);
  const seen = new Set<string>();
  const stack = [...after];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (next === id) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
  return false;
}

export interface StartLimits {
  /** Cards with a turn running at once, across the board. */
  running: number;
  /** Cards of one project running at once: they share its folder. */
  perProject: number;
}

/** The project a card runs in, with the orchestrator as a project of its own. */
export function scopeOf(card: Pick<BoardCard, "projectId">): string {
  return card.projectId || "none";
}

/**
 * Which queued cards to start now, in the order to start them.
 *
 * A card is ready when it is queued, not archived, past its retry time and
 * every card it waits for is done. The queue is read top to bottom, and a card
 * is skipped - not the whole queue stopped - when its project already has as
 * many running as it may: the next project's card goes ahead.
 */
export function pickCardsToStart(
  cards: BoardCard[],
  options: { limits: StartLimits; liveByScope: Map<string, number>; now: number; exclude?: Set<string> }
): BoardCard[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  let running = 0;
  for (const count of options.liveByScope.values()) running += count;
  const perScope = new Map(options.liveByScope);
  const ready = cards
    .filter((card) => card.status === "queued" && !card.archived && !options.exclude?.has(card.id))
    .filter((card) => !card.retryAt || Date.parse(card.retryAt) <= options.now)
    .filter((card) => waitingFor(card, byId).length === 0)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  const picked: BoardCard[] = [];
  for (const card of ready) {
    if (running >= options.limits.running) break;
    const scope = scopeOf(card);
    const inScope = perScope.get(scope) ?? 0;
    if (inScope >= options.limits.perProject) continue;
    picked.push(card);
    running += 1;
    perScope.set(scope, inScope + 1);
  }
  return picked;
}

/** How one run ended, as the host saw it. */
export interface RunEnd {
  runId?: string;
  outcome: CardRunOutcome;
  detail?: string;
  /** The last message the model wrote: the card's result when the run finished. */
  finalText?: string;
  files?: ProducedGroup[];
  /** The question the run stopped at, when the side that ran it could not put it on the card itself. */
  question?: Omit<CardQuestion, "askedAt">;
  /** A failure not to retry by itself: a computer that said no to the card is not asked again behind the person's back. */
  noRetry?: boolean;
}

export interface RunEndTexts {
  /** The message a retry after a failure starts with. */
  retry: (detail?: string) => string;
  /** The message a run cut off by a restart is resumed with. */
  resume: string;
}

export interface RunEndPolicy {
  /** Failed runs in a row that are retried by themselves before the card waits for the person. */
  autoRetries: number;
  retryDelayMs: number;
  /** Restarts in a row the card is resumed after. */
  autoResumes: number;
}

export const DEFAULT_RUN_END_POLICY: RunEndPolicy = { autoRetries: 1, retryDelayMs: 60_000, autoResumes: 2 };

function closeRun(runs: CardRun[], end: RunEnd, at: string): CardRun[] {
  const index = end.runId
    ? runs.findIndex((run) => run.id === end.runId)
    : runs.map((run) => !run.endedAt).lastIndexOf(true);
  if (index < 0) return runs;
  const next = [...runs];
  next[index] = { ...next[index], endedAt: at, outcome: end.outcome, ...(end.detail ? { detail: end.detail.slice(0, 600) } : {}) };
  return next;
}

function resultOf(end: RunEnd, at: string, previous: BoardCard["result"]): BoardCard["result"] {
  const text = (end.finalText ?? "").trim();
  if (!text && !end.files?.length) return previous;
  return {
    text: text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) : text,
    ...(text.length > MAX_RESULT_CHARS ? { truncated: true } : {}),
    ...(end.files?.length ? { files: end.files } : {}),
    at,
  };
}

/**
 * What a finished run does to its card. Only the run's own outcome decides, and
 * the card's next step is always one the person can see: done, back in the
 * queue for a retry it says it is, or waiting with the reason why.
 */
export function applyRunEnd(
  card: BoardCard,
  end: RunEnd,
  options: { now: Date; texts: RunEndTexts; policy?: RunEndPolicy; surface?: CardRun["surface"] }
): BoardCard {
  const policy = options.policy ?? DEFAULT_RUN_END_POLICY;
  const at = options.now.toISOString();
  const base: BoardCard = {
    ...card,
    runs: closeRun(card.runs, end, at),
    retryAt: undefined,
    waiting: undefined,
  };
  const wait = (reason: NonNullable<BoardCard["waiting"]>["reason"], detail?: string): BoardCard => ({
    ...base,
    status: "waiting",
    waiting: { reason, ...(detail ? { detail: detail.slice(0, 1_000) } : {}), at },
  });
  // A run somebody started from the card's chat is theirs to watch: it is not retried by itself.
  const startedHere = (options.surface ?? "board") === "board";

  switch (end.outcome) {
    case "done": {
      const finished: BoardCard = {
        ...base,
        result: resultOf(end, at, card.result),
        question: undefined,
        failures: 0,
        interruptions: 0,
      };
      if (card.review) return { ...finished, status: "waiting", waiting: { reason: "review", at } };
      return { ...finished, status: "done", doneAt: at };
    }
    case "question":
      return {
        ...wait("question"),
        ...(end.question ? { question: { ...end.question, askedAt: at } } : {}),
        failures: 0,
        interruptions: 0,
      };
    case "failed": {
      const failures = card.failures + 1;
      if (startedHere && !end.noRetry && failures <= policy.autoRetries) {
        return {
          ...base,
          status: "queued",
          failures,
          interruptions: 0,
          retryAt: new Date(options.now.getTime() + policy.retryDelayMs).toISOString(),
          next: { kind: "retry", text: options.texts.retry(end.detail) },
        };
      }
      return { ...wait("failed", end.detail), failures, interruptions: 0 };
    }
    case "interrupted": {
      const interruptions = card.interruptions + 1;
      if (interruptions <= policy.autoResumes) {
        return { ...base, status: "queued", interruptions, next: { kind: "continue", text: options.texts.resume } };
      }
      return { ...wait("interrupted"), interruptions };
    }
    case "stalled":
      return wait("stalled", end.detail);
    case "stopped":
      return wait("stopped");
    case "refused":
      return wait("refused", end.detail);
  }
}

/**
 * Two copies of one card, written on the two sides of a pair at once and left
 * by the file sync as a card and a conflict copy. The copy changed last is the
 * card - its column, result and question are what was decided last - and its
 * runs are those of both, so neither side's record of a run is lost: a run the
 * two copies both know keeps the version that saw it end. The same two copies
 * give the same card on every side, byte for byte, so the merge does not start
 * a conflict of its own.
 */
export function mergeCardCopies(a: BoardCard, b: BoardCard): BoardCard {
  const later = Date.parse(b.updatedAt) > Date.parse(a.updatedAt) || (b.updatedAt === a.updatedAt && JSON.stringify(b) > JSON.stringify(a));
  const [base, other] = later ? [b, a] : [a, b];
  const runs = new Map<string, CardRun>();
  for (const run of [...other.runs, ...base.runs]) {
    const known = runs.get(run.id);
    if (!known || run.endedAt || !known.endedAt) runs.set(run.id, run);
  }
  const merged = [...runs.values()].sort((x, y) => x.startedAt.localeCompare(y.startedAt) || x.id.localeCompare(y.id)).slice(-MAX_RUNS_KEPT);
  return { ...base, runs: merged };
}

/** A run starting on a card: it moves to "running" with a record of the run. */
export function applyRunStart(card: BoardCard, run: CardRun): BoardCard {
  return {
    ...card,
    status: "running",
    runs: [...card.runs, run].slice(-MAX_RUNS_KEPT),
    waiting: undefined,
    retryAt: undefined,
    next: undefined,
    archived: undefined,
  };
}

export interface FirstMessageTexts {
  /** Heading above what the cards this one waited for came to. */
  parents: string;
  /** Label before the files a parent made. */
  files: string;
  /** Where a parent's file is, for an agent that may be working in another project. */
  filePath: (project: string, relativePath: string) => string;
}

const PARENT_RESULT_CHARS = 3_000;

/**
 * What a card's first run is sent: the task as written, and - when it waited
 * for other cards - what those came to, so it starts where they finished. This
 * is the message stored in the card's chat, so the person sees exactly what the
 * agent was told.
 */
export function firstMessage(card: BoardCard, parents: BoardCard[], texts: FirstMessageTexts): string {
  const task = card.body.trim() || card.title.trim();
  const done = parents.filter((parent) => parent.result && (parent.result.text.trim() || parent.result.files?.length));
  if (done.length === 0) return task;
  const sections = done.map((parent) => {
    const result = parent.result!;
    const text = result.text.trim();
    // The parent's own headings would outrank the heading that names it: kept as bold lines instead.
    const flat = text.replace(/^#{1,6}\s+(.+?)\s*#*$/gm, "**$1**");
    const clipped = flat.length > PARENT_RESULT_CHARS ? `${flat.slice(0, PARENT_RESULT_CHARS).trimEnd()}…` : flat;
    const files = (result.files ?? [])
      .flatMap((group) => group.items.map((item) => texts.filePath(group.project, item.path)))
      .slice(0, 20);
    return [`### ${parent.title}`, clipped, files.length ? `${texts.files}: ${files.join(", ")}` : ""].filter(Boolean).join("\n");
  });
  return [task, "", "---", texts.parents, "", sections.join("\n\n")].join("\n");
}

/** Where a card is shown: an archived card is out of every column. */
export function columnOf(card: BoardCard): CardStatus | null {
  return card.archived ? null : card.status;
}

/** Order inside a column, as the screen and the host both read it. */
export function compareInColumn(a: BoardCard, b: BoardCard): number {
  if (a.status === "done" && b.status === "done") return (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt);
  if (a.status === "waiting" && b.status === "waiting") return (b.waiting?.at ?? b.updatedAt).localeCompare(a.waiting?.at ?? a.updatedAt);
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
}
