"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/utils";

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
        throw new Error(data.error || "Failed to load token status");
      }
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load token status");
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
        throw new Error(data.error || "Failed to rotate token");
      }
      setFreshToken(data.token);
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rotate token");
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
      setError("Failed to copy token");
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
        Create a token for <span className="font-mono">Authorization: Bearer ...</span> and
        rotate it when needed.
      </p>

      {status?.source === "env" && (
        <p className="text-xs text-amber-600">
          Env token detected. Generate to create and use an app-managed token.
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading token status...
        </div>
      ) : (
        <div className="space-y-1 text-sm">
          <div>
            Status:{" "}
            <span className="font-medium">
              {status?.configured ? "configured" : "not configured"}
            </span>
          </div>
          {status?.maskedToken && (
            <div>
              Current token:{" "}
              <span className="font-mono text-xs">{status.maskedToken}</span>
            </div>
          )}
          {updatedLabel && (
            <div className="text-muted-foreground">Updated: {updatedLabel}</div>
          )}
        </div>
      )}

      <Button onClick={rotateToken} disabled={rotating || loading}>
        {rotating ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Processing...
          </>
        ) : (
          <>
            <RefreshCw className="size-4" />
            {status?.configured ? "Regenerate Token" : "Generate Token"}
          </>
        )}
      </Button>

      {freshToken && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            New token (shown once):
          </p>
          <code className="block break-all rounded bg-background p-2 text-xs">
            {freshToken}
          </code>
          <Button variant="outline" size="sm" onClick={copyToken}>
            {copied ? (
              <>
                <Check className="size-4" />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-4" />
                Copy token
              </>
            )}
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
