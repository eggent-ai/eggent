import { tool } from "ai";
import { z } from "zod";
import type { AgentContext } from "@/lib/agent/types";
import { GLOBAL_CRON_PROJECT_ID } from "@/lib/cron/paths";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import {
  addCronJob,
  getCronProjectStatus,
  listCronJobs,
  listCronRuns,
  removeCronJob,
  runCronJobNow,
  updateCronJob,
} from "@/lib/cron/service";
import {
  explainCronToolAddInputFailure,
  normalizeCronToolAddInput,
  normalizeCronToolPatchInput,
} from "@/lib/cron/tool-normalize";

const cronInputSchema = z
  .object({
    action: z.enum(["status", "list", "add", "update", "remove", "run", "runs"]),
    projectId: z.string().optional(),
    includeDisabled: z.boolean().optional(),
    job: z.unknown().optional(),
    patch: z.unknown().optional(),
    jobId: z.string().optional(),
    id: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .passthrough();

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readTelegramChatIdFromContext(context: AgentContext): string | undefined {
  const raw = context.data?.telegram;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const chatId = record.chatId;
  if (typeof chatId === "number" && Number.isFinite(chatId)) {
    return String(Math.trunc(chatId));
  }
  return readString(chatId);
}

function resolveProjectId(context: AgentContext, fromArgs?: string): string {
  return readString(fromArgs) ?? context.projectId ?? GLOBAL_CRON_PROJECT_ID;
}

function resolveJobId(params: { jobId?: string; id?: string }): string | null {
  return readString(params.jobId) ?? readString(params.id) ?? null;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createCronTool(context: AgentContext) {
  return tool({
    description:
      "Manage scheduled cron jobs for a project: status, list, add, update, remove, run, and run history.",
    inputSchema: cronInputSchema,
    execute: async (input) => {
      try {
        await ensureCronSchedulerStarted();
        const projectId = resolveProjectId(context, input.projectId);
        const raw = input as Record<string, unknown>;

        if (input.action === "status") {
          return json(await getCronProjectStatus(projectId));
        }

        if (input.action === "list") {
          return json(
            await listCronJobs(projectId, {
              includeDisabled: input.includeDisabled === true,
            })
          );
        }

        if (input.action === "add") {
          const addInput = normalizeCronToolAddInput(raw);
          if (!addInput) {
            const reason = explainCronToolAddInputFailure(raw);
            return `[Preflight error] Invalid cron add payload. ${reason}`;
          }
          const telegramChatIdFromContext = readTelegramChatIdFromContext(context);
          if (telegramChatIdFromContext) {
            addInput.payload.telegramChatId = telegramChatIdFromContext;
          }
          if (!addInput.payload.chatId) {
            addInput.payload.chatId = context.chatId;
          }
          if (!addInput.payload.currentPath && context.currentPath) {
            addInput.payload.currentPath = context.currentPath;
          }
          return json(await addCronJob(projectId, addInput));
        }

        if (input.action === "update") {
          const jobId = resolveJobId(input);
          if (!jobId) {
            return "[Preflight error] jobId is required for update.";
          }
          const patch = normalizeCronToolPatchInput(raw, input.patch);
          if (!patch) {
            return "[Preflight error] Invalid patch payload.";
          }
          const updated = await updateCronJob(projectId, jobId, patch);
          if (!updated) {
            return json({ success: false, error: "Cron job not found." });
          }
          return json(updated);
        }

        if (input.action === "remove") {
          const jobId = resolveJobId(input);
          if (!jobId) {
            return "[Preflight error] jobId is required for remove.";
          }
          return json(await removeCronJob(projectId, jobId));
        }

        if (input.action === "run") {
          const jobId = resolveJobId(input);
          if (!jobId) {
            return "[Preflight error] jobId is required for run.";
          }
          return json(await runCronJobNow(projectId, jobId));
        }

        if (input.action === "runs") {
          const jobId = resolveJobId(input);
          if (!jobId) {
            return "[Preflight error] jobId is required for runs.";
          }
          return json(await listCronRuns(projectId, jobId, input.limit));
        }

        return `[Preflight error] Unsupported action: ${input.action}`;
      } catch (error) {
        return `[Cron tool error] ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
