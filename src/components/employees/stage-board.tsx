"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronRight, Loader2 } from "lucide-react";
import { embeddedImageUrl } from "@/lib/files/openable";
import { employeeEggSvg } from "@/lib/employees/egg";
import { isPending, type Stage, type StageBoard as Board, type StageTone } from "@/lib/employees/stage";
import { useI18n } from "@/i18n/provider";
import { useAppStore } from "@/store/app-store";

/** A stage with something to look at, not only a title. */
function hasContent(stage: Stage): boolean {
  return Boolean(stage.image || stage.stat || stage.table || stage.cards?.length || stage.verdict);
}

/**
 * An employee's work as it happens: the stages on the left, what was found in
 * front, big. What is in front is the last stage that found something - the
 * stage still running says what it is doing in a line above it - so the
 * person always has a finished result to look at instead of a placeholder
 * that flashes between steps. A click on any finished step shows its result.
 */
export function StageBoard({ board, running, projectId }: { board: Board; running: boolean; projectId: string }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  const employeeId = useAppStore((state) => state.projects.find((project) => project.id === projectId)?.employee);

  const current = board.stages.find((stage) => stage.id === board.currentId);
  const lastWithContent = useMemo(() => [...board.stages].reverse().find((stage) => !isPending(stage) && hasContent(stage)), [board.stages]);
  const shownId = picked ?? (current && hasContent(current) ? current.id : lastWithContent?.id ?? current?.id);
  // A new finding takes the front again, even over a step the person clicked.
  useEffect(() => setPicked(null), [lastWithContent?.id]);
  const shown = board.stages.find((stage) => stage.id === shownId);
  const working = running && current && current.status === "running" ? current : null;
  const done = board.stages.filter((stage) => !isPending(stage) && stage.status !== "running").length;
  const progressLine = running ? t("employees.board.progress", { done, total: board.stages.length }) : t("employees.board.finished");

  return (
    <section className="overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm" data-slot="stage-board" aria-label={t("employees.board.label")}>
      <div className="grid md:grid-cols-[minmax(0,15.5rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1 border-b bg-muted/40 p-3 md:border-r md:border-b-0">
          <div className="mb-2 flex items-center gap-2.5 px-2.5 pt-1">
            {employeeId ? (
              <span
                className={`size-9 shrink-0 ${running ? "eggent-egg-hop" : ""}`}
                aria-hidden
                // Our own drawing, built from a fixed table: nothing from the model reaches it.
                dangerouslySetInnerHTML={{ __html: employeeEggSvg(employeeId) }}
              />
            ) : null}
            <span className="text-xs leading-4 text-muted-foreground" aria-live="polite">{progressLine}</span>
          </div>
          <ol className="flex flex-col gap-0.5">
            {board.stages.map((stage) => {
              const pending = isPending(stage);
              const selected = stage.id === shown?.id;
              const clickable = !pending && hasContent(stage);
              return (
                <li key={stage.id}>
                  <button
                    type="button"
                    onClick={() => clickable && setPicked(stage.id)}
                    disabled={!clickable}
                    aria-current={selected ? "step" : undefined}
                    className={`group/step flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150 ${
                      selected
                        ? "bg-background shadow-xs ring-1 ring-border"
                        : clickable
                          ? "cursor-pointer hover:bg-background hover:shadow-xs"
                          : "cursor-default"
                    } ${pending ? "opacity-45" : ""}`}
                  >
                    <StageMark stage={stage} running={running} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-5">{stage.title}</span>
                      {stage.detail && !pending ? <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">{stage.detail}</span> : null}
                    </span>
                    {clickable && !selected ? (
                      <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-40 transition-opacity group-hover/step:opacity-100" aria-hidden />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="min-w-0 p-4 sm:p-6">
          {working && working.id !== shown?.id ? (
            <p className="mb-4 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground">{working.title}</span>
                {working.detail ? ` — ${working.detail}` : ""}
              </span>
            </p>
          ) : null}
          {shown ? (
            <div key={shown.id} className="eggent-stage-in">
              <StageArtifact stage={shown} projectId={projectId} running={running} employeeId={employeeId} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function StageMark({ stage, running }: { stage: Stage; running: boolean }) {
  if (isPending(stage)) return <span className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />;
  if (stage.status === "warn") return <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />;
  if (stage.status === "done") return <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />;
  // A stage still marked running after the answer ended was simply never closed.
  if (!running) return <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
  return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />;
}

const TONE_BORDER: Record<StageTone, string> = {
  good: "border-l-success",
  bad: "border-l-destructive",
  neutral: "border-l-border",
};

const TONE_TEXT: Record<StageTone, string> = {
  good: "text-success",
  bad: "text-destructive",
  neutral: "text-foreground",
};

function StageArtifact({ stage, projectId, running, employeeId }: { stage: Stage; projectId: string; running: boolean; employeeId?: string }) {
  const image = stage.image ? embeddedImageUrl(stage.image, projectId) : null;
  const empty = !image && !stage.stat && !stage.table && !stage.cards?.length;
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h3 className="text-lg font-semibold leading-7">{stage.title}</h3>
        {stage.detail ? <p className="text-sm text-muted-foreground">{stage.detail}</p> : null}
      </header>

      {image ? (
        <figure className="overflow-hidden rounded-xl border bg-muted/30">
          {/* eslint-disable-next-line @next/next/no-img-element -- a file in the workspace, served by its own route */}
          <img src={image} alt={stage.caption || stage.title} className="block max-h-[28rem] w-full object-cover object-top" />
          {stage.caption ? <figcaption className="border-t px-3 py-2 text-xs text-muted-foreground">{stage.caption}</figcaption> : null}
        </figure>
      ) : null}

      {stage.stat ? (
        <div className="flex flex-col items-start gap-1 py-2">
          <span className={`text-5xl font-semibold tracking-tight tabular-nums ${TONE_TEXT[stage.stat.tone ?? "neutral"]}`}>{stage.stat.value}</span>
          {stage.stat.label ? <span className="text-sm text-muted-foreground">{stage.stat.label}</span> : null}
        </div>
      ) : null}

      {stage.cards?.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {stage.cards.map((card, index) => (
            <article key={`${card.title}-${index}`} className={`flex min-w-0 flex-col gap-1.5 rounded-xl border border-l-4 bg-background p-3 ${TONE_BORDER[card.tone ?? "neutral"]}`}>
              {/* The badge rides above the title: beside it, a long one squeezed the title into a column. */}
              {card.badge ? <span className="w-fit max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-[11px]/4 font-medium text-muted-foreground">{card.badge}</span> : null}
              <h4 className="text-sm font-medium leading-5 [overflow-wrap:anywhere]">{card.title}</h4>
              {card.body ? <p className="line-clamp-6 text-sm leading-5 whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">{card.body}</p> : null}
            </article>
          ))}
        </div>
      ) : null}

      {stage.table ? (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>{stage.table.columns.map((column, index) => <th key={index} className="px-3 py-2 font-medium">{column}</th>)}</tr>
            </thead>
            <tbody>
              {stage.table.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t">
                  {row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Nothing found yet anywhere: the employee at work, not grey blocks. */}
      {empty && running && stage.status === "running" ? (
        <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-6">
          {employeeId ? (
            <span className="size-12 shrink-0 eggent-egg-hop" aria-hidden dangerouslySetInnerHTML={{ __html: employeeEggSvg(employeeId) }} />
          ) : (
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
          )}
          <span className="text-sm text-muted-foreground">{stage.detail}</span>
        </div>
      ) : null}

      {stage.verdict ? (
        <p className={`rounded-xl border border-l-4 bg-background px-4 py-3 text-sm font-medium leading-5 ${TONE_BORDER[stage.verdict.tone ?? (stage.status === "warn" ? "bad" : "neutral")]}`}>
          {stage.verdict.text}
        </p>
      ) : null}
    </div>
  );
}
