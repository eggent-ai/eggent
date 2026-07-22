import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getEggentAiModelLockState, getPiModelRuntime, getPiModelsState, setPiDefaultToFirstAvailableModel } from "@/lib/pi/config-store";

type LoginEvent =
  | { id: string; type: "auth_url"; url: string; instructions?: string; createdAt: number }
  | { id: string; type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number; createdAt: number }
  | { id: string; type: "progress"; message: string; createdAt: number }
  | { id: string; type: "prompt"; promptId: string; message: string; placeholder?: string; allowEmpty?: boolean; manualCode?: boolean; createdAt: number }
  | { id: string; type: "select"; promptId: string; message: string; options: Array<{ id: string; label: string }>; createdAt: number }
  | { id: string; type: "completed"; state: unknown; createdAt: number }
  | { id: string; type: "error"; message: string; createdAt: number };

type AuthPromptLike =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string; signal?: AbortSignal }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[]; signal?: AbortSignal };

type AuthEventLike =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

type LoginEventInput<T extends LoginEvent = LoginEvent> = T extends LoginEvent
  ? Omit<T, "id" | "createdAt">
  : never;

type PendingPrompt = {
  resolve: (value: string | undefined) => void;
  reject: (error: Error) => void;
};

type LoginJob = {
  id: string;
  provider: string;
  status: "running" | "completed" | "error" | "cancelled";
  events: LoginEvent[];
  pending: Map<string, PendingPrompt>;
  controller: AbortController;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

const jobs = new Map<string, LoginJob>();
const JOB_TTL_MS = 30 * 60 * 1000;

function eventId(): string {
  return randomUUID();
}

function pushEvent(job: LoginJob, event: LoginEventInput) {
  job.updatedAt = Date.now();
  job.events.push({ id: eventId(), createdAt: job.updatedAt, ...event } as LoginEvent);
}

function cleanupJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.updatedAt > JOB_TTL_MS) {
      job.controller.abort();
      jobs.delete(id);
    }
  }
}

function waitForPrompt(job: LoginJob, event: LoginEventInput<Extract<LoginEvent, { type: "prompt" | "select" }>>) {
  const promptId = event.promptId;
  pushEvent(job, event);
  return new Promise<string | undefined>((resolve, reject) => {
    job.pending.set(promptId, { resolve, reject });
    job.controller.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
  });
}

function handleAuthNotify(job: LoginJob, event: AuthEventLike): void {
  if (event.type === "auth_url") {
    pushEvent(job, { type: "auth_url", url: event.url, instructions: event.instructions });
    return;
  }
  if (event.type === "device_code") {
    pushEvent(job, event);
    return;
  }
  if (event.type === "progress") {
    pushEvent(job, { type: "progress", message: event.message });
    return;
  }
  const links = event.links?.map((link) => link.label ? `${link.label}: ${link.url}` : link.url).join("\n");
  pushEvent(job, { type: "progress", message: links ? `${event.message}\n${links}` : event.message });
}

async function handleAuthPrompt(job: LoginJob, prompt: AuthPromptLike): Promise<string> {
  const promptId = randomUUID();
  if (prompt.type === "select") {
    const value = await waitForPrompt(job, {
      type: "select",
      promptId,
      message: prompt.message,
      options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
    });
    if (!value) throw new Error("Login cancelled");
    return value;
  }

  const value = await waitForPrompt(job, {
    type: "prompt",
    promptId,
    message: prompt.message,
    placeholder: prompt.placeholder,
    allowEmpty: false,
    manualCode: prompt.type === "manual_code",
  });
  if (!value) throw new Error("Login cancelled");
  return value;
}

function serializeJob(job: LoginJob) {
  return {
    id: job.id,
    provider: job.provider,
    status: job.status,
    error: job.error,
    events: job.events,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export async function POST(req: NextRequest) {
  cleanupJobs();
  const body = await req.json().catch(() => null) as { provider?: unknown } | null;
  const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
  if (!provider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }

  const lock = await getEggentAiModelLockState();
  if (lock.locked) {
    return NextResponse.json({ error: "Provider login is managed by Eggent AI for this workspace." }, { status: 403 });
  }

  const modelRuntime = await getPiModelRuntime();
  const oauthProvider = modelRuntime.getProviders().find((item) => item.id === provider && item.auth?.oauth);
  if (!oauthProvider) {
    return NextResponse.json({ error: `${provider} is not an Eggent OAuth/subscription provider.` }, { status: 400 });
  }

  const now = Date.now();
  const job: LoginJob = {
    id: randomUUID(),
    provider,
    status: "running",
    events: [],
    pending: new Map(),
    controller: new AbortController(),
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);

  void (async () => {
    try {
      await modelRuntime.login(provider, "oauth", {
        prompt: (prompt) => handleAuthPrompt(job, prompt as AuthPromptLike),
        notify: (event) => handleAuthNotify(job, event as AuthEventLike),
        signal: job.controller.signal,
      });
      await setPiDefaultToFirstAvailableModel(provider);
      job.status = "completed";
      pushEvent(job, { type: "completed", state: await getPiModelsState() });
    } catch (error) {
      if (job.controller.signal.aborted) {
        job.status = "cancelled";
        job.error = "Login cancelled";
      } else {
        job.status = "error";
        job.error = error instanceof Error ? error.message : "Login failed";
      }
      pushEvent(job, { type: "error", message: job.error });
    } finally {
      for (const pending of job.pending.values()) {
        pending.reject(new Error(job.error || "Login finished"));
      }
      job.pending.clear();
      setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref?.();
    }
  })();

  return NextResponse.json(serializeJob(job));
}

export async function GET(req: NextRequest) {
  cleanupJobs();
  const id = req.nextUrl.searchParams.get("id") || "";
  const job = jobs.get(id);
  if (!job) {
    return NextResponse.json({ error: "login job not found" }, { status: 404 });
  }
  return NextResponse.json(serializeJob(job));
}

export async function PATCH(req: NextRequest) {
  cleanupJobs();
  const body = await req.json().catch(() => null) as { id?: unknown; promptId?: unknown; value?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const promptId = typeof body?.promptId === "string" ? body.promptId : "";
  const value = typeof body?.value === "string" ? body.value : undefined;
  const job = jobs.get(id);
  if (!job) {
    return NextResponse.json({ error: "login job not found" }, { status: 404 });
  }
  const pending = job.pending.get(promptId);
  if (!pending) {
    return NextResponse.json({ error: "prompt not found or already answered" }, { status: 404 });
  }
  job.pending.delete(promptId);
  pending.resolve(value);
  return NextResponse.json(serializeJob(job));
}

export async function DELETE(req: NextRequest) {
  cleanupJobs();
  const id = req.nextUrl.searchParams.get("id") || "";
  const job = jobs.get(id);
  if (!job) {
    return NextResponse.json({ error: "login job not found" }, { status: 404 });
  }
  job.status = "cancelled";
  job.error = "Login cancelled";
  job.controller.abort();
  for (const pending of job.pending.values()) {
    pending.reject(new Error("Login cancelled"));
  }
  job.pending.clear();
  pushEvent(job, { type: "error", message: "Login cancelled" });
  return NextResponse.json(serializeJob(job));
}
