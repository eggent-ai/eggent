import { listCronRuns } from "@/lib/cron/service";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id, jobId } = await params;
  await ensureCronSchedulerStarted();
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  try {
    const entries = await listCronRuns(id, jobId, Number.isFinite(limit) ? limit : undefined);
    return Response.json({ entries });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read cron run logs.";
    const status = message.includes("not found") ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
