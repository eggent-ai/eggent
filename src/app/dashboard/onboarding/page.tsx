"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";

/**
 * First run: replace the default login, then go straight to picking a model.
 *
 * This used to live on the projects page behind a query flag, which left the
 * new user staring at a project form they had no reason to fill in, and hung:
 * saving fired a push, a refresh and a replace at the same route at once. It is
 * its own page now, and the last step is a full page load rather than a client
 * navigation - the session cookie has just been replaced, so reloading is both
 * simpler and more honest than asking the router to keep up.
 */
export default function OnboardingPage() {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();

    if (!trimmedUsername) {
      setError(t("projects.errors.usernameRequired"));
      return;
    }
    if (trimmedPassword.length < 8) {
      setError(t("projects.errors.passwordMin"));
      return;
    }
    if (trimmedPassword !== passwordConfirm.trim()) {
      setError(t("projects.errors.passwordMismatch"));
      return;
    }

    try {
      setSaving(true);
      setError(null);
      const response = await fetch("/api/auth/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: trimmedUsername, password: trimmedPassword }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error || t("projects.errors.updateCredentials"));
      }
      window.location.replace("/dashboard/settings");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("projects.errors.updateCredentials"));
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-md space-y-5 rounded-2xl border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t("onboarding.title")}</h1>
          <p className="text-sm leading-6 text-muted-foreground">{t("onboarding.description")}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="onboarding-username">{t("projects.username")}</Label>
          <Input
            id="onboarding-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="admin"
            autoComplete="username"
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="onboarding-password">{t("projects.newPassword")}</Label>
          <Input
            id="onboarding-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t("projects.passwordMinPlaceholder")}
            autoComplete="new-password"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="onboarding-password-confirm">{t("projects.confirmPassword")}</Label>
          <Input
            id="onboarding-password-confirm"
            type="password"
            value={passwordConfirm}
            onChange={(event) => setPasswordConfirm(event.target.value)}
            placeholder={t("projects.repeatPasswordPlaceholder")}
            autoComplete="new-password"
          />
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Button type="submit" disabled={saving} className="w-full gap-2">
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {saving ? t("common.saving") : t("onboarding.submit")}
        </Button>
      </form>
    </div>
  );
}
