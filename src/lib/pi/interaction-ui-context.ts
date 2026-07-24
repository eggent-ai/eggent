import type { ExtensionUIContext, ExtensionUIDialogOptions, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import type { PiPendingInteraction } from "@/lib/pi/interaction-types";
import { createPendingInteraction } from "@/lib/pi/pending-interactions";

export interface EggentPiInteractionContextOptions {
  runId: string;
  onInteraction?: (interaction: PiPendingInteraction) => void;
}

function combineAbortSignals(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
  if (!left) return right;
  if (!right) return left;

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (left.aborted || right.aborted) {
    controller.abort();
    return controller.signal;
  }
  left.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function extractUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/)?.[0]?.replace(/[)>.,]+$/, "");
}

export function createEggentPiExtensionUIContext(
  options: EggentPiInteractionContextOptions & { abortSignal?: AbortSignal }
): ExtensionUIContext {
  const request = (interaction: Omit<PiPendingInteraction, "id" | "runId" | "status" | "createdAt" | "updatedAt">, dialogOptions?: ExtensionUIDialogOptions) =>
    createPendingInteraction({
      runId: options.runId,
      ...interaction,
      timeoutMs: dialogOptions?.timeout,
      signal: combineAbortSignals(options.abortSignal, dialogOptions?.signal),
      onUpdate: options.onInteraction,
    });

  const terminalHandlers = new Set<TerminalInputHandler>();
  const statuses = new Map<string, string>();

  return {
    select(title, choices, dialogOptions) {
      return request({ kind: "select", title, options: choices }, dialogOptions).then((value) =>
        typeof value === "string" ? value : undefined
      );
    },
    confirm(title, message, dialogOptions) {
      return request({ kind: "confirm", title, message }, dialogOptions).then((value) => value === true);
    },
    input(title, placeholder, dialogOptions) {
      return request({ kind: "text", title, placeholder }, dialogOptions).then((value) =>
        typeof value === "string" ? value : undefined
      );
    },
    notify(message, type = "info") {
      const url = extractUrl(message);
      const now = new Date().toISOString();
      options.onInteraction?.({
        id: crypto.randomUUID(),
        runId: options.runId,
        kind: url ? "oauth_url" : "text",
        status: "completed",
        title: type === "error" ? "Pi error" : type === "warning" ? "Pi warning" : "Pi notification",
        message,
        placeholder: url,
        createdAt: now,
        updatedAt: now,
      });
    },
    onTerminalInput(handler) {
      terminalHandlers.add(handler);
      return () => terminalHandlers.delete(handler);
    },
    setStatus(key, text) {
      if (text) statuses.set(key, text);
      else statuses.delete(key);
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    custom() {
      return Promise.reject(new Error("Custom interactive extension panels are not supported in Eggent web yet."));
    },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    editor(title: string, prefill?: string) {
      return request({ kind: "text", title, placeholder: prefill }).then((value) =>
        typeof value === "string" ? value : undefined
      );
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    theme: {} as ExtensionUIContext["theme"],
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Theme switching is not supported in Eggent web yet." };
    },
    getToolsExpanded() {
      return true;
    },
    setToolsExpanded() {},
  } satisfies ExtensionUIContext;
}
