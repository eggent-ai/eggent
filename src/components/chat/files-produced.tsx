"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, FileText, FolderArchive, ImageIcon, Send } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { useAppStore } from "@/store/app-store";
import { fileDownloadUrl, isOpenableFile } from "@/lib/files/openable";
import { startZipDownload } from "@/lib/files/zip-download";
import type { ProducedFile, ProducedGroup } from "@/lib/files/produced-shape";

/**
 * Under an answer: the files it made.
 *
 * Someone who asks for a document is told a path and left to find it. This is
 * the file itself, with the two things they do next - look at it, take it -
 * and, where Telegram is connected, a third that sends it to their phone.
 * Quiet like the note about what the agent learned, and only as long as it has
 * to be: five rows, then a count and one archive of the lot.
 */

const VISIBLE = 5;
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

type Existence = Map<string, boolean>;

let telegramAvailable: { value: boolean; at: number } | null = null;

async function isTelegramAvailable(): Promise<boolean> {
  if (telegramAvailable && Date.now() - telegramAvailable.at < 60_000) return telegramAvailable.value;
  try {
    const response = await fetch("/api/files/telegram", { cache: "no-store" });
    const value = response.ok ? Boolean(((await response.json()) as { available?: boolean }).available) : false;
    telegramAvailable = { value, at: Date.now() };
    return value;
  } catch {
    return false;
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function keyOf(project: string, path: string): string {
  return `${project}\u0000${path}`;
}

export function FilesProduced({ groups }: { groups: ProducedGroup[] }) {
  const { t } = useI18n();
  const chatId = useAppStore((state) => state.activeChatId);
  const [existence, setExistence] = useState<Existence | null>(null);
  const [telegram, setTelegram] = useState(false);
  const [sent, setSent] = useState<Record<string, "sending" | "sent" | "failed">>({});
  const [note, setNote] = useState<string | null>(null);

  // A card is stored with its message and a file is deleted whenever its owner
  // likes: ask which are still there before offering a button that would fail.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Existence = new Map();
      for (const group of groups) {
        const query = new URLSearchParams({ project: group.project });
        for (const item of group.items) query.append("path", item.path);
        try {
          const response = await fetch(`/api/files/stat?${query.toString()}`, { cache: "no-store" });
          if (!response.ok) continue;
          const data = (await response.json()) as { files?: Array<{ path: string; exists: boolean }> };
          for (const file of data.files ?? []) next.set(keyOf(group.project, file.path), file.exists);
        } catch {
          // Unknown: the buttons stay, and a missing file says so when it is asked for.
        }
      }
      if (!cancelled) setExistence(next);
    })();
    void isTelegramAvailable().then((value) => {
      if (!cancelled) setTelegram(value);
    });
    return () => {
      cancelled = true;
    };
  }, [groups]);

  const rows = useMemo(() => {
    const all = groups.flatMap((group) => group.items.map((item) => ({ project: group.project, item })));
    return all.filter(({ project, item }) => existence?.get(keyOf(project, item.path)) !== false);
  }, [groups, existence]);

  const total = useMemo(() => {
    const stored = groups.reduce((sum, group) => sum + group.total, 0);
    const missing = groups.reduce((sum, group) => sum + group.items.length, 0) - rows.length;
    return Math.max(rows.length, stored - missing);
  }, [groups, rows.length]);

  if (rows.length === 0) return null;
  const shown = rows.slice(0, VISIBLE);
  const hidden = total - shown.length;
  // One archive per folder: the files of an answer are nearly always in one.
  const archiveGroup = groups.length === 1 ? groups[0] : null;

  const sendToTelegram = async (project: string, item: ProducedFile) => {
    const key = keyOf(project, item.path);
    setSent((current) => ({ ...current, [key]: "sending" }));
    try {
      const response = await fetch("/api/files/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, path: item.path, ...(chatId ? { chatId } : {}) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setNote(body?.error ?? t("files.produced.sendFailed"));
      }
      setSent((current) => ({ ...current, [key]: response.ok ? "sent" : "failed" }));
    } catch {
      setNote(t("files.produced.sendFailed"));
      setSent((current) => ({ ...current, [key]: "failed" }));
    }
  };

  const downloadAll = async () => {
    if (!archiveGroup) return;
    const result = await startZipDownload(archiveGroup.project, archiveGroup.items.map((item) => item.path));
    if (!result.ok) setNote(result.error);
    else if (result.check.skipped.secrets > 0) setNote(t("files.produced.skippedSecrets", { count: result.check.skipped.secrets }));
    else setNote(null);
  };

  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs" data-produced-files>
      <div className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground">
        <FileText className="size-3.5" aria-hidden />
        {t("files.produced.title")}
      </div>
      <ul className="divide-y divide-border/60">
        {shown.map(({ project, item }) => {
          const name = item.path.split("/").pop() ?? item.path;
          const folder = item.path.includes("/") ? item.path.slice(0, item.path.length - name.length - 1) : "";
          const key = keyOf(project, item.path);
          const state = sent[key];
          const Icon = IMAGE.test(name) ? ImageIcon : FileText;
          return (
            <li key={key} className="flex items-center gap-2 py-1.5">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{name}</span>
                <span className="block truncate text-muted-foreground">
                  {[folder, formatSize(item.size)].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {isOpenableFile(name) ? (
                  <a
                    href={fileDownloadUrl(project, item.path, { inline: true })}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                    title={`${t("files.open")} ${name}`}
                    aria-label={`${t("files.open")} ${name}`}
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                ) : null}
                <a
                  href={fileDownloadUrl(project, item.path)}
                  download={name}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                  title={`${t("common.download")} ${name}`}
                  aria-label={`${t("common.download")} ${name}`}
                >
                  <Download className="size-3.5" />
                </a>
                {telegram ? (
                  <button
                    type="button"
                    onClick={() => void sendToTelegram(project, item)}
                    disabled={state === "sending"}
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
                    title={state === "sent" ? t("files.produced.sent") : t("files.produced.sendToTelegram")}
                    aria-label={state === "sent" ? t("files.produced.sent") : t("files.produced.sendToTelegram")}
                  >
                    <Send className={`size-3.5 ${state === "sent" ? "text-success" : ""}`} />
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {hidden > 0 || (archiveGroup && rows.length > 1) ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          {hidden > 0 ? <span>{t("files.produced.more", { count: hidden })}</span> : null}
          {archiveGroup && rows.length > 1 ? (
            <button
              type="button"
              onClick={() => void downloadAll()}
              className="inline-flex min-h-6 items-center gap-1.5 underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
            >
              <FolderArchive className="size-3.5" aria-hidden />
              {t("files.produced.zipAll")}
            </button>
          ) : null}
        </div>
      ) : null}
      {note ? <p className="mt-1 text-muted-foreground" role="status">{note}</p> : null}
    </div>
  );
}
