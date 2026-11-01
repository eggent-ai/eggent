"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { embeddedImageUrl } from "@/lib/files/openable";
import { isPending, type Stage, type StageBoard as Board, type StageTone } from "@/lib/employees/stage";
import { useI18n } from "@/i18n/provider";

/**
 * An employee's work as it happens: the stages on the left, what the current
 * one found in front, big. Built from the eggent_stage calls of one answer.
 */
export function StageBoard({ board, running, projectId }: { board: Board; running: boolean; projectId: string }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  // While the work runs the screen follows it; a stage the person clicked
  // stays in front until the next one starts.
  useEffect(() => setPicked(null), [board.currentId]);
  const shown = board.stages.find((stage) => stage.id === (picked ?? board.currentId)) ?? board.stages.at(-1);
  const done = board.stages.filter((stage) => !isPending(stage) && stage.status !== "running").length;

  return (
    <section
      className="overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm"
      data-slot="stage-board"
      aria-label={t("employees.board.label")}
    >
      <div className="grid md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <ol className="flex flex-col gap-0.5 border-b bg-muted/40 p-3 md:border-r md:border-b-0">
          {board.stages.map((stage) => (
            <li key={stage.id}>
              <button
                type="button"
                onClick={() => setPicked(stage.id)}
                disabled={isPending(stage)}
                aria-current={stage.id === shown?.id ? "step" : undefined}
                className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  stage.id === shown?.id ? "bg-background shadow-xs" : "hover:bg-background/60"
                } disabled:cursor-default disabled:opacity-50`}
              >
                <StageMark stage={stage} running={running} />
                <span className="min-w-0">
                  <span className="block font-medium leading-5">{stage.title}</span>
                  {stage.detail && !isPending(stage) ? (
                    <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">{stage.detail}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
          <li className="mt-2 px-2.5 text-xs text-muted-foreground" aria-live="polite">
            {running
              ? t("employees.board.progress", { done, total: board.stages.length })
              : t("employees.board.finished")}
          </li>
        </ol>
        <div className="min-w-0 p-4 sm:p-6">{shown ? <StageArtifact stage={shown} projectId={projectId} running={running} /> : null}</div>
      </div>
    </section>
  );
}

function StageMark({ stage, running }: { stage: Stage; running: boolean }) {
  if (isPending(stage)) return <span className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />;
  if (stage.status === "warn") return <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />;
  if (stage.status === "done") return <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />;
  // A stage still marked running after the answer ended was simply never closed.
  if (!running) return <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
  return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />;
}

const TONE_BORDER: Record<StageTone, string> = {
  good: "border-success",
  bad: "border-destructive",
  neutral: "border-border",
};

const TONE_TEXT: Record<StageTone, string> = {
  good: "text-success",
  bad: "text-destructive",
  neutral: "text-foreground",
};

function StageArtifact({ stage, projectId, running }: { stage: Stage; projectId: string; running: boolean }) {
  const image = stage.image ? embeddedImageUrl(stage.image, projectId) : null;
  const empty = !image && !stage.stat && !stage.table && !stage.cards?.length;
  return (
    <div className="flex flex-col gap-4" key={stage.id}>
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
            <article key={`${card.title}-${index}`} className={`flex flex-col gap-1.5 rounded-xl border-l-4 border bg-background p-3 ${TONE_BORDER[card.tone ?? "neutral"]}`}>
              <div className="flex items-start justify-between gap-2">
                <h4 className="text-sm font-medium leading-5">{card.title}</h4>
                {card.badge ? <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px]/4 font-medium">{card.badge}</span> : null}
              </div>
              {card.body ? <p className="line-clamp-6 text-sm leading-5 text-muted-foreground whitespace-pre-line">{card.body}</p> : null}
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

      {empty && running && stage.status === "running" ? <ArtifactShape /> : null}

      {stage.verdict ? (
        <p className={`rounded-xl border-l-4 border bg-background px-4 py-3 text-sm font-medium leading-5 ${TONE_BORDER[stage.verdict.tone ?? (stage.status === "warn" ? "bad" : "neutral")]}`}>
          {stage.verdict.text}
        </p>
      ) : null}
    </div>
  );
}

/** Shape, not words, while a stage has nothing to show yet. */
function ArtifactShape() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
    </div>
  );
}
