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
    set({ filesPanelOpen: open });
  },
  toggleFilesPanel: () =>
    set((state) => {
      const next = !state.filesPanelOpen;
      rememberFilesPanel(next);
      return { filesPanelOpen: next };
    }),
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
