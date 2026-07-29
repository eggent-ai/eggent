/**
 * Optional external usage/quota provider.
 *
 * Eggent itself has no concept of plans, credits or payments. A deployment may
 * point this at an HTTP endpoint that reports how much of some quota the current
 * workspace has consumed, and Eggent will render whatever that endpoint returns.
 *
 * Self-hosted Eggent normally leaves this unconfigured, in which case the whole
 * feature is absent: `/api/usage` returns 404, no widget is rendered, and the
 * usage tool is not registered.
 *
 * Every user-visible string (labels, plan name, notice text, action link) comes
 * from the provider, so Eggent ships no deployment-specific wording.
 */

export interface UsageMeter {
  /** Stable identifier, e.g. "ai" or "storage". Free-form. */
  id: string;
  /** Human-readable label, already localized by the provider. */
  label: string;
  used: number;
  limit: number;
  unit: "currency" | "bytes" | "count";
  /** ISO 4217 code, only meaningful when unit is "currency". */
  currency?: string;
  state?: "ok" | "warning" | "critical" | "exhausted";
}

export interface UsageNotice {
  level: "info" | "warning" | "critical";
  title: string;
  body: string;
  actionLabel?: string;
  actionUrl?: string;
}

export interface UsageSnapshot {
  plan?: { label: string; endsAt?: string };
  meters: UsageMeter[];
  notice?: UsageNotice;
  /** Provider hint for how long this snapshot stays valid. */
  refreshAfterSec?: number;
}

export interface UsageProviderConfig {
  url: string;
  token?: string;
}

const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

let cache: { snapshot: UsageSnapshot; expiresAt: number } | null = null;

export function getUsageProviderConfig(): UsageProviderConfig | null {
  const url = process.env.EGGENT_USAGE_API_URL?.trim();
  if (!url) return null;
  return { url, token: process.env.EGGENT_USAGE_API_TOKEN?.trim() || undefined };
}

export function isUsageProviderConfigured(): boolean {
  return getUsageProviderConfig() !== null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseMeter(raw: unknown): UsageMeter | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const used = asFiniteNumber(record.used);
  const limit = asFiniteNumber(record.limit);
  if (!id || !label || used === null || limit === null) return null;

  const unit = record.unit === "currency" || record.unit === "bytes" || record.unit === "count"
    ? record.unit
    : "count";
  const state = record.state === "ok" || record.state === "warning" || record.state === "critical" || record.state === "exhausted"
    ? record.state
    : undefined;

  return {
    id,
    label,
    used,
    limit,
    unit,
    currency: typeof record.currency === "string" ? record.currency : undefined,
    state,
  };
}

function parseNotice(raw: unknown): UsageNotice | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";
  if (!title && !body) return undefined;

  const level = record.level === "critical" || record.level === "warning" ? record.level : "info";
  const actionUrl = typeof record.actionUrl === "string" ? record.actionUrl.trim() : "";
  return {
    level,
    title,
    body,
    actionLabel: typeof record.actionLabel === "string" ? record.actionLabel.trim() || undefined : undefined,
    // Only http(s) links are accepted, so a provider cannot inject javascript: URLs.
    actionUrl: /^https?:\/\//i.test(actionUrl) ? actionUrl : undefined,
  };
}

export function parseUsageSnapshot(raw: unknown): UsageSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const meters = Array.isArray(record.meters)
    ? record.meters.map(parseMeter).filter((meter): meter is UsageMeter => meter !== null)
    : [];

  let plan: UsageSnapshot["plan"];
  if (record.plan && typeof record.plan === "object") {
    const planRecord = record.plan as Record<string, unknown>;
    const label = typeof planRecord.label === "string" ? planRecord.label.trim() : "";
    if (label) {
      plan = { label, endsAt: typeof planRecord.endsAt === "string" ? planRecord.endsAt : undefined };
    }
  }

  const notice = parseNotice(record.notice);
  if (!meters.length && !plan && !notice) return null;

  return {
    plan,
    meters,
    notice,
    refreshAfterSec: asFiniteNumber(record.refreshAfterSec) ?? undefined,
  };
}

export function clearUsageSnapshotCache(): void {
  cache = null;
}

/**
 * Fetch the current usage snapshot, or null when no provider is configured or
 * the provider is unreachable. Usage information is never load-bearing: a failed
 * fetch degrades to "no widget" rather than to an error.
 */
export async function getUsageSnapshot(options: { force?: boolean } = {}): Promise<UsageSnapshot | null> {
  const config = getUsageProviderConfig();
  if (!config) return null;

  const now = Date.now();
  if (!options.force && cache && cache.expiresAt > now) {
    return cache.snapshot;
  }

  try {
    const response = await fetch(config.url, {
      headers: {
        Accept: "application/json",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`[eggent] Usage provider returned ${response.status}`);
      return cache?.snapshot ?? null;
    }

    const snapshot = parseUsageSnapshot(await response.json());
    if (!snapshot) return cache?.snapshot ?? null;

    const ttl = snapshot.refreshAfterSec
      ? Math.min(Math.max(snapshot.refreshAfterSec * 1000, MIN_TTL_MS), MAX_TTL_MS)
      : DEFAULT_TTL_MS;
    cache = { snapshot, expiresAt: now + ttl };
    return snapshot;
  } catch (error) {
    console.warn("[eggent] Failed to reach usage provider:", error instanceof Error ? error.message : error);
    return cache?.snapshot ?? null;
  }
}

export function formatUsageMeter(meter: UsageMeter): string {
  const format = (value: number): string => {
    if (meter.unit === "currency") {
      const amount = value / 100;
      try {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: meter.currency || "EUR",
        }).format(amount);
      } catch {
        return `${amount.toFixed(2)} ${meter.currency || ""}`.trim();
      }
    }
    if (meter.unit === "bytes") {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let size = Math.max(0, value);
      let unitIndex = 0;
      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
      }
      return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
    }
    return String(value);
  };

  const remaining = Math.max(0, meter.limit - meter.used);
  return `${meter.label}: ${format(meter.used)} of ${format(meter.limit)} used, ${format(remaining)} left`;
}
