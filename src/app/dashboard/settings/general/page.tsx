"use client";

/**
 * Theme, language and the dashboard sign-in: settings about the person at the
 * screen rather than about what the agent does.
 *
 * They used to share a page with the model, under one Save button that also
 * wrote whatever model choice happened to be pending. Theme and language now
 * save the moment they change - both already take effect on the spot, so a
 * separate Save only produced a choice that looked applied and was gone after
 * a reload.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Moon, ShieldCheck, Sun } from "lucide-react";
import { SettingsPageHeader, SettingsShell } from "@/components/settings-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonBlock } from "@/components/ui/skeleton-list";
import { LOCALE_OPTIONS, normalizeLocalePreference, type LocalePreference } from "@/i18n/locales";
import { useI18n } from "@/i18n/provider";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
import type { AppSettings } from "@/lib/types";

type SaveState = "idle" | "saving" | "saved" | "error";

export default function GeneralSettingsPage() {
  const { setLocalePreference, t } = useI18n();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const latest = useRef<AppSettings | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [authSaving, setAuthSaving] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSaved, setAuthSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: AppSettings) => {
        if (cancelled) return;
        latest.current = data;
        setSettings(data);
        if (typeof data?.auth?.username === "string") setAuthUsername(data.auth.username);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Write one change straight away.
   *
   * Saves go out one at a time, and each sends the newest state at the moment
   * it leaves, so two quick changes cannot arrive in the wrong order and put
   * the first one back.
   */
  function change(path: string, value: unknown) {
    const current = latest.current;
    if (!current) return;
    const next = updateSettingsByPath(current, path, value);
    latest.current = next;
    setSettings(next);
    setSaveState("saving");
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const response = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(latest.current),
        });
        if (!response.ok) throw new Error(String(response.status));
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    });
  }

  function changeDarkMode(enabled: boolean) {
    document.documentElement.classList.toggle("dark", enabled);
    change("general.darkMode", enabled);
  }

  function changeLanguage(value: LocalePreference) {
    setLocalePreference(value);
    window.dispatchEvent(new CustomEvent("eggent:locale-change", { detail: { preference: value } }));
    change("general.language", value);
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
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : t("settings.errors.updateCredentials"));
    } finally {
      setAuthSaving(false);
    }
  }

  return (
    <SettingsShell title={t("settings.nav.general")}>
      <SettingsPageHeader title={t("settings.nav.general")} description={t("settings.general.description")} />

      {!settings ? (
        loadFailed ? (
          <Alert variant="destructive">
            <AlertDescription>{t("settings.errors.loadSettings")}</AlertDescription>
          </Alert>
        ) : (
          <section className="rounded-xl border bg-card p-5" aria-busy="true">
            <SkeletonBlock />
          </section>
        )
      ) : (
        <>
          <section className="space-y-4 rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold">{t("settings.appearance.title")}</h3>
              {saveState === "saving" ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("common.saving")}
                </span>
              ) : saveState === "saved" ? (
                <span role="status" className="inline-flex items-center gap-1.5 text-xs text-success">
                  <Check className="size-3.5" />
                  {t("settings.saved")}
                </span>
              ) : saveState === "error" ? (
                <span role="alert" className="text-xs text-destructive">{t("settings.errors.saveSettings")}</span>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">{t("settings.darkMode.title")}</p>
                <p className="text-sm text-muted-foreground">{t("settings.darkMode.description")}</p>
              </div>
              <Label htmlFor="dark-mode-enabled" className="flex cursor-pointer items-center gap-2">
                <Sun className="size-4 text-muted-foreground" />
                <input
                  id="dark-mode-enabled"
                  type="checkbox"
                  checked={settings.general.darkMode}
                  onChange={(event) => changeDarkMode(event.target.checked)}
                  className="rounded"
                />
                <Moon className="size-4 text-muted-foreground" />
              </Label>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">{t("settings.language.title")}</p>
                <p className="text-sm text-muted-foreground">{t("settings.language.description")}</p>
              </div>
              <Select value={normalizeLocalePreference(settings.general.language)} onValueChange={(value) => changeLanguage(value as LocalePreference)}>
                <SelectTrigger className="w-[180px]" aria-label={t("settings.language.title")}>
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

          <section className="space-y-4 rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" />
              <h3 className="text-lg font-semibold">{t("settings.auth.title")}</h3>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="auth-username">{t("settings.auth.username")}</Label>
                <Input id="auth-username" value={authUsername} onChange={(event) => setAuthUsername(event.target.value)} autoComplete="username" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="auth-password">{t("settings.auth.newPassword")}</Label>
                <Input id="auth-password" type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} autoComplete="new-password" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="auth-password-confirm">{t("settings.auth.confirmPassword")}</Label>
                <Input id="auth-password-confirm" type="password" value={authPasswordConfirm} onChange={(event) => setAuthPasswordConfirm(event.target.value)} autoComplete="new-password" />
              </div>
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
        </>
      )}
    </SettingsShell>
  );
}
