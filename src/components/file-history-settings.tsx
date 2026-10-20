"use client";

/**
 * How much the history of files takes, its switch, and the way to take the
 * space back.
 *
 * The history counts against the workspace's disk, so it must not be a place
 * the person cannot see into: a full disk stops the model, and "delete
 * something" is only an instruction when the something can be found. The
 * size is said here, with what is kept and for how long, and it can be cleared
 * all at once or down to the last few days.
 */

import { useCallback, useEffect, useState } from "react";
import { History, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import type { VersionUsageView } from "@/lib/files/versions/shape";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const RECENT_DAYS = 7;

export function FileHistorySettings({ enabled, onToggle }: { enabled: boolean; onToggle: (enabled: boolean) => void }) {
  const { t } = useI18n();
  const [usage, setUsage] = useState<VersionUsageView | null>(null);
  const [failed, setFailed] = useState(false);
  const [clearing, setClearing] = useState<"old" | "all" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/files/versions/usage", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      setUsage((await response.json()) as VersionUsageView);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clear = async (scope: "old" | "all") => {
    const question = scope === "all" ? t("settings.fileHistory.clearAllConfirm") : t("settings.fileHistory.clearOldConfirm", { days: RECENT_DAYS });
    if (clearing || !window.confirm(question)) return;
    setClearing(scope);
    setNotice(null);
    try {
      const response = await fetch("/api/files/versions/usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope === "all" ? { action: "clear" } : { action: "clear", olderThanDays: RECENT_DAYS }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as VersionUsageView;
      const freed = Math.max(0, (usage?.bytes ?? 0) - next.bytes);
      setUsage(next);
      setNotice(t("settings.fileHistory.cleared", { size: formatBytes(freed) }));
    } catch {
      setNotice(t("files.history.clearFailed"));
    } finally {
      setClearing(null);
    }
  };

  if (usage && !usage.available) {
    return (
      <section id="file-history" className="space-y-2 rounded-xl border bg-card p-5">
        <div className="flex items-center gap-2">
          <History className="size-5 text-primary" />
          <h3 className="text-lg font-semibold">{t("settings.fileHistory.title")}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t("settings.fileHistory.unavailable")}</p>
      </section>
    );
  }

  return (
    <section id="file-history" className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex items-center gap-2">
        <History className="size-5 text-primary" />
        <h3 className="text-lg font-semibold">{t("settings.fileHistory.title")}</h3>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">{t("settings.fileHistory.switch")}</p>
          <p className="text-sm text-muted-foreground">
            {usage
              ? t("settings.fileHistory.retention", { keep: usage.retention.keepDays, daily: usage.retention.dailyDays })
              : t("settings.fileHistory.description")}
          </p>
        </div>
        <Label htmlFor="file-history-enabled" className="flex cursor-pointer items-center gap-2">
          <input
            id="file-history-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(event) => onToggle(event.target.checked)}
            className="rounded"
          />
        </Label>
      </div>
      <div className="space-y-3 rounded-lg border p-3">
        <p className="text-sm">
          {failed
            ? t("settings.fileHistory.usageFailed")
            : usage
              ? usage.files === 0
                ? t("settings.fileHistory.usageEmpty")
                : t("settings.fileHistory.usage", { size: formatBytes(usage.bytes), versions: usage.versions, files: usage.files })
              : t("common.loading")}
        </p>
        <p className="text-sm text-muted-foreground">{t("settings.fileHistory.countsToDisk")}</p>
        {usage && usage.files > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void clear("old")} disabled={clearing !== null} className="gap-1.5">
              {clearing === "old" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("settings.fileHistory.clearOld", { days: RECENT_DAYS })}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void clear("all")} disabled={clearing !== null} className="gap-1.5 text-destructive hover:text-destructive">
              {clearing === "all" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("settings.fileHistory.clearAll")}
            </Button>
          </div>
        ) : null}
        {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
      </div>
    </section>
  );
}
