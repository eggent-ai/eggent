import { NextRequest } from "next/server";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import { addCronJob, listCronJobs } from "@/lib/cron/service";
import type { CronJobCreate, CronSchedule } from "@/lib/cron/types";

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await ensureCronSchedulerStarted();
  const includeDisabled = req.nextUrl.searchParams.get("includeDisabled") === "true";
  try {
    const jobs = await listCronJobs(id, { includeDisabled });
    return Response.json({ jobs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load cron jobs.";
    const status = message.includes("not found") ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await ensureCronSchedulerStarted();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Invalid JSON body.");
  }

  const schedule = coerceSchedule(body.schedule);
  if (!schedule) {
    return badRequest("Invalid schedule payload.");
  }
  if (!body.payload || typeof body.payload !== "object") {
    return badRequest("payload is required.");
  }
  const payload = body.payload as Record<string, unknown>;
  if (payload.kind !== "agentTurn" || typeof payload.message !== "string") {
    return badRequest('payload.kind must be "agentTurn" and payload.message is required.');
  }

  const input: CronJobCreate = {
    name: typeof body.name === "string" ? body.name : "",
    description: typeof body.description === "string" ? body.description : undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    deleteAfterRun: typeof body.deleteAfterRun === "boolean" ? body.deleteAfterRun : undefined,
    schedule,
    payload: {
      kind: "agentTurn",
      message: payload.message,
      chatId: typeof payload.chatId === "string" ? payload.chatId : undefined,
      telegramChatId:
        typeof payload.telegramChatId === "string" || typeof payload.telegramChatId === "number"
          ? String(payload.telegramChatId)
          : undefined,
      currentPath: typeof payload.currentPath === "string" ? payload.currentPath : undefined,
      timeoutSeconds:
        typeof payload.timeoutSeconds === "number" ? payload.timeoutSeconds : undefined,
    },
  };

  try {
    const job = await addCronJob(id, input);
    return Response.json(job, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create cron job.";
    const status = message.includes("not found") ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
