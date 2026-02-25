import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");

export const GLOBAL_CRON_PROJECT_ID = "none";

export function resolveCronProjectDir(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized || normalized === GLOBAL_CRON_PROJECT_ID) {
    return path.join(DATA_DIR, "cron", "main");
  }
  return path.join(PROJECTS_DIR, normalized, ".meta", "cron");
}

export function resolveCronStorePath(projectId: string): string {
  return path.join(resolveCronProjectDir(projectId), "jobs.json");
}

export function resolveCronRunsDir(projectId: string): string {
  return path.join(resolveCronProjectDir(projectId), "runs");
}

export function resolveCronRunLogPath(projectId: string, jobId: string): string {
  return path.join(resolveCronRunsDir(projectId), `${jobId}.jsonl`);
}
