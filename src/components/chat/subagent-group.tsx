"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  FileText,
  Globe,
  ImageIcon,
  Loader2,
  Plug,
  Search,
  Send,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { splitAgentResult, toolResultText } from "@/lib/pi/subagent-format";
import { toolActivity, type ToolActivity } from "@/lib/pi/tool-activity";
import type { SubagentSnapshot } from "@/lib/pi/types";

/**
 * The helpers a message started with the Agent tool, one row each.
 *
 * Until this existed a helper was a grey "Agent" box reading "Running..." until
 * it was done, and five of them were five of those - nobody could tell whether
 * anything was happening, what it was, or which one was stuck. A row now says
 * what its helper is doing this moment, how long it has been at it and how many
 * steps it has taken; opened, it shows the task it was given, every search and
 * page and file it went through, and what it came back with.
 */

export type HelperState = "running" | "done" | "failed" | "stopped" | "detached";

export interface HelperItem {
  toolCallId: string;
  input: Record<string, unknown>;
  /** The tool call's own state: still running, returned, or returned an error. */
  toolState: "running" | "output" | "error";
  output?: unknown;
  snapshot?: SubagentSnapshot;
}

interface SubagentGroupProps {
  items: HelperItem[];
  renderMarkdown: (content: string, key: string) => ReactNode;
}

const DETACHED_RESULT = /^Agent (?:started|queued) in background/i;

// What is open, remembered across remounts. When a turn ends the live message is
// replaced by the stored one, which mounts these components afresh; without
// this, a group someone was watching snapped shut the moment it finished.
const openGroups = new Map<string, boolean>();
const openRows = new Set<string>();

export function helperState(item: HelperItem): HelperState {
  const text = item.toolState === "running" ? "" : toolResultText(item.output);
  // A chat from before helpers were kept in their turn: the call returned at
  // once and the helper's own result never arrived. Saying "done" would be a lie.
  if (DETACHED_RESULT.test(text.trim())) return "detached";
  if (item.snapshot && item.snapshot.status !== "running") return item.snapshot.status;
  if (item.toolState === "running") return "running";
  if (item.toolState === "error") return "failed";
  return splitAgentResult(text).error ? "failed" : "done";
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function elapsedMs(snapshot: SubagentSnapshot | undefined, now: number): number | null {
  if (!snapshot?.startedAt) return null;
  const start = Date.parse(snapshot.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = snapshot.endedAt ? Date.parse(snapshot.endedAt) : now;
  return Number.isFinite(end) ? end - start : null;
}

/** A clock that ticks only while something on screen is still running. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const ACTIVITY_ICONS: Record<ToolActivity, React.ElementType> = {
  search: Search,
  page: Globe,
  files: FileText,
  command: Terminal,
  helper: Bot,
  service: Plug,
  image: ImageIcon,
  send: Send,
  work: Wrench,
};

function StatusIcon({ state, label }: { state: HelperState; label: string }) {
  const common = "size-4 shrink-0";
  const icon =
    state === "running" ? <Loader2 className={`${common} animate-spin text-muted-foreground`} aria-hidden /> :
    state === "done" ? <CircleCheck className={`${common} text-success`} aria-hidden /> :
    state === "failed" ? <CircleX className={`${common} text-destructive`} aria-hidden /> :
    state === "detached" ? <CircleDashed className={`${common} text-muted-foreground`} aria-hidden /> :
    <CircleSlash className={`${common} text-muted-foreground`} aria-hidden />;
  return (
    <span className="mt-0.5 inline-flex" title={label}>
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function SubagentGroup({ items, renderMarkdown }: SubagentGroupProps) {
  const { t } = useI18n();
  const states = items.map(helperState);
  const running = states.filter((state) => state === "running").length;
  const failed = states.filter((state) => state === "failed").length;
  const stopped = states.filter((state) => state === "stopped" || state === "detached").length;
  const finished = items.length - running;
  // Open while they work, so nobody has to go looking; a finished set from
  // history starts folded. Decided once per group, so the rows do not snap shut
  // under someone reading them the moment the last helper reports.
  const groupKey = items[0]?.toolCallId ?? "";
  const [expanded, setExpandedState] = useState(() => {
    const remembered = openGroups.get(groupKey);
    if (remembered !== undefined) return remembered;
    openGroups.set(groupKey, running > 0);
    return running > 0;
  });
  const setExpanded = (update: (value: boolean) => boolean) => {
    setExpandedState((value) => {
      const next = update(value);
      openGroups.set(groupKey, next);
      return next;
    });
  };
  const now = useNow(running > 0);

  const starts = items
    .map((item) => (item.snapshot?.startedAt ? Date.parse(item.snapshot.startedAt) : NaN))
    .filter(Number.isFinite);
  const ends = items.map((item, index) =>
    states[index] === "running" ? now : item.snapshot?.endedAt ? Date.parse(item.snapshot.endedAt) : NaN
  );
  const groupElapsed = starts.length && ends.every(Number.isFinite)
    ? formatElapsed(Math.max(...ends) - Math.min(...starts))
    : null;

  const summary = running > 0
    ? t("chat.helpers.summary.working", { done: finished, total: items.length })
    : [
        failed === 0 && stopped === 0 ? t("chat.helpers.summary.finished") : null,
        failed > 0 ? t("chat.helpers.summary.failed", { count: failed }) : null,
        stopped > 0 ? t("chat.helpers.summary.stopped", { count: stopped }) : null,
      ].filter(Boolean).join(" · ");

  return (
    <div className="rounded-lg border bg-card/40" data-helpers={running > 0 ? "running" : "finished"}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Users className="size-3.5 shrink-0" />
        <span className="font-medium">{t("chat.helpers.title")}</span>
        {/* Pinned leading, as in the tools group: an arbitrary size resets it. */}
        <span className="inline-flex min-w-5 justify-center rounded-full bg-muted px-1.5 py-0.5 text-[11px]/4 font-medium tabular-nums text-foreground">
          {items.length}
        </span>
        <span className="truncate" aria-live="polite">{summary}</span>
        {groupElapsed ? <span className="ml-auto shrink-0 tabular-nums">{groupElapsed}</span> : null}
      </button>

      {expanded ? (
        <ul className="divide-y border-t">
          {items.map((item, index) => (
            <HelperRow
              key={item.toolCallId}
              item={item}
              state={states[index]}
              now={now}
              renderMarkdown={renderMarkdown}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function HelperRow({
  item,
  state,
  now,
  renderMarkdown,
}: {
  item: HelperItem;
  state: HelperState;
  now: number;
  renderMarkdown: (content: string, key: string) => ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpenState] = useState(() => openRows.has(item.toolCallId));
  const setOpen = (update: (value: boolean) => boolean) => {
    setOpenState((value) => {
      const next = update(value);
      if (next) openRows.add(item.toolCallId);
      else openRows.delete(item.toolCallId);
      return next;
    });
  };
  const snapshot = item.snapshot;
  const description =
    (typeof item.input.description === "string" && item.input.description.trim()) ||
    snapshot?.description ||
    t("chat.helpers.title");
  const agentType =
    snapshot?.agentType ?? (typeof item.input.subagent_type === "string" ? item.input.subagent_type : undefined);
  const showType = agentType && agentType.toLowerCase() !== "general-purpose";
  const prompt = typeof item.input.prompt === "string" ? item.input.prompt.trim() : "";
  const elapsed = elapsedMs(snapshot, now);
  const steps = snapshot?.toolUses ?? snapshot?.steps.length ?? 0;
  const { result, error } = state === "running" ? { result: "", error: undefined } : splitAgentResult(toolResultText(item.output));
  const failure = snapshot?.error ?? error;

  const doing = (() => {
    const current = snapshot?.now;
    if (!current || current.kind === "thinking") return t("chat.helpers.now.thinking");
    if (current.kind === "queued") return t("chat.helpers.now.queued");
    if (current.kind === "writing") return t("chat.helpers.now.writing");
    const tool = current.tools?.[0] ?? "";
    const activity = toolActivity(tool);
    return activity === "work"
      ? t("chat.helpers.now.work", { tool })
      : t(`chat.helpers.now.${activity}` as MessageKey);
  })();

  const subline =
    state === "running" ? doing :
    state === "failed" ? failure || t("chat.helpers.status.failed") :
    state === "detached" ? t("chat.helpers.detachedNote") :
    state === "stopped" ? t("chat.helpers.status.stopped") :
    firstLine(result, description) || t("chat.helpers.status.done");

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <StatusIcon state={state} label={t(`chat.helpers.status.${state}` as MessageKey)} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">{description}</span>
            {showType ? (
              <span className="shrink-0 rounded bg-muted px-1.5 text-[11px]/4 text-muted-foreground">{agentType}</span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-baseline gap-2 text-xs tabular-nums text-muted-foreground">
              {steps > 0 ? <span>{t("chat.helpers.steps", { count: steps })}</span> : null}
              {elapsed !== null ? <span>{formatElapsed(elapsed)}</span> : null}
            </span>
          </span>
          <span
            className={`block truncate text-xs ${state === "failed" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {subline}
          </span>
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-3 px-3 pb-3 pl-9 text-sm">
          {prompt ? (
            <section>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("chat.helpers.task")}</h4>
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted/50 px-2 py-1.5 text-xs leading-5 text-foreground/90">
                {prompt}
              </p>
            </section>
          ) : null}

          {snapshot ? (
            <section>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("chat.helpers.whatItDid")}</h4>
              {snapshot.steps.length ? (
                <ol className="flex flex-col gap-1 text-xs leading-5">
                  {snapshot.earlierSteps ? (
                    <li className="text-muted-foreground">{t("chat.helpers.earlierSteps", { count: snapshot.earlierSteps })}</li>
                  ) : null}
                  {snapshot.steps.map((step, index) => {
                    const activity = toolActivity(step.tool);
                    const Icon = ACTIVITY_ICONS[activity];
                    const kind = stepKind(step.tool, activity);
                    return (
                      <li key={index} className="flex min-w-0 items-start gap-2">
                        <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="shrink-0 text-muted-foreground">
                          {kind === "work" ? step.tool : t(`chat.helpers.step.${kind}` as MessageKey)}
                        </span>
                        {step.target ? <span className="min-w-0 break-words text-foreground/90">{step.target}</span> : null}
                        {step.failed ? (
                          <span className="shrink-0 text-destructive">{t("chat.helpers.stepFailed")}</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {state === "running" ? doing : t("chat.helpers.noSteps")}
                </p>
              )}
            </section>
          ) : null}

          {state !== "running" && state !== "detached" ? (
            <section>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("chat.helpers.result")}</h4>
              {failure ? <p className="mb-1 text-xs text-destructive">{failure}</p> : null}
              {result ? (
                <div className="max-h-96 overflow-y-auto rounded border bg-background/60 px-3 py-2">
                  {renderMarkdown(result, `helper-result-${item.toolCallId}`)}
                </div>
              ) : failure ? null : (
                <p className="text-xs text-muted-foreground">{t("chat.helpers.noResult")}</p>
              )}
            </section>
          ) : null}

          {snapshot && (snapshot.model || snapshot.tokens) ? (
            <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {snapshot.model ? <span>{t("chat.helpers.meta.model", { model: snapshot.model })}</span> : null}
              {snapshot.tokens ? (
                <span className="tabular-nums">{t("chat.helpers.meta.tokens", { count: formatCount(snapshot.tokens) })}</span>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The first line of a result that says something - not a heading repeating the helper's name. */
function firstLine(text: string, name: string): string {
  const plain = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const title = plain(name);
  const line = text
    .split("\n")
    .map((part) => part.replace(/^[#>*\-\s\d.]+/, "").replace(/\*\*/g, "").trim())
    .find((part) => part && plain(part) !== title);
  return line ?? "";
}

/** Files are one activity while a helper works, but four different things it did. */
function stepKind(tool: string, activity: ToolActivity): string {
  const name = tool.toLowerCase();
  if (name === "read") return "read";
  if (name === "write") return "write";
  if (name === "edit") return "edit";
  if (name === "grep") return "grep";
  if (name === "ls" || name === "find") return "list";
  return activity;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
