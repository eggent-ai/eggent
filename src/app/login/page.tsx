"use client";

import { FormEvent, Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function normalizeNextPath(value: string | null): string {
  if (!value) return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  if (value.startsWith("/login")) return "/dashboard";
  return value;
}

function LoginPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextPath = useMemo(
    () => normalizeNextPath(searchParams.get("next")),
    [searchParams]
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password: password.trim(),
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { error?: string; mustChangeCredentials?: boolean }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error || "Login failed");
      }

      if (payload?.mustChangeCredentials) {
        router.replace("/dashboard/projects?onboarding=1&credentials=1");
        router.refresh();
        return;
      }

      router.replace(nextPath);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-muted/20 px-4 py-8">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-md items-center">
        <section className="w-full rounded-xl border bg-card p-6 shadow-sm">
          <div className="mb-6 flex items-center gap-2">
            <LockKeyhole className="size-5 text-primary" />
            <h1 className="text-xl font-semibold">Eggent Login</h1>
          </div>

          <p className="mb-6 text-sm text-muted-foreground">
            Default credentials: <span className="font-mono">admin / admin</span>
          </p>

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="admin"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full gap-2" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign In"
              )}
            </Button>
          </form>
        </section>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="p-4 text-sm text-muted-foreground">Loading...</main>}>
      <LoginPageClient />
    </Suspense>
  );
}
