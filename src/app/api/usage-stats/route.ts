import { getCurrentUser } from "@/lib/auth/get-current-user";
import {
  getUserUsageStats,
  getAllUsageStats,
} from "@/lib/storage/usage-stats-store";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Admins can see all users' stats
  if (user.role === "admin") {
    const allStats = await getAllUsageStats();
    return Response.json({ stats: allStats });
  }

  // Regular users see only their own stats
  const stats = await getUserUsageStats(user.id);
  return Response.json({
    stats: stats ? [stats] : [],
  });
}
