/**
 * A stage of an employee's first job, as the screen shows it.
 *
 * The agent reports each stage with the eggent_stage tool; the screen reads
 * the calls straight off the message (their input while one is running, the
 * checked result once it returns), so nothing about streaming or storage had
 * to change. Client-safe: no Node imports.
 */

export type StageStatus = "running" | "done" | "warn";
export type StageTone = "good" | "bad" | "neutral";

export interface StageCard {
  title: string;
  body?: string;
  badge?: string;
  tone?: StageTone;
}

export interface StageTable {
  columns: string[];
  rows: string[][];
}

export interface Stage {
  id: string;
  title: string;
  status: StageStatus;
  /** One line under the title: what is being done or what was found. */
  detail?: string;
  /** A picture in the working folder, relative to it. */
  image?: string;
  caption?: string;
  stat?: { value: string; label?: string; tone?: StageTone };
  table?: StageTable;
  cards?: StageCard[];
  verdict?: { text: string; tone?: StageTone };
}

export interface StageBoard {
  /** Every stage in the order it was first named, the plan's included. */
  stages: Stage[];
  /** The stage the screen puts in front: the last one touched. */
  currentId?: string;
}

export const STAGE_TOOL = "eggent_stage";

const LIMITS = { title: 120, detail: 300, caption: 200, verdict: 300, cell: 200, cards: 8, rows: 30, columns: 8, plan: 10 };

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function tone(value: unknown): StageTone | undefined {
  return value === "good" || value === "bad" || value === "neutral" ? value : undefined;
}

function status(value: unknown): StageStatus {
  return value === "done" || value === "warn" ? value : "running";
}

export function stageId(value: unknown): string | undefined {
  const id = text(value, 40)?.toLowerCase();
  return id && /^[a-z0-9][a-z0-9_-]*$/.test(id) ? id : undefined;
}

/** A stage from whatever the model sent, keeping only what the screen can draw. */
export function normalizeStage(raw: unknown): Stage | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const id = stageId(input.id);
  const title = text(input.title, LIMITS.title);
  if (!id) return null;
  const stage: Stage = { id, title: title || id, status: status(input.status) };
  const detail = text(input.detail, LIMITS.detail);
  if (detail) stage.detail = detail;
  const image = text(input.image, 500);
  if (image) stage.image = image;
  const caption = text(input.caption, LIMITS.caption);
  if (caption) stage.caption = caption;
  if (input.stat && typeof input.stat === "object") {
    const stat = input.stat as Record<string, unknown>;
    const value = text(stat.value, 40);
    if (value) stage.stat = { value, label: text(stat.label, 120), tone: tone(stat.tone) };
  }
  if (input.table && typeof input.table === "object") {
    const table = input.table as Record<string, unknown>;
    const columns = Array.isArray(table.columns) ? table.columns.slice(0, LIMITS.columns).map((c) => text(c, LIMITS.cell) ?? "") : [];
    const rows = Array.isArray(table.rows)
      ? table.rows.slice(0, LIMITS.rows).filter(Array.isArray).map((row) => (row as unknown[]).slice(0, LIMITS.columns).map((c) => text(String(c ?? ""), LIMITS.cell) ?? ""))
      : [];
    if (columns.length && rows.length) stage.table = { columns, rows };
  }
  if (Array.isArray(input.cards)) {
    const cards = input.cards.slice(0, LIMITS.cards).flatMap((card): StageCard[] => {
      if (!card || typeof card !== "object") return [];
      const c = card as Record<string, unknown>;
      const cardTitle = text(c.title, LIMITS.title);
      if (!cardTitle) return [];
      return [{ title: cardTitle, body: text(c.body, 600), badge: text(c.badge, 60), tone: tone(c.tone) }];
    });
    if (cards.length) stage.cards = cards;
  }
  if (input.verdict && typeof input.verdict === "object") {
    const verdict = input.verdict as Record<string, unknown>;
    const verdictText = text(verdict.text, LIMITS.verdict);
    if (verdictText) stage.verdict = { text: verdictText, tone: tone(verdict.tone) };
  } else {
    const verdictText = text(input.verdict, LIMITS.verdict);
    if (verdictText) stage.verdict = { text: verdictText };
  }
  return stage;
}

/** The plan a call may carry: the stages still ahead, drawn greyed out. */
export function normalizePlan(raw: unknown): Array<{ id: string; title: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, LIMITS.plan).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const id = stageId(e.id);
    const title = text(e.title, LIMITS.title);
    return id && title ? [{ id, title }] : [];
  });
}

/**
 * Folds the eggent_stage calls of a turn, in order, into one board. A later
 * call for the same id updates that stage; fields it does not repeat are kept.
 */
export function foldStages(calls: unknown[]): StageBoard {
  const order: string[] = [];
  const byId = new Map<string, Stage>();
  const planned = new Set<string>();
  let currentId: string | undefined;
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    for (const step of normalizePlan((call as Record<string, unknown>).plan)) {
      if (byId.has(step.id)) continue;
      order.push(step.id);
      planned.add(step.id);
      byId.set(step.id, { id: step.id, title: step.title, status: "running" });
    }
    const stage = normalizeStage(call);
    if (!stage) continue;
    const before = byId.get(stage.id);
    if (!before) order.push(stage.id);
    planned.delete(stage.id);
    byId.set(stage.id, before ? { ...before, ...definedOnly(stage) } : stage);
    currentId = stage.id;
  }
  const stages = order.map((id) => {
    const stage = byId.get(id)!;
    return planned.has(id) ? { ...stage, status: "running" as const, pending: true } : stage;
  });
  return { stages, currentId };
}

function definedOnly(stage: Stage): Partial<Stage> {
  return Object.fromEntries(Object.entries(stage).filter(([, value]) => value !== undefined)) as Partial<Stage>;
}

/** A stage the plan named that has not been started yet. */
export function isPending(stage: Stage): boolean {
  return Boolean((stage as Stage & { pending?: boolean }).pending);
}
