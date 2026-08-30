import type { PiInteractionResponse, PiPendingInteraction } from "@/lib/pi/interaction-types";
import { AFFIRMATIVES, alternation } from "@/i18n/vocabulary";

interface PendingInteractionEntry {
  interaction: PiPendingInteraction;
  resolve: (value: string | boolean | undefined) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  cleanup: () => void;
  onUpdate?: (interaction: PiPendingInteraction) => void;
}

interface CreatePendingInteractionOptions extends Omit<PiPendingInteraction, "id" | "status" | "createdAt" | "updatedAt"> {
  id?: string;
  signal?: AbortSignal;
  onUpdate?: (interaction: PiPendingInteraction) => void;
}

const GLOBAL_KEY = Symbol.for("eggent.pi.pendingInteractions");

type PendingInteractionMap = Map<string, PendingInteractionEntry>;

function getStore(): PendingInteractionMap {
  const globalRecord = globalThis as typeof globalThis & { [GLOBAL_KEY]?: PendingInteractionMap };
  if (!globalRecord[GLOBAL_KEY]) {
    globalRecord[GLOBAL_KEY] = new Map();
  }
  return globalRecord[GLOBAL_KEY];
}

function publish(entry: PendingInteractionEntry) {
  entry.onUpdate?.({ ...entry.interaction });
}

function finishInteraction(entry: PendingInteractionEntry, status: PiPendingInteraction["status"]) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.cleanup();
  entry.interaction.status = status;
  entry.interaction.updatedAt = new Date().toISOString();
  getStore().delete(entry.interaction.id);
  publish(entry);
}

export function createPendingInteraction(options: CreatePendingInteractionOptions): Promise<string | boolean | undefined> {
  const now = new Date().toISOString();
  const interaction: PiPendingInteraction = {
    id: options.id ?? crypto.randomUUID(),
    runId: options.runId,
    kind: options.kind,
    status: "pending",
    title: options.title,
    message: options.message,
    placeholder: options.placeholder,
    options: options.options,
    timeoutMs: options.timeoutMs,
    createdAt: now,
    updatedAt: now,
  };

  return new Promise((resolve, reject) => {
    const abortHandler = () => {
      finishInteraction(entry, "cancelled");
      resolve(undefined);
    };

    const entry: PendingInteractionEntry = {
      interaction,
      resolve,
      reject,
      onUpdate: options.onUpdate,
      cleanup: () => options.signal?.removeEventListener("abort", abortHandler),
    };

    if (options.signal?.aborted) {
      interaction.status = "cancelled";
      interaction.updatedAt = new Date().toISOString();
      options.onUpdate?.({ ...interaction });
      resolve(undefined);
      return;
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        finishInteraction(entry, "expired");
        resolve(undefined);
      }, options.timeoutMs);
    }

    options.signal?.addEventListener("abort", abortHandler, { once: true });
    getStore().set(interaction.id, entry);
    publish(entry);
  });
}

export function getPendingInteraction(interactionId: string): PiPendingInteraction | null {
  const entry = getStore().get(interactionId);
  return entry ? { ...entry.interaction } : null;
}

export function listPendingInteractions(runId?: string): PiPendingInteraction[] {
  return [...getStore().values()]
    .map((entry) => ({ ...entry.interaction }))
    .filter((interaction) => !runId || interaction.runId === runId);
}

export function respondToPendingInteraction(
  runId: string,
  interactionId: string,
  response: PiInteractionResponse
): PiPendingInteraction {
  const entry = getStore().get(interactionId);
  if (!entry || entry.interaction.runId !== runId) {
    throw new Error("Pending interaction not found");
  }

  if (response.cancel) {
    finishInteraction(entry, "cancelled");
    entry.resolve(undefined);
    return { ...entry.interaction };
  }

  let value: string | boolean | undefined;
  if (entry.interaction.kind === "confirm") {
    if (typeof response.value === "string") {
      value = new RegExp(`^(?:${alternation(AFFIRMATIVES)})$`, "i").test(response.value.trim());
    } else {
      value = response.value === true;
    }
  } else if (typeof response.value === "string") {
    value = response.value;
  } else if (response.value == null) {
    value = undefined;
  } else {
    value = String(response.value);
  }

  if (entry.interaction.kind === "select" && typeof value === "string") {
    const allowed = entry.interaction.options ?? [];
    if (allowed.length > 0 && !allowed.includes(value)) {
      throw new Error("Selected option is not available");
    }
  }

  finishInteraction(entry, "completed");
  entry.resolve(value);
  return { ...entry.interaction };
}

export function cancelPendingInteractionsForRun(runId: string) {
  for (const entry of [...getStore().values()]) {
    if (entry.interaction.runId !== runId) continue;
    finishInteraction(entry, "cancelled");
    entry.resolve(undefined);
  }
}
