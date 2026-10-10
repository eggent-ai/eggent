"use client";

import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  FileArchive,
  FileText,
  Loader2,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { SettingsScopeSelect, useSettingsScope } from "@/components/settings-scope";
import { SettingsPageHeader, SettingsShell } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { formatUploadSize } from "@/lib/files/upload-limits";
import { settingsScopeHref } from "@/lib/orchestrator-scope";
import { SKILL_ARCHIVE_MAX_BYTES, SKILL_UPLOAD_EXTENSIONS, skillUploadKind } from "@/lib/skills/limits";
import { cn } from "@/lib/utils";

type ItemStatus = "queued" | "working" | "done" | "failed";

interface UploadItem {
  id: string;
  file: File;
  status: ItemStatus;
  /** What is wrong, in the workspace's language. More than one when the header has several faults. */
  problems: string[];
  /** The server's code for the first problem; an existing skill is a question, not an error. */
  code?: string;
  skill?: string;
  replaced?: boolean;
  keptAs?: string | null;
  notes: string[];
}

export default function UploadSkillPage() {
  const { t } = useI18n();
  const scope = useSettingsScope();
  const { scopeId } = scope;
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [summary, setSummary] = useState<{ ok: number; total: number } | null>(null);
  const nextId = useRef(0);

  const skillsHref = settingsScopeHref("/dashboard/skills", scopeId);
  const queued = items.filter((item) => item.status === "queued");
  const anyDone = items.some((item) => item.status === "done");

  function patchItem(id: string, patch: Partial<UploadItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function addFiles(files: Iterable<File>) {
    const added: UploadItem[] = [];
    for (const file of files) {
      const id = String((nextId.current += 1));
      // The same refusals the server makes, made before the file is sent: a file
      // that cannot be a skill is not worth uploading to be told so.
      let problem: string | null = null;
      if (!skillUploadKind(file.name)) problem = t("skills.upload.error.unsupportedType", { name: file.name });
      else if (file.size === 0) problem = t("skills.upload.error.empty");
      else if (file.size > SKILL_ARCHIVE_MAX_BYTES) {
        problem = t("skills.upload.error.tooLarge", {
          size: formatUploadSize(file.size),
          limit: formatUploadSize(SKILL_ARCHIVE_MAX_BYTES),
        });
      }
      added.push({
        id,
        file,
        status: problem ? "failed" : "queued",
        problems: problem ? [problem] : [],
        notes: [],
      });
    }
    if (added.length > 0) {
      setSummary(null);
      setItems((current) => [...current, ...added]);
    }
  }

  function handleChoose(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []));
    // Choosing the same file again, after fixing it, has to count as a choice.
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    addFiles(Array.from(event.dataTransfer.files));
  }

  function handleDragLeave(event: DragEvent<HTMLLabelElement>) {
    // Moving over the zone's own children fires a leave on the zone as well.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  }

  async function send(item: UploadItem, replace: boolean): Promise<boolean> {
    patchItem(item.id, { status: "working", problems: [], code: undefined });
    try {
      const body = new FormData();
      body.set("file", item.file);
      if (replace) body.set("replace", "1");
      const response = await fetch(`/api/projects/${encodeURIComponent(scopeId)}/skills/upload`, {
        method: "POST",
        body,
      });
      const payload: unknown = await response.json().catch(() => null);
      const data = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;

      if (response.ok && data.ok === true) {
        patchItem(item.id, {
          status: "done",
          skill: typeof data.skill === "string" ? data.skill : undefined,
          replaced: data.replaced === true,
          keptAs: typeof data.keptAs === "string" ? data.keptAs : null,
          notes: Array.isArray(data.notes) ? data.notes.filter((note): note is string => typeof note === "string") : [],
        });
        return true;
      }

      // The guard answers in a sentence of its own; what the person can act on
      // is that they are signed out, or that the page is not the one they opened.
      const refused = response.status === 401 || response.status === 403;
      const problems = refused
        ? [t("skills.upload.error.notAllowed")]
        : Array.isArray(data.problems)
          ? data.problems.filter((problem): problem is string => typeof problem === "string")
          : [];
      patchItem(item.id, {
        status: "failed",
        problems: problems.length > 0 ? problems : [t("skills.upload.error.badRequest")],
        code: typeof data.code === "string" ? data.code : undefined,
      });
    } catch {
      patchItem(item.id, { status: "failed", problems: [t("skills.upload.error.network")] });
    }
    return false;
  }

  async function handleUpload() {
    if (busy || queued.length === 0) return;
    setBusy(true);
    setSummary(null);
    let ok = 0;
    // One at a time: each file gets its own answer, and two files that carry
    // the same skill name must not race to be the first.
    for (const item of queued) {
      if (await send(item, false)) ok += 1;
    }
    setSummary({ ok, total: queued.length });
    setBusy(false);
  }

  async function handleReplace(item: UploadItem) {
    if (busy) return;
    setBusy(true);
    setSummary(null);
    const ok = await send(item, true);
    setSummary({ ok: ok ? 1 : 0, total: 1 });
    setBusy(false);
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
  }

  return (
    <SettingsShell title={t("skills.upload.title")}>
      <Link
        href={skillsHref}
        className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t("skills.upload.back")}
      </Link>

      <SettingsPageHeader
        title={t("skills.upload.title")}
        description={t("skills.upload.description")}
        scope={<SettingsScopeSelect scope={scope} />}
      />

      <section className="space-y-3" aria-labelledby="skill-file-heading">
        <h3 id="skill-file-heading" className="text-sm font-medium">
          {t("skills.upload.fileLabel")}
        </h3>
        <label
          onDragEnter={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "flex min-h-40 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground transition-colors",
            "hover:bg-muted/40 has-[:focus-visible]:border-ring has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring",
            dragging && "border-primary bg-primary/5 text-foreground",
            busy && "pointer-events-none opacity-60"
          )}
        >
          <input
            type="file"
            multiple
            accept={SKILL_UPLOAD_EXTENSIONS.join(",")}
            className="sr-only"
            disabled={busy}
            onChange={handleChoose}
          />
          <Upload className="size-5" aria-hidden="true" />
          <span>{dragging ? t("skills.upload.dropActive") : t("skills.upload.drop")}</span>
        </label>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground marker:text-muted-foreground/60">
          <li>{t("skills.upload.hintMarkdown")}</li>
          <li>{t("skills.upload.hintArchive")}</li>
        </ul>
      </section>

      {items.length > 0 ? (
        <ul className="space-y-2" aria-live="polite">
          {items.map((item) => {
            const isArchive = skillUploadKind(item.file.name) === "archive";
            const Icon = isArchive ? FileArchive : FileText;
            const removable = !busy && (item.status === "queued" || item.status === "failed");
            return (
              <li key={item.id} className="flex items-start gap-3 rounded-lg border bg-card p-3">
                <div className="mt-0.5 shrink-0 rounded bg-primary/10 p-2">
                  <Icon className="size-4 text-primary" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                    <span className="break-all">{item.file.name}</span>
                    <span className="text-xs font-normal text-muted-foreground">{formatUploadSize(item.file.size)}</span>
                  </p>

                  {item.status === "queued" ? (
                    <p className="text-xs text-muted-foreground">{t("skills.upload.status.queued")}</p>
                  ) : null}

                  {item.status === "working" ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      {t("skills.upload.status.working")}
                    </p>
                  ) : null}

                  {item.status === "done" ? (
                    <div className="space-y-1">
                      <p className="flex items-start gap-1.5 text-xs text-success">
                        <CircleCheck className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                        <span>
                          {item.replaced
                            ? t("skills.upload.replaced", { skill: item.skill ?? "", kept: item.keptAs ?? "" })
                            : t("skills.upload.installed", { skill: item.skill ?? "" })}
                        </span>
                      </p>
                      {item.notes.map((note) => (
                        <p key={note} className="pl-5 text-xs text-muted-foreground">
                          {note}
                        </p>
                      ))}
                    </div>
                  ) : null}

                  {item.status === "failed" ? (
                    <div className="space-y-2">
                      <div className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
                        <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                        {item.problems.length > 1 ? (
                          <ul className="list-disc space-y-0.5 pl-4">
                            {item.problems.map((problem) => (
                              <li key={problem}>{problem}</li>
                            ))}
                          </ul>
                        ) : (
                          <p>{item.problems[0]}</p>
                        )}
                      </div>
                      {item.code === "exists" ? (
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => handleReplace(item)}>
                          {t("skills.upload.replace")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {removable ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={t("skills.upload.remove", { name: item.file.name })}
                    onClick={() => removeItem(item.id)}
                  >
                    <X />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex flex-col gap-1.5 rounded-xl border bg-card px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            {t("skills.upload.checksTitle")}
          </h3>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("skills.upload.checksNote")}</p>
        </div>
        <span className="shrink-0 text-sm text-muted-foreground">{t("skills.upload.checksWhen")}</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={busy || queued.length === 0} onClick={handleUpload}>
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("skills.upload.uploading")}
            </>
          ) : (
            t("skills.upload.upload")
          )}
        </Button>
        <Button asChild variant="outline">
          <Link href={skillsHref}>{anyDone ? t("skills.upload.backToSkills") : t("skills.upload.cancel")}</Link>
        </Button>
        <p role="status" className="text-sm text-muted-foreground">
          {summary
            ? t("skills.upload.summary", { ok: summary.ok, total: summary.total })
            : queued.length > 0
              ? t("skills.upload.ready", { count: queued.length })
              : items.length === 0
                ? t("skills.upload.chooseFile")
                : ""}
        </p>
      </div>
    </SettingsShell>
  );
}
