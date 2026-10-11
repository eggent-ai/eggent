/**
 * What a stored answer says about the files it made, and reading it back safely.
 *
 * No Node imports: the chat reads this in the browser. A chat is a file that other
 * computers write to as well (it is synced) and that older versions wrote in other
 * shapes, so what comes out of it is checked before anything draws or sends from
 * it: a path that is not a string would otherwise stop a whole conversation from
 * rendering.
 */

export type ProducedSource = "answer" | "tool" | "scan";

export interface ProducedFile {
  /** Relative to the folder it belongs to, forward slashes. */
  path: string;
  size: number;
  source: ProducedSource;
}

/** The files of one folder: a project's, or the orchestrator's ("none"). */
export interface ProducedGroup {
  project: string;
  items: ProducedFile[];
  /** How many there were; `items` holds the first few. */
  total: number;
}

const MAX_GROUPS = 20;
const MAX_ITEMS = 50;

/** The groups a stored message holds, without anything that is not the shape of one. */
export function cleanProducedGroups(value: unknown): ProducedGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: ProducedGroup[] = [];
  for (const candidate of value.slice(0, MAX_GROUPS)) {
    if (!candidate || typeof candidate !== "object") continue;
    const group = candidate as Record<string, unknown>;
    if (typeof group.project !== "string" || !group.project || !Array.isArray(group.items)) continue;
    const items: ProducedFile[] = [];
    for (const raw of group.items.slice(0, MAX_ITEMS)) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.path !== "string" || !item.path || item.path.length > 1024 || item.path.includes("\0")) continue;
      const size = typeof item.size === "number" && Number.isFinite(item.size) && item.size >= 0 ? item.size : 0;
      items.push({ path: item.path, size, source: item.source === "tool" || item.source === "scan" ? item.source : "answer" });
    }
    if (items.length === 0) continue;
    const total = typeof group.total === "number" && Number.isFinite(group.total) ? Math.max(items.length, Math.floor(group.total)) : items.length;
    groups.push({ project: group.project, items, total });
  }
  return groups;
}
