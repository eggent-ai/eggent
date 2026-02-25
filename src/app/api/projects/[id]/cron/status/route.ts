import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import { getCronProjectStatus } from "@/lib/cron/service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await ensureCronSchedulerStarted();
  try {
    const status = await getCronProjectStatus(id);
    return Response.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load cron status.";
    const status = message.includes("not found") ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
