import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getAllProjects, getWorkDir } from "@/lib/storage/project-store";
import { managePiSchedules } from "@/lib/pi/schedule-host";

export const dynamic = "force-dynamic";

type PiScheduleFile = {
  version?: number;
  jobs?: PiScheduledSubagent[];
};

type PiScheduledSubagent = {
  id: string;
  name?: string;
  description?: string;
  schedule?: string;
  scheduleType?: "cron" | "once" | "interval";
  subagent_type?: string;
  prompt?: string;
  enabled?: boolean;
  createdAt?: string;
  lastRun?: string;
  lastStatus?: "success" | "error" | "running";
  nextRun?: string;
  runCount?: number;
};

async function readSchedulesForContext(context: { projectId: string | null; projectName: string; cwd: string }) {
  const scheduleDir = path.join(context.cwd, ".pi", "subagent-schedules");
  let entries: string[];
  try {
    entries = await fs.readdir(scheduleDir);
  } catch {
    return [];
  }

  const schedules = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(scheduleDir, entry);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as PiScheduleFile;
      const sessionId = entry.replace(/\.json$/, "");
      for (const job of parsed.jobs ?? []) {
        schedules.push({
          ...job,
          projectId: context.projectId,
          projectName: context.projectName,
          sessionId,
          storePath: filePath,
        });
      }
    } catch {
      // Ignore corrupt/stale schedule files; pi-subagents will repair on next save.
    }
  }
  return schedules;
}

export async function GET() {
  const projects = await getAllProjects();
  const contexts = [
    { projectId: null, projectName: "Orchestrator", cwd: getWorkDir(null) },
    ...projects.map((project) => ({ projectId: project.id, projectName: project.name, cwd: getWorkDir(project.id) })),
  ];

  const nested = await Promise.all(contexts.map(readSchedulesForContext));
  const schedules = nested.flat().sort((a, b) => {
    const aNext = a.nextRun ?? a.createdAt ?? "";
    const bNext = b.nextRun ?? b.createdAt ?? "";
    return aNext.localeCompare(bNext);
  });

  return NextResponse.json({ schedules });
}


/**
 * Delete a job, or move it to a different time.
 *
 * Both go through `managePiSchedules`, never through the store file. The store
 * is owned by a live pi session: writing it directly changes the persisted time
 * while the armed cron keeps firing on the old one, which is the exact fault
 * `schedule-policy.ts` exists to block for the agent's own tools. Creating a
 * job is deliberately absent - a schedule is a subagent belonging to a session,
 * so it is made in chat and only managed here.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { action?: string; jobId?: string; schedule?: string }
    | null;
  const action = body?.action;
  const jobId = body?.jobId?.trim();

  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  try {
    if (action === "delete") {
      const result = await managePiSchedules({ action: "clear", scope: "all", jobId });
      return NextResponse.json(result);
    }
    if (action === "retime") {
      const schedule = body?.schedule?.trim();
      if (!schedule) return NextResponse.json({ error: "schedule is required" }, { status: 400 });
      const result = await managePiSchedules({ action: "update", scope: "all", jobId, schedule });
      return NextResponse.json(result);
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("[pi-schedules]", error);
    return NextResponse.json({ error: "Could not change the schedule" }, { status: 500 });
  }
}
