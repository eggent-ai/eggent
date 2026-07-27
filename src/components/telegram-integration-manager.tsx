"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Loader2, Link2, ShieldCheck, Trash2, Play, Square, Radio, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";

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

function sourceLabel(source: "stored" | "env" | "none", t: (key: MessageKey) => string): string {
  if (source === "stored") return t("telegram.source.stored");
  if (source === "env") return t("telegram.source.env");
  return t("telegram.source.none");
}

export function TelegramIntegrationManager() {
  const { t } = useI18n();
  const [botToken, setBotToken] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [storedMaskedToken, setStoredMaskedToken] = useState("");
  const [tokenSource, setTokenSource] = useState<"stored" | "env" | "none">(
    "none"
  );
  const [mode, setMode] = useState<TelegramMode>("polling");
  const [detectedMode, setDetectedMode] = useState<"webhook" | "polling">("polling");

  // Helper to detect if URL is localhost/private (needs polling) or public (can use webhook)
  const detectUrlMode = useCallback((url: string): "webhook" | "polling" => {
    const normalized = url.trim();
    if (!normalized) return "polling";

    try {
      const parsed = new URL(normalized);
      const hostname = parsed.hostname.toLowerCase();
      if (parsed.protocol !== "https:") return "polling";

      if (
        hostname === "localhost" ||
        hostname === "::1" ||
        hostname.endsWith(".local")
      ) {
        return "polling";
      }

      const octets = hostname.split(".").map((part) => Number(part));
      if (
        octets.length === 4 &&
        octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
      ) {
        const [first, second] = octets;
        if (
          first === 10 ||
          first === 127 ||
          (first === 192 && second === 168) ||
          (first === 172 && second >= 16 && second <= 31)
        ) {
          return "polling";
        }
      }

      return "webhook";
    } catch {
      return "polling";
    }
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
        throw new Error(data.error || t("telegram.errors.loadSettings"));
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
      setError(e instanceof Error ? e.message : t("telegram.errors.loadSettings"));
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
        throw new Error(t("telegram.errors.startPolling"));
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
        throw new Error(t("telegram.botToken.required"));
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
        throw new Error(saveConfigData.error || t("telegram.errors.saveSettings"));
      }

      const setupRes = await fetch("/api/integrations/telegram/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken: trimmedToken,
          mode: "webhook",
        }),
      });
      const setupData = (await setupRes.json()) as {
        success?: boolean;
        message?: string;
        error?: string;
      };
      if (!setupRes.ok) {
        throw new Error(setupData.error || t("telegram.errors.connect"));
      }

      setSuccess(setupData.message || t("telegram.webhookConfigured"));
      setBotToken("");
      await loadSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("telegram.errors.connect"));
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
        throw new Error(data.error || t("telegram.errors.disconnect"));
      }

      const messages = [data.message || t("telegram.disconnected")];
      if (data.webhookWarning) messages.push(t("telegram.webhookWarning", { warning: data.webhookWarning }));
      if (data.note) messages.push(data.note);
      setSuccess(messages.join(" "));

      setBotToken("");
      await loadSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("telegram.errors.disconnect"));
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
        throw new Error(data.error || t("telegram.errors.saveAllowedUsers"));
      }
      setAllowedUserIdsInput((data.allowedUserIds || []).join(", "));
      setPendingAccessCodes(
        typeof data.pendingAccessCodes === "number" ? data.pendingAccessCodes : 0
      );
      setSuccess(t("telegram.allowedUsersUpdated"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("telegram.errors.saveAllowedUsers"));
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
        throw new Error(data.error || t("telegram.errors.generateAccessCode"));
      }

      setGeneratedAccessCode(data.code);
      setGeneratedAccessCodeExpiresAt(
        typeof data.expiresAt === "string" ? data.expiresAt : null
      );
      setSuccess(t("telegram.accessCodeGenerated"));
      await loadSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("telegram.errors.generateAccessCode"));
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
        throw new Error(data.error || t("telegram.errors.startPolling"));
      }
      setSuccess(data.message || t("telegram.pollingStarted"));
      await loadPollingStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("telegram.errors.startPolling"));
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
        throw new Error(data.error || t("telegram.errors.stopPolling"));
      }
      setSuccess(data.message || t("telegram.pollingStopped"));
      await loadPollingStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("telegram.errors.stopPolling"));
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
        throw new Error(data.error || t("telegram.errors.saveMode"));
      }
      setMode(data.mode || "auto");
      setDetectedMode(data.detectedMode || "polling");
      setSuccess(t("telegram.modeUpdated", { mode: newMode }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("telegram.errors.saveMode"));
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
          <h3 className="text-lg font-medium">{t("telegram.botToken.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("telegram.botToken.description")}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="telegram-bot-token">{t("telegram.botToken.label")}</Label>
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
              {t("telegram.botToken.saved", { source: sourceLabel(tokenSource, t) })}
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
                  setError(t("telegram.botToken.required"));
                  return;
                }
                setConnectState("loading");
                setError(null);
                try {
                  const res = await fetch("/api/integrations/telegram/setup", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ botToken: trimmedToken, mode: "polling" }),
                  });
                  const data = (await res.json()) as {
                    error?: string;
                    message?: string;
                    botLink?: string | null;
                  };
                  if (!res.ok) {
                    throw new Error(data.error || t("telegram.errors.activate"));
                  }
                  setSuccess(data.botLink ? `${data.message || t("telegram.longPollingStarted")} ${data.botLink}` : data.message || t("telegram.longPollingStarted"));
                  setBotToken("");
                  await loadSettings();
                  await loadPollingStatus();
                } catch (e) {
                  setError(e instanceof Error ? e.message : t("telegram.errors.activate"));
                } finally {
                  setConnectState("idle");
                }
              }}
              disabled={!botToken.trim() || isBusy}
            >
              {connectState === "loading" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("telegram.activating")}
                </>
              ) : (
                <>
                  <Link2 className="size-4" />
                  {t("telegram.activate")}
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
            <h3 className="text-lg font-medium">{t("telegram.connectionMode.title")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("telegram.connectionMode.description")}
            </p>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Label htmlFor="telegram-mode" className="text-sm">{t("telegram.mode")}</Label>
                <select
                  id="telegram-mode"
                  value={mode}
                  onChange={(e) => saveMode(e.target.value as TelegramMode)}
                  disabled={isBusy}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="polling">{t("telegram.mode.pollingRecommended")}</option>
                  <option value="auto">{t("telegram.mode.auto")}</option>
                  <option value="webhook">{t("telegram.mode.webhook")}</option>
                </select>
              </div>
              <div className="flex-1">
                <Label className="text-sm">{t("telegram.activeMode")}</Label>
                <div className="mt-1 flex items-center gap-2 text-sm">
                  {effectiveMode === "webhook" ? (
                    <>
                      <Globe className="size-4 text-blue-500" />
                      <span>{t("telegram.mode.webhook")}</span>
                    </>
                  ) : (
                    <>
                      <Radio className="size-4 text-green-500" />
                      <span>{t("telegram.mode.polling")}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {mode === "auto" && (
              <div className="rounded-md border bg-muted/20 p-3 text-sm">
                <p className="text-muted-foreground">
                  <strong>{t("telegram.autoMode")}</strong>{" "}
                  {detectedMode === "webhook"
                    ? t("telegram.autoWebhook")
                    : t("telegram.autoPolling")}
                </p>
              </div>
            )}

            {/* Webhook URL Input - only show when webhook mode is active */}
            {effectiveMode === "webhook" && (
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <Label htmlFor="telegram-public-base-url">{t("telegram.publicBaseUrl")}</Label>
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
                  {t("telegram.webhookEndpoint")} 
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
                        {t("telegram.connecting")}
                      </>
                    ) : (
                      <>
                        <Link2 className="size-4" />
                        {t("telegram.setupWebhook")}
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
                    <p className="font-medium text-sm">{t("telegram.mode.polling")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("telegram.polling.description")}
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
                          {t("telegram.starting")}
                        </>
                      ) : (
                        <>
                          <Play className="size-4" />
                          {t("telegram.startPolling")}
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
                          {t("telegram.stopping")}
                        </>
                      ) : (
                        <>
                          <Square className="size-4" />
                          {t("telegram.stopPolling")}
                        </>
                      )}
                    </Button>
                  )}
                </div>

                {pollingStatus?.polling && (
                  <div className="text-sm space-y-1 pt-2 border-t">
                    <div className="flex items-center gap-2">
                      {t("telegram.status")} 
                      {pollingStatus.polling.isRunning ? (
                        <span className="flex items-center gap-1 text-green-600">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                          </span>
                          {t("telegram.running")}
                        </span>
                      ) : (
                        <span className="text-gray-500">{t("telegram.stopped")}</span>
                      )}
                    </div>
                    {pollingStatus.polling.lastUpdateId !== null && (
                      <div className="text-xs text-muted-foreground">
                        {t("telegram.lastUpdateId", { id: pollingStatus.polling.lastUpdateId })}
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
            <h4 className="font-medium">{t("telegram.connectionStatus")}</h4>
          </div>

          <div className="rounded-md border bg-muted/20 p-3 text-sm space-y-1">
            <div>
              {t("telegram.token")} {sourceLabel(tokenSource, t)}
              {storedMaskedToken ? ` (${storedMaskedToken})` : ""}
            </div>
            {publicBaseUrl && (
              <div>
                {t("telegram.publicBaseUrlShort")} 
                <span className="font-mono text-xs break-all">{publicBaseUrl}</span>
              </div>
            )}
            <div>
              {t("telegram.mode")}: <span className="font-medium">{effectiveMode === "webhook" ? t("telegram.mode.webhook") : t("telegram.mode.polling")}</span>
            </div>
            {updatedAtLabel && (
              <div className="text-xs text-muted-foreground">{t("telegram.updated", { date: updatedAtLabel })}</div>
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
                  {t("telegram.disconnecting")}
                </>
              ) : (
                <>
                  <Trash2 className="size-4" />
                  {t("telegram.disconnect")}
                </>
              )}
            </Button>
          </div>
        </section>
      )}

      <section className="rounded-lg border bg-card p-4 space-y-4">
        <div className="space-y-1">
          <h4 className="font-medium">{t("telegram.accessControl")}</h4>
          <p className="text-sm text-muted-foreground">
            {t("telegram.accessDescription")}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="telegram-allowed-user-ids">{t("telegram.allowedUserIds")}</Label>
          <Input
            id="telegram-allowed-user-ids"
            type="text"
            value={allowedUserIdsInput}
            onChange={(e) => setAllowedUserIdsInput(e.target.value)}
            placeholder="123456789, 987654321"
            disabled={isBusy}
          />
          <p className="text-xs text-muted-foreground">
            {t("telegram.separatorHelp")}
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
                {t("common.saving")}
              </>
            ) : (
              <>
                <ShieldCheck className="size-4" />
                {t("telegram.saveAllowlist")}
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
                {t("telegram.generating")}
              </>
            ) : (
              <>
                <KeyRound className="size-4" />
                {t("telegram.generateAccessCode")}
              </>
            )}
          </Button>
        </div>

        <div className="rounded-md border bg-muted/20 p-3 text-sm space-y-1">
          <div>{t("telegram.pendingCodes", { count: pendingAccessCodes })}</div>
          {generatedAccessCode && (
            <div>
              {t("telegram.latestCode")} <span className="font-mono">{generatedAccessCode}</span>
            </div>
          )}
          {generatedAccessCodeExpiresAt && (
            <div className="text-xs text-muted-foreground">
              {t("telegram.expiresAt", { date: new Date(generatedAccessCodeExpiresAt).toLocaleString() })}
            </div>
          )}
        </div>
      </section>

      {success && <p className="text-sm text-emerald-600">{success}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
