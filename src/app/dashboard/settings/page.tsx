"use client";

import { useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SettingsNavigation } from "@/components/settings-navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Check, ExternalLink, KeyRound, Loader2, LogOut, Moon, PlugZap, Save, ShieldCheck, Sun } from "lucide-react";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
import { LOCALE_OPTIONS, normalizeLocalePreference, type LocalePreference } from "@/i18n/locales";
import { useI18n } from "@/i18n/provider";
import type { AppSettings } from "@/lib/types";

interface PiProviderState {
  id: string;
  name?: string;
  stored: boolean;
  credentialType?: "api_key" | "oauth";
  modelCount: number;
  availableModelCount: number;
  auth?: { configured?: boolean; source?: string; label?: string };
}

interface PiOAuthProviderState {
  id: string;
  name: string;
  usesCallbackServer?: boolean;
}

interface PiApiKeyProviderState {
  id: string;
  name?: string;
  auth?: { configured?: boolean; source?: string; label?: string };
}

interface PiCredentialState {
  provider: string;
  providerName?: string;
  type: "api_key" | "oauth";
  auth?: { configured?: boolean; source?: string; label?: string };
}

interface PiModelState {
  provider: string;
  id: string;
  name?: string;
  available: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

interface PiState {
  agentDir: string;
  authFile: string;
  modelsFile: string;
  settings?: {
    settingsFile: string;
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
  };
  current?: {
    provider?: string;
    providerName?: string;
    model?: PiModelState;
    auth?: { configured?: boolean; source?: string; label?: string };
    credentialType?: "api_key" | "oauth";
    stored?: boolean;
  } | null;
  oauthProviders: PiOAuthProviderState[];
  apiKeyProviders: PiApiKeyProviderState[];
  credentials: PiCredentialState[];
  providers: PiProviderState[];
  models: PiModelState[];
  availableModels: PiModelState[];
  modelLock?: {
    locked: boolean;
    label: string;
    enforced?: boolean;
    selfHostedUrl?: string;
  };
  managed?: {
    available: boolean;
    providerId?: string | null;
    label?: string;
  };
  imageGeneration?: {
    enabled: boolean;
    provider: "eggent" | "custom" | "none";
    label: string;
    providerId?: string;
    model?: string;
    reason?: string;
  };
  imageProviders?: Array<{ id: string; name: string }>;
}

type LoginEvent =
  | { id: string; type: "auth_url"; url: string; instructions?: string }
  | { id: string; type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { id: string; type: "progress"; message: string }
  | { id: string; type: "prompt"; promptId: string; message: string; placeholder?: string; allowEmpty?: boolean; manualCode?: boolean }
  | { id: string; type: "select"; promptId: string; message: string; options: Array<{ id: string; label: string }> }
  | { id: string; type: "completed" }
  | { id: string; type: "error"; message: string };

interface LoginJobState {
  id: string;
  provider: string;
  status: "running" | "completed" | "error" | "cancelled";
  error?: string;
  events: LoginEvent[];
}

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** How long to wait for a provider login before treating it as abandoned. */
const OAUTH_POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** Consecutive failed polls tolerated before giving up on the login. */
const OAUTH_POLL_MAX_FAILURES = 5;

export default function SettingsPage() {
  const { setLocalePreference, t } = useI18n();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [piState, setPiState] = useState<PiState | null>(null);
  const [modelsJson, setModelsJson] = useState("");
  const [modelsJsonSaved, setModelsJsonSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [piLoading, setPiLoading] = useState(true);
  const [piError, setPiError] = useState<string | null>(null);
  const [piNotice, setPiNotice] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [returningToManaged, setReturningToManaged] = useState(false);
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [savingProvider, setSavingProvider] = useState(false);
  const [oauthSaving, setOauthSaving] = useState(false);
  const [oauthJob, setOauthJob] = useState<LoginJobState | null>(null);
  const [promptInputs, setPromptInputs] = useState<Record<string, string>>({});
  const [answeredPrompts, setAnsweredPrompts] = useState<Record<string, true>>({});
  const [savingModelsJson, setSavingModelsJson] = useState(false);
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);
  const [defaultProviderSelection, setDefaultProviderSelection] = useState("");
  const [defaultModelSelection, setDefaultModelSelection] = useState("");
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState("high");
  const [imageProviderSelection, setImageProviderSelection] = useState("");
  const [imageModelSelection, setImageModelSelection] = useState("");
  const [savingImageBackend, setSavingImageBackend] = useState(false);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [authSaving, setAuthSaving] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSaved, setAuthSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((response) => response.json()),
      loadPiState(),
    ])
      .then(([data]) => {
        setSettings(data);
        if (data?.auth?.username && typeof data.auth.username === "string") {
          setAuthUsername(data.auth.username);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const oauthJobId = oauthJob?.id;
  const oauthJobStatus = oauthJob?.status;

  useEffect(() => {
    if (!oauthJobId || oauthJobStatus !== "running") return;

    // This runs once a second, so every way out of "running" has to stop it.
    // Reporting an error and carrying on left the tab polling for as long as it
    // stayed open — one workspace sent 950 of these in a day — and a provider
    // login the person abandoned halfway never resolves at all.
    const startedAt = Date.now();
    let failures = 0;
    let timer: number | null = null;

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const giveUp = (message?: string) => {
      stop();
      setPiError(message || t("settings.errors.pollProviderLogin"));
    };

    timer = window.setInterval(async () => {
      if (Date.now() - startedAt > OAUTH_POLL_TIMEOUT_MS) {
        giveUp();
        return;
      }
      try {
        const res = await fetch(`/api/pi/auth/login?id=${encodeURIComponent(oauthJobId)}`, { cache: "no-store" });
        const json = await res.json().catch(() => null) as LoginJobState | { error?: string } | null;
        if (!res.ok || !json || ("error" in json && !("status" in json))) {
          failures += 1;
          // A single blip mid-login is not worth losing the flow over.
          if (failures >= OAUTH_POLL_MAX_FAILURES) giveUp(json?.error);
          return;
        }
        failures = 0;
        const next = json as LoginJobState;
        setOauthJob(next);
        if (next.status !== "running") {
          stop();
          await loadPiState();
        }
      } catch {
        failures += 1;
        if (failures >= OAUTH_POLL_MAX_FAILURES) giveUp();
      }
    }, 1000);

    return stop;
  }, [oauthJobId, oauthJobStatus]);

  const darkMode = settings?.general.darkMode ?? false;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  async function loadPiState() {
    try {
      setPiLoading(true);
      setPiError(null);
      const [stateRes, rawRes] = await Promise.all([
        fetch("/api/pi/models", { cache: "no-store" }),
        fetch("/api/pi/models?raw=1", { cache: "no-store" }),
      ]);
      const [stateJson, rawJson] = await Promise.all([stateRes.json(), rawRes.json()]);
      if (!stateRes.ok) throw new Error(stateJson.error || t("settings.errors.loadModels"));
      setPiState(stateJson);
      const defaultProvider = typeof stateJson?.settings?.defaultProvider === "string" ? stateJson.settings.defaultProvider : "";
      const defaultModel = typeof stateJson?.settings?.defaultModel === "string" ? stateJson.settings.defaultModel : "";
      const availablePiModels = Array.isArray(stateJson?.availableModels) ? stateJson.availableModels as PiModelState[] : [];
      const defaultProviderHasModels = Boolean(defaultProvider && availablePiModels.some((model) => model.provider === defaultProvider));
      // Nothing is preselected when the workspace has no default provider.
      // Falling back to the first available one put the included model back in
      // the box right after someone had deliberately disconnected it, which read
      // as "it is still on" and made the screen look like it ignored the click.
      const providerSelection = defaultProviderHasModels ? defaultProvider : "";
      const firstProviderModel = availablePiModels.find((model) => model.provider === providerSelection);
      setDefaultProviderSelection(providerSelection);
      setDefaultModelSelection(defaultProviderHasModels && defaultModel ? defaultModel : firstProviderModel?.id || "");
      const imageBackend = stateJson?.imageGeneration as { providerId?: string; model?: string; provider?: string } | undefined;
      setImageProviderSelection(imageBackend?.provider === "custom" ? imageBackend.providerId || "" : "");
      setImageModelSelection(imageBackend?.provider === "custom" ? imageBackend.model || "" : "");
      setDefaultThinkingLevel(typeof stateJson?.settings?.defaultThinkingLevel === "string" ? stateJson.settings.defaultThinkingLevel : "high");
      const raw = typeof rawJson.content === "string" ? rawJson.content : "";
      setModelsJson(raw);
      setModelsJsonSaved(raw);
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.loadModelConnections"));
    } finally {
      setPiLoading(false);
    }
  }

  /**
   * Saves everything the page is holding, not just the general settings.
   *
   * The model lives in a different store behind its own button, so a user who
   * picked a model and pressed the page's main Save button got a green
   * confirmation for settings that never included their model. Whichever button
   * is pressed, a pending model choice is written too - and if it cannot be
   * written, the error is shown instead of the success tick.
   */
  async function handleSaveSettings() {
    if (!settings) return;
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (modelSelectionDirty) {
      const savedModel = await saveDefaultModel();
      if (!savedModel) return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function updateSettings(path: string, value: unknown) {
    setSettings((prev) => (prev ? updateSettingsByPath(prev, path, value) : prev));
  }

  function updateLanguage(value: LocalePreference) {
    updateSettings("general.language", value);
    setLocalePreference(value);
    window.dispatchEvent(new CustomEvent("eggent:locale-change", { detail: { preference: value } }));
  }

  async function saveProviderKey() {
    const providerId = defaultProviderSelection.trim();
    if (!providerId || !apiKey.trim()) return;
    let env: Record<string, string> | undefined;
    if (apiKeyEnv.trim()) {
      try {
        const parsed = JSON.parse(apiKeyEnv) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        env = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>;
      } catch {
        setPiError(t("settings.errors.providerEnvJson"));
        return;
      }
    }
    try {
      setSavingProvider(true);
      setPiError(null);
      const res = await fetch("/api/pi/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, apiKey: apiKey.trim(), env }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.errors.saveProviderKey"));
      setApiKey("");
      setApiKeyEnv("");
      setPiState(json);
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.saveProviderKey"));
    } finally {
      setSavingProvider(false);
    }
  }

  /**
   * Save which provider and model answer image requests.
   *
   * Only reachable on a workspace running its own model: while the included
   * model is active it serves images too, so there is nothing to choose.
   */
  async function saveImageBackend(clear = false) {
    try {
      setSavingImageBackend(true);
      setPiError(null);
      const res = await fetch("/api/pi/images", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clear ? {} : { provider: imageProviderSelection, model: imageModelSelection }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t("settings.errors.saveImageBackend"));
      setPiState(json);
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.saveImageBackend"));
    } finally {
      setSavingImageBackend(false);
    }
  }

  async function returnToEggentAi() {
    try {
      setReturningToManaged(true);
      setPiError(null);
      setPiNotice(null);
      const res = await fetch("/api/pi/auth/eggent", { method: "POST" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t("settings.errors.returnToManaged"));
      setPiState(json);
      // Say so when the included model had to be written back into models.json:
      // the user is looking at that file in the editor below, and a silent
      // rewrite of what they are editing is worse than a sentence about it.
      const repair = json?.repair as { repaired?: boolean; backupPath?: string } | undefined;
      if (repair?.backupPath) {
        setPiNotice(t("settings.managedRepairedFromBroken", { path: repair.backupPath }));
      } else if (repair?.repaired) {
        setPiNotice(t("settings.managedRepaired"));
      }
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.returnToManaged"));
    } finally {
      setReturningToManaged(false);
    }
  }

  async function logoutProvider(providerId: string) {
    const message = providerId === "eggent-ai"
      ? t("settings.logoutEggentAiConfirm")
      : `Log out from ${providerId}? Stored credentials will be removed.`;
    if (!confirm(message)) return;
    const res = await fetch(`/api/pi/auth?provider=${encodeURIComponent(providerId)}`, { method: "DELETE" });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setPiError(json?.error || t("settings.errors.logoutProvider"));
      return;
    }
    setPiState(json);
    await loadPiState();
  }

  async function startOAuthLogin() {
    const providerId = defaultProviderSelection.trim();
    if (!providerId) return;
    try {
      setOauthSaving(true);
      setPiError(null);
      setOauthJob(null);
      setPromptInputs({});
      setAnsweredPrompts({});
      const res = await fetch("/api/pi/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.errors.startProviderLogin"));
      setOauthJob(json);
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.startProviderLogin"));
    } finally {
      setOauthSaving(false);
    }
  }

  async function answerLoginPrompt(promptId: string, value: string) {
    if (!oauthJob) return;
    const res = await fetch("/api/pi/auth/login", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: oauthJob.id, promptId, value }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setPiError(json?.error || t("settings.errors.answerLoginPrompt"));
      return;
    }
    setAnsweredPrompts((prev) => ({ ...prev, [promptId]: true }));
    setOauthJob(json);
  }

  async function cancelOAuthLogin() {
    if (!oauthJob) return;
    await fetch(`/api/pi/auth/login?id=${encodeURIComponent(oauthJob.id)}`, { method: "DELETE" }).catch(() => null);
    setOauthJob((prev) => prev ? { ...prev, status: "cancelled", error: t("common.cancel") } : prev);
  }

  function handleDefaultProviderChange(providerId: string) {
    setDefaultProviderSelection(providerId);
    const firstModel = (piState?.availableModels ?? [])
      .filter((model) => model.provider === providerId)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    setDefaultModelSelection(firstModel?.id || "");
  }

  async function saveDefaultModel(): Promise<boolean> {
    const providerId = defaultProviderSelection.trim();
    const modelId = defaultModelSelection.trim();
    if (!providerId || !modelId) return false;
    try {
      setSavingDefaultModel(true);
      setPiError(null);
      const res = await fetch("/api/pi/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, model: modelId, thinkingLevel: defaultThinkingLevel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.errors.saveDefaultModel"));
      await loadPiState();
      return true;
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.saveDefaultModel"));
      return false;
    } finally {
      setSavingDefaultModel(false);
    }
  }

  async function saveModelsJson() {
    try {
      setSavingModelsJson(true);
      setPiError(null);
      const res = await fetch("/api/pi/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: modelsJson }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.errors.saveModelsJson"));
      const next = typeof json.content === "string" ? json.content : modelsJson;
      setModelsJson(next);
      setModelsJsonSaved(next);
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.saveModelsJson"));
    } finally {
      setSavingModelsJson(false);
    }
  }

  async function handleUpdateAuth() {
    const username = authUsername.trim();
    const password = authPassword.trim();
    const passwordConfirm = authPasswordConfirm.trim();

    if (!username) return setAuthError(t("projects.errors.usernameRequired"));
    if (password.length < 8) return setAuthError(t("projects.errors.passwordMin"));
    if (password !== passwordConfirm) return setAuthError(t("projects.errors.passwordMismatch"));

    try {
      setAuthSaving(true);
      setAuthError(null);
      setAuthSaved(false);
      const response = await fetch("/api/auth/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; username?: string } | null;
      if (!response.ok) throw new Error(payload?.error || t("settings.errors.updateCredentials"));
      setAuthUsername(payload?.username || username);
      setAuthPassword("");
      setAuthPasswordConfirm("");
      setAuthSaved(true);
      setTimeout(() => setAuthSaved(false), 2000);
      setSettings((prev) => prev ? { ...prev, auth: { ...prev.auth, username: payload?.username || username, mustChangeCredentials: false } } : prev);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : t("settings.errors.updateCredentials"));
    } finally {
      setAuthSaving(false);
    }
  }

  // The included model is deliberately absent from this list. It is not a
  // provider you connect - coming back to it is one button of its own at the
  // bottom - and leaving it in meant the same action appeared twice on one
  // screen, in a list the user had just used to walk away from it.
  const providerChoices = useMemo(() => {
    const managedId = piState?.managed?.providerId || "eggent-ai";
    return (piState?.providers ?? [])
      .filter((item) => piState?.modelLock?.locked || item.id !== managedId)
      .map((item) => ({ id: item.id, name: item.name || item.id, availableModelCount: item.availableModelCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [piState]);

  const imageProviderChoices = useMemo(() => piState?.imageProviders ?? [], [piState]);

  const modelChoices = useMemo(() => {
    return (piState?.availableModels ?? [])
      .filter((model) => model.provider === defaultProviderSelection)
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [defaultProviderSelection, piState]);
  const modelsJsonDirty = modelsJson !== modelsJsonSaved;
  const currentCredential = piState?.current?.provider
    ? piState.credentials.find((item) => item.provider === piState.current?.provider)
    : undefined;
  const selectedProviderState = piState?.providers.find((item) => item.id === defaultProviderSelection);
  const selectedOauthProvider = piState?.oauthProviders.find((item) => item.id === defaultProviderSelection);
  const selectedApiKeyProvider = piState?.apiKeyProviders.find((item) => item.id === defaultProviderSelection);
  const selectedProviderName = selectedProviderState?.name || selectedOauthProvider?.name || selectedApiKeyProvider?.name || defaultProviderSelection;
  const selectedProviderConnected = Boolean(defaultProviderSelection && modelChoices.length > 0);
  const selectedProviderHasStoredCredential = Boolean(piState?.credentials.some((item) => item.provider === defaultProviderSelection));
  const managedProviderId = piState?.managed?.providerId || "";
  const managedLabel = piState?.managed?.label || piState?.modelLock?.label || "Eggent AI";
  // Offered only when the credential is actually there and is not already in use.
  const managedAvailable = Boolean(piState?.managed?.available) && piState?.settings?.defaultProvider !== managedProviderId;
  // True while the page holds a model choice the server does not have yet.
  const modelSelectionDirty = Boolean(defaultProviderSelection && defaultModelSelection) && (
    piState?.settings?.defaultProvider !== defaultProviderSelection ||
    piState?.settings?.defaultModel !== defaultModelSelection ||
    piState?.settings?.defaultThinkingLevel !== defaultThinkingLevel
  );
  const currentModelIsAvailable = Boolean(piState?.current?.model?.available);
  const modelLocked = Boolean(piState?.modelLock?.locked);
  const modelLockLabel = piState?.modelLock?.label || "Eggent AI";
  const modelLockEnforced = Boolean(piState?.modelLock?.enforced);
  const modelLockSelfHostedUrl = piState?.modelLock?.selfHostedUrl || "https://github.com/eggent-ai/eggent";
  const eggentImagesEnabled = Boolean(piState?.imageGeneration?.enabled);

  if (loading || !settings) {
    return (
      <div className="[--header-height:calc(--spacing(14))]">
        <SidebarProvider className="flex flex-col">
          <SiteHeader title={t("settings.title")} />
          <div className="flex flex-1"><AppSidebar /><SidebarInset><div className="flex flex-1 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div></SidebarInset></div>
        </SidebarProvider>
      </div>
    );
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("settings.title")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto p-4 md:p-6">
              <SettingsNavigation />

              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">{t("settings.title")}</h2>
                  <p className="text-sm text-muted-foreground">{t("settings.description")}</p>
                </div>
                <Button onClick={handleSaveSettings} className="gap-2">
                  {saved ? <Check className="size-4" /> : <Save className="size-4" />}
                  {saved ? t("settings.saved") : t("settings.save")}
                </Button>
              </div>

              <section className="rounded-xl border bg-card p-5 space-y-5">
                <div className="flex items-center gap-2">
                  <PlugZap className="size-5 text-primary" />
                  <h3 className="text-lg font-semibold">{t("settings.models.title")}</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t("settings.models.description")}
                </p>
                {piError ? (
                  <Alert variant="destructive">
                    <AlertDescription>{piError}</AlertDescription>
                  </Alert>
                ) : null}
                {piNotice ? (
                  <Alert>
                    <AlertDescription>{piNotice}</AlertDescription>
                  </Alert>
                ) : null}

                {piLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading providers...</div> : null}

                {/* What is answering right now. One statement, no actions: every
                    action lives in the numbered steps below, so there is exactly
                    one place to disconnect a provider. */}
                {currentModelIsAvailable || modelLocked ? (
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <div className="text-xs font-mono text-muted-foreground">{t("settings.activeNow")}</div>
                    <h4 className="font-medium">{modelLocked ? modelLockLabel : (piState?.current?.providerName || piState?.current?.provider)}</h4>
                    <p className="text-sm text-muted-foreground">
                      {modelLocked ? t("settings.modelLock.includedCredits") : (
                        <>
                          <span className="font-mono">{piState?.current?.model?.id}</span>
                          {currentCredential?.type ? ` · ${currentCredential.type === "oauth" ? t("settings.authOauth") : t("settings.authApiKey")}` : ""}
                          {piState?.settings?.defaultThinkingLevel ? ` · ${t("settings.thinking")} ${piState.settings.defaultThinkingLevel}` : ""}
                        </>
                      )}
                    </p>
                  </div>
                ) : null}

                {modelLocked ? (
                  <div className="rounded-lg border p-4 space-y-3">
                    <p className="text-sm text-muted-foreground">
                      {modelLockEnforced
                        ? t("settings.modelLock.enforcedDescription", { label: modelLockLabel })
                        : t("settings.modelLock.switchAwayHint", { label: modelLockLabel })}
                    </p>
                    {modelLockEnforced ? (
                      <Button variant="outline" className="gap-2" asChild>
                        <a href={modelLockSelfHostedUrl} target="_blank" rel="noreferrer noopener">
                          <ExternalLink className="size-4" />
                          {t("settings.modelLock.selfHostedCta")}
                        </a>
                      </Button>
                    ) : (
                      <Button variant="outline" className="gap-2" onClick={() => logoutProvider("eggent-ai")}>
                        <KeyRound className="size-4" />
                        {t("settings.modelLock.useOwnProvider")}
                      </Button>
                    )}
                  </div>
                ) : null}

{!modelLocked ? <>
                {/* One card, in the order the work actually happens: pick a
                    provider, connect it, pick its model. Three separate cards
                    made a single decision look like three, and the model card
                    appearing out of nowhere further down was easy to miss. */}
                <div className="rounded-lg border p-4 space-y-4">
                  <div>
                    <h4 className="font-medium">{t("settings.textModel.title")}</h4>
                    <p className="text-xs text-muted-foreground">{t("settings.textModel.description")}</p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">{t("settings.chooseProvider")}</Label>
                    <Select
                      value={defaultProviderSelection}
                      onValueChange={handleDefaultProviderChange}
                      disabled={piLoading || providerChoices.length === 0}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t("settings.selectProvider")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {providerChoices.map((item) => (
                            <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Exactly one way to connect is shown: the sign-in button for
                      an OAuth provider, the key field for an API one. */}
                  {defaultProviderSelection ? (
                    <div className="space-y-3 border-t pt-4">
                      {selectedProviderConnected ? (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-emerald-600/30 bg-emerald-600/5 px-3 py-2">
                          <span className="text-sm text-emerald-700 dark:text-emerald-400">
                            {t("settings.providerConnectedBadge", { provider: selectedProviderName })}
                          </span>
                          {selectedProviderState?.stored ? (
                            <Button variant="ghost" size="sm" className="gap-2 text-destructive" onClick={() => logoutProvider(defaultProviderSelection)}>
                              <LogOut className="size-4" /> {t("settings.disconnect")}
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t("settings.providerDisconnectedDescription")}</p>
                      )}

                      {selectedOauthProvider && !selectedProviderConnected ? (
                        <Button onClick={startOAuthLogin} disabled={oauthSaving} className="gap-2">
                          {oauthSaving ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                          {t("settings.loginWithSubscription")}
                        </Button>
                      ) : null}

                      {selectedApiKeyProvider ? (
                        <div className="space-y-3">
                          <Label className="text-xs text-muted-foreground">
                            {selectedProviderHasStoredCredential ? t("settings.replaceKeyLabel") : t("settings.apiKeyLabel", { provider: selectedProviderName })}
                          </Label>
                          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                            <Input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder={t("settings.apiKeyPlaceholder", { provider: selectedProviderName })} />
                            <Button onClick={saveProviderKey} disabled={savingProvider || !apiKey.trim()} className="gap-2">
                              {savingProvider ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                              {selectedProviderHasStoredCredential ? t("settings.replaceKey") : t("settings.saveKey")}
                            </Button>
                          </div>
                          <details>
                            <summary className="cursor-pointer text-xs text-muted-foreground">{t("settings.providerEnvSummary")}</summary>
                            <Textarea value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} rows={4} className="mt-2 font-mono text-xs" placeholder={t("settings.providerEnvPlaceholder")} />
                          </details>
                        </div>
                      ) : null}

                      {!selectedOauthProvider && !selectedApiKeyProvider ? (
                        <p className="text-sm text-muted-foreground">{t("settings.noLoginMethod")}</p>
                      ) : null}
                    </div>
                  ) : null}

                  {oauthJob ? (
                    <div className="rounded-md border bg-muted/20 p-3 space-y-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div>{t("settings.status")} <span className="font-medium">{oauthJob.status}</span>{oauthJob.error ? <span className="text-destructive"> · {oauthJob.error}</span> : null}</div>
                        {oauthJob.status === "running" ? <Button size="sm" variant="outline" onClick={cancelOAuthLogin}>{t("common.cancel")}</Button> : null}
                      </div>
                      {oauthJob.events.map((event) => {
                        if (event.type === "auth_url") return <div key={event.id} className="space-y-1"><p>{event.instructions || t("settings.openAuthUrlInstruction")}</p><a href={event.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline"><ExternalLink className="size-3" />{t("settings.openAuthUrl")}</a><p className="break-all text-xs text-muted-foreground">{event.url}</p></div>;
                        if (event.type === "device_code") return <div key={event.id} className="rounded-md bg-background p-3"><p>{t("settings.deviceCodeInstruction", { url: event.verificationUri })}</p><div className="mt-2 font-mono text-lg font-semibold tracking-widest">{event.userCode}</div></div>;
                        if (event.type === "progress") return <p key={event.id} className="text-muted-foreground">{event.message}</p>;
                        if (event.type === "select" && oauthJob.status === "running" && !answeredPrompts[event.promptId]) return <div key={event.id} className="space-y-2"><p className="font-medium">{event.message}</p><div className="flex flex-wrap gap-2">{event.options.map((option) => <Button key={option.id} size="sm" variant="outline" onClick={() => answerLoginPrompt(event.promptId, option.id)}>{option.label}</Button>)}</div></div>;
                        if (event.type === "prompt" && oauthJob.status === "running" && !answeredPrompts[event.promptId]) return <div key={event.id} className="space-y-2"><Label>{event.message}</Label><div className="grid gap-2 md:grid-cols-[1fr_auto]"><Input value={promptInputs[event.promptId] || ""} placeholder={event.placeholder || ""} onChange={(inputEvent) => setPromptInputs((prev) => ({ ...prev, [event.promptId]: inputEvent.target.value }))} /><Button onClick={() => answerLoginPrompt(event.promptId, promptInputs[event.promptId] || "")} disabled={!event.allowEmpty && !promptInputs[event.promptId]?.trim()}>{t("settings.send")}</Button></div></div>;
                        if (event.type === "completed") return <p key={event.id} className="text-emerald-600">{t("settings.loginCompleted")}</p>;
                        if (event.type === "error") return <p key={event.id} className="text-destructive">{event.message}</p>;
                        return null;
                      })}
                    </div>
                  ) : null}

                  {/* Stays visible but inert until the provider above can serve a
                      model, so the last step is never a surprise. */}
                  <div className="space-y-2 border-t pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label className="text-xs text-muted-foreground">{t("settings.chooseModelLabel")}</Label>
                      {modelSelectionDirty ? (
                        <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
                          {t("settings.unsavedModel")}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="grid gap-3 md:grid-cols-[1fr_160px_auto]">
                      <Select value={defaultModelSelection} onValueChange={setDefaultModelSelection} disabled={!selectedProviderConnected}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={selectedProviderConnected ? t("settings.selectModel") : t("settings.selectProviderFirst")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {modelChoices.map((model) => (
                              <SelectItem key={`${model.provider}/${model.id}`} value={model.id}>
                                {model.id}{model.name && model.name !== model.id ? ` · ${model.name}` : ""}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <Select value={defaultThinkingLevel} onValueChange={setDefaultThinkingLevel} disabled={!selectedProviderConnected}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t("settings.thinking")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {thinkingLevels.map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <Button onClick={saveDefaultModel} disabled={savingDefaultModel || !defaultModelSelection || !selectedProviderConnected} className="gap-2">
                        {savingDefaultModel ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                        {t("settings.saveModel")}
                      </Button>
                    </div>
                  </div>
                </div>
                </> : null}

                {/* Images follow the text model. The included model covers both,
                    so there is nothing to configure while it is on; a workspace
                    on its own provider brings its own image model or has none. */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h4 className="font-medium">{t("settings.imageGeneration.title")}</h4>
                      <p className="text-xs text-muted-foreground">
                        {modelLocked
                          ? t("settings.imageGeneration.includedDescription", { label: modelLockLabel })
                          : t("settings.imageGeneration.ownDescription")}
                      </p>
                    </div>
                    <Badge variant={eggentImagesEnabled ? "secondary" : "outline"}>
                      {eggentImagesEnabled ? t("settings.imageGeneration.enabled") : t("settings.imageGeneration.unavailable")}
                    </Badge>
                  </div>

                  {!modelLocked ? (
                    <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                      <Select value={imageProviderSelection} onValueChange={setImageProviderSelection} disabled={imageProviderChoices.length === 0}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={imageProviderChoices.length === 0 ? t("settings.imageGeneration.noProviders") : t("settings.imageGeneration.selectProvider")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {imageProviderChoices.map((item) => (
                              <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <Input
                        value={imageModelSelection}
                        onChange={(event) => setImageModelSelection(event.target.value)}
                        placeholder={t("settings.imageGeneration.modelPlaceholder")}
                        disabled={!imageProviderSelection}
                      />
                      <div className="flex gap-2">
                        <Button onClick={() => saveImageBackend()} disabled={savingImageBackend || !imageProviderSelection || !imageModelSelection.trim()} className="gap-2">
                          {savingImageBackend ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                          {t("common.save")}
                        </Button>
                        {piState?.imageGeneration?.provider === "custom" ? (
                          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => saveImageBackend(true)} disabled={savingImageBackend}>
                            {t("settings.imageGeneration.clear")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* The way back, last, because it undoes everything above at
                    once. The managed credential survives leaving, so this is a
                    state change rather than a re-authentication. */}
                {!modelLocked && managedAvailable ? (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
                    <div>
                      <h4 className="font-medium">{t("settings.managedReturn.title", { label: managedLabel })}</h4>
                      <p className="text-sm text-muted-foreground">{t("settings.managedReturn.description", { label: managedLabel })}</p>
                    </div>
                    <Button variant="outline" className="gap-2" onClick={returnToEggentAi} disabled={returningToManaged}>
                      {returningToManaged ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                      {t("settings.managedReturn.cta", { label: managedLabel })}
                    </Button>
                  </div>
                ) : null}

                {!modelLocked ? (
                <details className="rounded-lg border p-4">
                  <summary className="cursor-pointer text-sm font-medium">{t("settings.advancedModelsSummary")}</summary>
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-mono text-muted-foreground">models.json</div>
                        <h4 className="font-medium">{t("settings.customProvidersTitle")}</h4>
                        <p className="text-xs text-muted-foreground">{t("settings.customProvidersDescription")}</p>
                      </div>
                      <Button size="sm" onClick={saveModelsJson} disabled={savingModelsJson || !modelsJsonDirty}>
                        {savingModelsJson ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                        {t("settings.saveModelsJson")}
                      </Button>
                    </div>
                    <Textarea value={modelsJson} onChange={(event) => setModelsJson(event.target.value)} rows={14} className="min-h-80 font-mono text-xs" />
                  </div>
                </details>
                ) : null}
              </section>

              <section className="rounded-xl border bg-card p-5 space-y-4">
                <h3 className="text-lg font-semibold">{t("settings.appearance.title")}</h3>
                <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                  <div><p className="text-sm font-medium">{t("settings.darkMode.title")}</p><p className="text-sm text-muted-foreground">{t("settings.darkMode.description")}</p></div>
                  <Label htmlFor="dark-mode-enabled" className="flex cursor-pointer items-center gap-2">
                    <Sun className="size-4 text-muted-foreground" />
                    <input id="dark-mode-enabled" type="checkbox" checked={settings.general.darkMode} onChange={(event) => updateSettings("general.darkMode", event.target.checked)} className="rounded" />
                    <Moon className="size-4 text-muted-foreground" />
                  </Label>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                  <div>
                    <p className="text-sm font-medium">{t("settings.language.title")}</p>
                    <p className="text-sm text-muted-foreground">{t("settings.language.description")}</p>
                  </div>
                  <Select value={normalizeLocalePreference(settings.general.language)} onValueChange={(value) => updateLanguage(value as LocalePreference)}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {LOCALE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </section>

              <section className="rounded-xl border bg-card p-5 space-y-4">
                <div className="flex items-center gap-2"><ShieldCheck className="size-5 text-primary" /><h3 className="text-lg font-semibold">{t("settings.auth.title")}</h3></div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2"><Label htmlFor="auth-username">{t("settings.auth.username")}</Label><Input id="auth-username" value={authUsername} onChange={(event) => setAuthUsername(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="auth-password">{t("settings.auth.newPassword")}</Label><Input id="auth-password" type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="auth-password-confirm">{t("settings.auth.confirmPassword")}</Label><Input id="auth-password-confirm" type="password" value={authPasswordConfirm} onChange={(event) => setAuthPasswordConfirm(event.target.value)} /></div>
                </div>
                {authError ? (
                  <Alert variant="destructive">
                    <AlertDescription>{authError}</AlertDescription>
                  </Alert>
                ) : null}
                {authSaved ? <Badge variant="secondary">{t("settings.auth.credentialsUpdated")}</Badge> : null}
                <Button onClick={handleUpdateAuth} disabled={authSaving} className="gap-2">
                  {authSaving ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                  {t("settings.auth.updateCredentials")}
                </Button>
              </section>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
