import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import { runCronJobNow } from "@/lib/cron/service";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id, jobId } = await params;
  await ensureCronSchedulerStarted();

  try {
    const result = await runCronJobNow(id, jobId);
    if (!result.ran) {
      if (result.reason === "not-found") {
        return Response.json({ error: "Cron job not found." }, { status: 404 });
      }
      if (result.reason === "already-running") {
        return Response.json(
          { error: "Cron job is already running." },
          { status: 409 }
        );
      }
    }
    return Response.json({ success: true, ran: result.ran });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run cron job.";
    const status = message.includes("not found") ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
