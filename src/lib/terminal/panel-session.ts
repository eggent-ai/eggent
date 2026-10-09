/**
 * The terminal in the side panel, outside any one screen.
 *
 * Every dashboard page mounts a panel of its own, so a terminal that lived in
 * the component that drew it would be thrown away every time somebody opened a
 * file or went to settings: the scrollback, the cursor, the program that was
 * half way through printing. The terminal itself - the xterm instance, the
 * reader on the server's output, the keystrokes waiting to go - lives here, at
 * module level, one per project, and a panel that mounts only lends it a place
 * on the page.
 *
 * Only the terminal that is on screen is *attached*, which means being read
 * from the server. Switching to another project detaches the old one; the
 * server keeps its shell for a few minutes and hands everything back when it is
 * asked for again, and closes it if nobody does. That is what keeps a handful
 * of projects from holding a handful of idle shells open.
 *
 * xterm is loaded when the first terminal is opened, not with the page: it is
 * a few hundred kilobytes that most visits never need.
 */
import { create } from "zustand";
import type { Terminal, ITheme } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import {
  createTerminalJob,
  followTerminalJob,
  resizeTerminal,
  sendTerminalInput,
  stopTerminalJob,
  TerminalApiError,
  type Follower,
} from "@/lib/terminal/client";
import type { TerminalCloseReason } from "@/lib/terminal/protocol";

export type PanelStatus = "idle" | "starting" | "live" | "reconnecting" | "closed" | "unavailable" | "error";

export interface PanelInfo {
  status: PanelStatus;
  /** Why it closed; "lost" when the server no longer knows the shell. */
  reason: TerminalCloseReason | "lost" | null;
  exitCode: number | null;
  error: string | null;
}

const IDLE: PanelInfo = { status: "idle", reason: null, exitCode: null, error: null };

export const usePanelSessions = create<{ info: Record<string, PanelInfo> }>(() => ({ info: {} }));

function setInfo(scope: string, changes: Partial<PanelInfo>): void {
  usePanelSessions.setState((state) => ({
    info: { ...state.info, [scope]: { ...(state.info[scope] ?? IDLE), ...changes } },
  }));
}

interface Live {
  scope: string;
  projectId: string | null;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  opened: boolean;
  jobId: string | null;
  follower: Follower | null;
  offset: number;
  closed: boolean;
  inputQueue: string;
  sending: boolean;
  resizeTimer: ReturnType<typeof setTimeout> | null;
  observer: ResizeObserver | null;
  starting: Promise<void> | null;
}

const lives = new Map<string, Live>();

const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// ANSI colours chosen against each background, not xterm's defaults, which are
// tuned for black: yellow and white on a light page are close to invisible.
const LIGHT_PALETTE: ITheme = {
  black: "#1f2937",
  red: "#b91c1c",
  green: "#166534",
  yellow: "#854d0e",
  blue: "#1d4ed8",
  magenta: "#86198f",
  cyan: "#155e75",
  white: "#4b5563",
  brightBlack: "#6b7280",
  brightRed: "#dc2626",
  brightGreen: "#15803d",
  brightYellow: "#a16207",
  brightBlue: "#2563eb",
  brightMagenta: "#a21caf",
  brightCyan: "#0e7490",
  brightWhite: "#111827",
};
const DARK_PALETTE: ITheme = {
  black: "#4b5563",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#e879f9",
  cyan: "#22d3ee",
  white: "#e5e7eb",
  brightBlack: "#9ca3af",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#f0abfc",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

let scratch: CanvasRenderingContext2D | null = null;

/**
 * A CSS colour as `rgb()`. The theme tokens are written in a colour space the
 * terminal's own parser may not read, and a canvas reads any of them.
 */
function toRgb(value: string, fallback: string): string {
  try {
    scratch ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!scratch || !value.trim()) return fallback;
    scratch.clearRect(0, 0, 1, 1);
    scratch.fillStyle = "#000";
    scratch.fillStyle = value.trim();
    scratch.fillRect(0, 0, 1, 1);
    const [r, g, b] = scratch.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  } catch {
    return fallback;
  }
}

function currentTheme(): ITheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const dark = root.classList.contains("dark") || root.dataset.theme === "dark";
  const background = toRgb(style.getPropertyValue("--background"), dark ? "rgb(10, 10, 10)" : "rgb(255, 255, 255)");
  const foreground = toRgb(style.getPropertyValue("--foreground"), dark ? "rgb(250, 250, 250)" : "rgb(10, 10, 10)");
  const ring = toRgb(style.getPropertyValue("--ring"), "rgb(120, 120, 120)");
  return {
    ...(dark ? DARK_PALETTE : LIGHT_PALETTE),
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: ring.replace("rgb(", "rgba(").replace(")", ", 0.35)"),
  };
}

let themeWatcher: MutationObserver | null = null;
function watchTheme(): void {
  if (themeWatcher || typeof MutationObserver === "undefined") return;
  themeWatcher = new MutationObserver(() => {
    const theme = currentTheme();
    for (const live of lives.values()) live.term.options.theme = theme;
  });
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
}

async function createLive(scope: string, projectId: string | null): Promise<Live> {
  const existing = lives.get(scope);
  if (existing) return existing;
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
  // Another call may have created it while the modules were loading.
  const raced = lives.get(scope);
  if (raced) return raced;

  const term = new Terminal({
    fontFamily: MONO_FONT,
    fontSize: 13,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5000,
    // Whatever a program colours, keep it readable on this background.
    minimumContrastRatio: 4.5,
    macOptionIsMeta: true,
    theme: currentTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const host = document.createElement("div");
  host.className = "eggent-terminal-host";
  host.style.height = "100%";
  host.style.width = "100%";

  const live: Live = {
    scope,
    projectId,
    term,
    fit,
    host,
    opened: false,
    jobId: null,
    follower: null,
    offset: 0,
    closed: false,
    inputQueue: "",
    sending: false,
    resizeTimer: null,
    observer: null,
    starting: null,
  };

  term.onData((data) => queueInput(live, data));
  term.onResize(({ cols, rows }) => {
    if (live.resizeTimer) clearTimeout(live.resizeTimer);
    live.resizeTimer = setTimeout(() => {
      live.resizeTimer = null;
      if (live.jobId && !live.closed) void resizeTerminal(live.jobId, cols, rows).catch(() => undefined);
    }, 120);
  });
  // Ctrl+C is an interrupt - unless something is selected, when it is a copy,
  // which is what every other text surface in the browser does with it.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && term.hasSelection()) {
      return false;
    }
    return true;
  });

  lives.set(scope, live);
  watchTheme();
  return live;
}

// -- keystrokes ---------------------------------------------------------------

function queueInput(live: Live, data: string): void {
  if (live.closed || !live.jobId) return;
  live.inputQueue += data;
  if (!live.sending) void flushInput(live);
}

async function flushInput(live: Live): Promise<void> {
  live.sending = true;
  try {
    // One request at a time, so keystrokes arrive in the order they were
    // typed; what piles up while one is in flight goes in the next as a piece.
    while (live.inputQueue && live.jobId && !live.closed) {
      const chunk = live.inputQueue.slice(0, 32 * 1024);
      live.inputQueue = live.inputQueue.slice(chunk.length);
      let attempts = 0;
      for (;;) {
        try {
          await sendTerminalInput(live.jobId, chunk);
          break;
        } catch (error) {
          const status = error instanceof TerminalApiError ? error.status : 0;
          // The shell is gone: what was typed has nowhere to go.
          if (status === 404 || status === 409) {
            live.inputQueue = "";
            return;
          }
          attempts += 1;
          if (attempts >= 3) {
            live.inputQueue = "";
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 300 * attempts));
        }
      }
    }
  } finally {
    live.sending = false;
  }
}

// -- following the shell ------------------------------------------------------

function follow(live: Live): void {
  if (!live.jobId || live.follower) return;
  const jobId = live.jobId;
  live.follower = followTerminalJob(jobId, live.offset, {
    onStart: ({ truncated }) => {
      setInfo(live.scope, { status: "live", reason: null, exitCode: null, error: null });
      if (truncated) live.term.write("\r\n\x1b[2m[earlier output is no longer kept]\x1b[0m\r\n");
    },
    onOutput: (text) => {
      live.term.write(text);
      live.offset = live.follower?.offset() ?? live.offset;
    },
    onExit: (info) => {
      live.offset = live.follower?.offset() ?? live.offset;
      live.follower = null;
      live.closed = true;
      live.inputQueue = "";
      setInfo(live.scope, { status: "closed", reason: info.reason, exitCode: info.code, error: null });
    },
    onLost: () => {
      live.follower = null;
      live.closed = true;
      live.inputQueue = "";
      setInfo(live.scope, { status: "closed", reason: "lost", exitCode: null, error: null });
    },
    onConnection: (state) => {
      const current = usePanelSessions.getState().info[live.scope]?.status;
      if (state === "reconnecting") setInfo(live.scope, { status: "reconnecting" });
      else if (current === "reconnecting") setInfo(live.scope, { status: "live" });
    },
  });
}

async function start(live: Live): Promise<void> {
  setInfo(live.scope, { status: "starting", reason: null, exitCode: null, error: null });
  try {
    const { cols, rows } = live.term;
    const job = await createTerminalJob({ kind: "pty", projectId: live.projectId, cols, rows });
    if (job.id !== live.jobId) {
      // A shell this terminal has not seen: start from a clean screen.
      live.term.reset();
      live.offset = 0;
      live.jobId = job.id;
    }
    live.closed = false;
    follow(live);
  } catch (error) {
    if (error instanceof TerminalApiError && error.code === "pty-unavailable") {
      setInfo(live.scope, { status: "unavailable", error: error.message });
      return;
    }
    setInfo(live.scope, { status: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

// -- what a panel calls -------------------------------------------------------

/**
 * Put this project's terminal in `container` and start reading it.
 * Safe to call again for the same place; it is how a remounted panel gets its
 * terminal back.
 */
export async function showTerminal(scope: string, projectId: string | null, container: HTMLElement): Promise<void> {
  const live = await createLive(scope, projectId);
  // The panel may have been closed or the project changed while xterm loaded.
  if (!container.isConnected) return;

  if (live.host.parentElement !== container) container.appendChild(live.host);
  if (!live.opened) {
    live.term.open(live.host);
    live.opened = true;
  }
  live.observer?.disconnect();
  live.observer = new ResizeObserver(() => fitTerminal(scope));
  live.observer.observe(container);
  fitTerminal(scope);

  // Asking for the shell again is how a terminal that was detached gets its
  // output back (the server hands out the one that is still running) and how
  // one that has closed gets a new shell: opening the panel on a terminal that
  // timed out should give a working one, not a notice about the old.
  if (!live.follower && !live.starting) {
    live.starting = start(live).finally(() => {
      live.starting = null;
    });
  }
  await live.starting;
}

/** Stop reading it, and leave the shell to the server's timeout. */
export function hideTerminal(scope: string): void {
  const live = lives.get(scope);
  if (!live) return;
  live.observer?.disconnect();
  live.observer = null;
  live.follower?.stop();
  live.offset = live.follower?.offset() ?? live.offset;
  live.follower = null;
}

export function fitTerminal(scope: string): void {
  const live = lives.get(scope);
  if (!live?.opened) return;
  const box = live.host.parentElement;
  // A panel that is closed has no width to fit into; fitting to nothing would
  // shrink the shell to a sliver that the program inside then draws for.
  if (!box || box.clientWidth < 80 || box.clientHeight < 40) return;
  try {
    live.fit.fit();
  } catch {
    // Not laid out yet; the observer calls again.
  }
}

export function focusTerminal(scope: string): void {
  lives.get(scope)?.term.focus();
}

/** Close this terminal's shell, if it is running, and start a new one. */
export async function restartTerminal(scope: string): Promise<void> {
  const live = lives.get(scope);
  if (!live) return;
  const old = live.jobId;
  live.follower?.stop();
  live.follower = null;
  live.closed = true;
  live.inputQueue = "";
  if (old) await stopTerminalJob(old).catch(() => undefined);
  live.jobId = null;
  live.offset = 0;
  live.term.reset();
  await start(live);
}

export function terminalInfo(scope: string): PanelInfo {
  return usePanelSessions.getState().info[scope] ?? IDLE;
}
