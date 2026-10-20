import { getServerTranslator } from "@/i18n/server";
import type { MessageKey, MessageValues } from "@/i18n/messages";
import { getActiveRun, stopActiveRun } from "@/lib/pi/active-runs";
import { deleteChat } from "@/lib/storage/chat-store";
import { getProject } from "@/lib/storage/project-store";
import { wouldCycle } from "@/lib/board/logic";
import {
  deleteCardFile,
  endOfColumn,
  getCard,
  insertCard,
  isCardId,
  listCards,
  updateBoardState,
  updateCard,
} from "@/lib/board/store";
import {
  MAX_AFTER,
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  type BoardCard,
  type CardStatus,
} from "@/lib/board/types";

/**
 * What a person or the agent may do to the board, with the rules in one place:
 * the screen's routes and the agent's tool both come through here.
 *
 * The one rule that is a boundary rather than a convenience: only the person
 * starts work. A card the agent writes lands in the inbox and stays there until
 * somebody presses Start, because the agent reads pages, files and messages
 * from outside, and a line in any of them could otherwise put a task with a
 * shell into the queue. The same reason keeps the agent's hands off a card once
 * it has left the inbox - its task is what the person agreed to.
 */

/**
 * A rule said no. The message is for the agent, which reads English; the key is
 * for a screen, which says it in the workspace's language.
 */
export class BoardError extends Error {
  readonly code: "not-found" | "invalid" | "running" | "conflict";
  readonly status: number;
  readonly key: MessageKey;
  readonly values?: MessageValues;

  constructor(code: BoardError["code"], message: string, key: MessageKey, values?: MessageValues) {
    super(message);
    this.name = "BoardError";
    this.code = code;
    this.status = code === "not-found" ? 404 : code === "invalid" ? 400 : 409;
    this.key = key;
    this.values = values;
  }
}

export interface CardInput {
  title?: string;
  body?: string;
  projectId?: string | null;
  after?: string[];
  review?: boolean;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function checkProject(projectId: string | null | undefined): Promise<string | undefined> {
  if (!projectId || projectId === "none") return undefined;
  const project = await getProject(projectId);
  if (!project) throw new BoardError("invalid", `There is no project "${projectId}".`, "board.error.noProject", { project: projectId });
  return project.id;
}

function checkAfter(cards: BoardCard[], id: string, after: string[] | undefined): string[] | undefined {
  if (after === undefined) return undefined;
  const ids = [...new Set(after.filter((value) => typeof value === "string").map((value) => value.trim()))].filter(Boolean);
  if (ids.length > MAX_AFTER) throw new BoardError("invalid", `A card can wait for at most ${MAX_AFTER} others.`, "board.error.tooManyAfter", { max: MAX_AFTER });
  const known = new Set(cards.map((card) => card.id));
  for (const other of ids) {
    if (other === id) throw new BoardError("invalid", "A card cannot wait for itself.", "board.error.afterSelf");
    if (!isCardId(other) || !known.has(other)) throw new BoardError("invalid", `There is no card ${other}.`, "board.error.noCard");
  }
  if (wouldCycle(cards, id, ids)) throw new BoardError("invalid", "Those cards would wait for each other, and none of them could ever start.", "board.error.cycle");
  return ids;
}

/**
 * Write new cards, in order. `after` may name cards made earlier in the same
 * call by their place in it ("#1" is the first) - how the agent writes down a
 * plan whose steps follow one another.
 */
export async function createCards(
  inputs: CardInput[],
  options: { createdBy: "person" | "agent"; createdFrom?: { chatId: string; title?: string }; start?: boolean }
): Promise<BoardCard[]> {
  if (inputs.length === 0) throw new BoardError("invalid", "Nothing to put on the board.", "board.error.nothing");
  if (inputs.length > 30) throw new BoardError("invalid", "At most 30 cards at a time.", "board.error.tooMany");
  // Only the person starts work; see above.
  const status: CardStatus = options.createdBy === "person" && options.start ? "queued" : "inbox";
  const created: BoardCard[] = [];
  const existing = await listCards();
  let position = endOfColumn(existing, status);
  for (const [index, input] of inputs.entries()) {
    const title = clean(input.title, MAX_TITLE_CHARS) || clean(input.body, MAX_TITLE_CHARS).split("\n")[0];
    const body = clean(input.body, MAX_BODY_CHARS);
    if (!title && !body) throw new BoardError("invalid", `Card ${index + 1} has neither a title nor a task.`, "board.error.emptyCard");
    const id = crypto.randomUUID();
    const resolvedAfter = (input.after ?? []).map((ref) => {
      const match = /^#(\d+)$/.exec(String(ref).trim());
      if (!match) return String(ref).trim();
      const earlier = created[Number(match[1]) - 1];
      if (!earlier) throw new BoardError("invalid", `Card ${index + 1} waits for ${ref}, which is not an earlier card of this list.`, "board.error.noCard");
      return earlier.id;
    });
    const after = checkAfter([...existing, ...created], id, resolvedAfter);
    const projectId = await checkProject(input.projectId);
    const now = new Date().toISOString();
    const card: BoardCard = {
      id,
      title: title || body.slice(0, MAX_TITLE_CHARS),
      body,
      ...(projectId ? { projectId } : {}),
      status,
      position: position++,
      ...(after?.length ? { after } : {}),
      createdBy: options.createdBy,
      ...(options.createdFrom ? { createdFrom: options.createdFrom } : {}),
      ...(input.review ? { review: true } : {}),
      runs: [],
      failures: 0,
      interruptions: 0,
      createdAt: now,
      updatedAt: now,
    };
    created.push(await insertCard(card));
  }
  return created;
}

async function requireCard(id: string): Promise<BoardCard> {
  const card = await getCard(id);
  if (!card) throw new BoardError("not-found", `There is no card ${id}.`, "board.error.noCard");
  return card;
}

function refuseWhileRunning(card: BoardCard): void {
  if (card.status === "running" || getActiveRun(card.id)) {
    throw new BoardError("running", "The card is being worked on. Stop it first, or wait for it to finish.", "board.error.running");
  }
}

/** Change what a card says. Not while it runs; its project only before it ever ran, since its chat is in that project. */
export async function editCard(id: string, input: CardInput, actor: "person" | "agent"): Promise<BoardCard> {
  const card = await requireCard(id);
  refuseWhileRunning(card);
  if (actor === "agent" && card.status !== "inbox") {
    throw new BoardError("conflict", "The agent can change a card only while it waits in the inbox; this one has been started.", "board.error.agentStarted");
  }
  const projectId = input.projectId !== undefined ? await checkProject(input.projectId) : card.projectId;
  if (input.projectId !== undefined && (projectId ?? null) !== (card.projectId ?? null) && card.runs.length > 0) {
    throw new BoardError("conflict", "The card has already run in its project, and its conversation is there.", "board.error.projectFixed");
  }
  const after = checkAfter(await listCards(), id, input.after);
  const updated = await updateCard(id, (current) => {
    const title = input.title !== undefined ? clean(input.title, MAX_TITLE_CHARS) : current.title;
    return {
      ...current,
      title: title || current.title,
      ...(input.body !== undefined ? { body: clean(input.body, MAX_BODY_CHARS) } : {}),
      projectId,
      ...(after !== undefined ? { after: after.length ? after : undefined } : {}),
      ...(input.review !== undefined ? { review: input.review || undefined } : {}),
    };
  }, "card_edited");
  if (!updated) throw new BoardError("not-found", `There is no card ${id}.`, "board.error.noCard");
  return updated;
}

export type MoveTarget = CardStatus | "archived" | "unarchived";

/**
 * Move a card between columns - by the person; the agent never starts work.
 *
 * Into the queue it carries the message its next run starts with: for a card
 * that never ran, its task; for one that stopped, to carry on; for a question
 * nobody answered, to decide; for a finished one, to do it again.
 */
export async function moveCard(id: string, to: MoveTarget, options: { position?: number } = {}): Promise<BoardCard> {
  const card = await requireCard(id);
  if (to !== card.status && to !== "archived" && to !== "unarchived") refuseWhileRunning(card);
  if (to === "running") throw new BoardError("invalid", "A card starts by being put in the queue.", "board.error.moveRunning");
  const t = await getServerTranslator();
  const cards = await listCards();
  const now = new Date().toISOString();
  const updated = await updateCard(id, (current) => {
    if (to === "archived") {
      if (current.status === "running" || current.status === "queued") throw new BoardError("conflict", "Only a card that is not working or waiting to start can be put away.", "board.error.archiveActive");
      return { ...current, archived: true };
    }
    if (to === "unarchived") return { ...current, archived: undefined };
    const position = typeof options.position === "number" && Number.isFinite(options.position)
      ? options.position
      : current.status === to
        ? current.position
        : endOfColumn(cards, to);
    if (to === current.status) return { ...current, position };
    if (to === "queued") {
      const next = current.next
        ?? (current.runs.length === 0
          ? undefined
          : current.status === "done"
            ? { kind: "continue" as const, text: t("board.next.redo") }
            : current.waiting?.reason === "question"
              ? { kind: "continue" as const, text: t("board.next.decide") }
              : current.waiting?.reason === "review"
                ? { kind: "continue" as const, text: t("board.next.redo") }
                : { kind: "continue" as const, text: t("board.next.continue") });
      return {
        ...current,
        status: "queued",
        position,
        next,
        waiting: undefined,
        question: current.waiting?.reason === "question" ? undefined : current.question,
        retryAt: undefined,
        failures: 0,
        interruptions: 0,
        archived: undefined,
      };
    }
    if (to === "done") {
      return { ...current, status: "done", position, waiting: undefined, question: undefined, retryAt: undefined, doneAt: now, archived: undefined };
    }
    if (to === "inbox") {
      return { ...current, status: "inbox", position, waiting: undefined, retryAt: undefined, archived: undefined };
    }
    // "waiting" is where the host puts a card, not a place to move one to.
    throw new BoardError("invalid", "A card waits for you when its run says so.", "board.error.moveWaiting");
  }, `card_moved_${to}`);
  if (!updated) throw new BoardError("not-found", `There is no card ${id}.`, "board.error.noCard");
  return updated;
}

/** The person's answer to the card's question: the card's next run starts with it, ahead of the queue. */
export async function answerCard(id: string, text: string): Promise<BoardCard> {
  const answer = clean(text, MAX_BODY_CHARS);
  if (!answer) throw new BoardError("invalid", "The answer is empty.", "board.error.emptyAnswer");
  const card = await requireCard(id);
  refuseWhileRunning(card);
  const cards = await listCards();
  const top = cards.filter((other) => other.status === "queued").reduce((min, other) => Math.min(min, other.position), 1) - 1;
  const updated = await updateCard(id, (current) => ({
    ...current,
    status: "queued",
    position: top,
    next: { kind: "answer", text: answer },
    question: undefined,
    waiting: undefined,
    retryAt: undefined,
    failures: 0,
    archived: undefined,
  }), "card_answered");
  if (!updated) throw new BoardError("not-found", `There is no card ${id}.`, "board.error.noCard");
  return updated;
}

/** Stop a card: a running one is stopped where it is; a queued one goes back to the inbox. */
export async function stopCardWork(id: string): Promise<BoardCard> {
  const card = await requireCard(id);
  if (getActiveRun(id)) {
    await stopActiveRun(id);
    return card;
  }
  if (card.status === "queued") return moveCard(id, "inbox");
  return card;
}

/** Delete a card and its conversation. Not while it runs. The files it made stay where they are. */
export async function deleteCard(id: string, actor: "person" | "agent"): Promise<void> {
  const card = await requireCard(id);
  refuseWhileRunning(card);
  if (actor === "agent" && (card.status !== "inbox" || card.createdBy !== "agent")) {
    throw new BoardError("conflict", "The agent can remove only a card it proposed that is still in the inbox.", "board.error.agentRemove");
  }
  await deleteCardFile(id);
  await deleteChat(id);
  // Cards that waited for this one no longer do.
  for (const other of await listCards()) {
    if (other.after?.includes(id)) {
      await updateCard(other.id, (current) => {
        const after = (current.after ?? []).filter((parent) => parent !== id);
        return { ...current, after: after.length ? after : undefined };
      }, "card_edited");
    }
  }
}

/** Start every card in the inbox (of one project, when named), in their order. */
export async function startInbox(projectId?: string | null): Promise<number> {
  const cards = (await listCards())
    .filter((card) => card.status === "inbox" && !card.archived)
    .filter((card) => projectId === undefined || (card.projectId ?? "none") === (projectId || "none"))
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  for (const card of cards) await moveCard(card.id, "queued");
  return cards.length;
}

/** The person says the board may go on after a refusal. */
export async function resumeBoard(): Promise<void> {
  await updateBoardState((state) => ({ ...state, paused: undefined }));
}
