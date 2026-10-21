/**
 * The one tool a session on an engine has: hand the person's request to the
 * program and bring back what it says.
 *
 * It is a tool, and not the model's own text, so that the turn looks to the
 * rest of the application like any turn with work in it: the steps the program
 * takes stream into a card while it runs, a stop reaches the program through
 * the tool's signal, and a long stretch with no answer is a tool running, which
 * the watchdog allows for, rather than a model gone quiet.
 */
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n/messages";
import { getChat } from "@/lib/storage/chat-store";
import { buildEngineBrief, buildEngineRecap, indexOfLastUserMessage } from "@/lib/engines/brief";
import type { EngineErrorCode, EngineEvent, EngineRunResult } from "@/lib/engines/host-types";
import { engineNotReady, type EngineRun } from "@/lib/engines/resolve";
import { forgetEngineStatus } from "@/lib/engines/registry";
import { readEngineSession, writeEngineSession } from "@/lib/engines/store";
import { ENGINE_TOOL_NAME } from "@/lib/engines/types";

const MAX_STEPS = 40;
/** Text goes out to the card this often at most; steps go out at once. */
const TEXT_REPORT_MS = 300;

export interface EngineToolOptions {
  run: EngineRun;
  chatId?: string;
  projectId: string | null;
  cwd: string;
}

interface Step {
  id: string;
  tool: string;
  target?: string;
  failed?: boolean;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

const ERROR_MESSAGE: Record<Exclude<EngineErrorCode, "session-lost">, MessageKey> = {
  "not-installed": "engines.error.notInstalled",
  "signed-out": "engines.error.signedOut",
  limit: "engines.error.limit",
  "unsupported-model": "engines.error.unsupportedModel",
  "api-key": "engines.error.apiKey",
  timeout: "engines.error.timeout",
  failed: "engines.error.failed",
};

function clockTime(unixSeconds: number): string {
  const when = new Date(unixSeconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/** What the card is told while the program runs, in the shape the helper cards read. */
export function engineProgressDetails(input: {
  label: string;
  modelLabel: string;
  steps: Step[];
  earlierSteps: number;
  toolUses: number;
  activity?: string;
  text?: string;
}): Record<string, unknown> {
  return {
    status: "running",
    toolUses: input.toolUses,
    activity: input.activity ? `${input.activity}…` : input.text ? "writing…" : "thinking…",
    steps: input.steps.map((step) => ({
      tool: step.tool,
      ...(step.target ? { target: step.target } : {}),
      ...(step.failed ? { failed: true } : {}),
    })),
    ...(input.earlierSteps > 0 ? { earlierSteps: input.earlierSteps } : {}),
    engineName: input.label,
    engineModel: input.modelLabel,
  };
}

export function createEngineTool(options: EngineToolOptions): ToolDefinition {
  const { run } = options;
  return defineTool({
    name: ENGINE_TOOL_NAME,
    label: run.engine.label,
    description: `Hand the person's request to ${run.engine.label}, which works on this computer, and bring back what it says.`,
    parameters: Type.Object({
      prompt: Type.String({ description: "The person's request, word for word." }),
    }),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const t = await getServerTranslator();
      const label = run.engine.label;
      const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
      if (!prompt) return textResult(t("engines.noAnswer", { engine: label }), { engine: { ok: false, id: run.engine.id } });

      const modelLabel = run.model.label;
      const finish = (text: string, extra: Record<string, unknown>) =>
        textResult(text, { engine: { id: run.engine.id, label, model: run.model.id, modelLabel, ...extra } });

      // Not signed in, not installed, a problem of its own: said before anything is started.
      const blocked = await engineNotReady(run);
      if (blocked) {
        const code: EngineErrorCode = blocked.state === "not-installed"
          ? "not-installed"
          : blocked.state === "signed-out"
            ? "signed-out"
            : blocked.code === "api-key"
              ? "api-key"
              : "failed";
        const key = ERROR_MESSAGE[code as Exclude<EngineErrorCode, "session-lost">];
        const text = code === "failed"
          ? t("engines.error.problem", { engine: label, detail: blocked.detail ?? "not ready" })
          : t(key, { engine: label, until: "", detail: "" });
        return finish(text, { ok: false, errorCode: code });
      }

      const brief = await buildEngineBrief({ projectId: options.projectId, cwd: options.cwd });
      const saved = options.chatId ? await readEngineSession(options.chatId) : null;
      const resumable = saved && saved.engine === run.engine.id && saved.cwd === options.cwd ? saved : null;

      const startedAt = Date.now();
      const steps: Step[] = [];
      let earlierSteps = 0;
      let toolUses = 0;
      let activity: string | undefined;
      let liveText = "";
      let lastTextReport = 0;
      let limits: unknown;

      const report = () => {
        onUpdate?.({
          content: [{ type: "text" as const, text: "" }],
          details: engineProgressDetails({ label, modelLabel, steps, earlierSteps, toolUses, activity, text: liveText }),
        });
      };

      const onEvent = (event: EngineEvent) => {
        if (event.type === "step") {
          if (event.phase === "start") {
            toolUses += 1;
            activity = event.tool;
            steps.push({ id: event.id, tool: event.tool, ...(event.target ? { target: event.target } : {}) });
            if (steps.length > MAX_STEPS) {
              steps.shift();
              earlierSteps += 1;
            }
          } else {
            activity = undefined;
            const step = steps.find((candidate) => candidate.id === event.id);
            if (step && event.failed) step.failed = true;
          }
          report();
        } else if (event.type === "activity") {
          activity = event.text;
          report();
        } else if (event.type === "text") {
          liveText = event.text;
          const now = Date.now();
          if (now - lastTextReport >= TEXT_REPORT_MS) {
            lastTextReport = now;
            report();
          }
        } else if (event.type === "limits") {
          limits = event.windows;
        }
      };

      const attempt = async (sessionId: string | null, fresh: boolean): Promise<EngineRunResult> => {
        let recap = "";
        let promptForRun = prompt;
        if (fresh) {
          if (options.chatId) {
            const chat = await getChat(options.chatId);
            if (chat) recap = buildEngineRecap(chat.messages, { before: indexOfLastUserMessage(chat.messages) });
          }
        } else if (resumable && resumable.briefKey && resumable.briefKey !== brief.key) {
          // The person changed their instructions since this session began: tell it, in the message.
          promptForRun = `The instructions for this project have changed. They are now:\n\n${brief.text}\n\n---\n\n${prompt}`;
        }
        return run.engine.run({
          prompt: promptForRun,
          brief: fresh ? brief.text : "",
          recap,
          cwd: options.cwd,
          sessionId,
          model: run.model.id,
          access: run.choice.access,
          signal: signal ?? new AbortController().signal,
          onEvent,
        });
      };

      report();
      let freshSession = !resumable;
      let result = await attempt(resumable?.sessionId ?? null, freshSession);
      if (!result.ok && result.error?.code === "session-lost" && !signal?.aborted) {
        // The program no longer has the conversation: begin again, and tell it what was said.
        if (options.chatId) await writeEngineSession(options.chatId, null);
        freshSession = true;
        steps.length = 0;
        earlierSteps = 0;
        toolUses = 0;
        result = await attempt(null, true);
      }

      if (result.sessionId && options.chatId) {
        await writeEngineSession(options.chatId, {
          engine: run.engine.id,
          sessionId: result.sessionId,
          cwd: options.cwd,
          briefKey: brief.key,
          at: new Date().toISOString(),
        });
      }
      // A sign-in that ran out, or a limit that was hit, changes what the plate should say.
      if (!result.ok && result.error && (result.error.code === "signed-out" || result.error.code === "limit")) {
        forgetEngineStatus(run.engine.id);
      }

      const seconds = result.seconds ?? Math.round((Date.now() - startedAt) / 1000);
      const common = {
        toolUses: result.toolUses ?? toolUses,
        seconds,
        resumed: !freshSession,
        ...(limits ? { limits } : {}),
        ...(result.files && result.files.length > 0 ? { files: result.files.slice(0, 40) } : {}),
      };

      if (result.stopped) return finish(t("engines.stopped"), { ...common, ok: false, stopped: true });
      if (result.ok) {
        const text = result.text.trim() || t("engines.noAnswer", { engine: label });
        return finish(text, { ...common, ok: true });
      }
      const code = (result.error?.code ?? "failed") as EngineErrorCode;
      const key = ERROR_MESSAGE[(code === "session-lost" ? "failed" : code) as Exclude<EngineErrorCode, "session-lost">];
      const until = result.resetsAt ? t("engines.error.limitUntil", { time: clockTime(result.resetsAt) }) : "";
      const detail = (result.error?.message || result.text || "").trim().slice(0, 400);
      return finish(t(key, { engine: label, until, detail }), { ...common, ok: false, errorCode: code });
    },
  }) as ToolDefinition;
}
