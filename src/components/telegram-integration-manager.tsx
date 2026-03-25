"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Loader2, Link2, ShieldCheck, Trash2, Play, Square, Radio, Globe } from "lucide-react";
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
  mode: "auto" | "webhook" | "polling";
  pollingInterval: number;
  detectedMode: "webhook" | "polling";
  sources: {
    botToken: "stored" | "env" | "none";
    webhookSecret: "stored" | "env" | "none";
    mode: "stored" | "env" | "none";
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

interface PollingStatusResponse {
  status: string;
  polling: {
    isRunning: boolean;
    lastUpdateId: number | null;
    lastPollTime: string | null;
    errorCount: number;
    consecutiveErrors: number;
  };
  config: {
    mode: "auto" | "webhook" | "polling";
    detectedMode: "webhook" | "polling";
    canStartPolling: boolean;
  };
}

type ActionState = "idle" | "loading";
type TelegramMode = "auto" | "webhook" | "polling";

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
  const [mode, setMode] = useState<TelegramMode>("auto");
  const [detectedMode, setDetectedMode] = useState<"webhook" | "polling">("polling");

  // Helper to detect if URL is localhost/private (needs polling) or public (can use webhook)
  const detectUrlMode = useCallback((url: string): "webhook" | "polling" => {
    if (!url.trim()) return "polling";
    const lowerUrl = url.toLowerCase().trim();
    // Check for localhost, private IPs, or non-HTTPS
    if (lowerUrl.includes("localhost")) return "polling";
    if (lowerUrl.includes("127.0.0.1")) return "polling";
    if (lowerUrl.includes("192.168.")) return "polling";
    if (lowerUrl.includes("10.0.")) return "polling";
    if (lowerUrl.includes("172.16.")) return "polling";
    if (lowerUrl.startsWith("http://")) return "polling";
    return "webhook";
  }, []);
  const [allowedUserIdsInput, setAllowedUserIdsInput] = useState("");
  const [pendingAccessCodes, setPendingAccessCodes] = useState(0);
  const [generatedAccessCode, setGeneratedAccessCode] = useState<string | null>(null);
  const [generatedAccessCodeExpiresAt, setGeneratedAccessCodeExpiresAt] = useState<
    string | null
  >(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [pollingStatus, setPollingStatus] = useState<PollingStatusResponse | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [connectState, setConnectState] = useState<ActionState>("idle");
  const [disconnectState, setDisconnectState] = useState<ActionState>("idle");
  const [saveAllowedUsersState, setSaveAllowedUsersState] = useState<ActionState>("idle");
  const [generateCodeState, setGenerateCodeState] = useState<ActionState>("idle");
  const [pollingState, setPollingState] = useState<ActionState>("idle");
  const [modeState, setModeState] = useState<ActionState>("idle");
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
      setMode(data.mode || "auto");
      setDetectedMode(data.detectedMode || "polling");
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

  const loadPollingStatus = useCallback(async () => {
    setPollingState("loading");
    try {
      const res = await fetch("/api/integrations/telegram/polling", {
        cache: "no-store",
      });
      const data = (await res.json()) as PollingStatusResponse;
      if (!res.ok) {
        throw new Error("Failed to load polling status");
      }
      setPollingStatus(data);
    } catch {
      setPollingStatus(null);
    } finally {
      setPollingState("idle");
    }
  }, []);

  useEffect(() => {
    loadSettings();
    loadPollingStatus();

    // Refresh polling status every 5 seconds when in polling mode
    const interval = setInterval(() => {
      if (detectedMode === "polling" || mode === "polling") {
        loadPollingStatus();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [loadSettings, loadPollingStatus, detectedMode, mode]);

  const connectTelegram = useCallback(async () => {
    setConnectState("loading");
    setError(null);
    setSuccess(null);
    try {
      const trimmedToken = botToken.trim();
      const trimmedBaseUrl = publicBaseUrl.trim();

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

      setSuccess(setupData.message || "Webhook configured");
      setBotToken("");
      await loadSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect Telegram");
    } finally {
      setConnectState("idle");
    }
  }, [botToken, loadSettings, publicBaseUrl, tokenSource]);

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
      await loadSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect Telegram");
    } finally {
      setDisconnectState("idle");
    }
  }, [loadSettings]);

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

  const startPolling = useCallback(async () => {
    setPollingState("loading");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/integrations/telegram/polling", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.error || "Failed to start polling");
      }
      setSuccess(data.message || "Polling started");
      await loadPollingStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start polling");
    } finally {
      setPollingState("idle");
    }
  }, [loadPollingStatus]);

  const stopPolling = useCallback(async () => {
    setPollingState("loading");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/integrations/telegram/polling", {
        method: "DELETE",
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.error || "Failed to stop polling");
      }
      setSuccess(data.message || "Polling stopped");
      await loadPollingStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stop polling");
    } finally {
      setPollingState("idle");
    }
  }, [loadPollingStatus]);

  const saveMode = useCallback(async (newMode: TelegramMode) => {
    setModeState("loading");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/integrations/telegram/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: newMode }),
      });
      const data = (await res.json()) as TelegramSettingsResponse;
      if (!res.ok) {
        throw new Error(data.error || "Failed to save mode");
      }
      setMode(data.mode || "auto");
      setDetectedMode(data.detectedMode || "polling");
      setSuccess(`Mode updated to ${newMode}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save mode");
    } finally {
      setModeState("idle");
    }
  }, []);

  const hasTokenConfigured = tokenSource !== "none";

  const isBusy =
    loadingSettings ||
    connectState === "loading" ||
    disconnectState === "loading" ||
    saveAllowedUsersState === "loading" ||
    generateCodeState === "loading" ||
    pollingState === "loading" ||
    modeState === "loading";

  const updatedAtLabel = useMemo(() => {
    if (!updatedAt) return null;
    const date = new Date(updatedAt);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString();
  }, [updatedAt]);

  // Determine effective mode considering auto detection
  const effectiveMode = mode === "auto" ? detectedMode : mode;

  return (
    <div className="space-y-4">
      {/* Step 1: Bot Token */}
      <section className="rounded-lg border bg-card p-4 space-y-4">
        <div className="space-y-1">
          <h3 className="text-lg font-medium">1. Bot Token</h3>
          <p className="text-sm text-muted-foreground">
            Enter your Telegram bot token from @BotFather.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="telegram-bot-token">Bot Token</Label>
          <Input
            id="telegram-bot-token"
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456789:AA..."
            disabled={isBusy || hasTokenConfigured}
          />
          {hasTokenConfigured && (
            <p className="text-xs text-muted-foreground">
              Token saved ({sourceLabel(tokenSource)})
              {storedMaskedToken ? `: ${storedMaskedToken}` : ""}
            </p>
          )}
        </div>

        {!hasTokenConfigured && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={async () => {
                const trimmedToken = botToken.trim();
                if (!trimmedToken) {
                  setError("Bot token is required");
                  return;
                }
                setConnectState("loading");
                setError(null);
                try {
                  const res = await fetch("/api/integrations/telegram/config", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ botToken: trimmedToken }),
                  });
                  const data = (await res.json()) as { error?: string };
                  if (!res.ok) {
                    throw new Error(data.error || "Failed to save bot token");
                  }
                  setSuccess("Bot token saved");
                  setBotToken("");
                  await loadSettings();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Failed to save bot token");
                } finally {
                  setConnectState("idle");
                }
              }}
              disabled={!botToken.trim() || isBusy}
            >
              {connectState === "loading" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Link2 className="size-4" />
                  Save Token
                </>
              )}
            </Button>
          </div>
        )}
      </section>

      {/* Step 2: Connection Mode */}
      {hasTokenConfigured && (
        <section className="rounded-lg border bg-card p-4 space-y-4">
          <div className="space-y-1">
            <h3 className="text-lg font-medium">2. Connection Mode</h3>
            <p className="text-sm text-muted-foreground">
              Choose how Telegram connects to your bot.
            </p>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Label htmlFor="telegram-mode" className="text-sm">Mode</Label>
                <select
                  id="telegram-mode"
                  value={mode}
                  onChange={(e) => saveMode(e.target.value as TelegramMode)}
                  disabled={isBusy}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="auto">Auto (recommended)</option>
                  <option value="webhook">Webhook</option>
                  <option value="polling">Long Polling</option>
                </select>
              </div>
              <div className="flex-1">
                <Label className="text-sm">Active Mode</Label>
                <div className="mt-1 flex items-center gap-2 text-sm">
                  {effectiveMode === "webhook" ? (
                    <>
                      <Globe className="size-4 text-blue-500" />
                      <span>Webhook</span>
                    </>
                  ) : (
                    <>
                      <Radio className="size-4 text-green-500" />
                      <span>Long Polling</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {mode === "auto" && (
              <div className="rounded-md border bg-muted/20 p-3 text-sm">
                <p className="text-muted-foreground">
                  <strong>Auto mode:</strong>{" "}
                  {detectedMode === "webhook"
                    ? "Webhook will be used when a public HTTPS URL is configured."
                    : "Long polling is active. Add a public HTTPS URL to switch to webhook."}
                </p>
              </div>
            )}

            {/* Webhook URL Input - only show when webhook mode is active */}
            {effectiveMode === "webhook" && (
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <Label htmlFor="telegram-public-base-url">Public Base URL (HTTPS required)</Label>
                <Input
                  id="telegram-public-base-url"
                  type="text"
                  value={publicBaseUrl}
                  onChange={(e) => {
                    const newUrl = e.target.value;
                    setPublicBaseUrl(newUrl);
                    const detected = detectUrlMode(newUrl);
                    setDetectedMode(detected);
                  }}
                  placeholder="https://your-public-host.example.com"
                  disabled={isBusy}
                />
                <p className="text-xs text-muted-foreground">
                  Webhook endpoint:{" "}
                  <span className="font-mono">{publicBaseUrl || "https://..."}/api/integrations/telegram</span>
                </p>
                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <Button
                    onClick={connectTelegram}
                    disabled={!publicBaseUrl.trim() || isBusy}
                    size="sm"
                  >
                    {connectState === "loading" ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Connecting...
                      </>
                    ) : (
                      <>
                        <Link2 className="size-4" />
                        Setup Webhook
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* Polling Controls - only show when polling mode is active */}
            {effectiveMode === "polling" && (
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">Long Polling</p>
                    <p className="text-xs text-muted-foreground">
                      Bot will receive messages via long polling (no HTTPS required).
                    </p>
                  </div>
                  {!pollingStatus?.polling?.isRunning ? (
                    <Button
                      variant="outline"
                      onClick={startPolling}
                      disabled={isBusy}
                      size="sm"
                    >
                      {pollingState === "loading" ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Starting...
                        </>
                      ) : (
                        <>
                          <Play className="size-4" />
                          Start Polling
                        </>
                      )}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={stopPolling}
                      disabled={isBusy}
                      size="sm"
                    >
                      {pollingState === "loading" ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Stopping...
                        </>
                      ) : (
                        <>
                          <Square className="size-4" />
                          Stop Polling
                        </>
                      )}
                    </Button>
                  )}
                </div>

                {pollingStatus?.polling && (
                  <div className="text-sm space-y-1 pt-2 border-t">
                    <div className="flex items-center gap-2">
                      Status:{" "}
                      {pollingStatus.polling.isRunning ? (
                        <span className="flex items-center gap-1 text-green-600">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                          </span>
                          Running
                        </span>
                      ) : (
                        <span className="text-gray-500">Stopped</span>
                      )}
                    </div>
                    {pollingStatus.polling.lastUpdateId !== null && (
                      <div className="text-xs text-muted-foreground">
                        Last update ID: {pollingStatus.polling.lastUpdateId}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Connected Status */}
      {hasTokenConfigured && (
        <section className="rounded-lg border bg-card p-4 space-y-4">
          <div className="space-y-1">
            <h4 className="font-medium">Connection Status</h4>
          </div>

          <div className="rounded-md border bg-muted/20 p-3 text-sm space-y-1">
            <div>
              Token: {sourceLabel(tokenSource)}
              {storedMaskedToken ? ` (${storedMaskedToken})` : ""}
            </div>
            {publicBaseUrl && (
              <div>
                Public Base URL:{" "}
                <span className="font-mono text-xs break-all">{publicBaseUrl}</span>
              </div>
            )}
            <div>
              Mode: <span className="font-medium">{effectiveMode === "webhook" ? "Webhook" : "Long Polling"}</span>
            </div>
            {updatedAtLabel && (
              <div className="text-xs text-muted-foreground">Updated: {updatedAtLabel}</div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
                  Disconnect
                </>
              )}
            </Button>
          </div>
        </section>
      )}

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

      {success && <p className="text-sm text-emerald-600">{success}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
