import fs from "fs/promises";
import path from "path";
import type { CronRunLogEntry } from "@/lib/cron/types";

const writesByPath = new Map<string, Promise<void>>();

async function pruneIfNeeded(filePath: string, maxBytes: number, keepLines: number) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= maxBytes) {
    return;
  }

  const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const kept = lines.slice(Math.max(0, lines.length - keepLines));
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${kept.join("\n")}\n`, "utf-8");
  await fs.rename(tmp, filePath);
}

export async function appendCronRunLog(
  filePath: string,
  entry: CronRunLogEntry,
  opts?: { maxBytes?: number; keepLines?: number }
): Promise<void> {
  const resolved = path.resolve(filePath);
  const previous = writesByPath.get(resolved) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.appendFile(resolved, `${JSON.stringify(entry)}\n`, "utf-8");
      await pruneIfNeeded(
        resolved,
        opts?.maxBytes ?? 1_000_000,
        opts?.keepLines ?? 1_000
      );
    });
  writesByPath.set(resolved, next);
  await next;
}

export async function readCronRunLogEntries(
  filePath: string,
  opts?: { limit?: number }
): Promise<CronRunLogEntry[]> {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 200)));
  const raw = await fs.readFile(path.resolve(filePath), "utf-8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }

  const parsed: CronRunLogEntry[] = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    try {
      const value = JSON.parse(line) as Partial<CronRunLogEntry>;
      if (
        typeof value.ts === "number" &&
        typeof value.jobId === "string" &&
        typeof value.projectId === "string" &&
        (value.status === "ok" || value.status === "error" || value.status === "skipped")
      ) {
        parsed.push(value as CronRunLogEntry);
      }
    } catch {
      // Skip malformed lines.
    }
  }

  return parsed.reverse();
}
