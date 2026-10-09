"use client";

/**
 * The terminal, in a panel of its own beside the file tree.
 *
 * The agent works in a shell; this is the same shell's neighbour, for the
 * moments a person wants to look at something themselves - `ls`, `git status`,
 * a log that is still being written - without asking in a sentence and waiting
 * for a model to type it. It starts where the agent works, in the project's
 * folder, and is one terminal per project.
 *
 * The panel only lends the terminal a place on the page. The terminal itself
 * lives in `panel-session.ts` and outlasts this component, because every
 * dashboard page mounts a panel of its own and moving between pages must not
 * take a running program with it.
 */
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Loader2, RotateCw, SquareTerminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import {
  clampTerminalPanelWidth,
  readTerminalPanelPreference,
  useAppStore,
} from "@/store/app-store";
import {
  focusTerminal,
  hideTerminal,
  restartTerminal,
  showTerminal,
  usePanelSessions,
  type PanelInfo,
} from "@/lib/terminal/panel-session";

const KEYBOARD_STEP_PX = 24;

function closedMessageKey(info: PanelInfo): MessageKey {
  switch (info.reason) {
    case "exit":
      return "terminal.panel.closed.exit";
    case "stopped":
      return "terminal.panel.closed.stopped";
    case "idle":
      return "terminal.panel.closed.idle";
    case "detached":
      return "terminal.panel.closed.detached";
    case "shutdown":
    case "lost":
      return "terminal.panel.closed.shutdown";
    case "timeout":
      return "terminal.panel.closed.timeout";
    default:
      return "terminal.panel.closed.error";
  }
}

export function TerminalPanel() {
  const { t } = useI18n();
  const open = useAppStore((state) => state.terminalPanelOpen);
  const width = useAppStore((state) => state.terminalPanelWidth);
  const filesOpen = useAppStore((state) => state.filesPanelOpen);
  const setOpen = useAppStore((state) => state.setTerminalPanelOpen);
  const setWidth = useAppStore((state) => state.setTerminalPanelWidth);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const projects = useAppStore((state) => state.projects);
  const scope = activeProjectId ?? "none";
  const info = usePanelSessions((state) => state.info[scope]);
  const status = info?.status ?? "idle";
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);

  const projectName = activeProjectId
    ? projects.find((project) => project.id === activeProjectId)?.name ?? activeProjectId
    : t("nav.orchestrator");

  // After mount, not as the store's initial value: the server renders this too.
  useEffect(() => {
    const preference = readTerminalPanelPreference();
    setWidth(preference.width, false);
    if (preference.open) setOpen(true);
  }, [setOpen, setWidth]);

  // A shell is started when the panel is opened, never before: most visits
  // never want one, and each is a process in a container with a memory limit.
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    void showTerminal(scope, activeProjectId, container).then(() => {
      if (!cancelled) focusTerminal(scope);
    });
    return () => {
      cancelled = true;
      // Stop reading, not stop the shell: it is kept a while, so closing the
      // panel by mistake or moving to another page is not the end of it.
      hideTerminal(scope);
    };
  }, [open, scope, activeProjectId]);

  const startResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      setResizing(true);
      const move = (moved: globalThis.PointerEvent) => setWidth(startWidth + (startX - moved.clientX), false);
      const finish = () => {
        window.removeEventListener("pointermove", move);
        setResizing(false);
        setWidth(useAppStore.getState().terminalPanelWidth, true);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish, { once: true });
      window.addEventListener("pointercancel", finish, { once: true });
    },
    [setWidth, width]
  );

  const resizeWithKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX;
    setWidth(clampTerminalPanelWidth(width + delta), true);
  };

  const restart = () => void restartTerminal(scope);
  const closed = status === "closed";
  const showOverlay = status === "starting" || status === "unavailable" || status === "error";

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label={t("terminal.panel.close")}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
        />
      ) : null}
      <aside
        data-state={open ? "open" : "closed"}
        data-resizing={resizing ? "true" : "false"}
        aria-label={t("terminal.panel.title")}
        // Not reachable by Tab while it has no width: a terminal that is not on
        // screen must not hold the keyboard.
        inert={!open}
        style={{
          ["--terminal-width" as string]: `${width}px`,
          // However wide it was left, it never takes the room the conversation
          // needs: on a narrow window the chosen width is a wish, and the
          // terminal gives way down to a floor of its own.
          ["--terminal-max" as string]: `calc(100vw - var(--sidebar-width, 16rem) - 24rem${filesOpen ? " - 20rem" : ""})`,
        }}
        className={[
          "sticky top-[var(--header-height,3.5rem)] h-[calc(100svh-var(--header-height,3.5rem))] shrink-0 overflow-hidden border-l bg-background",
          "transition-[width,transform] duration-200 ease-out motion-reduce:transition-none data-[resizing=true]:transition-none",
          "max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-50 max-md:h-auto max-md:w-[min(100vw,32rem)]",
          "max-md:data-[state=closed]:translate-x-full max-md:data-[state=open]:translate-x-0",
          "md:data-[state=closed]:w-0 md:data-[state=open]:w-(--terminal-width) md:data-[state=open]:max-w-(--terminal-max) md:data-[state=open]:min-w-80",
        ].join(" ")}
      >
        {/* Its own width, not the panel's: the terminal inside does not reflow
            while the panel opens, and a closed panel does not shrink it to a
            sliver that the program then draws for. */}
        <div className="relative flex h-full w-[min(100vw,32rem)] flex-col md:w-full md:min-w-80">
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("terminal.panel.resize")}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={resizeWithKeys}
            className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize touch-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none md:block"
          />

          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
              <SquareTerminal className="size-4 shrink-0" />
              <span>{t("terminal.panel.title")}</span>
              <span className="truncate font-normal text-muted-foreground">· {projectName}</span>
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={restart}
                disabled={status === "starting" || status === "unavailable"}
                aria-label={t("terminal.panel.restart")}
                title={t("terminal.panel.restart")}
              >
                <RotateCw className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(false)}
                aria-label={t("terminal.panel.close")}
                title={t("terminal.panel.close")}
              >
                <X className="size-4" />
              </Button>
            </span>
          </div>

          {status === "reconnecting" ? (
            <div role="status" className="border-b bg-muted/60 px-3 py-1 text-xs text-muted-foreground">
              {t("terminal.panel.reconnecting")}
            </div>
          ) : null}

          <div className="relative min-h-0 flex-1">
            <div
              ref={containerRef}
              className="absolute inset-0 overflow-hidden px-2 py-1.5 data-[resizing=true]:pointer-events-none"
              data-resizing={resizing ? "true" : "false"}
            />
            {showOverlay ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 px-6 text-center text-sm text-muted-foreground">
                {status === "starting" ? (
                  <>
                    <Loader2 className="size-5 animate-spin" aria-hidden />
                    <span role="status">{t("terminal.panel.starting")}</span>
                  </>
                ) : status === "unavailable" ? (
                  <span>{t("terminal.panel.unavailable")}</span>
                ) : (
                  <>
                    <span role="alert">{t("terminal.panel.error", { reason: info?.error ?? "" })}</span>
                    <Button variant="outline" size="sm" onClick={restart}>
                      {t("terminal.panel.tryAgain")}
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </div>

          {closed && info ? (
            <div className="flex items-center justify-between gap-2 border-t bg-muted/60 px-3 py-2 text-xs">
              <span role="status" className="min-w-0 text-muted-foreground">
                {t(closedMessageKey(info), { code: info.exitCode ?? "?" })}
              </span>
              <Button variant="outline" size="xs" onClick={restart} className="shrink-0">
                {t("terminal.panel.startAgain")}
              </Button>
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}

/** The button that opens it, beside the one for the files. */
export function TerminalPanelTrigger() {
  const { t } = useI18n();
  const open = useAppStore((state) => state.terminalPanelOpen);
  const toggle = useAppStore((state) => state.toggleTerminalPanel);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      onClick={toggle}
      aria-label={t("terminal.panel.toggle")}
      aria-pressed={open}
      title={t("terminal.panel.toggle")}
    >
      <SquareTerminal className="size-4" />
    </Button>
  );
}
