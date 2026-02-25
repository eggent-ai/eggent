export type CronProjectId = string;

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type CronPayload = {
  kind: "agentTurn";
  message: string;
  chatId?: string;
  telegramChatId?: string;
  currentPath?: string;
  timeoutSeconds?: number;
};

export type CronRunStatus = "ok" | "error" | "skipped";

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: CronRunStatus;
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
};

export type CronJob = {
  id: string;
  projectId: CronProjectId;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  payload: CronPayload;
  state: CronJobState;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronJobCreate = {
  name: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
};

export type CronJobPatch = Partial<{
  name: string;
  description: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  schedule: CronSchedule;
  payload: Partial<CronPayload>;
}>;

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  projectId: CronProjectId;
  status: CronRunStatus;
  error?: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
};
