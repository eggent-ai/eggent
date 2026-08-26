"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/utils";
import { useI18n } from "@/i18n/provider";

type TokenSource = "env" | "stored" | "none";

interface TokenStatusResponse {
  configured: boolean;
  source: TokenSource;
  maskedToken: string | null;
  updatedAt: string | null;
  error?: string;
}

interface TokenRotateResponse {
  success: boolean;
  token: string;
  maskedToken: string;
  source: "stored";
  error?: string;
}

export function ExternalApiTokenManager() {
  const { t } = useI18n();
  const [status, setStatus] = useState<TokenStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/external/token", { cache: "no-store" });
      const data = (await res.json()) as TokenStatusResponse;
      if (!res.ok) {
        throw new Error(data.error || t("externalApiToken.errors.load"));
      }
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("externalApiToken.errors.load"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const rotateToken = useCallback(async () => {
    setError(null);
    setRotating(true);
    setCopied(false);
    try {
      const res = await fetch("/api/external/token", { method: "POST" });
      const data = (await res.json()) as TokenRotateResponse;
      if (!res.ok) {
        throw new Error(data.error || t("externalApiToken.errors.rotate"));
      }
      setFreshToken(data.token);
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("externalApiToken.errors.rotate"));
    } finally {
      setRotating(false);
    }
  }, [loadStatus]);

  const copyToken = useCallback(async () => {
    if (!freshToken) return;
    setError(null);
    try {
      const copiedOk = await copyTextToClipboard(freshToken);
      if (!copiedOk) {
        throw new Error("copy-failed");
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t("externalApiToken.errors.copy"));
    }
  }, [freshToken]);

  const updatedLabel = useMemo(() => {
    if (!status?.updatedAt) return null;
    const date = new Date(status.updatedAt);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString();
  }, [status?.updatedAt]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("externalApiToken.description", { header: "Authorization: Bearer ..." })}
      </p>

      {status?.source === "env" && (
        <p className="text-xs text-warning">
          {t("externalApiToken.envDetected")}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("externalApiToken.loading")}
        </div>
      ) : (
        <div className="space-y-1 text-sm">
          <div>
            {t("externalApiToken.status")} 
            <span className="font-medium">
              {status?.configured ? t("externalApiToken.configured") : t("externalApiToken.notConfigured")}
            </span>
          </div>
          {status?.maskedToken && (
            <div>
              {t("externalApiToken.current")} 
              <span className="font-mono text-xs">{status.maskedToken}</span>
            </div>
          )}
          {updatedLabel && (
            <div className="text-muted-foreground">{t("externalApiToken.updated", { date: updatedLabel })}</div>
          )}
        </div>
      )}

      <Button onClick={rotateToken} disabled={rotating || loading}>
        {rotating ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {t("externalApiToken.processing")}
          </>
        ) : (
          <>
            <RefreshCw className="size-4" />
            {status?.configured ? t("externalApiToken.regenerate") : t("externalApiToken.generate")}
          </>
        )}
      </Button>

      {freshToken && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            {t("externalApiToken.newShownOnce")}
          </p>
          <code className="block break-all rounded bg-background p-2 text-xs">
            {freshToken}
          </code>
          <Button variant="outline" size="sm" onClick={copyToken}>
            {copied ? (
              <>
                <Check className="size-4" />
                {t("externalApiToken.copied")}
              </>
            ) : (
              <>
                <Copy className="size-4" />
                {t("externalApiToken.copy")}
              </>
            )}
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
