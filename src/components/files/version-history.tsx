"use client";

/**
 * A file's history: every version kept, any two compared, any one restored.
 *
 * It lives beside the file it belongs to - in the files panel next to the chat,
 * and on the file's own page - because the moment somebody wants it is the
 * moment they are looking at the file and something in it is not what it was.
 * The list says who made each version (you, the agent in a named chat, an
 * upload, the sync); choosing one compares it with the version before it, or
 * with the file as it is now, and the arrows walk through the changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Download, History, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { VersionDiff, type DiffMode } from "@/components/files/version-diff";
import { subscribeUiSync } from "@/hooks/use-background-sync";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { buildDiff } from "@/lib/files/versions/diff-model";
import { historyKeyOf, prefersProse } from "@/lib/files/versions/rules";
import type { FileHistoryView, VersionInfo, VersionTextView } from "@/lib/files/versions/shape";
import { cn } from "@/lib/utils";

const MODE_KEY = "eggent.diffMode";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatWhen(iso: string, locale: string, t: (key: MessageKey, values?: Record<string, string | number>) => string): { label: string; full: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { label: iso, full: iso };
  const now = new Date();
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const label = date.toDateString() === now.toDateString()
    ? time
    : date.toDateString() === yesterday.toDateString()
      ? t("files.history.yesterday", { time })
      : `${date.toLocaleDateString(locale, {
          day: "numeric",
          month: "short",
          ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
        })}, ${time}`;
  return { label, full: date.toLocaleString(locale, { dateStyle: "long", timeStyle: "short" }) };
}

function readMode(fallback: DiffMode): DiffMode {
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    return stored === "text" || stored === "lines" ? stored : fallback;
  } catch {
    return fallback;
  }
}

function rememberMode(mode: DiffMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // A browser that keeps nothing still shows the comparison.
  }
}

/** Who made a version, in words. */
export function useVersionAuthor() {
  const { t } = useI18n();
  return useCallback(
    (version: VersionInfo): string => {
      if (version.deleted) return t("files.history.by.deleted");
      switch (version.by.kind) {
        case "person":
          return t("files.history.by.person");
        case "agent":
          return version.by.helper ? t("files.history.by.helper") : t("files.history.by.agent");
        case "upload":
          return t("files.history.by.upload");
        case "restore":
          return t("files.history.by.restore", { n: version.by.restoredFrom ?? "?" });
        case "earlier":
          return t("files.history.by.earlier");
        default:
          return t("files.history.by.outside");
      }
    },
    [t]
  );
}

type CompareWith = "previous" | "current" | `v${number}`;

/** What identifies a version's content on screen: its number, and when and how big it was last written. */
function textKey(version: VersionInfo): string {
  return `${version.n}:${version.at}:${version.size}`;
}

export function VersionHistory({ projectId, path, fill = false, onRestored }: {
  projectId: string;
  path: string;
  /** Take the height it is given, as in the files panel; otherwise a page-sized box. */
  fill?: boolean;
  /** The file changed on disk: whoever shows it should read it again. */
  onRestored?: () => void;
}) {
  const { t, locale } = useI18n();
  const authorOf = useVersionAuthor();
  const key = historyKeyOf(projectId, path);
  const [history, setHistory] = useState<FileHistoryView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [compareWith, setCompareWith] = useState<CompareWith>("previous");
  // Keyed by what a version is, not only its number: a turn's later write rewrites its own version in place.
  const [texts, setTexts] = useState<Record<string, VersionTextView | "error">>({});
  const [mode, setMode] = useState<DiffMode>(prefersProse(path) ? "text" : "lines");
  const [activeChange, setActiveChange] = useState(0);
  const [busy, setBusy] = useState<"restore" | "forget" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  // Each version's text is asked for once, whatever re-renders while the answer is on its way.
  const requested = useRef<Set<string>>(new Set());
  const query = useCallback(
    (extra: Record<string, string> = {}) => new URLSearchParams({ project: projectId, path, ...extra }).toString(),
    [projectId, path]
  );

  // After mount: the server renders this too, and has no browser storage.
  useEffect(() => {
    setMode(readMode(prefersProse(path) ? "text" : "lines"));
  }, [path]);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch(`/api/files/versions?${query()}`, { cache: "no-store" });
      const payload = (await response.json()) as FileHistoryView & { error?: string };
      if (!response.ok) throw new Error(payload.error || t("files.history.loadFailed"));
      setHistory(payload);
      setLoadError(null);
      setSelected((current) => (current !== null && payload.versions.some((version) => version.n === current) ? current : payload.versions[0]?.n ?? null));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("files.history.loadFailed"));
    }
  }, [query, t]);

  useEffect(() => {
    setHistory(null);
    setTexts({});
    requested.current = new Set();
    setSelected(null);
    setCompareWith("previous");
    void loadHistory();
  }, [loadHistory]);

  // A version written while the history is open appears in it.
  useEffect(
    () =>
      subscribeUiSync((event) => {
        if (event.reason === "file_version" && event.paths?.includes(key)) void loadHistory();
      }),
    [key, loadHistory]
  );

  const versions = useMemo(() => history?.versions ?? [], [history]);
  const selectedIndex = versions.findIndex((version) => version.n === selected);
  const selectedVersion = selectedIndex >= 0 ? versions[selectedIndex] : null;

  // The pair compared, older first.
  const pair = useMemo(() => {
    if (!selectedVersion) return null;
    let other: VersionInfo | null = null;
    if (compareWith === "previous") other = versions[selectedIndex + 1] ?? null;
    else if (compareWith === "current") other = versions[0] && versions[0].n !== selectedVersion.n ? versions[0] : versions[selectedIndex + 1] ?? null;
    else other = versions.find((version) => `v${version.n}` === compareWith) ?? null;
    if (!other) return { older: null, newer: selectedVersion };
    return other.n < selectedVersion.n ? { older: other, newer: selectedVersion } : { older: selectedVersion, newer: other };
  }, [compareWith, selectedIndex, selectedVersion, versions]);

  const loadText = useCallback(
    async (version: VersionInfo) => {
      const id = textKey(version);
      if (requested.current.has(id)) return;
      requested.current.add(id);
      try {
        const response = await fetch(`/api/files/versions/content?${query({ n: String(version.n) })}`, { cache: "no-store" });
        const payload = (await response.json()) as VersionTextView & { error?: string };
        if (!response.ok) throw new Error(payload.error);
        setTexts((current) => ({ ...current, [id]: payload }));
      } catch {
        setTexts((current) => ({ ...current, [id]: "error" }));
      }
    },
    [query]
  );

  useEffect(() => {
    if (!pair || history?.comparison === "none") return;
    for (const version of [pair.older, pair.newer]) {
      if (version && texts[textKey(version)] === undefined) void loadText(version);
    }
  }, [pair, history?.comparison, texts, loadText]);

  const olderText = pair?.older ? texts[textKey(pair.older)] : undefined;
  const newerText = pair ? texts[textKey(pair.newer)] : undefined;
  const ready = Boolean(pair && newerText !== undefined && (pair.older === null || olderText !== undefined));
  const failed = olderText === "error" || newerText === "error";
  // The first version kept has nothing before it: there is nothing to compare, not "everything added".
  const model = useMemo(() => {
    if (!ready || failed || !pair?.older) return null;
    return buildDiff((olderText as VersionTextView).text, (newerText as VersionTextView).text);
  }, [ready, failed, pair, olderText, newerText]);

  useEffect(() => {
    setActiveChange(0);
    diffRef.current?.scrollTo({ top: 0 });
  }, [model]);

  const goTo = useCallback(
    (index: number) => {
      if (!model || model.changes === 0) return;
      const next = Math.max(0, Math.min(model.changes - 1, index));
      setActiveChange(next);
      const container = diffRef.current;
      const element = container?.querySelector<HTMLElement>(`[data-change="${next}"]`);
      if (!container || !element) return;
      // The comparison scrolls, not the page around it: scrollIntoView would move every scrolling ancestor.
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const top = element.offsetTop - Math.max(0, (container.clientHeight - element.offsetHeight) / 2);
      container.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
    },
    [model]
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    goTo(activeChange + (event.key === "ArrowDown" ? 1 : -1));
  };

  const restore = async () => {
    if (!selectedVersion || busy) return;
    // Known already not to be kept, what the file holds is said to be lost in the one question asked.
    const unkept = Boolean(history?.unkept);
    if (!window.confirm(unkept ? t("files.history.restoreAnyway") : t("files.history.restoreConfirm", { n: selectedVersion.n }))) return;
    setBusy("restore");
    setNotice(null);
    try {
      const send = (force: boolean) =>
        fetch("/api/files/versions/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: projectId, path, n: selectedVersion.n, ...(force ? { force: true } : {}) }),
        });
      let response = await send(unkept);
      let payload = (await response.json().catch(() => ({}))) as { error?: string; code?: string; version?: VersionInfo | null; lost?: boolean };
      // What the file holds now cannot be kept: said plainly, and done only if the person still wants it.
      if (response.status === 409 && payload.code === "unkept") {
        if (!window.confirm(t("files.history.restoreAnyway"))) return;
        response = await send(true);
        payload = (await response.json().catch(() => ({}))) as typeof payload;
      }
      if (!response.ok) throw new Error(payload.error || t("files.history.restoreFailed"));
      setNotice(t(payload.lost ? "files.history.restoredLost" : "files.history.restored", { n: selectedVersion.n }));
      setCompareWith("previous");
      if (payload.version) setSelected(payload.version.n);
      await loadHistory();
      onRestored?.();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("files.history.restoreFailed"));
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    if (busy || !window.confirm(t("files.history.forgetConfirm"))) return;
    setBusy("forget");
    setNotice(null);
    try {
      const response = await fetch(`/api/files/versions?${query()}`, { method: "DELETE" });
      if (!response.ok) throw new Error(t("files.history.forgetFailed"));
      setTexts({});
      requested.current = new Set();
      await loadHistory();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("files.history.forgetFailed"));
    } finally {
      setBusy(null);
    }
  };

  const changeMode = (next: DiffMode) => {
    setMode(next);
    rememberMode(next);
  };

  if (loadError && !history) {
    return <p role="alert" className="p-3 text-sm text-destructive">{loadError}</p>;
  }
  if (!history) {
    return (
      <div className="p-3" aria-busy="true">
        <SkeletonList rows={4} />
      </div>
    );
  }

  const empty = (text: string, extra?: ReactNode) => (
    <div className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
      <History className="size-5" aria-hidden />
      <p className="max-w-prose">{text}</p>
      {extra}
    </div>
  );

  if (!history.versioned) return empty(t("files.history.notVersioned"));
  if (versions.length === 0) {
    return history.enabled
      ? empty(t("files.history.empty"))
      : empty(t("files.history.off"), (
          <Link href="/dashboard/settings/general#file-history" className="text-sm font-medium text-foreground underline underline-offset-4">
            {t("files.history.openSettings")}
          </Link>
        ));
  }

  // When the file has moved on to something its history could not keep, no version is what it holds now.
  const currentN = versions[0] && !versions[0].deleted && !history.unkept ? versions[0].n : null;
  const compareOptions: Array<{ value: CompareWith; label: string }> = [
    { value: "previous", label: t("files.history.compare.previous") },
    ...(currentN !== null && selectedVersion && selectedVersion.n !== currentN ? [{ value: "current" as const, label: t("files.history.compare.current") }] : []),
    ...versions
      .filter((version) => selectedVersion && version.n !== selectedVersion.n && !version.deleted)
      .map((version) => ({ value: `v${version.n}` as CompareWith, label: t("files.history.compare.version", { n: version.n }) })),
  ];
  const selectedWhen = selectedVersion ? formatWhen(selectedVersion.at, locale, t) : null;

  return (
    <div className={cn("@container flex min-h-0 flex-col", fill ? "h-full" : "rounded-lg border")} onKeyDown={onKeyDown}>
      {/* In the panel the history takes the panel's height; on the file's page it is as tall as it needs
          on a phone, where the page scrolls, and side by side at a fixed height where there is room. */}
      <div
        className={cn(
          "grid @3xl:grid-cols-[17rem_minmax(0,1fr)] @3xl:grid-rows-1",
          fill ? "min-h-0 flex-1 grid-rows-[minmax(0,auto)_minmax(0,1fr)]" : "@3xl:h-[70vh] @3xl:min-h-[28rem]"
        )}
      >
        {/* The versions, newest first. */}
        <div className="flex min-h-0 flex-col border-b @3xl:border-b-0 @3xl:border-r">
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
            <span>{t("files.history.summary", { count: versions.length, size: formatBytes(history.bytes) })}</span>
          </div>
          {history.unkept ? (
            <p role="status" className="mx-3 mb-2 border-l-2 border-l-warning bg-muted/50 px-2 py-1.5 text-xs">
              {t(history.unkept === "too-large" ? "files.history.nowTooLarge" : "files.history.nowUnreadable")}
            </p>
          ) : null}
          <ul className="max-h-44 min-h-0 overflow-y-auto pb-1 @3xl:max-h-none @3xl:flex-1" aria-label={t("files.history.listLabel")}>
            {versions.map((version) => {
              const when = formatWhen(version.at, locale, t);
              const active = version.n === selected;
              return (
                <li key={version.n}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(version.n);
                      setNotice(null);
                      // A version is never compared with itself: picking the one it was compared with starts over.
                      if (compareWith === `v${version.n}` || (compareWith === "current" && version.n === versions[0]?.n)) setCompareWith("previous");
                    }}
                    aria-pressed={active}
                    className={cn(
                      "flex w-full flex-col gap-0.5 border-l-2 px-3 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      active ? "border-primary bg-accent text-accent-foreground" : "border-transparent hover:bg-muted"
                    )}
                  >
                    <span className="flex items-baseline gap-2 text-sm">
                      <span className="font-medium tabular-nums">{t("files.history.versionShort", { n: version.n })}</span>
                      <span className="text-xs text-muted-foreground" title={when.full}>{when.label}</span>
                      {version.n === currentN ? (
                        <span className="rounded border px-1 text-[11px]/4 text-muted-foreground">{t("files.history.current")}</span>
                      ) : null}
                      {typeof version.added === "number" && typeof version.removed === "number" && (version.added > 0 || version.removed > 0) ? (
                        <span className="ml-auto shrink-0 text-xs tabular-nums">
                          <span className="text-success">+{version.added}</span>{" "}
                          <span className="text-destructive">{"−"}{version.removed}</span>
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="truncate text-xs text-muted-foreground"
                      title={version.fileTime ? t("files.history.fileTime", { date: formatWhen(version.fileTime, locale, t).full }) : undefined}
                    >
                      {authorOf(version)}
                      {version.by.kind === "agent" && version.chatTitle ? ` · ${version.chatTitle}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* The comparison. */}
        <div className="flex min-h-0 flex-col">
          {selectedVersion ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 text-xs">
              <span className="min-w-0 text-muted-foreground">
                <span className="font-medium text-foreground">
                  {pair?.older
                    ? t("files.history.pair", { from: pair.older.n, to: pair.newer.n })
                    : t("files.history.versionShort", { n: selectedVersion.n })}
                </span>
                {" · "}
                <span title={selectedWhen?.full}>{authorOf(selectedVersion)}</span>
                {selectedVersion.by.kind === "agent" && selectedVersion.by.chat ? (
                  <>
                    {" · "}
                    <Link href={`/dashboard/${encodeURIComponent(selectedVersion.by.chat)}`} className="underline underline-offset-2 hover:text-foreground">
                      {selectedVersion.chatTitle || t("files.history.chat")}
                    </Link>
                  </>
                ) : null}
              </span>
              {compareOptions.length > 1 ? (
                <Select
                  value={compareOptions.some((option) => option.value === compareWith) ? compareWith : "previous"}
                  onValueChange={(value) => setCompareWith(value as CompareWith)}
                >
                  <SelectTrigger size="sm" className="w-auto gap-1 px-2 text-xs" aria-label={t("files.history.compare.label")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {compareOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {history.comparison !== "none" ? (
                <span className="ml-auto inline-flex rounded-md border p-0.5" role="group" aria-label={t("files.history.mode.label")}>
                  {(["text", "lines"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => changeMode(option)}
                      aria-pressed={mode === option}
                      className={cn(
                        "rounded px-2 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        mode === option ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {t(option === "text" ? "files.history.mode.text" : "files.history.mode.lines")}
                    </button>
                  ))}
                </span>
              ) : null}
            </div>
          ) : null}

          {model && model.changes > 0 ? (
            <div className="flex items-center gap-1 border-b px-3 py-1 text-xs text-muted-foreground">
              <span className="tabular-nums" aria-live="polite">
                {t("files.history.changeOf", { index: activeChange + 1, total: model.changes })}
              </span>
              <span className="tabular-nums">
                {" · "}
                <span className="text-success">+{model.added}</span> <span className="text-destructive">{"−"}{model.removed}</span>
              </span>
              <span className="ml-auto inline-flex gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => goTo(activeChange - 1)}
                  disabled={activeChange === 0}
                  aria-label={t("files.history.previousChange")}
                  title={`${t("files.history.previousChange")} (Alt+↑)`}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => goTo(activeChange + 1)}
                  disabled={activeChange >= model.changes - 1}
                  aria-label={t("files.history.nextChange")}
                  title={`${t("files.history.nextChange")} (Alt+↓)`}
                >
                  <ArrowDown className="size-4" />
                </Button>
              </span>
            </div>
          ) : null}

          <div
            ref={diffRef}
            className={cn(
              "relative overflow-auto py-1",
              fill ? "min-h-0 flex-1" : "min-h-[12rem] max-h-[65vh] @3xl:max-h-none @3xl:min-h-0 @3xl:flex-1"
            )}
            tabIndex={-1}
          >
            {history.comparison === "none" ? (
              <p className="p-3 text-sm text-muted-foreground">{t("files.history.noComparison")}</p>
            ) : !pair ? null : failed ? (
              <p role="alert" className="p-3 text-sm text-destructive">{t("files.history.versionMissing")}</p>
            ) : !ready ? (
              <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden /> {t("files.history.comparing")}
              </div>
            ) : model?.tooLarge ? (
              <p className="p-3 text-sm text-muted-foreground">{t("files.history.tooLarge")}</p>
            ) : !pair.older ? (
              <div className="flex flex-col items-start gap-2 p-3 text-sm text-muted-foreground">
                <p>{t("files.history.firstVersion")}</p>
                {currentN !== null && selectedVersion && selectedVersion.n !== currentN ? (
                  <Button size="sm" variant="outline" onClick={() => setCompareWith("current")}>
                    {t("files.history.compareWithNow")}
                  </Button>
                ) : null}
              </div>
            ) : model && model.changes === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                {history.comparison === "extracted" ? t("files.history.sameTextDocument") : t("files.history.same")}
              </p>
            ) : model ? (
              <>
                {[olderText, newerText].some((text) => typeof text === "object" && text.kind === "extracted") ? (
                  <p className="px-3 pb-1 text-xs text-muted-foreground">{t("files.history.extractedNote")}</p>
                ) : null}
                <VersionDiff key={`${pair.older.n}:${pair.older.at}-${pair.newer.n}:${pair.newer.at}`} model={model} mode={mode} activeChange={activeChange} />
              </>
            ) : null}
          </div>

          {selectedVersion ? (
            <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => void restore()}
                disabled={busy !== null || selectedVersion.deleted || selectedVersion.n === currentN}
                title={selectedVersion.n === currentN ? t("files.history.isCurrent") : undefined}
              >
                {busy === "restore" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                {t("files.history.restore", { n: selectedVersion.n })}
              </Button>
              {!selectedVersion.deleted ? (
                <Button size="sm" variant="ghost" className="gap-1.5" asChild>
                  <a href={`/api/files/versions/download?${query({ n: String(selectedVersion.n) })}`} download>
                    <Download className="size-3.5" />
                    {t("files.history.download")}
                  </a>
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto gap-1.5 text-muted-foreground hover:text-destructive"
                onClick={() => void forget()}
                disabled={busy !== null}
              >
                {busy === "forget" ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                {t("files.history.forget")}
              </Button>
              {notice ? <p role="status" className="basis-full text-xs text-muted-foreground">{notice}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
