"use client";

import { useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SettingsNavigation } from "@/components/settings-navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, ExternalLink, KeyRound, Loader2, LogOut, Moon, PlugZap, Save, ShieldCheck, Sun } from "lucide-react";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
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

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [piState, setPiState] = useState<PiState | null>(null);
  const [modelsJson, setModelsJson] = useState("");
  const [modelsJsonSaved, setModelsJsonSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [piLoading, setPiLoading] = useState(true);
  const [piError, setPiError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
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
    const timer = window.setInterval(async () => {
      const res = await fetch(`/api/pi/auth/login?id=${encodeURIComponent(oauthJobId)}`, { cache: "no-store" });
      const json = await res.json().catch(() => null) as LoginJobState | { error?: string } | null;
      if (!res.ok || !json || ("error" in json && !("status" in json))) {
        setPiError(json?.error || "Failed to poll provider login");
        return;
      }
      const next = json as LoginJobState;
      setOauthJob(next);
      if (next.status !== "running") {
        await loadPiState();
      }
    }, 1000);
    return () => window.clearInterval(timer);
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
      if (!stateRes.ok) throw new Error(stateJson.error || "Failed to load models");
      setPiState(stateJson);
      const defaultProvider = typeof stateJson?.settings?.defaultProvider === "string" ? stateJson.settings.defaultProvider : "";
      const defaultModel = typeof stateJson?.settings?.defaultModel === "string" ? stateJson.settings.defaultModel : "";
      const availablePiModels = Array.isArray(stateJson?.availableModels) ? stateJson.availableModels as PiModelState[] : [];
      const firstAvailableModel = availablePiModels[0];
      const defaultProviderHasModels = Boolean(defaultProvider && availablePiModels.some((model) => model.provider === defaultProvider));
      const providerSelection = defaultProviderHasModels ? defaultProvider : firstAvailableModel?.provider || "";
      const firstProviderModel = availablePiModels.find((model) => model.provider === providerSelection);
      setDefaultProviderSelection(providerSelection);
      setDefaultModelSelection(defaultProviderHasModels && defaultModel ? defaultModel : firstProviderModel?.id || "");
      setDefaultThinkingLevel(typeof stateJson?.settings?.defaultThinkingLevel === "string" ? stateJson.settings.defaultThinkingLevel : "high");
      const raw = typeof rawJson.content === "string" ? rawJson.content : "";
      setModelsJson(raw);
      setModelsJsonSaved(raw);
    } catch (error) {
      setPiError(error instanceof Error ? error.message : "Failed to load model connections");
    } finally {
      setPiLoading(false);
    }
  }

  async function handleSaveSettings() {
    if (!settings) return;
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function updateSettings(path: string, value: unknown) {
    setSettings((prev) => (prev ? updateSettingsByPath(prev, path, value) : prev));
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
        setPiError("Provider env must be a JSON object, for example {\"CLOUDFLARE_ACCOUNT_ID\":\"...\"}.");
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
      if (!res.ok) throw new Error(json.error || "Failed to save provider key");
      setApiKey("");
      setApiKeyEnv("");
      setPiState(json);
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : "Failed to save provider key");
    } finally {
      setSavingProvider(false);
    }
  }

  async function logoutProvider(providerId: string) {
    if (!confirm(`Log out from ${providerId}? Stored credentials will be removed.`)) return;
    const res = await fetch(`/api/pi/auth?provider=${encodeURIComponent(providerId)}`, { method: "DELETE" });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setPiError(json?.error || "Failed to logout provider");
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
      if (!res.ok) throw new Error(json.error || "Failed to start provider login");
      setOauthJob(json);
    } catch (error) {
      setPiError(error instanceof Error ? error.message : "Failed to start provider login");
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
      setPiError(json?.error || "Failed to answer login prompt");
      return;
    }
    setAnsweredPrompts((prev) => ({ ...prev, [promptId]: true }));
    setOauthJob(json);
  }

  async function cancelOAuthLogin() {
    if (!oauthJob) return;
    await fetch(`/api/pi/auth/login?id=${encodeURIComponent(oauthJob.id)}`, { method: "DELETE" }).catch(() => null);
    setOauthJob((prev) => prev ? { ...prev, status: "cancelled", error: "Login cancelled" } : prev);
  }

  function handleDefaultProviderChange(providerId: string) {
    setDefaultProviderSelection(providerId);
    const firstModel = (piState?.availableModels ?? [])
      .filter((model) => model.provider === providerId)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    setDefaultModelSelection(firstModel?.id || "");
  }

  async function saveDefaultModel() {
    const providerId = defaultProviderSelection.trim();
    const modelId = defaultModelSelection.trim();
    if (!providerId || !modelId) return;
    try {
      setSavingDefaultModel(true);
      setPiError(null);
      const res = await fetch("/api/pi/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, model: modelId, thinkingLevel: defaultThinkingLevel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save default model");
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : "Failed to save default model");
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
      if (!res.ok) throw new Error(json.error || "Failed to save models.json");
      const next = typeof json.content === "string" ? json.content : modelsJson;
      setModelsJson(next);
      setModelsJsonSaved(next);
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : "Failed to save models.json");
    } finally {
      setSavingModelsJson(false);
    }
  }

  async function handleUpdateAuth() {
    const username = authUsername.trim();
    const password = authPassword.trim();
    const passwordConfirm = authPasswordConfirm.trim();

    if (!username) return setAuthError("Username is required.");
    if (password.length < 8) return setAuthError("Password must be at least 8 characters.");
    if (password !== passwordConfirm) return setAuthError("Password confirmation does not match.");

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
      if (!response.ok) throw new Error(payload?.error || "Failed to update credentials.");
      setAuthUsername(payload?.username || username);
      setAuthPassword("");
      setAuthPasswordConfirm("");
      setAuthSaved(true);
      setTimeout(() => setAuthSaved(false), 2000);
      setSettings((prev) => prev ? { ...prev, auth: { ...prev.auth, username: payload?.username || username, mustChangeCredentials: false } } : prev);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Failed to update credentials.");
    } finally {
      setAuthSaving(false);
    }
  }

  const providerChoices = useMemo(() => {
    return (piState?.providers ?? [])
      .map((item) => ({ id: item.id, name: item.name || item.id, availableModelCount: item.availableModelCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [piState]);

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
  const currentModelIsAvailable = Boolean(piState?.current?.model?.available);

  if (loading || !settings) {
    return (
      <div className="[--header-height:calc(--spacing(14))]">
        <SidebarProvider className="flex flex-col">
          <SiteHeader title="Settings" />
          <div className="flex flex-1"><AppSidebar /><SidebarInset><div className="flex flex-1 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div></SidebarInset></div>
        </SidebarProvider>
      </div>
    );
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="Settings" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto p-4 md:p-6">
              <SettingsNavigation />

              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">Settings</h2>
                  <p className="text-sm text-muted-foreground">Manage Eggent model and authentication settings from one UI.</p>
                </div>
                <Button onClick={handleSaveSettings} className="gap-2">
                  {saved ? <Check className="size-4" /> : <Save className="size-4" />}
                  {saved ? "Saved" : "Save App Settings"}
                </Button>
              </div>

              <section className="rounded-xl border bg-card p-5 space-y-5">
                <div className="flex items-center gap-2">
                  <PlugZap className="size-5 text-primary" />
                  <h3 className="text-lg font-semibold">Models and login</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Configure provider logins, API keys, model defaults, and custom model providers for Eggent.
                </p>
                {piError ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{piError}</div> : null}

                {piLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading providers...</div> : null}

                {currentModelIsAvailable ? (
                  <div className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-mono text-muted-foreground">current default</div>
                        <h4 className="font-medium">{piState?.current?.providerName || piState?.current?.provider}</h4>
                        <p className="text-sm text-muted-foreground">
                          <span className="font-mono">{piState?.current?.model?.id}</span>
                          {currentCredential?.type ? ` · ${currentCredential.type === "oauth" ? "OAuth/subscription" : "API key"}` : ""}
                          {piState?.settings?.defaultThinkingLevel ? ` · thinking ${piState.settings.defaultThinkingLevel}` : ""}
                        </p>
                      </div>
                      {piState?.current?.provider && piState.current.stored ? (
                        <Button variant="outline" className="gap-2 text-destructive" onClick={() => logoutProvider(piState.current?.provider || "")}>
                          <LogOut className="size-4" />
                          Logout
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="rounded-lg border p-4 space-y-3">
                  <div>
                    <div className="text-xs font-mono text-muted-foreground">provider</div>
                    <h4 className="font-medium">Choose provider</h4>
                    <p className="text-xs text-muted-foreground">Pick one provider first. Eggent will only show models for that provider.</p>
                  </div>
                  <select
                    value={defaultProviderSelection}
                    onChange={(event) => handleDefaultProviderChange(event.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    disabled={piLoading || providerChoices.length === 0}
                  >
                    <option value="">Select provider...</option>
                    {providerChoices.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </div>

                {defaultProviderSelection ? (
                  <div className="rounded-lg border p-4 space-y-4">
                    <div>
                      <div className="text-xs font-mono text-muted-foreground">/login</div>
                      <h4 className="font-medium">Connect {selectedProviderName}</h4>
                      <p className="text-xs text-muted-foreground">
                        {selectedProviderConnected
                          ? "This provider already has available models. You can still save or replace its API key."
                          : "After this provider is connected, its available models will appear here."}
                      </p>
                    </div>

                    {selectedOauthProvider && !selectedProviderConnected ? (
                      <Button onClick={startOAuthLogin} disabled={oauthSaving} className="gap-2">
                        {oauthSaving ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                        Login with subscription
                      </Button>
                    ) : null}

                    {selectedApiKeyProvider ? (
                      <div className="space-y-3">
                        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                          <Input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder={`API key for ${selectedProviderName}`} />
                          <Button onClick={saveProviderKey} disabled={savingProvider || !apiKey.trim()} className="gap-2">
                            {savingProvider ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                            {selectedProviderHasStoredCredential ? "Replace key" : "Save key"}
                          </Button>
                        </div>
                        <textarea value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} rows={4} className="w-full rounded-lg border bg-muted/30 p-3 text-xs font-mono" placeholder={'Optional provider-scoped env JSON, e.g. {"CLOUDFLARE_ACCOUNT_ID":"..."}'} />
                      </div>
                    ) : null}

                    {!selectedOauthProvider && !selectedApiKeyProvider ? (
                      <p className="text-sm text-muted-foreground">This provider does not expose a login method here.</p>
                    ) : null}
                  </div>
                ) : null}

                {oauthJob ? (
                  <div className="rounded-md border bg-muted/20 p-3 space-y-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div>Status: <span className="font-medium">{oauthJob.status}</span>{oauthJob.error ? <span className="text-destructive"> · {oauthJob.error}</span> : null}</div>
                      {oauthJob.status === "running" ? <Button size="sm" variant="outline" onClick={cancelOAuthLogin}>Cancel</Button> : null}
                    </div>
                    {oauthJob.events.map((event) => {
                      if (event.type === "auth_url") return <div key={event.id} className="space-y-1"><p>{event.instructions || "Open this URL to authenticate:"}</p><a href={event.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline"><ExternalLink className="size-3" />Open auth URL</a><p className="break-all text-xs text-muted-foreground">{event.url}</p></div>;
                      if (event.type === "device_code") return <div key={event.id} className="rounded-md bg-background p-3"><p>Open <a href={event.verificationUri} target="_blank" rel="noreferrer" className="text-primary underline">{event.verificationUri}</a> and enter code:</p><div className="mt-2 font-mono text-lg font-semibold tracking-widest">{event.userCode}</div></div>;
                      if (event.type === "progress") return <p key={event.id} className="text-muted-foreground">{event.message}</p>;
                      if (event.type === "select" && oauthJob.status === "running" && !answeredPrompts[event.promptId]) return <div key={event.id} className="space-y-2"><p className="font-medium">{event.message}</p><div className="flex flex-wrap gap-2">{event.options.map((option) => <Button key={option.id} size="sm" variant="outline" onClick={() => answerLoginPrompt(event.promptId, option.id)}>{option.label}</Button>)}</div></div>;
                      if (event.type === "prompt" && oauthJob.status === "running" && !answeredPrompts[event.promptId]) return <div key={event.id} className="space-y-2"><Label>{event.message}</Label><div className="grid gap-2 md:grid-cols-[1fr_auto]"><Input value={promptInputs[event.promptId] || ""} placeholder={event.placeholder || ""} onChange={(inputEvent) => setPromptInputs((prev) => ({ ...prev, [event.promptId]: inputEvent.target.value }))} /><Button onClick={() => answerLoginPrompt(event.promptId, promptInputs[event.promptId] || "")} disabled={!event.allowEmpty && !promptInputs[event.promptId]?.trim()}>Send</Button></div></div>;
                      if (event.type === "completed") return <p key={event.id} className="text-emerald-600">Login completed. Credentials were updated.</p>;
                      if (event.type === "error") return <p key={event.id} className="text-destructive">{event.message}</p>;
                      return null;
                    })}
                  </div>
                ) : null}

                {selectedProviderConnected ? (
                  <div className="rounded-lg border p-4 space-y-3">
                    <div>
                      <div className="text-xs font-mono text-muted-foreground">/model</div>
                      <h4 className="font-medium">Choose {selectedProviderName} model</h4>
                      <p className="text-xs text-muted-foreground">Only models currently available for this provider are shown.</p>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[1fr_160px_auto]">
                      <select value={defaultModelSelection} onChange={(event) => setDefaultModelSelection(event.target.value)} className="rounded-md border bg-background px-3 py-2 text-sm">
                        {modelChoices.map((model) => (
                          <option key={`${model.provider}/${model.id}`} value={model.id}>
                            {model.id}{model.name && model.name !== model.id ? ` · ${model.name}` : ""}
                          </option>
                        ))}
                      </select>
                      <select value={defaultThinkingLevel} onChange={(event) => setDefaultThinkingLevel(event.target.value)} className="rounded-md border bg-background px-3 py-2 text-sm">
                        {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
                      </select>
                      <Button onClick={saveDefaultModel} disabled={savingDefaultModel || !defaultModelSelection} className="gap-2">
                        {savingDefaultModel ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                        Save model
                      </Button>
                    </div>
                    {selectedProviderState?.stored ? (
                      <Button variant="ghost" className="gap-2 px-0 text-destructive" onClick={() => logoutProvider(defaultProviderSelection)}>
                        <LogOut className="size-4" /> Logout from {selectedProviderName}
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {defaultProviderSelection ? (
                  <details className="rounded-lg border p-4">
                    <summary className="cursor-pointer text-sm font-medium">Advanced: edit custom models.json</summary>
                    <div className="mt-4 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-mono text-muted-foreground">models.json</div>
                          <h4 className="font-medium">Custom providers and models</h4>
                        </div>
                        <Button size="sm" onClick={saveModelsJson} disabled={savingModelsJson || !modelsJsonDirty}>
                          {savingModelsJson ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                          Save models.json
                        </Button>
                      </div>
                      <textarea value={modelsJson} onChange={(event) => setModelsJson(event.target.value)} rows={14} className="w-full rounded-lg border bg-muted/30 p-3 text-xs font-mono" />
                    </div>
                  </details>
                ) : null}
              </section>

              <section className="rounded-xl border bg-card p-5 space-y-4">
                <h3 className="text-lg font-semibold">Appearance</h3>
                <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                  <div><p className="text-sm font-medium">Dark mode</p><p className="text-sm text-muted-foreground">Switch between light and dark theme.</p></div>
                  <Label htmlFor="dark-mode-enabled" className="flex cursor-pointer items-center gap-2">
                    <Sun className="size-4 text-muted-foreground" />
                    <input id="dark-mode-enabled" type="checkbox" checked={settings.general.darkMode} onChange={(event) => updateSettings("general.darkMode", event.target.checked)} className="rounded" />
                    <Moon className="size-4 text-muted-foreground" />
                  </Label>
                </div>
              </section>

              <section className="rounded-xl border bg-card p-5 space-y-4">
                <div className="flex items-center gap-2"><ShieldCheck className="size-5 text-primary" /><h3 className="text-lg font-semibold">Dashboard authentication</h3></div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2"><Label htmlFor="auth-username">Username</Label><Input id="auth-username" value={authUsername} onChange={(event) => setAuthUsername(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="auth-password">New password</Label><Input id="auth-password" type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="auth-password-confirm">Confirm password</Label><Input id="auth-password-confirm" type="password" value={authPasswordConfirm} onChange={(event) => setAuthPasswordConfirm(event.target.value)} /></div>
                </div>
                {authError ? <p className="text-sm text-destructive">{authError}</p> : null}
                {authSaved ? <p className="text-sm text-emerald-600">Credentials updated.</p> : null}
                <Button onClick={handleUpdateAuth} disabled={authSaving} className="gap-2">
                  {authSaving ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                  Update credentials
                </Button>
              </section>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
