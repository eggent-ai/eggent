"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, Plus, Save, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import { SHARE_ROLES, type FileShareStatus, type SharePeopleAnswer, type ShareRole } from "@/lib/shares/types";
import { cn } from "@/lib/utils";
import { sharedPath, sharesApi } from "./api";
import { ShareComments } from "./share-comments";
import { useRoleWords } from "./share-parts";
import { refreshSharesSummary } from "./use-shares-summary";

type Person = SharePeopleAnswer["people"][number];

/** A file's share as its screen reads it, asked again whenever `version` moves (a save, a restore). */
export function useFileShare(projectId: string, path: string, enabled: boolean, version = 0) {
  const [status, setStatus] = useState<FileShareStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled || !path) return;
    try {
      setStatus(await sharesApi.file(projectId, path));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "failed");
    }
  }, [enabled, path, projectId]);
  useEffect(() => {
    void load();
  }, [load, version]);
  return { status, error, reload: load, setStatus };
}

/** A line over a file that is shared: who sees a change once it is saved. */
export function FileShareNotice({ status, className }: { status: FileShareStatus | null; className?: string }) {
  const { t } = useI18n();
  const share = status?.share;
  if (!share || !share.people.length) return null;
  const names = share.people.map((person) => person.name).join(", ");
  return (
    <div role="status" className={cn("border-l-2 border-info px-3 py-1.5 text-xs text-foreground", className)}>
      {t("shares.notice.shared", { names })}
      {share.unresolved ? ` ${t("shares.notice.comments", { count: share.unresolved })}` : ""}
    </div>
  );
}

/**
 * A file and who it is shared with, beside the file: each person with what
 * they may do, people to add, and the comments on it. The list on screen is
 * the list saved: a change takes effect with Save.
 */
export function FileShare({ projectId, path, fill = false, version = 0 }: { projectId: string; path: string; fill?: boolean; version?: number }) {
  const { t } = useI18n();
  const { roleWord } = useRoleWords();
  const { status, error, reload, setStatus } = useFileShare(projectId, path, true, version);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Array<{ id: string; role: ShareRole }>>([]);
  const [busy, setBusy] = useState<"save" | "stop" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const share = status?.share ?? null;
  const savedList = useMemo(
    () => (share?.people ?? []).filter((person) => person.role !== "owner").map((person) => ({ id: person.id, role: person.role as ShareRole })),
    [share]
  );

  // What is on screen starts as what is saved, and is put back to it whenever the share changes underneath.
  useEffect(() => {
    setChosen(savedList);
  }, [savedList]);

  useEffect(() => {
    setActionError(null);
    setSaved(false);
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    sharesApi
      .people()
      .then((answer) => {
        if (!cancelled) setPeople(answer.people);
      })
      .catch((failure) => {
        if (!cancelled) setPeopleError(failure instanceof Error ? failure.message : t("shares.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const nameOf = (id: string) => people?.find((person) => person.id === id)?.name ?? share?.people.find((person) => person.id === id)?.name ?? id;
  const changed = JSON.stringify([...chosen].sort((a, b) => a.id.localeCompare(b.id))) !== JSON.stringify([...savedList].sort((a, b) => a.id.localeCompare(b.id)));
  const others = (people ?? []).filter((person) => !chosen.some((entry) => entry.id === person.id));

  const save = async () => {
    setBusy("save");
    setActionError(null);
    setSaved(false);
    try {
      const updated = await sharesApi.share({ project: projectId, path, people: chosen });
      setStatus((current) => (current ? { ...current, share: updated } : current));
      setSaved(true);
      void refreshSharesSummary();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t("shares.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    if (!share || !window.confirm(t("shares.file.stopConfirm"))) return;
    setBusy("stop");
    setActionError(null);
    try {
      await sharesApi.stop(share.id);
      setSaved(false);
      void refreshSharesSummary();
      await reload();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : t("shares.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const wrap = (body: ReactNode) => <div className={fill ? "h-full overflow-y-auto p-3" : "space-y-3"}>{body}</div>;

  if (!status) return wrap(error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <SkeletonList rows={2} />);
  if (!status.enabled) return wrap(<p className="text-sm text-muted-foreground">{t("shares.unavailable")}</p>);
  if (status.current.sensitive) return wrap(<p className="text-sm text-muted-foreground">{t("shares.error.sensitive")}</p>);
  if (!status.current.exists && !share) return wrap(<p className="text-sm text-muted-foreground">{t("shares.error.missing")}</p>);
  if (status.current.tooLarge && !share) return wrap(<p className="text-sm text-muted-foreground">{t("shares.error.tooLarge", { maxMb: status.maxBytes / 1024 / 1024 })}</p>);

  return wrap(
    <div className="space-y-5">
      <div className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Users aria-hidden className="size-4 text-muted-foreground" />
          {t("shares.file.who")}
        </h3>
        {chosen.length === 0 ? (
          <p className="text-sm text-muted-foreground">{share ? t("shares.file.nobodyNow") : t("shares.file.none")}</p>
        ) : (
          <ul className="space-y-1.5">
            {chosen.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm">{nameOf(entry.id)}</span>
                <label className="sr-only" htmlFor={`share-role-${entry.id}`}>{t("shares.file.roleOf", { name: nameOf(entry.id) })}</label>
                <select
                  id={`share-role-${entry.id}`}
                  value={entry.role}
                  onChange={(event) => setChosen((current) => current.map((item) => (item.id === entry.id ? { ...item, role: event.target.value as ShareRole } : item)))}
                  className="h-8 rounded-md border bg-background px-2 text-base md:text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {SHARE_ROLES.map((role) => (
                    <option key={role} value={role}>{roleWord(role)}</option>
                  ))}
                </select>
                <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => setChosen((current) => current.filter((item) => item.id !== entry.id))} aria-label={t("shares.file.remove", { name: nameOf(entry.id) })}>
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {others.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {others.map((person) => (
              <Button key={person.id} type="button" variant="outline" size="sm" className="h-8 gap-1" title={person.about || undefined} onClick={() => setChosen((current) => [...current, { id: person.id, role: "view" }])}>
                <Plus className="size-3.5" />
                {person.name}
              </Button>
            ))}
          </div>
        ) : null}
        {people !== null && people.length === 0 ? <p className="text-sm text-muted-foreground">{t("shares.file.nobodyElse")}</p> : null}
        {peopleError ? <p role="alert" className="text-sm text-destructive">{peopleError}</p> : null}
      </div>
      <p className="text-xs text-muted-foreground">{t("shares.file.howItWorks")}</p>
      {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void save()} disabled={!changed || busy !== null || (!share && chosen.length === 0)} className="gap-2">
          {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {share ? t("shares.file.save") : t("shares.file.share")}
        </Button>
        {saved && !changed ? <span role="status" className="text-xs text-muted-foreground">{t("shares.file.saved")}</span> : null}
        {share ? (
          <>
            <Button type="button" variant="ghost" asChild className="gap-1.5">
              <Link href={sharedPath(share.id)}>
                <ArrowUpRight className="size-4" />
                {t("shares.file.openAsShared")}
              </Link>
            </Button>
            <Button type="button" variant="ghost" onClick={() => void stop()} disabled={busy !== null} className="gap-1.5 text-muted-foreground">
              {busy === "stop" ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
              {t("shares.file.stop")}
            </Button>
          </>
        ) : null}
      </div>
      {share ? <ShareComments shareId={share.id} canWrite isOwner /> : null}
    </div>
  );
}
