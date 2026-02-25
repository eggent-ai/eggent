import { NextRequest } from "next/server";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import { getCronJob, removeCronJob, updateCronJob } from "@/lib/cron/service";
import type { CronJobPatch, CronSchedule } from "@/lib/cron/types";

function coerceSchedule(value: unknown): CronSchedule | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "at" && typeof raw.at === "string") {
    return { kind: "at", at: raw.at };
  }
  if (raw.kind === "every" && typeof raw.everyMs === "number") {
    return {
      kind: "every",
      everyMs: raw.everyMs,
      anchorMs: typeof raw.anchorMs === "number" ? raw.anchorMs : undefined,
    };
  }
  if (raw.kind === "cron" && typeof raw.expr === "string") {
    return {
      kind: "cron",
      expr: raw.expr,
      tz: typeof raw.tz === "string" ? raw.tz : undefined,
    };
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id, jobId } = await params;
  await ensureCronSchedulerStarted();
  try {
    const job = await getCronJob(id, jobId);
    if (!job) {
      return Response.json({ error: "Cron job not found." }, { status: 404 });
    }
    return Response.json(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load cron job.";
    const status = message.includes("not found") ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id, jobId } = await params;
  await ensureCronSchedulerStarted();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const patch: CronJobPatch = {};

  if ("name" in body) {
    patch.name = typeof body.name === "string" ? body.name : "";
  }
  if ("description" in body) {
    patch.description = typeof body.description === "string" ? body.description : "";
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      return Response.json({ error: "enabled must be a boolean." }, { status: 400 });
    }
    patch.enabled = body.enabled;
  }
  if ("deleteAfterRun" in body) {
    if (typeof body.deleteAfterRun !== "boolean") {
      return Response.json({ error: "deleteAfterRun must be a boolean." }, { status: 400 });
    }
    patch.deleteAfterRun = body.deleteAfterRun;
  }
  if ("schedule" in body) {
    const schedule = coerceSchedule(body.schedule);
    if (!schedule) {
      return Response.json({ error: "Invalid schedule patch." }, { status: 400 });
    }
    patch.schedule = schedule;
  }
  if ("payload" in body) {
    if (!body.payload || typeof body.payload !== "object") {
      return Response.json({ error: "Invalid payload patch." }, { status: 400 });
    }
    const payload = body.payload as Record<string, unknown>;
    patch.payload = {
      kind: "agentTurn",
      message: typeof payload.message === "string" ? payload.message : undefined,
      chatId: typeof payload.chatId === "string" ? payload.chatId : undefined,
      telegramChatId:
        typeof payload.telegramChatId === "string" ||
        typeof payload.telegramChatId === "number"
          ? String(payload.telegramChatId)
          : undefined,
      currentPath: typeof payload.currentPath === "string" ? payload.currentPath : undefined,
      timeoutSeconds:
        typeof payload.timeoutSeconds === "number" ? payload.timeoutSeconds : undefined,
    };
  }

  try {
    const job = await updateCronJob(id, jobId, patch);
    if (!job) {
      return Response.json({ error: "Cron job not found." }, { status: 404 });
    }
    return Response.json(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update cron job.";
    const status = message.includes("not found") ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id, jobId } = await params;
  await ensureCronSchedulerStarted();

  try {
    const result = await removeCronJob(id, jobId);
    if (!result.removed) {
      return Response.json({ error: "Cron job not found." }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to remove cron job.";
    const status = message.includes("not found") ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
