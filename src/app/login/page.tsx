"use client";

import { FormEvent, Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";

function normalizeNextPath(value: string | null): string {
  if (!value) return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  if (value.startsWith("/login")) return "/dashboard";
  return value;
}

// A one-time sign-in link arrives as /login#handoff=<token>. It rides in the
// fragment because browsers never send that part to a server, so the token
// stays out of access logs and Referer headers until it is spent here.
function readHandoffToken(): string | null {
  const fragment = window.location.hash.replace(/^#/, "");
  for (const part of fragment.split("&")) {
    if (part.startsWith("handoff=")) {
      const token = decodeURIComponent(part.slice("handoff=".length)).trim();
      return token || null;
    }
  }
  return null;
}

function LoginPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const [handoff, setHandoff] = useState<"none" | "redeeming" | "failed">("none");
  const handoffStarted = useRef(false);
  // Deliberately empty. These fields used to be seeded with the default
  // credentials on every visit, forever - so a returning user had to clear two
  // fields the app had filled with an answer that was wrong for their install,
  // and a publicly reachable workspace advertised its defaults to anyone who
  // loaded the page.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextParam = searchParams.get("next");
  const nextPath = useMemo(() => normalizeNextPath(nextParam), [nextParam]);
  // Arriving here with a destination in hand means something interrupted the
  // person rather than that they chose to sign in. Saying so is the difference
  // between an explanation and a silent bounce.
  const wasInterrupted = Boolean(nextParam);

  // Layout effect, so the form is never painted under a link that is about to
  // sign the person in. The ref keeps a development double-run from spending
  // the token twice - the second attempt would find it gone.
  useLayoutEffect(() => {
    if (handoffStarted.current) return;
    const token = readHandoffToken();
    if (!token) return;
    handoffStarted.current = true;
    // Out of the address bar before anything else, so the link is not left in
    // history or copied onward; it has done its job either way.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setHandoff("redeeming");
    void (async () => {
      try {
        const response = await fetch("/api/auth/handoff/redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { mustChangeCredentials?: boolean }
          | null;
        if (!response.ok) throw new Error("handoff refused");
        router.replace(payload?.mustChangeCredentials ? "/dashboard/onboarding" : nextPath);
        router.refresh();
      } catch {
        setHandoff("failed");
      }
    })();
  }, [nextPath, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password: password.trim() }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { error?: string; mustChangeCredentials?: boolean }
        | null;

      if (!response.ok) throw new Error(payload?.error || t("login.failed"));

      if (payload?.mustChangeCredentials) {
        router.replace("/dashboard/onboarding");
        router.refresh();
        return;
      }

      router.replace(nextPath);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (handoff === "redeeming") {
    return (
      <main className="min-h-screen bg-muted/20 px-4 py-8">
        <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-md items-center">
          <section
            className="flex w-full items-center gap-3 rounded-xl border bg-card p-6 shadow-sm"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="size-5 animate-spin text-primary" />
            <h1 className="text-xl font-semibold">{t("login.handoffSigningIn")}</h1>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/20 px-4 py-8">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-md items-center">
        <section className="w-full rounded-xl border bg-card p-6 shadow-sm">
          <div className="mb-6 flex items-center gap-2">
            <LockKeyhole className="size-5 text-primary" />
            <h1 className="text-xl font-semibold">{t("login.title")}</h1>
          </div>

          {handoff === "failed" ? (
            <p className="mb-6 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
              {t("login.handoffExpired")}
            </p>
          ) : wasInterrupted && (
            <p className="mb-6 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
              {t("login.sessionExpired")}
            </p>
          )}

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="username">{t("login.username")}</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{t("login.password")}</Label>
              <div className="relative flex items-center">
                <Input
                  id="password"
                  className="pr-16"
                  type={revealed ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setRevealed((value) => !value)}
                  aria-pressed={revealed}
                  aria-controls="password"
                  className="absolute right-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground after:absolute after:-inset-2 hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                >
                  {revealed ? t("login.hidePassword") : t("login.showPassword")}
                </button>
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="h-11 w-full gap-2" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("login.submitting")}
                </>
              ) : (
                t("login.submit")
              )}
            </Button>
          </form>

          <p className="mt-6 text-xs leading-relaxed text-muted-foreground">{t("login.noReset")}</p>
        </section>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="p-4 text-sm text-muted-foreground" />}>
      <LoginPageClient />
    </Suspense>
  );
}
