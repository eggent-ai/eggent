"use client";

import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Loader2, Save, ShieldCheck } from "lucide-react";
import { ChatModelWizard, UtilityModelWizard, MultimediaModelWizard, EmbeddingsModelWizard } from "@/components/settings/model-wizards";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
import type { AppSettings } from "@/lib/types";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [authSaving, setAuthSaving] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSaved, setAuthSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((response) => response.json())
      .then((data) => {
        setSettings(data);
        if (data?.auth?.username && typeof data.auth.username === "string") {
          setAuthUsername(data.auth.username);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function handleSave() {
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
    setSettings((prev) => {
      if (!prev) return null;
      return updateSettingsByPath(prev, path, value);
    });
  }

  async function handleUpdateAuth() {
    const username = authUsername.trim();
    const password = authPassword.trim();
    const passwordConfirm = authPasswordConfirm.trim();

    if (!username) {
      setAuthError("Username is required.");
      return;
    }
    if (password.length < 8) {
      setAuthError("Password must be at least 8 characters.");
      return;
    }
    if (password !== passwordConfirm) {
      setAuthError("Password confirmation does not match.");
      return;
    }

    try {
      setAuthSaving(true);
      setAuthError(null);
      setAuthSaved(false);

      const response = await fetch("/api/auth/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; username?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error || "Failed to update credentials.");
      }

      const normalizedUsername = payload?.username || username;
      setAuthUsername(normalizedUsername);
      setAuthPassword("");
      setAuthPasswordConfirm("");
      setAuthSaved(true);
      setTimeout(() => setAuthSaved(false), 2000);

      setSettings((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          auth: {
            ...prev.auth,
            username: normalizedUsername,
            mustChangeCredentials: false,
          },
        };
      });
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Failed to update credentials."
      );
    } finally {
      setAuthSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="[--header-height:calc(--spacing(14))]">
        <SidebarProvider className="flex flex-col">
          <SiteHeader title="Settings" />
          <div className="flex flex-1">
            <AppSidebar />
            <SidebarInset>
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            </SidebarInset>
          </div>
        </SidebarProvider>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="Settings" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 max-w-3xl mx-auto w-full overflow-y-auto">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">Settings</h2>
                  <p className="text-sm text-muted-foreground">
                    Configure AI models, tools, and preferences.
                  </p>
                </div>
                <Button onClick={handleSave} className="gap-2">
                  {saved ? (
                    <>
                      <Check className="size-4" />
                      Saved
                    </>
                  ) : (
                    <>
                      <Save className="size-4" />
                      Save Settings
                    </>
                  )}
                </Button>
              </div>

              <ChatModelWizard settings={settings} updateSettings={updateSettings} />
              <UtilityModelWizard settings={settings} updateSettings={updateSettings} />
              <MultimediaModelWizard settings={settings} updateSettings={updateSettings} />
              <EmbeddingsModelWizard settings={settings} updateSettings={updateSettings} />

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-5 text-primary" />
                  <h3 className="font-semibold text-lg">Authentication</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Change dashboard login username and password.
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="auth-username">Username</Label>
                    <Input
                      id="auth-username"
                      value={authUsername}
                      onChange={(e) => setAuthUsername(e.target.value)}
                      autoComplete="username"
                      placeholder="admin"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="auth-password">New Password</Label>
                    <Input
                      id="auth-password"
                      type="password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="auth-password-confirm">Confirm Password</Label>
                    <Input
                      id="auth-password-confirm"
                      type="password"
                      value={authPasswordConfirm}
                      onChange={(e) => setAuthPasswordConfirm(e.target.value)}
                      autoComplete="new-password"
                      placeholder="Repeat password"
                    />
                  </div>
                </div>

                {authError && <p className="text-sm text-destructive">{authError}</p>}

                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleUpdateAuth}
                    disabled={authSaving}
                    className="gap-2"
                  >
                    {authSaving ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Updating...
                      </>
                    ) : authSaved ? (
                      <>
                        <Check className="size-4" />
                        Updated
                      </>
                    ) : (
                      "Update Credentials"
                    )}
                  </Button>
                </div>
              </section>

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold text-lg">Code Execution</h3>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="code-enabled"
                    checked={settings.codeExecution.enabled}
                    onChange={(e) =>
                      updateSettings("codeExecution.enabled", e.target.checked)
                    }
                    className="rounded"
                  />
                  <Label htmlFor="code-enabled">
                    Enable code execution (Python, Node.js, Shell)
                  </Label>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Timeout (seconds)</Label>
                    <Input
                      type="number"
                      value={settings.codeExecution.timeout}
                      onChange={(e) =>
                        updateSettings(
                          "codeExecution.timeout",
                          parseInt(e.target.value, 10)
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Max Output Length</Label>
                    <Input
                      type="number"
                      value={settings.codeExecution.maxOutputLength}
                      onChange={(e) =>
                        updateSettings(
                          "codeExecution.maxOutputLength",
                          parseInt(e.target.value, 10)
                        )
                      }
                    />
                  </div>
                </div>
              </section>

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold text-lg">Memory</h3>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="memory-enabled"
                    checked={settings.memory.enabled}
                    onChange={(e) => updateSettings("memory.enabled", e.target.checked)}
                    className="rounded"
                  />
                  <Label htmlFor="memory-enabled">
                    Enable persistent vector memory
                  </Label>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Similarity Threshold</Label>
                    <Input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={settings.memory.similarityThreshold}
                      onChange={(e) =>
                        updateSettings(
                          "memory.similarityThreshold",
                          parseFloat(e.target.value)
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Max Results</Label>
                    <Input
                      type="number"
                      value={settings.memory.maxResults}
                      onChange={(e) =>
                        updateSettings("memory.maxResults", parseInt(e.target.value, 10))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Knowledge Chunk Size</Label>
                    <Input
                      type="number"
                      min="100"
                      max="4000"
                      step="50"
                      value={settings.memory.chunkSize}
                      onChange={(e) =>
                        updateSettings("memory.chunkSize", parseInt(e.target.value, 10))
                      }
                    />
                  </div>
                </div>
              </section>

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold text-lg">Web Search</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Provider</Label>
                    <select
                      value={settings.search.provider}
                      onChange={(e) => {
                        updateSettings("search.provider", e.target.value);
                        updateSettings("search.enabled", e.target.value !== "none");
                      }}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      <option value="none">Disabled</option>
                      <option value="searxng">SearXNG (self-hosted)</option>
                      <option value="tavily">Tavily API</option>
                    </select>
                  </div>
                  {settings.search.provider === "tavily" && (
                    <div className="space-y-2">
                      <Label>Tavily API Key</Label>
                      <Input
                        type="password"
                        value={settings.search.apiKey || ""}
                        onChange={(e) => updateSettings("search.apiKey", e.target.value)}
                        placeholder="tvly-..."
                      />
                    </div>
                  )}
                  {settings.search.provider === "searxng" && (
                    <div className="space-y-2">
                      <Label>SearXNG URL</Label>
                      <Input
                        value={settings.search.baseUrl || ""}
                        onChange={(e) => updateSettings("search.baseUrl", e.target.value)}
                        placeholder="http://localhost:8080"
                      />
                    </div>
                  )}
                </div>
              </section>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
