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
}

interface UsageSnapshot {
  plan?: { label: string; endsAt?: string };
  meters: UsageMeter[];
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

    const load = async () => {
      try {
        const response = await fetch("/api/usage");
        if (response.status === 404) {
          if (!cancelled) setUnavailable(true);
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
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (unavailable || !snapshot) return null;

  return (
    <div className="mx-2 mb-2 rounded-lg border bg-sidebar-accent/40 p-3 space-y-2 text-xs">
      {snapshot.plan ? (
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">{snapshot.plan.label}</span>
          {snapshot.plan.endsAt ? (
            <span className="text-muted-foreground">
              {new Date(snapshot.plan.endsAt).toLocaleDateString()}
            </span>
          ) : null}
        </div>
      ) : null}

      {snapshot.meters.map((meter) => {
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

      {snapshot.notice ? (
        <div
          className={`rounded-md border p-2 space-y-1 ${
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
