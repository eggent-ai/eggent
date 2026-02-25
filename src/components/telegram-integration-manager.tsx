"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Loader2, Link2, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface TelegramSettingsResponse {
  botToken: string;
  webhookSecret: string;
  publicBaseUrl: string;
  defaultProjectId: string;
  allowedUserIds: string[];
  pendingAccessCodes: number;
  updatedAt: string | null;
  sources: {
    botToken: "stored" | "env" | "none";
    webhookSecret: "stored" | "env" | "none";
  };
  error?: string;
}

interface TelegramAccessCodeResponse {
  success?: boolean;
  code?: string;
  createdAt?: string;
  expiresAt?: string;
  error?: string;
}

interface WebhookStatusResponse {
  configured: boolean;
  message?: string;
  webhook: {
    url: string;
    pendingUpdateCount: number;
    lastErrorDate: number | null;
    lastErrorMessage: string | null;
  } | null;
  error?: string;
}

type ActionState = "idle" | "loading";

function sourceLabel(source: "stored" | "env" | "none"): string {
  if (source === "stored") return "stored in app";
  if (source === "env") return "from .env";
  return "not configured";
}

export function TelegramIntegrationManager() {
  const [botToken, setBotToken] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [storedMaskedToken, setStoredMaskedToken] = useState("");
  const [tokenSource, setTokenSource] = useState<"stored" | "env" | "none">(
    "none"
  );
  const [allowedUserIdsInput, setAllowedUserIdsInput] = useState("");
  const [pendingAccessCodes, setPendingAccessCodes] = useState(0);
  const [generatedAccessCode, setGeneratedAccessCode] = useState<string | null>(null);
  const [generatedAccessCodeExpiresAt, setGeneratedAccessCodeExpiresAt] = useState<
    string | null
  >(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [webhookStatus, setWebhookStatus] = useState<WebhookStatusResponse | null>(
    null
  );
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [connectState, setConnectState] = useState<ActionState>("idle");
  const [reconnectState, setReconnectState] = useState<ActionState>("idle");
  const [disconnectState, setDisconnectState] = useState<ActionState>("idle");
  const [saveAllowedUsersState, setSaveAllowedUsersState] = useState<ActionState>("idle");
  const [generateCodeState, setGenerateCodeState] = useState<ActionState>("idle");
  const [webhookState, setWebhookState] = useState<ActionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoadingSettings(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/telegram/config", {
        cache: "no-store",
      });
      const data = (await res.json()) as TelegramSettingsResponse;
      if (!res.ok) {
        throw new Error(data.error || "Failed to load Telegram settings");
      }
      setStoredMaskedToken(data.botToken || "");
      setPublicBaseUrl(data.publicBaseUrl || "");
      setTokenSource(data.sources.botToken);
      setAllowedUserIdsInput((data.allowedUserIds || []).join(", "));
      setPendingAccessCodes(
        typeof data.pendingAccessCodes === "number" ? data.pendingAccessCodes : 0
      );
      setUpdatedAt(data.updatedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Telegram settings");
    } finally {
      setLoadingSettings(false);
    }
  }, []);

  const loadWebhookStatus = useCallback(async () => {
    setWebhookState("loading");
    try {
      const res = await fetch("/api/integrations/telegram/webhook", {
        cache: "no-store",
      });
      const data = (await res.json()) as WebhookStatusResponse;
      if (!res.ok) {
        throw new Error(data.error || "Failed to load webhook status");
      }
      setWebhookStatus(data);
    } catch {
      setWebhookStatus(null);
    } finally {
      setWebhookState("idle");
    }
  }, []);

  useEffect(() => {
    loadSettings();
    loadWebhookStatus();
  }, [loadSettings, loadWebhookStatus]);

  const connectTelegram = useCallback(async () => {
    setConnectState("loading");
    setError(null);
    setSuccess(null);
    try {
      const trimmedToken = botToken.trim();
      const trimmedBaseUrl = publicBaseUrl.trim();

      if (!trimmedBaseUrl) {
        throw new Error("Public Base URL is required");
      }
      if (!trimmedToken && tokenSource === "none") {
        throw new Error("Telegram bot token is required");
      }

      const saveConfigRes = await fetch("/api/integrations/telegram/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(trimmedToken ? { botToken: trimmedToken } : {}),
          publicBaseUrl: trimmedBaseUrl,
        }),
      });
      const saveConfigData = (await saveConfigRes.json()) as { error?: string };
      if (!saveConfigRes.ok) {
        throw new Error(saveConfigData.error || "Failed to save Telegram settings");
      }

      const setupRes = await fetch("/api/integrations/telegram/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken: trimmedToken,
        }),
      });
      const setupData = (await setupRes.json()) as {
        success?: boolean;
        message?: string;
        error?: string;
      };
      if (!setupRes.ok) {
        throw new Error(setupData.error || "Failed to connect Telegram");
      }

      setSuccess(setupData.message || "Telegram connected");
      setBotToken("");
      await Promise.all([loadSettings(), loadWebhookStatus()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect Telegram");
    } finally {
      setConnectState("idle");
    }
  }, [botToken, loadSettings, loadWebhookStatus, publicBaseUrl, tokenSource]);

  const reconnectTelegram = useCallback(async () => {
    setReconnectState("loading");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/integrations/telegram/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Failed to reconnect Telegram");
      }

      setSuccess(data.message || "Telegram reconnected");
      await Promise.all([loadSettings(), loadWebhookStatus()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reconnect Telegram");
    } finally {
      setReconnectState("idle");
    }
  }, [loadSettings, loadWebhookStatus]);

  const disconnectTelegram = useCallback(async () => {
    setDisconnectState("loading");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/integrations/telegram/disconnect", {
        method: "POST",
      });
      const data = (await res.json()) as {
        message?: string;
        note?: string | null;
        webhookWarning?: string | null;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Failed to disconnect Telegram");
      }

      const messages = [data.message || "Telegram disconnected"];
      if (data.webhookWarning) messages.push(`Webhook warning: ${data.webhookWarning}`);
      if (data.note) messages.push(data.note);
      setSuccess(messages.join(" "));

      setBotToken("");
      await Promise.all([loadSettings(), loadWebhookStatus()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect Telegram");
    } finally {
      setDisconnectState("idle");
    }
  }, [loadSettings, loadWebhookStatus]);

  const saveAllowedUsers = useCallback(async () => {
    setSaveAllowedUsersState("loading");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/integrations/telegram/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowedUserIds: allowedUserIdsInput,
        }),
      });
      const data = (await res.json()) as TelegramSettingsResponse;
      if (!res.ok) {
        throw new Error(data.error || "Failed to save allowed users");
      }
      setAllowedUserIdsInput((data.allowedUserIds || []).join(", "));
      setPendingAccessCodes(
        typeof data.pendingAccessCodes === "number" ? data.pendingAccessCodes : 0
      );
      setSuccess("Allowed Telegram user_id list updated");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save allowed users");
    } finally {
      setSaveAllowedUsersState("idle");
    }
  }, [allowedUserIdsInput]);

  const generateAccessCode = useCallback(async () => {
    setGenerateCodeState("loading");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/integrations/telegram/access-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as TelegramAccessCodeResponse;
      if (!res.ok || !data.code) {
        throw new Error(data.error || "Failed to generate access code");
      }

      setGeneratedAccessCode(data.code);
      setGeneratedAccessCodeExpiresAt(
        typeof data.expiresAt === "string" ? data.expiresAt : null
      );
      setSuccess("Access code generated");
      await loadSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate access code");
    } finally {
      setGenerateCodeState("idle");
    }
  }, [loadSettings]);

  const hasTokenConfigured = tokenSource !== "none";
  const hasBaseUrlConfigured = publicBaseUrl.trim().length > 0;
  const isConnected = hasTokenConfigured && hasBaseUrlConfigured;

  const canConnect = useMemo(() => {
    if (!publicBaseUrl.trim()) return false;
    if (botToken.trim()) return true;
    return tokenSource !== "none";
  }, [botToken, publicBaseUrl, tokenSource]);

  const isBusy =
    loadingSettings ||
    connectState === "loading" ||
    reconnectState === "loading" ||
    disconnectState === "loading" ||
    saveAllowedUsersState === "loading" ||
    generateCodeState === "loading";

  const updatedAtLabel = useMemo(() => {
    if (!updatedAt) return null;
    const date = new Date(updatedAt);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString();
  }, [updatedAt]);

  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-4 space-y-4">
        <div className="space-y-1">
          <h3 className="text-lg font-medium">Telegram</h3>
          {!isConnected ? (
            <p className="text-sm text-muted-foreground">
              Enter the bot token and Public Base URL, then click Connect Telegram.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Telegram is connected. You can reconnect or disconnect it.
            </p>
          )}
        </div>

        {!isConnected ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="telegram-bot-token">Bot Token</Label>
              <Input
                id="telegram-bot-token"
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="123456789:AA..."
                disabled={isBusy}
              />
              <p className="text-xs text-muted-foreground">
                Current source: {sourceLabel(tokenSource)}
                {storedMaskedToken ? ` (${storedMaskedToken})` : ""}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="telegram-public-base-url">Public Base URL</Label>
              <Input
                id="telegram-public-base-url"
                type="text"
                value={publicBaseUrl}
                onChange={(e) => setPublicBaseUrl(e.target.value)}
                placeholder="https://your-public-host.example.com"
                disabled={isBusy}
              />
              <p className="text-xs text-muted-foreground">
                Webhook endpoint:{" "}
                <span className="font-mono">{publicBaseUrl || "https://..."}/api/integrations/telegram</span>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={connectTelegram} disabled={!canConnect || isBusy}>
                {connectState === "loading" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Link2 className="size-4" />
                    Connect Telegram
                  </>
                )}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-md border bg-muted/20 p-3 text-sm space-y-1">
              <div>
                Token source: {sourceLabel(tokenSource)}
                {storedMaskedToken ? ` (${storedMaskedToken})` : ""}
              </div>
              <div>
                Public Base URL:{" "}
                <span className="font-mono text-xs break-all">{publicBaseUrl}</span>
              </div>
              {updatedAtLabel && (
                <div className="text-xs text-muted-foreground">Updated: {updatedAtLabel}</div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={reconnectTelegram}
                disabled={isBusy}
              >
                {reconnectState === "loading" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Reconnecting...
                  </>
                ) : (
                  <>
                    <RotateCcw className="size-4" />
                    Reconnect Telegram
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={disconnectTelegram}
                disabled={isBusy}
              >
                {disconnectState === "loading" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Disconnecting...
                  </>
                ) : (
                  <>
                    <Trash2 className="size-4" />
                    Disconnect Telegram
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </section>

      <section className="rounded-lg border bg-card p-4 space-y-4">
        <div className="space-y-1">
          <h4 className="font-medium">Access Control</h4>
          <p className="text-sm text-muted-foreground">
            Only users from this allowlist can chat with the bot. Others must send an access
            code first.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="telegram-allowed-user-ids">Allowed Telegram user_id</Label>
          <Input
            id="telegram-allowed-user-ids"
            type="text"
            value={allowedUserIdsInput}
            onChange={(e) => setAllowedUserIdsInput(e.target.value)}
            placeholder="123456789, 987654321"
            disabled={isBusy}
          />
          <p className="text-xs text-muted-foreground">
            Use comma, space, or newline as separator.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={saveAllowedUsers}
            disabled={isBusy}
          >
            {saveAllowedUsersState === "loading" ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <ShieldCheck className="size-4" />
                Save Allowlist
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={generateAccessCode}
            disabled={isBusy}
          >
            {generateCodeState === "loading" ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <KeyRound className="size-4" />
                Generate Access Code
              </>
            )}
          </Button>
        </div>

        <div className="rounded-md border bg-muted/20 p-3 text-sm space-y-1">
          <div>Pending access codes: {pendingAccessCodes}</div>
          {generatedAccessCode && (
            <div>
              Latest code: <span className="font-mono">{generatedAccessCode}</span>
            </div>
          )}
          {generatedAccessCodeExpiresAt && (
            <div className="text-xs text-muted-foreground">
              Expires at: {new Date(generatedAccessCodeExpiresAt).toLocaleString()}
            </div>
          )}
        </div>
      </section>

      {isConnected && (
        <section className="rounded-lg border bg-card p-4 space-y-4">
          <div className="space-y-1">
            <h4 className="font-medium">Webhook Status</h4>
            <p className="text-sm text-muted-foreground">
              Current webhook status from the latest check.
            </p>
          </div>

          {webhookState === "loading" && (
            <p className="text-sm text-muted-foreground">Loading webhook status...</p>
          )}

          {webhookStatus?.webhook && (
            <div className="rounded-md border bg-muted/20 p-3 text-sm space-y-1">
              <div>
                URL:{" "}
                <span className="font-mono text-xs break-all">
                  {webhookStatus.webhook.url || "(empty)"}
                </span>
              </div>
              <div>Pending updates: {webhookStatus.webhook.pendingUpdateCount}</div>
              {webhookStatus.webhook.lastErrorMessage && (
                <div className="text-red-600">
                  Last error: {webhookStatus.webhook.lastErrorMessage}
                </div>
              )}
              {webhookStatus.webhook.lastErrorDate && (
                <div className="text-xs text-muted-foreground">
                  Last error at:{" "}
                  {new Date(webhookStatus.webhook.lastErrorDate * 1000).toLocaleString()}
                </div>
              )}
            </div>
          )}

          {webhookState !== "loading" && !webhookStatus?.webhook && (
            <p className="text-sm text-muted-foreground">
              {webhookStatus?.message || "Webhook status is not loaded yet."}
            </p>
          )}
        </section>
      )}

      {success && <p className="text-sm text-emerald-600">{success}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
