"use client";

import { create } from "zustand";
import type { ChatListItem, Project } from "@/lib/types";

interface AppState {
  // Chats
  chats: ChatListItem[];
  activeChatId: string | null;
  setChats: (chats: ChatListItem[]) => void;
  setActiveChatId: (id: string | null) => void;
  /**
   * Put a chat on screen, together with the project it belongs to.
   *
   * Opening a chat by its address is the case this exists for: the browser
   * knows which conversation to show and nothing else, while the composer, the
   * file tree and the chat list all read the project. Setting the two
   * separately meant going through a state where the chat was open under the
   * wrong project - and `setActiveProjectId` clears the open chat by default,
   * so the obvious order does not even work.
   *
   * `projectId` undefined means "leave the project alone", which is what the
   * new-chat screen wants: starting one inside a project stays in it.
   */
  openChat: (chatId: string | null, projectId?: string | null) => void;
  addChat: (chat: ChatListItem) => void;
  removeChat: (id: string) => void;

  // Projects
  projects: Project[];
  activeProjectId: string | null;
  currentPath: string; // relative path within the project, "" = project root
  setProjects: (projects: Project[]) => void;
  /**
   * Change the active project.
   *
   * Clears the open chat by default, because the usual reason to change project
   * is that the person navigated somewhere else. Pass `keepActiveChat` when the
   * agent moved on its own to do the work it was asked for: the conversation is
   * still going, and dropping it puts the person on a blank screen in a project
   * they never asked to open, with what they were saying left behind.
   */
  setActiveProjectId: (id: string | null, options?: { keepActiveChat?: boolean }) => void;
  setCurrentPath: (path: string) => void;

  // UI
  sidebarTab: "chats" | "projects";
  setSidebarTab: (tab: "chats" | "projects") => void;
  /**
   * The file tree, which lives in its own panel on the right.
   *
   * It used to sit in the left sidebar under the chat list, where it competed
   * for height with the thing people came for. On the right it is a panel you
   * open when you are looking at files and close when you are not, so the
   * state is remembered per browser rather than reset on every load.
   */
  filesPanelOpen: boolean;
  setFilesPanelOpen: (open: boolean) => void;
  toggleFilesPanel: () => void;
  /**
   * The terminal, in a panel of its own beside the file tree.
   *
   * Remembered per browser like the tree, and for the same reason: it is
   * something you open when you have work for it and close when you do not.
   * Its width is remembered too, because how wide a terminal should be is a
   * decision about a screen and a font, made once.
   */
  terminalPanelOpen: boolean;
  terminalPanelWidth: number;
  setTerminalPanelOpen: (open: boolean) => void;
  toggleTerminalPanel: () => void;
  setTerminalPanelWidth: (width: number, remember?: boolean) => void;
  /**
   * The folders open in the file tree, per project.
   *
   * Kept here rather than in each folder, because every page mounts a panel
   * of its own. Clicking a file in the chat's panel opens the file's screen,
   * and a folder's own state was thrown away on the way there: the file stood
   * highlighted inside folders that had closed behind it, and finding it again
   * meant opening them one by one.
   */
  expandedFolders: Record<string, Record<string, true>>;
  setFolderExpanded: (projectId: string, path: string, expanded: boolean) => void;
  /** Open these folders; the ones already open are left as they are. */
  expandFolders: (projectId: string, paths: string[]) => void;
}

const FILES_PANEL_KEY = "eggent.filesPanelOpen";
const TERMINAL_PANEL_KEY = "eggent.terminalPanelOpen";
const TERMINAL_WIDTH_KEY = "eggent.terminalPanelWidth";

export const TERMINAL_PANEL_MIN_WIDTH = 320;
export const TERMINAL_PANEL_MAX_WIDTH = 960;
export const TERMINAL_PANEL_DEFAULT_WIDTH = 480;

/** Below this width a second panel has no room beside the chat and covers it. */
const MOBILE_BREAKPOINT_PX = 768;
function isNarrowScreen(): boolean {
  return typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT_PX;
}

export function clampTerminalPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return TERMINAL_PANEL_DEFAULT_WIDTH;
  return Math.min(TERMINAL_PANEL_MAX_WIDTH, Math.max(TERMINAL_PANEL_MIN_WIDTH, Math.round(width)));
}

export function readTerminalPanelPreference(): { open: boolean; width: number } {
  if (typeof window === "undefined") return { open: false, width: TERMINAL_PANEL_DEFAULT_WIDTH };
  try {
    const stored = Number.parseInt(window.localStorage.getItem(TERMINAL_WIDTH_KEY) ?? "", 10);
    return {
      open: window.localStorage.getItem(TERMINAL_PANEL_KEY) === "1",
      width: Number.isFinite(stored) ? clampTerminalPanelWidth(stored) : TERMINAL_PANEL_DEFAULT_WIDTH,
    };
  } catch {
    return { open: false, width: TERMINAL_PANEL_DEFAULT_WIDTH };
  }
}

function rememberTerminalPanel(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not worth an error: the panel still works for this page.
  }
}

/**
 * Read back last session's choice.
 *
 * Called from the panel after mount rather than used as the store's initial
 * value: the server renders this too, and a value that exists only in the
 * browser would make the first paint disagree with the markup.
 */
export function readFilesPanelPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(FILES_PANEL_KEY) === "1";
  } catch {
    // Private windows and blocked site data throw on access rather than
    // returning nothing, and a closed panel is the safe default.
    return false;
  }
}

function rememberFilesPanel(open: boolean): void {
  try {
    window.localStorage.setItem(FILES_PANEL_KEY, open ? "1" : "0");
  } catch {
    // Not worth an error: the panel still works for this page.
  }
}

export const useAppStore = create<AppState>((set) => ({
  filesPanelOpen: false,
  setFilesPanelOpen: (open) => {
    rememberFilesPanel(open);
    if (open && isNarrowScreen()) rememberTerminalPanel(TERMINAL_PANEL_KEY, "0");
    set((state) => ({
      filesPanelOpen: open,
      terminalPanelOpen: open && isNarrowScreen() ? false : state.terminalPanelOpen,
    }));
  },
  toggleFilesPanel: () =>
    set((state) => {
      const next = !state.filesPanelOpen;
      rememberFilesPanel(next);
      // On a phone the two panels would be one on top of the other.
      const closeTerminal = next && isNarrowScreen();
      if (closeTerminal) rememberTerminalPanel(TERMINAL_PANEL_KEY, "0");
      return { filesPanelOpen: next, terminalPanelOpen: closeTerminal ? false : state.terminalPanelOpen };
    }),
  terminalPanelOpen: false,
  terminalPanelWidth: TERMINAL_PANEL_DEFAULT_WIDTH,
  setTerminalPanelOpen: (open) => {
    rememberTerminalPanel(TERMINAL_PANEL_KEY, open ? "1" : "0");
    if (open && isNarrowScreen()) rememberFilesPanel(false);
    set((state) => ({
      terminalPanelOpen: open,
      filesPanelOpen: open && isNarrowScreen() ? false : state.filesPanelOpen,
    }));
  },
  toggleTerminalPanel: () =>
    set((state) => {
      const next = !state.terminalPanelOpen;
      rememberTerminalPanel(TERMINAL_PANEL_KEY, next ? "1" : "0");
      const closeFiles = next && isNarrowScreen();
      if (closeFiles) rememberFilesPanel(false);
      return { terminalPanelOpen: next, filesPanelOpen: closeFiles ? false : state.filesPanelOpen };
    }),
  setTerminalPanelWidth: (width, remember = true) => {
    const next = clampTerminalPanelWidth(width);
    if (remember) rememberTerminalPanel(TERMINAL_WIDTH_KEY, String(next));
    set({ terminalPanelWidth: next });
  },
  expandedFolders: {},
  setFolderExpanded: (projectId, path, expanded) =>
    set((state) => {
      const open = state.expandedFolders[projectId] ?? {};
      if (Boolean(open[path]) === expanded) return state;
      const next = { ...open };
      if (expanded) next[path] = true;
      else delete next[path];
      return { expandedFolders: { ...state.expandedFolders, [projectId]: next } };
    }),
  expandFolders: (projectId, paths) =>
    set((state) => {
      const open = state.expandedFolders[projectId] ?? {};
      const closed = paths.filter((path) => !open[path]);
      if (closed.length === 0) return state;
      const next = { ...open };
      for (const path of closed) next[path] = true;
      return { expandedFolders: { ...state.expandedFolders, [projectId]: next } };
    }),
  // Chats
  chats: [],
  activeChatId: null,
  setChats: (chats) => set({ chats }),
  setActiveChatId: (id) => set({ activeChatId: id }),
  openChat: (chatId, projectId) =>
    set((state) => {
      const nextProjectId = projectId === undefined ? state.activeProjectId : projectId;
      // Changing project resets where the file tree and the composer are
      // pointing, exactly as picking one from the sidebar does.
      const projectChanged = nextProjectId !== state.activeProjectId;
      return {
        activeChatId: chatId,
        activeProjectId: nextProjectId,
        currentPath: projectChanged ? "" : state.currentPath,
      };
    }),
  addChat: (chat) =>
    set((state) => ({ chats: [chat, ...state.chats] })),
  removeChat: (id) =>
    set((state) => ({
      chats: state.chats.filter((c) => c.id !== id),
      activeChatId: state.activeChatId === id ? null : state.activeChatId,
    })),

  // Projects
  projects: [],
  activeProjectId: null,
  currentPath: "",
  setProjects: (projects) => set({ projects }),
  setActiveProjectId: (id, options) =>
    set(
      options?.keepActiveChat
        ? { activeProjectId: id, currentPath: "" }
        : { activeProjectId: id, activeChatId: null, currentPath: "" }
    ),
  setCurrentPath: (path) => set({ currentPath: path }),

  // UI
  sidebarTab: "chats",
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
}));
