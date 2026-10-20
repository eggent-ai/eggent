import fs from "fs/promises";
import path from "path";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { withoutSecrets } from "@/lib/secrets/mask";
import { cleanProducedGroups } from "@/lib/files/produced-shape";
import { parseHome } from "@/lib/remote/types";
import { mergeCardCopies } from "@/lib/board/logic";
import {
  CARD_STATUSES,
  MAX_AFTER,
  MAX_BODY_CHARS,
  MAX_RESULT_CHARS,
  MAX_RUNS_KEPT,
  MAX_TITLE_CHARS,
  type BoardCard,
  type BoardState,
  type CardQuestion,
  type CardRun,
  type CardStatus,
  type WaitingReason,
} from "@/lib/board/types";

/**
 * Where the board keeps its cards: one small JSON file per card, so a card that
 * changes rewrites only itself and a broken file costs one card, not the board.
 *
 * Writes go through a temporary file and a rename, so a reader never sees half
 * a card, and through one queue per card, so the host finishing a run and the
 * person editing the same card at that moment cannot each write over the other.
 * The board's own state - whether it is paused - is a file beside them.
 *
 * What is written is masked the way a stored chat is: a card is shown on
 * screens and copied wherever the workspace's files go, and a key pasted into a
 * task belongs in settings, not on a card.
 */

const BOARD_DIR = () => path.join(process.cwd(), "data", "board");
const CARDS_DIR = () => path.join(BOARD_DIR(), "cards");
const STATE_FILE = () => path.join(BOARD_DIR(), "state.json");

/** A card id is a chat id: a UUID. Anything else is not looked up, so a request can never name a path. */
const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCardId(value: unknown): value is string {
  return typeof value === "string" && CARD_ID.test(value);
}

function cardFile(id: string): string {
  return path.join(CARDS_DIR(), `${id}.json`);
}

// Routes are compiled separately and each would get its own copy of a module
// variable; the cache and the write queues have to be one per process.
const STATE_KEY = "__EGGENT_BOARD_STORE__";

interface StoreState {
  cache: Map<string, { identity: string; card: BoardCard }>;
  queues: Map<string, Promise<unknown>>;
  stateQueue: Promise<unknown>;
}

function storeState(): StoreState {
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: StoreState };
  if (!holder[STATE_KEY]) holder[STATE_KEY] = { cache: new Map(), queues: new Map(), stateQueue: Promise.resolve() };
  return holder[STATE_KEY];
}

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function isoOr(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

const WAITING_REASONS: readonly WaitingReason[] = ["question", "failed", "stalled", "stopped", "refused", "review", "interrupted"];
const RUN_OUTCOMES = ["done", "question", "failed", "stalled", "stopped", "refused", "interrupted"] as const;

function cleanQuestion(value: unknown): CardQuestion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<CardQuestion>;
  const text = clip(raw.text, 2_000);
  if (!text) return undefined;
  const options = Array.isArray(raw.options)
    ? raw.options.map((option) => clip(option, 200)).filter(Boolean).slice(0, 6)
    : undefined;
  const kind = raw.kind === "choice" || raw.kind === "confirm" ? raw.kind : "free_text";
  return {
    text,
    kind,
    ...(options?.length ? { options } : {}),
    ...(typeof raw.placeholder === "string" && raw.placeholder.trim() ? { placeholder: clip(raw.placeholder, 200) } : {}),
    askedAt: isoOr(raw.askedAt, new Date().toISOString()),
  };
}

function cleanRun(value: unknown): CardRun | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CardRun>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const surface = raw.surface === "web" || raw.surface === "external" ? raw.surface : "board";
  const outcome = RUN_OUTCOMES.find((candidate) => candidate === raw.outcome);
  const node = parseHome(raw.node);
  return {
    id: raw.id.slice(0, 80),
    surface,
    ...(node ? { node } : {}),
    startedAt: isoOr(raw.startedAt, new Date(0).toISOString()),
    ...(typeof raw.endedAt === "string" ? { endedAt: isoOr(raw.endedAt, raw.startedAt ?? "") } : {}),
    ...(outcome ? { outcome } : {}),
    ...(typeof raw.detail === "string" && raw.detail.trim() ? { detail: clip(raw.detail, 600) } : {}),
  };
}

/** A card as stored, read whatever shape it is in. Null for a file that is not a card at all. */
export function normalizeCard(value: unknown): BoardCard | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<BoardCard>;
  if (!isCardId(raw.id)) return null;
  const now = new Date().toISOString();
  const status: CardStatus = CARD_STATUSES.find((candidate) => candidate === raw.status) ?? "inbox";
  const waitingReason = WAITING_REASONS.find((reason) => reason === raw.waiting?.reason);
  const after = Array.isArray(raw.after)
    ? [...new Set(raw.after.filter((id): id is string => isCardId(id) && id !== raw.id))].slice(0, MAX_AFTER)
    : [];
  const runs = Array.isArray(raw.runs) ? raw.runs.map(cleanRun).filter((run): run is CardRun => run !== null).slice(-MAX_RUNS_KEPT) : [];
  const question = cleanQuestion(raw.question);
  const nextKind = raw.next?.kind === "answer" || raw.next?.kind === "retry" ? raw.next.kind : "continue";
  const nextText = clip(raw.next?.text, MAX_BODY_CHARS);
  const resultText = typeof raw.result?.text === "string" ? raw.result.text : null;
  const home = parseHome(raw.home);
  const files = raw.result ? cleanProducedGroups(raw.result.files) : [];
  return {
    id: raw.id,
    title: clip(raw.title, MAX_TITLE_CHARS) || "Untitled",
    body: clip(raw.body, MAX_BODY_CHARS),
    ...(typeof raw.projectId === "string" && raw.projectId.trim() && raw.projectId !== "none" ? { projectId: raw.projectId.trim() } : {}),
    ...(home ? { home } : {}),
    status,
    position: typeof raw.position === "number" && Number.isFinite(raw.position) ? raw.position : 0,
    ...(after.length ? { after } : {}),
    createdBy: raw.createdBy === "agent" ? "agent" : "person",
    ...(raw.createdFrom && typeof raw.createdFrom.chatId === "string"
      ? { createdFrom: { chatId: raw.createdFrom.chatId.slice(0, 80), ...(typeof raw.createdFrom.title === "string" ? { title: clip(raw.createdFrom.title, 200) } : {}) } }
      : {}),
    ...(raw.review === true ? { review: true } : {}),
    ...(waitingReason
      ? {
          waiting: {
            reason: waitingReason,
            ...(typeof raw.waiting?.detail === "string" && raw.waiting.detail.trim() ? { detail: clip(raw.waiting.detail, 1_000) } : {}),
            at: isoOr(raw.waiting?.at, now),
          },
        }
      : {}),
    ...(question ? { question } : {}),
    ...(nextText ? { next: { kind: nextKind, text: nextText } } : {}),
    ...(resultText !== null
      ? {
          result: {
            text: resultText.length > MAX_RESULT_CHARS ? resultText.slice(0, MAX_RESULT_CHARS) : resultText,
            ...(raw.result?.truncated || resultText.length > MAX_RESULT_CHARS ? { truncated: true } : {}),
            ...(files.length ? { files } : {}),
            at: isoOr(raw.result?.at, now),
          },
        }
      : {}),
    runs,
    failures: typeof raw.failures === "number" && raw.failures > 0 ? Math.floor(raw.failures) : 0,
    interruptions: typeof raw.interruptions === "number" && raw.interruptions > 0 ? Math.floor(raw.interruptions) : 0,
    ...(typeof raw.retryAt === "string" && Number.isFinite(Date.parse(raw.retryAt)) ? { retryAt: raw.retryAt } : {}),
    ...(raw.archived === true ? { archived: true } : {}),
    createdAt: isoOr(raw.createdAt, now),
    updatedAt: isoOr(raw.updatedAt, now),
    ...(typeof raw.doneAt === "string" && Number.isFinite(Date.parse(raw.doneAt)) ? { doneAt: raw.doneAt } : {}),
  };
}

async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(temp, data, "utf-8");
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readCardFile(id: string): Promise<BoardCard | null> {
  const file = cardFile(id);
  const cache = storeState().cache;
  let identity: string;
  try {
    const stat = await fs.stat(file);
    identity = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    cache.delete(id);
    return null;
  }
  const cached = cache.get(id);
  if (cached && cached.identity === identity) return cached.card;
  try {
    const card = normalizeCard(JSON.parse(await fs.readFile(file, "utf-8")));
    if (!card || card.id !== id) return null;
    if (cache.size > 2_000) cache.clear();
    cache.set(id, { identity, card });
    return card;
  } catch {
    return null;
  }
}

async function writeCardFile(card: BoardCard): Promise<BoardCard> {
  const masked = withoutSecrets(card);
  const normalized = normalizeCard(masked) ?? masked;
  await writeAtomic(cardFile(card.id), JSON.stringify(normalized, null, 2));
  storeState().cache.delete(card.id);
  return normalized;
}

function publish(card: Pick<BoardCard, "id" | "projectId">, reason: string): void {
  publishUiSyncEvent({ topic: "board", chatId: card.id, projectId: card.projectId ?? null, reason });
}

/** `<id>.sync-conflict-<date>-<time>-<device>.json`: the copy the file sync kept when both sides wrote a card. */
const CONFLICT_COPY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sync-conflict-[A-Za-z0-9-]+\.json$/i;

/**
 * Settle the copies the file sync left when both sides of a pair wrote one card
 * at once: the two are joined (see mergeCardCopies) - what was decided last,
 * and every run either side recorded - and the copy is let go of. Every side
 * does the same with the same two files and writes the same bytes, so they
 * agree without asking each other.
 */
async function settleConflictCopies(names: string[]): Promise<void> {
  for (const name of names) {
    const match = CONFLICT_COPY.exec(name);
    if (!match) continue;
    const id = match[1];
    const copyFile = path.join(CARDS_DIR(), name);
    try {
      const copy = normalizeCard(JSON.parse(await fs.readFile(copyFile, "utf-8")));
      const current = await readCardFile(id);
      if (copy && copy.id === id) {
        if (!current) await insertCard(copy);
        else {
          await updateCard(
            id,
            (now) => {
              const merged = mergeCardCopies(now, copy);
              return JSON.stringify(merged) === JSON.stringify(now) ? null : merged;
            },
            "card_conflict_settled",
            { keepTime: true }
          ).catch(() => null);
        }
      }
      await fs.rm(copyFile, { force: true });
    } catch {
      // Unreadable: left for a later look rather than guessed at.
    }
  }
}

/** Every card on the board, in no particular order. */
export async function listCards(): Promise<BoardCard[]> {
  let names: string[];
  try {
    names = await fs.readdir(CARDS_DIR());
  } catch {
    return [];
  }
  if (names.some((name) => CONFLICT_COPY.test(name))) {
    await settleConflictCopies(names);
    names = await fs.readdir(CARDS_DIR()).catch(() => []);
  }
  const ids = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter(isCardId);
  const cards = await Promise.all(ids.map((id) => readCardFile(id)));
  return cards.filter((card): card is BoardCard => card !== null);
}

export async function getCard(id: string | null | undefined): Promise<BoardCard | null> {
  if (!isCardId(id)) return null;
  return readCardFile(id);
}

/**
 * Change one card, in order with every other change to it.
 *
 * The change is handed the card as it is on disk now, not as somebody read it a
 * moment ago, and returns the card to write - or null to write nothing. The
 * card's id is kept whatever the change does to it.
 */
export async function updateCard(
  id: string,
  change: (card: BoardCard) => BoardCard | null | Promise<BoardCard | null>,
  reason = "card_updated",
  /** Keep the time the change says: a join of two copies is not a new change, and must read the same on every side. */
  options: { keepTime?: boolean } = {}
): Promise<BoardCard | null> {
  if (!isCardId(id)) return null;
  const { queues } = storeState();
  const previous = queues.get(id) ?? Promise.resolve();
  const work = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readCardFile(id);
      if (!current) return null;
      const next = await change(structuredClone(current));
      if (!next) return current;
      const written = await writeCardFile({ ...next, id, updatedAt: options.keepTime ? next.updatedAt : new Date().toISOString() });
      publish(written, reason);
      return written;
    });
  queues.set(id, work);
  try {
    return await work;
  } finally {
    if (queues.get(id) === work) queues.delete(id);
  }
}

/** Write a new card. Its position, when not given, is the end of its column. */
export async function insertCard(card: BoardCard): Promise<BoardCard> {
  const written = await writeCardFile(card);
  publish(written, "card_created");
  return written;
}

export async function deleteCardFile(id: string): Promise<boolean> {
  if (!isCardId(id)) return false;
  const existing = await readCardFile(id);
  try {
    await fs.unlink(cardFile(id));
  } catch {
    return false;
  }
  storeState().cache.delete(id);
  publish({ id, projectId: existing?.projectId }, "card_deleted");
  return true;
}

/** The next free position at the end of a column. */
export function endOfColumn(cards: BoardCard[], status: CardStatus): number {
  let max = 0;
  for (const card of cards) {
    if (card.status === status && card.position > max) max = card.position;
  }
  return max + 1;
}

export async function readBoardState(): Promise<BoardState> {
  try {
    const raw = JSON.parse(await fs.readFile(STATE_FILE(), "utf-8")) as BoardState;
    if (raw && typeof raw === "object" && raw.paused && raw.paused.reason === "refused") {
      return {
        paused: {
          reason: "refused",
          ...(typeof raw.paused.detail === "string" ? { detail: clip(raw.paused.detail, 1_000) } : {}),
          at: isoOr(raw.paused.at, new Date().toISOString()),
          ...(isCardId(raw.paused.cardId) ? { cardId: raw.paused.cardId } : {}),
        },
      };
    }
  } catch {
    // no state yet: nothing is paused
  }
  return {};
}

export async function updateBoardState(change: (state: BoardState) => BoardState): Promise<BoardState> {
  const holder = storeState();
  const work = holder.stateQueue
    .catch(() => undefined)
    .then(async () => {
      const next = change(await readBoardState());
      await writeAtomic(STATE_FILE(), JSON.stringify(next, null, 2));
      publishUiSyncEvent({ topic: "board", reason: "board_state" });
      return next;
    });
  holder.stateQueue = work;
  return work;
}

/** The directory the board's files live in, for the guard that keeps the agent's own tools out of it. */
export function boardDirectory(): string {
  return BOARD_DIR();
}
