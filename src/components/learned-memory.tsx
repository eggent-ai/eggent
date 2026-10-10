"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Loader2, Plus, Sparkles, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonBlock } from "@/components/ui/skeleton-list";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import type { LearnedTarget, LearningView } from "@/lib/learning/types";

/**
 * What the agent has kept from conversations, where the person can read it.
 *
 * It writes things down about someone and about their work, and reads them at
 * the start of every chat. The least that is owed is a place to see them all,
 * take one out, add one of your own, and switch the whole thing off. Nothing
 * here is a setting in the usual sense: it is the notes themselves.
 */

/** Keys are written out: the dictionary is typed, and a built key is a key nothing checks. */
const REASONS: Record<string, MessageKey> = {
  secret: "learning.reason.secret",
  override: "learning.reason.override",
  role: "learning.reason.role",
  invisible: "learning.reason.invisible",
  too_long: "learning.reason.too_long",
  empty: "learning.reason.empty",
  heading: "learning.reason.heading",
  credential_url: "learning.reason.credential_url",
  url_send: "learning.reason.url_send",
  similar: "learning.reason.similar",
  full: "learning.reason.full",
  too_many_entries: "learning.reason.too_many_entries",
};

type Request =
  | { enabled: boolean }
  | { action: "add"; target: LearnedTarget; content: string }
  | { action: "remove"; target: LearnedTarget; text: string };

function NoteList({
  title,
  target,
  entries,
  used,
  limit,
  busy,
  onRemove,
  onAdd,
}: {
  title: string;
  target: LearnedTarget;
  entries: string[];
  used: number;
  limit: number;
  busy: boolean;
  onRemove: (target: LearnedTarget, text: string) => void;
  onAdd: (target: LearnedTarget, content: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    if (await onAdd(target, content)) setDraft("");
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">{title}</h4>
        <span className="text-xs tabular-nums text-muted-foreground">{t("learning.settings.used", { used, limit })}</span>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("learning.settings.empty")}</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((entry) => (
            <li key={entry} className="flex items-start gap-2 text-sm">
              <span className="min-w-0 flex-1 break-words leading-6">{entry}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="mt-0.5 text-muted-foreground"
                disabled={busy}
                aria-label={`${t("learning.settings.remove")}: ${entry}`}
                title={t("learning.settings.remove")}
                onClick={() => onRemove(target, entry)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex gap-2" onSubmit={submit}>
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("learning.settings.addPlaceholder")}
          aria-label={`${t("learning.settings.add")}: ${title}`}
          maxLength={300}
          disabled={busy}
        />
        <Button type="submit" variant="outline" disabled={busy || !draft.trim()} className="shrink-0 gap-1.5">
          <Plus />
          {t("learning.settings.add")}
        </Button>
      </form>
    </div>
  );
}

export function LearnedMemory() {
  const { t } = useI18n();
  const [view, setView] = useState<LearningView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/learning", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      setView((await response.json()) as LearningView);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(request: Request): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const payload = (await response.json().catch(() => null)) as (LearningView & { error?: string; code?: string }) | null;
      if (!response.ok) {
        const known = typeof payload?.code === "string" ? REASONS[payload.code] : undefined;
        const reason = known ? t(known) : typeof payload?.error === "string" ? payload.error : "";
        setError(
          "action" in request && request.action === "add" && reason
            ? t("learning.settings.addFailed", { reason })
            : t("learning.settings.saveFailed")
        );
        return false;
      }
      if (payload) setView(payload);
      return true;
    } catch {
      setError(t("learning.settings.saveFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loadFailed && !view) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("learning.settings.loadFailed")}</AlertDescription>
      </Alert>
    );
  }
  if (!view) {
    return (
      <section className="rounded-xl border bg-card p-5" aria-busy="true">
        <SkeletonBlock />
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 md:p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded bg-primary/10 p-2">
          <Brain className="size-4 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-semibold">{t("learning.settings.title")}</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("learning.settings.description")}</p>
        </div>
      </div>

      {!view.available ? (
        <Alert>
          <AlertDescription>{t("learning.settings.unavailable")}</AlertDescription>
        </Alert>
      ) : (
        <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border p-3">
          <span>
            <span className="block text-sm font-medium">{t("learning.settings.enabled")}</span>
            <span className="block text-sm text-muted-foreground">{t("learning.settings.enabledHint")}</span>
          </span>
          <input
            type="checkbox"
            className="rounded"
            checked={view.enabled}
            disabled={busy}
            onChange={(event) => void send({ enabled: event.target.checked })}
          />
        </label>
      )}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <NoteList
          title={t("learning.settings.aboutYou")}
          target="user"
          entries={view.notes.user}
          used={view.notes.used.user}
          limit={view.notes.limits.user}
          busy={busy}
          onRemove={(target, text) => void send({ action: "remove", target, text })}
          onAdd={(target, content) => send({ action: "add", target, content })}
        />
        <NoteList
          title={t("learning.settings.aboutWork")}
          target="notes"
          entries={view.notes.notes}
          used={view.notes.used.notes}
          limit={view.notes.limits.notes}
          busy={busy}
          onRemove={(target, text) => void send({ action: "remove", target, text })}
          onAdd={(target, content) => send({ action: "add", target, content })}
        />
      </div>

      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" aria-hidden="true" />
          <h4 className="text-sm font-medium">{t("learning.settings.skillsTitle")}</h4>
          {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
        </div>
        {view.skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("learning.settings.skillsEmpty")}</p>
        ) : (
          <ul className="divide-y">
            {view.skills.map((skill) => (
              <li key={skill.name} className="space-y-1 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{skill.name}</span>
                  {skill.state === "stale" ? <Badge variant="outline">{t("learning.settings.stale")}</Badge> : null}
                  {skill.useCount > 0 ? (
                    <span className="text-xs text-muted-foreground">{t("learning.settings.uses", { count: skill.useCount })}</span>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">{skill.description}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {t("learning.settings.skillsHint")}
          {view.archived > 0 ? ` ${t("learning.settings.archived", { count: view.archived })}.` : ""}
        </p>
      </div>
    </section>
  );
}
