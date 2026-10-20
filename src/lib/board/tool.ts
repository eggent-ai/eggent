import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { chatPath } from "@/lib/dashboard-routes";
import { getChat } from "@/lib/storage/chat-store";
import { BoardError, createCards, deleteCard, editCard } from "@/lib/board/cards";
import { waitingFor } from "@/lib/board/logic";
import { getCard, listCards } from "@/lib/board/store";
import { CARD_STATUSES, type BoardCard, type CardStatus } from "@/lib/board/types";

/**
 * The agent's way onto the board: read it, and write down work as cards.
 *
 * One tool, because its schema is sent with every request and the three
 * pipeline tools it replaces cost more than this does. What it cannot do is the
 * point of it: the agent proposes, and only the person starts - a card it makes
 * waits in the inbox, and once the person has started one, its task is no
 * longer the agent's to rewrite.
 */

function textResult(value: Record<string, unknown>, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details };
}

const RESULT_PREVIEW_CHARS = 1_500;

function summary(card: BoardCard, byId: Map<string, BoardCard>) {
  const pending = waitingFor(card, byId);
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    project: card.projectId ?? "none",
    ...(card.waiting ? { waiting: card.waiting.reason } : {}),
    ...(card.after?.length ? { after: card.after } : {}),
    ...(pending.length ? { waits_for: pending.map((parent) => parent.title) } : {}),
    ...(card.archived ? { archived: true } : {}),
    created_by: card.createdBy,
  };
}

export function createBoardTool(options: { chatId?: string; projectId?: string }): ToolDefinition {
  return defineTool({
    name: "eggent_board",
    label: "Task Board",
    description:
      "The workspace's task board: cards of work, each done by you later in a chat of its own, one after another, while nobody needs to watch. list/get read it. create writes cards for the person to start - use it when the person asks to plan work as tasks, put something on the board, or split a job into steps that can run on their own (each card a self-contained task; `after` makes a card wait for others). New cards wait in the Inbox until the person presses Start on the board; you cannot start them, so say so and point to the board. update/remove change only cards still in the Inbox.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("create"), Type.Literal("update"), Type.Literal("remove")]),
      card_id: Type.Optional(Type.String({ description: "get, update, remove: the card's id from list." })),
      status: Type.Optional(Type.String({ description: "list: only cards in this column: inbox, queued, running, waiting or done." })),
      cards: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String({ description: "Short name of the task, in the person's language." }),
            task: Type.String({ description: "What to do, complete enough to carry out without this conversation." }),
            project_id: Type.Optional(Type.String({ description: "The project it runs in; omit for the orchestrator." })),
            after: Type.Optional(Type.Array(Type.String(), { description: "Cards it waits for: ids, or \"#1\", \"#2\"... for earlier cards of this same list." })),
          }),
          { description: "create: the cards, in the order they should run." }
        )
      ),
      title: Type.Optional(Type.String({ description: "update: the new title." })),
      task: Type.Optional(Type.String({ description: "update: the new task." })),
      project_id: Type.Optional(Type.String({ description: "update: the new project, or \"none\"." })),
      after: Type.Optional(Type.Array(Type.String(), { description: "update: the cards it waits for, replacing the old list." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        if (params.action === "list") {
          const cards = await listCards();
          const byId = new Map(cards.map((card) => [card.id, card]));
          const status = CARD_STATUSES.find((candidate) => candidate === params.status) as CardStatus | undefined;
          const shown = cards
            .filter((card) => !card.archived || params.status === "done")
            .filter((card) => !status || card.status === status)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 60);
          return textResult({ success: true, board: "/dashboard/board", cards: shown.map((card) => summary(card, byId)) });
        }

        if (params.action === "create") {
          const inputs = params.cards ?? [];
          const from = options.chatId ? await getChat(options.chatId) : null;
          const created = await createCards(
            inputs.map((card) => ({ title: card.title, body: card.task, projectId: card.project_id ?? options.projectId, after: card.after })),
            { createdBy: "agent", ...(options.chatId ? { createdFrom: { chatId: options.chatId, ...(from?.title ? { title: from.title } : {}) } } : {}) }
          );
          return textResult(
            {
              success: true,
              created: created.map((card) => ({ id: card.id, title: card.title, status: card.status })),
              board: "/dashboard/board",
              note: "The cards wait in the Inbox. Only the person can start them: tell them so in one line and point to the board (Board in the sidebar), where Start runs one card and Start all runs the Inbox in order.",
            },
            { board: { created: created.length } }
          );
        }

        const id = params.card_id?.trim() || "";
        if (!id) return textResult({ success: false, error: `${params.action} needs card_id; list the board first.` });

        if (params.action === "get") {
          const card = await getCard(id);
          if (!card) return textResult({ success: false, error: `There is no card ${id}. List the board first.` });
          const byId = new Map((await listCards()).map((other) => [other.id, other]));
          const text = card.result?.text ?? "";
          return textResult({
            success: true,
            card: {
              ...summary(card, byId),
              task: card.body,
              ...(card.question ? { question: card.question.text } : {}),
              ...(card.waiting?.detail ? { waiting_detail: card.waiting.detail } : {}),
              ...(card.result
                ? {
                    result: text.length > RESULT_PREVIEW_CHARS ? `${text.slice(0, RESULT_PREVIEW_CHARS)}…` : text,
                    result_files: (card.result.files ?? []).flatMap((group) => group.items.map((item) => `${group.project}/${item.path}`)),
                  }
                : {}),
              chat: card.runs.length > 0 ? chatPath(card.id) : null,
            },
            note: card.runs.length > 0 ? "The whole conversation of this card can be read with eggent_manage_chats read, chat_id = the card's id." : undefined,
          });
        }

        if (params.action === "update") {
          const card = await editCard(
            id,
            {
              ...(params.title !== undefined ? { title: params.title } : {}),
              ...(params.task !== undefined ? { body: params.task } : {}),
              ...(params.project_id !== undefined ? { projectId: params.project_id } : {}),
              ...(params.after !== undefined ? { after: params.after } : {}),
            },
            "agent"
          );
          return textResult({ success: true, card: { id: card.id, title: card.title, status: card.status } });
        }

        await deleteCard(id, "agent");
        return textResult({ success: true, removed: id });
      } catch (error) {
        if (error instanceof BoardError) return textResult({ success: false, error: error.message });
        throw error;
      }
    },
  }) as ToolDefinition;
}
