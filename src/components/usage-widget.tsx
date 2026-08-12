"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useI18n } from "@/i18n/provider";

interface UsageMeter {
  id: string;
  label: string;
  used: number;
  limit: number;
  unit: "currency" | "bytes" | "count";
  currency?: string;
  state?: "ok" | "warning" | "critical" | "exhausted";
  visibility?: "visible" | "agentOnly";
}

interface UsageSnapshot {
  plan?: { label: string; endsAt?: string };
  meters: UsageMeter[];
  /**
   * Where this plan is managed. Supplied by the provider, like everything else
   * here — core does not know what lives at the other end of it.
   */
  manage?: { url: string; label?: string };
  notice?: {
    level: "info" | "warning" | "critical";
    title: string;
    body: string;
    actionLabel?: string;
    actionUrl?: string;
  };
  refreshAfterSec?: number;
}

const POLL_INTERVAL_MS = 60_000;

function formatAmount(meter: UsageMeter, value: number): string {
  if (meter.unit === "currency") {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: meter.currency || "EUR",
      }).format(value / 100);
    } catch {
      return (value / 100).toFixed(2);
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
}

function barColor(state: UsageMeter["state"], ratio: number): string {
  const level = state ?? (ratio >= 1 ? "exhausted" : ratio >= 0.8 ? "critical" : ratio >= 0.5 ? "warning" : "ok");
  if (level === "exhausted" || level === "critical") return "bg-destructive";
  if (level === "warning") return "bg-amber-500";
  return "bg-primary";
}

/**
 * Renders quota information from the deployment's usage provider.
 *
 * Every label, notice and link comes from that provider. When no provider is
 * configured the endpoint answers 404 and this component renders nothing, which
 * is the normal case for self-hosted Eggent.
 */
export function UsageWidget() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const load = async () => {
      try {
        const response = await fetch("/api/usage");
        if (response.status === 404) {
          // No usage provider is configured and none will appear while this
          // page is open, so there is nothing left to ask for.
          if (!cancelled) setUnavailable(true);
          stopPolling();
          return;
        }
        if (response.status === 401) {
          // The session is gone. Polling on regardless leaves a tab that looks
          // alive answering 401 for hours while the person wonders why nothing
          // works, so follow the same redirect the middleware performs on any
          // page request.
          stopPolling();
          if (!cancelled) {
            const next = `${window.location.pathname}${window.location.search}`;
            const target = next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
            window.location.replace(target);
          }
          return;
        }
        if (!response.ok) return;
        const data = (await response.json()) as UsageSnapshot;
        if (!cancelled) setSnapshot(data);
      } catch {
        // Usage info is never load-bearing; stay quiet and retry on the next tick.
      }
    };

    void load();
    timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, []);

  if (unavailable || !snapshot) return null;

  // Meters the provider marked as agent-only are answers to questions, not
  // things worth taking up sidebar space.
  const visibleMeters = snapshot.meters.filter((meter) => meter.visibility !== "agentOnly");
  if (!visibleMeters.length && !snapshot.plan && !snapshot.notice) return null;

  const manageUrl = snapshot.manage?.url;
  const manageLabel = snapshot.manage?.label || t("usage.openAction");

  const summary = (
    <>
      {snapshot.plan ? (
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">{snapshot.plan.label}</span>
          <span className="flex items-baseline gap-1 text-muted-foreground">
            {snapshot.plan.endsAt ? (
              <span>{new Date(snapshot.plan.endsAt).toLocaleDateString()}</span>
            ) : null}
            {manageUrl ? <ExternalLink className="size-3 shrink-0 self-center" /> : null}
          </span>
        </div>
      ) : null}

      {visibleMeters.map((meter) => {
        const ratio = meter.limit > 0 ? Math.min(1, Math.max(0, meter.used / meter.limit)) : 0;
        return (
          <div key={meter.id} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground truncate">{meter.label}</span>
              <span className="tabular-nums whitespace-nowrap">
                {formatAmount(meter, Math.max(0, meter.limit - meter.used))} {t("usage.left")}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${barColor(meter.state, ratio)}`}
                style={{ width: `${Math.round(ratio * 100)}%` }}
              />
            </div>
          </div>
        );
      })}
    </>
  );

  return (
    <div className="mx-2 mb-2 rounded-lg border bg-sidebar-accent/40 text-xs">
      {/*
        The plan and its meters are the card; the notice below keeps its own
        link, so the two never nest.
      */}
      {manageUrl ? (
        <a
          href={manageUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={manageLabel}
          title={manageLabel}
          className="block space-y-2 rounded-lg p-3 transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {summary}
        </a>
      ) : (
        <div className="space-y-2 p-3">{summary}</div>
      )}

      {snapshot.notice ? (
        <div
          className={`mx-3 mb-3 space-y-1 rounded-md border p-2 ${
            snapshot.notice.level === "critical"
              ? "border-destructive/50 text-destructive"
              : snapshot.notice.level === "warning"
                ? "border-amber-500/50"
                : "border-border"
          }`}
        >
          <div className="font-medium">{snapshot.notice.title}</div>
          <p className="text-muted-foreground">{snapshot.notice.body}</p>
          {snapshot.notice.actionUrl ? (
            <a
              className="inline-flex items-center gap-1 underline underline-offset-2"
              href={snapshot.notice.actionUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {snapshot.notice.actionLabel || t("usage.openAction")}
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
