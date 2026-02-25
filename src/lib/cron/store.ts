import fs from "fs/promises";
import path from "path";
import type { CronStoreFile } from "@/lib/cron/types";

const storeLocks = new Map<string, Promise<void>>();

async function resolveChain(promise: Promise<unknown>): Promise<void> {
  await promise.then(
    () => undefined,
    () => undefined
  );
}

async function withStoreLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(storePath);
  const previous = storeLocks.get(resolved) ?? Promise.resolve();
  const next = resolveChain(previous).then(fn);
  storeLocks.set(resolved, resolveChain(next));
  return await next;
}

export async function withCronStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>
): Promise<T> {
  return await withStoreLock(storePath, fn);
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CronStoreFile>;
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    return {
      version: 1,
      jobs: jobs.filter(Boolean),
    };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw error;
  }
}

export async function saveCronStore(
  storePath: string,
  store: CronStoreFile
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tmp, storePath);
}
