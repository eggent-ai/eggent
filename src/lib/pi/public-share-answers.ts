import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPendingInteraction } from "@/lib/pi/pending-interactions";
import { DEFER_INTERACTION_ANSWER, type PiPendingInteraction } from "@/lib/pi/interaction-types";
import { UNANSWERED_QUESTION } from "@/lib/pi/turn-watchdog";

/**
 * What a visitor of a shared project can do besides being answered: be asked a
 * question on a card, and leave an answer for the owner.
 *
 * Neither reaches anything the visitor could not reach before. The card is the
 * visitor's own screen asking them; the answer goes into one file the visitor
 * cannot read back - `responses/` is closed to the read tools (public-share.ts),
 * so nobody reads another visitor's row - and who wrote the row is stamped here
 * from what the host passed with the turn, never from what the model says.
 */

/** The folder at the top of a shared project where visitors' answers are kept. */
export const RESPONSES_FOLDER = "responses";

/** Who is writing, as the host that let them in knows them. Hidden from the model. */
export interface PublicVisitor {
  name?: string;
  email?: string;
  /** The email was confirmed with a code sent to it. */
  confirmed?: boolean;
  /** The conversation this turn belongs to, so a row can be traced back to it. */
  conversation?: string;
}

/** Where answers go and who gives them, read from a turn's hidden runtime data. */
export interface PublicAnswersTarget {
  /** File name stem inside `responses/`: one file per link. */
  file: string;
  visitor: PublicVisitor;
}

export function answersTargetOf(toolRuntimeData: Record<string, unknown> | undefined): PublicAnswersTarget | null {
  const raw = toolRuntimeData?.publicAnswers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const file = typeof record.file === "string" ? safeStem(record.file) : "";
  if (!file) return null;
  const visitor = record.visitor && typeof record.visitor === "object" && !Array.isArray(record.visitor)
    ? record.visitor as Record<string, unknown>
    : {};
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : undefined) || undefined;
  return {
    file,
    visitor: {
      name: text(visitor.name, 120),
      email: text(visitor.email, 254),
      confirmed: visitor.confirmed === true,
      conversation: text(visitor.conversation, 64),
    },
  };
}

/** A file name stem made of letters, digits, `-` and `_`; anything else is dropped. */
export function safeStem(value: string): string {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

const MAX_FIELDS = 30;
const MAX_KEY = 60;
const MAX_VALUE = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS_PER_CONVERSATION = 200;
const FIXED_COLUMNS = ["time", "name", "email", "email confirmed", "conversation"] as const;

/**
 * A cell as a spreadsheet reads it, safely: quoted when it has to be, and a
 * leading `= + - @` (or a tab or return) disarmed, so a visitor's answer opened
 * in a spreadsheet stays text instead of becoming a formula.
 */
export function csvCell(value: string): string {
  const disarmed = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(disarmed) ? `"${disarmed.replace(/"/g, '""')}"` : disarmed;
}

/** Rows of a CSV this module wrote (quoted cells, doubled quotes, any line ending inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cleanFields(raw: unknown): Array<[string, string]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const seen = new Set<string>(FIXED_COLUMNS);
  const fields: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(key).replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_KEY);
    if (!name || seen.has(name.toLowerCase())) continue;
    const text = typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
    seen.add(name.toLowerCase());
    fields.push([name, text.slice(0, MAX_VALUE)]);
    if (fields.length >= MAX_FIELDS) break;
  }
  return fields;
}

// One write at a time per file in this process, so two visitors answering in
// the same second do not each rewrite the file without the other's row.
const writing = new Map<string, Promise<unknown>>();

/** The directory a link's answers go in, made if missing; null if something other than a plain folder is there. */
async function responsesDir(projectDir: string): Promise<string | null> {
  const real = await fs.realpath(projectDir);
  const dir = path.join(real, RESPONSES_FOLDER);
  try {
    const stat = await fs.lstat(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() ? dir : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  await fs.mkdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await fs.lstat(dir);
  return stat.isDirectory() && !stat.isSymbolicLink() ? dir : null;
}

export type RecordAnswerResult =
  | { ok: true; file: string; row: number }
  | { ok: false; error: string };

/**
 * Add one row of answers to `responses/<file>.csv` in the project.
 *
 * The columns are the fixed ones (time, name, email, whether it was confirmed,
 * conversation) and then whatever names the answers use; a new name adds a
 * column at the end, so the file keeps opening as one table.
 */
export async function recordPublicAnswer(projectDir: string, target: PublicAnswersTarget, rawFields: unknown, now = new Date()): Promise<RecordAnswerResult> {
  const fields = cleanFields(rawFields);
  if (fields.length === 0) return { ok: false, error: "Give at least one answer as a name and a value." };
  // The name is made safe here as well as where it is read: nothing a caller passes leaves responses/.
  const stem = safeStem(target.file);
  if (!stem) return { ok: false, error: "The answers could not be saved." };
  const dir = await responsesDir(projectDir);
  if (!dir) return { ok: false, error: "The answers could not be saved." };
  const file = path.join(dir, `${stem}.csv`);
  const previous = writing.get(file) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(() => appendRow(file, target, fields, now));
  writing.set(file, work);
  try {
    return await work;
  } finally {
    if (writing.get(file) === work) writing.delete(file);
  }
}

async function appendRow(file: string, target: PublicAnswersTarget, fields: Array<[string, string]>, now: Date): Promise<RecordAnswerResult> {
  let existing = "";
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: "The answers could not be saved." };
    if (stat.size > MAX_FILE_BYTES) return { ok: false, error: "The answers file is full; tell the person their answer could not be saved." };
    existing = await fs.readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, error: "The answers could not be saved." };
  }
  const rows = existing.replace(/^﻿/, "") ? parseCsv(existing.replace(/^﻿/, "")) : [];
  const header = rows[0]?.length ? [...rows[0]] : [...FIXED_COLUMNS];
  const conversationAt = header.indexOf("conversation");
  if (target.visitor.conversation && conversationAt >= 0) {
    const count = rows.slice(1).filter((row) => row[conversationAt] === target.visitor.conversation).length;
    if (count >= MAX_ROWS_PER_CONVERSATION) return { ok: false, error: "This conversation has saved as many answers as it may." };
  }
  for (const [name] of fields) if (!header.includes(name)) header.push(name);
  const values = new Map<string, string>([
    ["time", now.toISOString()],
    ["name", target.visitor.name ?? ""],
    ["email", target.visitor.email ?? ""],
    ["email confirmed", target.visitor.email ? (target.visitor.confirmed ? "yes" : "no") : ""],
    ["conversation", target.visitor.conversation ?? ""],
    ...fields,
  ]);
  const body = [header, ...rows.slice(1), header.map((name) => values.get(name) ?? "")];
  // Excel reads UTF-8 only with the mark; the rows carry names in any language.
  const text = `﻿${body.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const handle = await fs.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
  try {
    await handle.writeFile(text, "utf-8");
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  return { ok: true, file: `${RESPONSES_FOLDER}/${path.basename(file)}`, row: body.length - 1 };
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/** What a public turn lends its tools: who asked, and how to put a card on their screen. */
export interface PublicTurn {
  readonly runId?: string;
  readonly abortSignal?: AbortSignal;
  readonly onPiInteraction?: (interaction: PiPendingInteraction) => void;
  readonly toolRuntimeData?: Record<string, unknown>;
}

/**
 * `eggent_ask_user` for a visitor: the same card as in the workspace's own chat,
 * without what a visitor has no use for (files attached under it, the task board).
 */
export function createPublicAskTool(turn: PublicTurn): ToolDefinition {
  return defineTool({
    name: "eggent_ask_user",
    label: "Ask The User",
    description:
      "Ask the person one question and wait for the answer, shown as a card with buttons and a field to type in. Use it when the project's instructions ask you to collect answers (a questionnaire, a survey, an application) or when you need the person to choose. Pass two to four `options` whenever the answer can be tapped. Ask one question at a time and wait for its answer before the next. The card adds \"decide for me\" and \"skip\" itself.",
    parameters: Type.Object({
      question: Type.String({ description: "The question, in the person's language. One sentence." }),
      kind: Type.Optional(Type.Union([Type.Literal("choice"), Type.Literal("confirm"), Type.Literal("free_text")], {
        description: "choice = pick one of `options` (default when options are given), confirm = yes/no, free_text = typed answer.",
      })),
      options: Type.Optional(Type.Array(Type.String(), { description: "Answer choices, 2 to 6 short labels." })),
      placeholder: Type.Optional(Type.String({ description: "Hint shown in the field for a typed answer." })),
      title: Type.Optional(Type.String({ description: "Short card heading. Defaults to the question." })),
    }),
    execute: async (_toolCallId, params) => {
      const question = params.question?.trim();
      if (!question) return textResult(JSON.stringify({ success: false, error: "question is required" }));
      const choices = (params.options ?? []).map((option) => option.trim()).filter(Boolean).slice(0, 6);
      const kind = params.kind ?? (choices.length >= 2 ? "choice" : "free_text");
      if (kind === "choice" && choices.length < 2) return textResult(JSON.stringify({ success: false, error: "kind=choice needs at least 2 options" }));
      if (!turn.onPiInteraction) {
        return textResult(JSON.stringify({ success: false, error: "Nobody can answer a card here.", note: "Ask the question as normal chat text." }));
      }
      const title = params.title?.trim() || question;
      const answer = await createPendingInteraction({
        runId: turn.runId ?? crypto.randomUUID(),
        kind: kind === "confirm" ? "confirm" : kind === "choice" ? "select" : "text",
        title,
        message: title === question ? undefined : question,
        placeholder: params.placeholder?.trim() || undefined,
        options: choices.length > 0 ? choices : undefined,
        signal: turn.abortSignal,
        onUpdate: turn.onPiInteraction,
      });
      if (answer === DEFER_INTERACTION_ANSWER) {
        return textResult(JSON.stringify({ success: true, deferred: true, note: "The person asked you to decide. Take the sensible default, say in one line what you chose, and go on." }), { kind });
      }
      if (answer === undefined) {
        const unanswered = turn.abortSignal?.aborted === true && turn.abortSignal.reason === UNANSWERED_QUESTION;
        return textResult(JSON.stringify({
          success: false,
          cancelled: true,
          note: unanswered
            ? "Nobody answered for a long time, so the turn stopped here. If the person writes later, read it as the answer."
            : "The person skipped the question. Do not ask it again; go on without it.",
        }));
      }
      return textResult(JSON.stringify({ success: true, kind, answer }), { kind });
    },
  }) as unknown as ToolDefinition;
}

/** `eggent_record_answer`: one row into the link's answers file, never read back. */
export function createRecordAnswerTool(projectDir: string, turn: PublicTurn): ToolDefinition {
  return defineTool({
    name: "eggent_record_answer",
    label: "Save answers",
    description:
      "Save the person's answers as one row of the project's answers table, which the project's owner reads. Use it when the project's instructions ask you to collect answers, once you have them (or once per finished part of a long questionnaire). Pass `answers` as short column names mapped to the answers, in the person's own words; keep the same column names for the same questions. The time and who is writing are added by the system, so do not ask for or pass them unless the instructions ask for something else about the person. You cannot read the table back.",
    parameters: Type.Object({
      answers: Type.Record(Type.String(), Type.String(), { description: "Column name -> answer, at most 30 of them." }),
    }),
    execute: async (_toolCallId, params) => {
      const target = answersTargetOf(turn.toolRuntimeData);
      if (!target) return textResult(JSON.stringify({ success: false, error: "Answers cannot be saved in this chat." }));
      const result = await recordPublicAnswer(projectDir, target, params.answers);
      return result.ok
        ? textResult(JSON.stringify({ success: true, note: "Saved. Tell the person in one line that their answers were saved." }), { row: result.row })
        : textResult(JSON.stringify({ success: false, error: result.error }));
    },
  }) as unknown as ToolDefinition;
}
