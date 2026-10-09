"use client";

/**
 * A command that was run from the conversation, and what it printed.
 *
 * It is the same card under a code block in an answer (where the command is
 * already on screen above it) and on its own after a message that began with
 * `!` (where it is not). What it shows follows what a terminal would: output as
 * it arrives, a way to stop it, a line to answer a prompt on, and when it ends,
 * how. What it will *not* do is tell the agent anything unasked. A command the
 * person ran is theirs, its output may be anything, and every message to the
 * agent is billed; "show to the agent" is a button, not a side effect.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, CircleAlert, Copy, Loader2, Square, SquareTerminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/provider";
import { cn, copyTextToClipboard } from "@/lib/utils";
import { fencedBlock, formatOutput, lastChars } from "@/lib/terminal/format";
import { useShellRuns, type ShellRun } from "@/store/shell-runs";
import { useShellActions } from "@/components/chat/shell-actions";

const VISIBLE_LINES = 300;
const SHARED_OUTPUT_CHARS = 6000;

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

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

interface ShellRunViewProps {
  runKey: string;
  /** Show the command itself above the output, for a card that stands alone. */
  showCommand?: boolean;
  /** Offer to remove the card even while it is running. */
  alwaysDismissible?: boolean;
  className?: string;
}

export function ShellRunView({ runKey, showCommand = false, alwaysDismissible = false, className }: ShellRunViewProps) {
  const { t } = useI18n();
  const run = useShellRuns((state) => state.runs[runKey]);
  const actions = useShellActions();
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const outputRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  // A run that was going when the page loaded is followed again.
  useEffect(() => {
    useShellRuns.getState().resume(runKey);
  }, [runKey]);

  const running = run?.status === "running" || run?.status === "starting";
  const now = useNow(running);
  const shown = useMemo(() => formatOutput(run?.output ?? "", VISIBLE_LINES), [run?.output]);

  useEffect(() => {
    const element = outputRef.current;
    if (element && stickRef.current) element.scrollTop = element.scrollHeight;
  }, [shown.text]);

  if (!run) return null;

  const dismissible = alwaysDismissible || !running;
  const { status } = run;
  const duration = elapsed((run.endedAt ?? now) - run.startedAt);

  const statusLabel =
    status === "starting"
      ? t("terminal.run.starting")
      : status === "running"
        ? t("terminal.run.running", { time: duration })
        : status === "done"
          ? t("terminal.run.done", { time: duration })
          : status === "failed"
            ? run.reason === "timeout"
              ? t("terminal.run.timeout")
              : t("terminal.run.failed", { code: run.exitCode ?? "?" })
            : status === "stopped"
              ? t("terminal.run.stopped")
              : status === "lost"
                ? t("terminal.run.lost")
                : t("terminal.run.error", { reason: run.error ?? "" });

  const copyOutput = async () => {
    const ok = await copyTextToClipboard(shown.hiddenLines ? formatOutput(run.output, Number.MAX_SAFE_INTEGER).text : shown.text);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const showToAgent = () => {
    const whole = formatOutput(run.output, Number.MAX_SAFE_INTEGER).text;
    const tail = lastChars(whole, SHARED_OUTPUT_CHARS);
    const result =
      status === "done" || status === "failed"
        ? t("terminal.run.askExit", { code: run.exitCode ?? "?" })
        : status === "stopped"
          ? t("terminal.run.stopped")
          : "";
    const parts = [
      t("terminal.run.askIntro"),
      "",
      fencedBlock(run.command, "bash"),
      "",
      result,
      result ? "" : null,
      tail.text ? t("terminal.run.askOutput") : t("terminal.run.noOutput"),
      tail.cut ? t("terminal.run.askTruncated") : null,
      tail.text ? fencedBlock(tail.text) : null,
    ].filter((part): part is string => part !== null);
    actions.ask(parts.join("\n"));
  };

  const icon =
    status === "starting" || status === "running" ? (
      <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
    ) : status === "done" ? (
      <Check className="size-3.5 text-success" aria-hidden />
    ) : status === "stopped" || status === "lost" ? (
      <Square className="size-3.5 text-muted-foreground" aria-hidden />
    ) : (
      <CircleAlert className="size-3.5 text-destructive" aria-hidden />
    );

  return (
    // A container of its own: how much room the card has depends on the panels
    // open beside the chat, not on the window, so the labels follow the card.
    <div className={cn("@container overflow-hidden rounded-lg border bg-card text-card-foreground", className)} data-shell-run={run.status}>
      {showCommand ? (
        <div className="flex items-start gap-2 border-b bg-muted/60 px-3 py-2">
          <SquareTerminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs leading-5">{run.command}</code>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5">
        {/* Announced once, when the command ends: the seconds ticking by while
            it runs are not news, and a live region would read every one. */}
        <span role="status" className="sr-only">
          {running ? "" : statusLabel}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          <span className="truncate">{statusLabel}</span>
          {run.connection === "reconnecting" && running ? (
            <span className="shrink-0">· {t("terminal.run.reconnecting")}</span>
          ) : null}
        </span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {running ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-destructive hover:text-destructive"
              onClick={() => void useShellRuns.getState().stop(runKey)}
            >
              <Square className="size-3" />
              {t("terminal.run.stop")}
            </Button>
          ) : (
            <>
              {shown.text ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void copyOutput()}
                  aria-label={t("terminal.run.copy")}
                  title={t("terminal.run.copy")}
                >
                  {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  <span className="hidden @md:inline">{copied ? t("terminal.run.copied") : t("terminal.run.copy")}</span>
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={showToAgent}
                disabled={!actions.canAsk}
                aria-label={t("terminal.run.askAgent")}
                title={t("terminal.run.askAgent")}
              >
                <Bot className="size-3" />
                <span className="hidden @md:inline">{t("terminal.run.askAgent")}</span>
              </Button>
            </>
          )}
          {dismissible ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("terminal.run.dismiss")}
              title={t("terminal.run.dismiss")}
              onClick={() => useShellRuns.getState().dismiss(runKey)}
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </span>
      </div>

      {shown.text || shown.hiddenLines ? (
        <pre
          ref={outputRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          }}
          className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-5"
          tabIndex={0}
        >
          {shown.hiddenLines || run.droppedChars ? (
            <span className="mb-1 block text-muted-foreground">
              {shown.hiddenLines
                ? t("terminal.run.hiddenLines", { count: shown.hiddenLines })
                : t("terminal.run.earlierDropped")}
            </span>
          ) : null}
          {shown.text}
        </pre>
      ) : !running && status !== "error" ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t("terminal.run.noOutput")}</p>
      ) : null}

      {status === "error" && run.error ? (
        <p className="px-3 py-2 text-xs text-destructive">{run.error}</p>
      ) : null}

      {status === "running" ? (
        <form
          className="flex items-center gap-2 border-t px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft;
            setDraft("");
            void useShellRuns.getState().sendInput(runKey, text);
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("terminal.run.inputPlaceholder")}
            aria-label={t("terminal.run.inputPlaceholder")}
            className="h-7 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" size="xs" variant="outline">
            {t("terminal.run.send")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

export type { ShellRun };
