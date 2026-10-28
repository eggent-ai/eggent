"use client";

/**
 * Connecting the person's Google account, where the deployment offers it.
 *
 * Shown in two places: under an answer whose agent asked for the connection,
 * and in Settings. Connecting happens in the browser, on the workspace's own
 * address - the deployment checks the person is signed in, sends them to
 * Google and brings them back to the page they left with `?google=connected`
 * - so the button is a plain link, never something the agent can press.
 * Nothing is drawn where the deployment has no Google (`enabled: false`).
 */
import { useEffect, useState } from "react";
import { CheckCircle2, FileSpreadsheet, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { connectHref } from "@/lib/google/connect-link";

interface StatusAnswer {
  enabled: boolean;
  connected?: boolean;
  email?: string;
  sheets?: boolean;
  calendar?: "on" | "consent" | "off";
  connectUrl?: string;
}

type ReturnNotice = "connected" | "cancelled" | "failed" | null;

let returnNotice: ReturnNotice | undefined;

/**
 * What the way back from Google said, read once per page load: every card on
 * the page shows it, and the address loses the parameter so a reload does not
 * say it again.
 */
function takeReturnNotice(): ReturnNotice {
  if (returnNotice !== undefined) return returnNotice;
  returnNotice = null;
  try {
    const url = new URL(window.location.href);
    const value = url.searchParams.get("google");
    if (value === "connected" || value === "cancelled" || value === "failed") returnNotice = value;
    if (value !== null) {
      url.searchParams.delete("google");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {
    // No address to read.
  }
  return returnNotice;
}

export function GoogleConnectCard({ variant, connectUrl }: { variant: "chat" | "settings"; connectUrl?: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusAnswer | null>(null);
  const [notice, setNotice] = useState<ReturnNotice>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    setNotice(takeReturnNotice());
    let cancelled = false;
    fetch("/api/google/status", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: StatusAnswer | null) => {
        if (!cancelled) setStatus(json ?? { enabled: Boolean(connectUrl), connected: false, connectUrl });
      })
      .catch(() => {
        if (!cancelled) setStatus({ enabled: Boolean(connectUrl), connected: false, connectUrl });
      });
    return () => {
      cancelled = true;
    };
  }, [connectUrl]);

  useEffect(() => {
    if (!status?.enabled) return;
    setHref(connectHref(status.connectUrl || connectUrl, window.location));
  }, [status, connectUrl]);

  if (!status?.enabled) return null;

  const disconnect = async () => {
    if (!window.confirm(t("google.card.disconnectConfirm", { email: status.email ?? "" }))) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/google/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await response.json().catch(() => null)) as (StatusAnswer & { error?: string }) | null;
      if (!response.ok || !json) throw new Error(json?.error || t("google.card.failed"));
      setStatus(json);
      setNotice(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("google.card.failed"));
    } finally {
      setBusy(false);
    }
  };

  const calendarOffered = status.calendar === "on" || status.calendar === "consent";
  const title = calendarOffered ? t("google.card.titleWithCalendar") : t("google.card.title");
  const connectButton = href ? (
    <Button asChild size="sm">
      {/* A full page load: the entry is answered by the deployment, not by this app. */}
      <a href={href}>{status.connected ? t("google.card.reconnect") : t("google.card.connect")}</a>
    </Button>
  ) : null;

  const lines = (
    <>
      {status.connected ? (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <span className="break-all">{t("google.card.connectedAs", { email: status.email ?? "" })}</span>
        </p>
      ) : (
        <p className="text-muted-foreground">
          {calendarOffered ? t("google.card.explainWithCalendar") : t("google.card.explain")}
        </p>
      )}
      {notice === "connected" && status.connected ? (
        <p role="status" className="text-emerald-700 dark:text-emerald-400">
          {variant === "chat" ? t("google.card.connectedNowChat") : t("google.card.connectedNow")}
        </p>
      ) : null}
      {notice === "cancelled" && !status.connected ? <p role="status" className="text-muted-foreground">{t("google.card.cancelled")}</p> : null}
      {notice === "failed" ? <p role="alert" className="text-destructive">{t("google.card.returnFailed")}</p> : null}
      {status.connected && status.calendar === "consent" ? <p className="text-muted-foreground">{t("google.card.calendarConsent")}</p> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {!status.connected || status.calendar === "consent" ? connectButton : null}
        {status.connected && variant === "settings" ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void disconnect()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy ? t("google.card.disconnecting") : t("google.card.disconnect")}
          </Button>
        ) : null}
      </div>
    </>
  );

  // In Settings it is one section among the others, laid out like them.
  if (variant === "settings") {
    return (
      <section className="space-y-3 rounded-xl border bg-card p-5 text-sm" aria-label={title} data-google-card="settings">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="size-5 text-primary" aria-hidden="true" />
          <h3 className="text-lg font-semibold">{title}</h3>
        </div>
        {lines}
      </section>
    );
  }
  return (
    <section className="rounded-lg border bg-card px-3 py-3 text-sm" aria-label={title} data-google-card="chat">
      <div className="flex items-start gap-3">
        <FileSpreadsheet className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="font-medium">{title}</div>
          {lines}
        </div>
      </div>
    </section>
  );
}
