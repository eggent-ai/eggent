import { getUsageSnapshot, isUsageProviderConfigured } from "@/lib/usage/usage-provider";

/**
 * How much of the included usage allowance is spent, as a level.
 *
 * Read from the snapshot the sidebar already polls, so this costs nothing on a
 * warm cache and degrades to "say nothing" when no provider is configured or
 * the provider is unreachable. A meter the provider marked agentOnly still
 * counts: a workspace on its own model is not spending this allowance, and the
 * provider hides the meter for exactly that reason.
 */
export async function currentBudgetLevel(): Promise<"ok" | "half" | "low"> {
  try {
    if (!isUsageProviderConfigured()) return "ok";
    const snapshot = await getUsageSnapshot();
    const meter = snapshot?.meters?.find((item) => item.id === "ai" && item.visibility !== "agentOnly");
    if (!meter || !(meter.limit > 0)) return "ok";
    const ratio = meter.used / meter.limit;
    if (ratio >= 0.75) return "low";
    if (ratio >= 0.5) return "half";
    return "ok";
  } catch {
    return "ok";
  }
}
