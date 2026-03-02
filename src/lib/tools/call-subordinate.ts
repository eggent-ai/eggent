import type { ModelMessage } from "ai";

const MAX_SUBORDINATE_CONCURRENCY = 2;
const SUBORDINATE_RETRY_DELAYS_MS = [1000, 2500] as const;

let activeSubordinateCalls = 0;
const subordinateWaitQueue: Array<() => void> = [];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getStatusCode(error: unknown): number | null {
  const queue = [error];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    const record = asRecord(current);
    if (!record) {
      continue;
    }

    const rawStatus = record.statusCode ?? record.status ?? record.status_code;
    if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
      return rawStatus;
    }
    if (typeof rawStatus === "string") {
      const parsed = Number.parseInt(rawStatus, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    if (record.cause) {
      queue.push(record.cause);
    }
    if (record.responseBody) {
      queue.push(record.responseBody);
    }
    if (record.data) {
      queue.push(record.data);
    }
    if (record.error) {
      queue.push(record.error);
    }
  }

  return null;
}

function getErrorCode(error: unknown): string | null {
  const queue = [error];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    const record = asRecord(current);
    if (!record) {
      continue;
    }

    const rawCode = record.code ?? record.type;
    if (typeof rawCode === "string" && rawCode.trim()) {
      return rawCode.trim();
    }

    if (record.cause) {
      queue.push(record.cause);
    }
    if (record.responseBody) {
      queue.push(record.responseBody);
    }
    if (record.data) {
      queue.push(record.data);
    }
    if (record.error) {
      queue.push(record.error);
    }
  }

  return null;
}

function getErrorDetail(error: unknown): string | null {
  const queue = [error];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (typeof current === "string" && current.trim()) {
      const detail = current.trim().replace(/\s+/g, " ");
      return detail.length > 280 ? `${detail.slice(0, 280)}...` : detail;
    }

    const record = asRecord(current);
    if (!record) {
      continue;
    }

    const rawMessage = record.message;
    if (typeof rawMessage === "string" && rawMessage.trim()) {
      const detail = rawMessage.trim().replace(/\s+/g, " ");
      return detail.length > 280 ? `${detail.slice(0, 280)}...` : detail;
    }

    if (record.cause) {
      queue.push(record.cause);
    }
    if (record.responseBody) {
      queue.push(record.responseBody);
    }
    if (record.data) {
      queue.push(record.data);
    }
    if (record.error) {
      queue.push(record.error);
    }
  }

  return null;
}

function isRetriableProviderError(error: unknown): boolean {
  const statusCode = getStatusCode(error);
  if (statusCode !== null) {
    return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes("provider returned error") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset")
  );
}

function formatSubordinateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = getStatusCode(error);
  const code = getErrorCode(error);
  const detail = getErrorDetail(error);

  const details: string[] = [];
  if (statusCode !== null) {
    details.push(`status=${statusCode}`);
  }
  if (code) {
    details.push(`code=${code}`);
  }

  const base = details.length > 0 ? `${message} (${details.join(", ")})` : message;
  if (!detail || detail === message) {
    return base;
  }
  return `${base}: ${detail}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSubordinateSlot(): Promise<void> {
  if (activeSubordinateCalls < MAX_SUBORDINATE_CONCURRENCY) {
    activeSubordinateCalls += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    subordinateWaitQueue.push(() => resolve());
  });
}

function releaseSubordinateSlot(): void {
  const next = subordinateWaitQueue.shift();
  if (next) {
    next();
    return;
  }

  activeSubordinateCalls = Math.max(0, activeSubordinateCalls - 1);
}

async function withSubordinateSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSubordinateSlot();
  try {
    return await fn();
  } finally {
    releaseSubordinateSlot();
  }
}

async function runSubordinateWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= SUBORDINATE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === SUBORDINATE_RETRY_DELAYS_MS.length;
      if (isLastAttempt || !isRetriableProviderError(error)) {
        throw error;
      }
      const delay = SUBORDINATE_RETRY_DELAYS_MS[attempt] ?? 1000;
      await sleep(delay + Math.floor(Math.random() * 400));
    }
  }

  throw new Error("Subordinate retry loop exited unexpectedly");
}

/**
 * Delegate a task to a subordinate agent
 */
export async function callSubordinate(
  task: string,
  projectId: string | undefined,
  parentAgentNumber: number,
  parentHistory: ModelMessage[]
): Promise<string> {
  try {
    // Dynamic import to avoid circular dependency
    const { runSubordinateAgent } = await import("@/lib/agent/agent");

    const result = await withSubordinateSlot(() =>
      runSubordinateWithRetry(() =>
        runSubordinateAgent({
          task,
          projectId,
          parentAgentNumber,
          parentHistory,
        })
      )
    );

    return `Subordinate Agent ${parentAgentNumber + 1} completed the task:\n\n${result}`;
  } catch (error) {
    return `Subordinate agent error: ${formatSubordinateError(error)}`;
  }
}
