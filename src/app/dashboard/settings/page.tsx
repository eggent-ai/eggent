"use client";

import { useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, KeyRound, Loader2, Moon, Save, ShieldCheck, Sun, Trash2 } from "lucide-react";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
import type { AppSettings } from "@/lib/types";

interface PiProviderState {
  id: string;
  name?: string;
  stored: boolean;
  modelCount: number;
  availableModelCount: number;
  auth?: { configured?: boolean; source?: string };
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
  providers: PiProviderState[];
  models: PiModelState[];
  availableModels: PiModelState[];
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [piState, setPiState] = useState<PiState | null>(null);
  const [modelsJson, setModelsJson] = useState("");
  const [modelsJsonSaved, setModelsJsonSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [piLoading, setPiLoading] = useState(true);
  const [piError, setPiError] = useState<string | null>(null);
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [savingProvider, setSavingProvider] = useState(false);
  const [savingModelsJson, setSavingModelsJson] = useState(false);
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);
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
      if (!stateRes.ok) throw new Error(stateJson.error || "Failed to load pi models");
      setPiState(stateJson);
      const defaultProvider = typeof stateJson?.settings?.defaultProvider === "string" ? stateJson.settings.defaultProvider : "";
      const defaultModel = typeof stateJson?.settings?.defaultModel === "string" ? stateJson.settings.defaultModel : "";
      setDefaultModelSelection(defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : "");
      setDefaultThinkingLevel(typeof stateJson?.settings?.defaultThinkingLevel === "string" ? stateJson.settings.defaultThinkingLevel : "high");
      const raw = typeof rawJson.content === "string" ? rawJson.content : "";
      setModelsJson(raw);
      setModelsJsonSaved(raw);
    } catch (error) {
      setPiError(error instanceof Error ? error.message : "Failed to load pi model connections");
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
    if (!provider.trim() || !apiKey.trim()) return;
    try {
      setSavingProvider(true);
      setPiError(null);
      const res = await fetch("/api/pi/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.trim(), apiKey: apiKey.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save provider key");
      setApiKey("");
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : "Failed to save provider key");
    } finally {
      setSavingProvider(false);
    }
  }

  async function deleteProviderKey(providerId: string) {
    if (!confirm(`Remove pi credentials for ${providerId}?`)) return;
    const res = await fetch(`/api/pi/auth?provider=${encodeURIComponent(providerId)}`, { method: "DELETE" });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setPiError(json?.error || "Failed to remove provider key");
      return;
    }
    await loadPiState();
  }

  async function saveDefaultModel() {
    const slash = defaultModelSelection.indexOf("/");
    if (slash <= 0) return;
    const providerId = defaultModelSelection.slice(0, slash);
    const modelId = defaultModelSelection.slice(slash + 1);
    try {
      setSavingDefaultModel(true);
      setPiError(null);
      const res = await fetch("/api/pi/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          model: modelId,
          thinkingLevel: defaultThinkingLevel,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save pi default model");
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : "Failed to save pi default model");
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

  const modelChoices = useMemo(() => {
    const source = piState?.availableModels.length ? piState.availableModels : piState?.models ?? [];
    return source.slice().sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  }, [piState]);
  const availableModels = useMemo(() => piState?.availableModels.slice(0, 80) ?? [], [piState]);
  const modelsJsonDirty = modelsJson !== modelsJsonSaved;

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
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">Settings</h2>
                  <p className="text-sm text-muted-foreground">Eggent uses pi&apos;s own auth.json and models.json for model connections.</p>
                </div>
                <Button onClick={handleSaveSettings} className="gap-2">
                  {saved ? <Check className="size-4" /> : <Save className="size-4" />}
                  {saved ? "Saved" : "Save App Settings"}
                </Button>
              </div>

              <section className="rounded-xl border bg-card p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <KeyRound className="size-5 text-primary" />
                  <h3 className="text-lg font-semibold">pi model connections</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Credentials are stored by pi in <code>{piState?.authFile || "~/.pi/agent/auth.json"}</code>. Custom providers/models live in <code>{piState?.modelsFile || "~/.pi/agent/models.json"}</code>.
                  OAuth subscription logins can still be created with pi CLI <code>/login</code>; Eggent will read them here.
                </p>
                {piError ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{piError}</div> : null}

                <div className="rounded-lg border p-4 space-y-3">
                  <div>
                    <div className="text-xs font-mono text-muted-foreground">settings.json</div>
                    <h4 className="font-medium">Global default model</h4>
                    <p className="text-xs text-muted-foreground">
                      Stored in pi global settings. Project <code>model.json</code> can still override it.
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
                    <select
                      value={defaultModelSelection}
                      onChange={(event) => setDefaultModelSelection(event.target.value)}
                      className="rounded-md border bg-background px-3 py-2 text-sm"
                      disabled={piLoading || modelChoices.length === 0}
                    >
                      {!defaultModelSelection ? <option value="">Select pi model...</option> : null}
                      {modelChoices.map((model) => (
                        <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                          {model.provider}/{model.id}{model.available ? "" : " (auth missing)"}
                        </option>
                      ))}
                    </select>
                    <select
                      value={defaultThinkingLevel}
                      onChange={(event) => setDefaultThinkingLevel(event.target.value)}
                      className="rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      {["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => (
                        <option key={level} value={level}>{level}</option>
                      ))}
                    </select>
                    <Button onClick={saveDefaultModel} disabled={savingDefaultModel || !defaultModelSelection} className="gap-2">
                      {savingDefaultModel ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                      Save default
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-[220px_1fr_auto]">
                  <Input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="provider, e.g. anthropic" />
                  <Input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="API key stored in pi auth.json" />
                  <Button onClick={saveProviderKey} disabled={savingProvider || !provider.trim() || !apiKey.trim()} className="gap-2">
                    {savingProvider ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                    Save key
                  </Button>
                </div>

                {piLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading pi providers...</div> : null}
                {piState ? (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="rounded-lg border">
                      <div className="border-b px-3 py-2 text-sm font-medium">Providers</div>
                      <div className="max-h-96 divide-y overflow-auto">
                        {piState.providers.map((item) => (
                          <div key={item.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                            <div className="min-w-0">
                              <div className="font-medium">{item.name || item.id}</div>
                              <div className="text-xs text-muted-foreground">
                                {item.availableModelCount}/{item.modelCount} models available · auth {item.auth?.configured ? item.auth.source || "configured" : "missing"}
                              </div>
                            </div>
                            {item.stored ? (
                              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => deleteProviderKey(item.id)}>
                                <Trash2 className="size-4" />
                              </Button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-lg border">
                      <div className="border-b px-3 py-2 text-sm font-medium">Available pi models</div>
                      <div className="max-h-96 divide-y overflow-auto">
                        {availableModels.length === 0 ? <div className="p-3 text-sm text-muted-foreground">No authenticated pi models yet.</div> : null}
                        {availableModels.map((model) => (
                          <div key={`${model.provider}/${model.id}`} className="p-3 text-sm">
                            <div className="font-medium">{model.provider}/{model.id}</div>
                            <div className="text-xs text-muted-foreground">{model.name || ""}{model.reasoning ? " · reasoning" : ""}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-mono text-muted-foreground">models.json</div>
                      <h4 className="font-medium">pi custom providers and models</h4>
                    </div>
                    <Button size="sm" onClick={saveModelsJson} disabled={savingModelsJson || !modelsJsonDirty}>
                      {savingModelsJson ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                      Save models.json
                    </Button>
                  </div>
                  <textarea value={modelsJson} onChange={(event) => setModelsJson(event.target.value)} rows={14} className="w-full rounded-lg border bg-muted/30 p-3 text-xs font-mono" />
                </div>
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
