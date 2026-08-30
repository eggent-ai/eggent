"use client";

import { create } from "zustand";
import type { ChatListItem, Project } from "@/lib/types";

interface AppState {
  // Chats
  chats: ChatListItem[];
  activeChatId: string | null;
  setChats: (chats: ChatListItem[]) => void;
  setActiveChatId: (id: string | null) => void;
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
}

export const useAppStore = create<AppState>((set) => ({
  // Chats
  chats: [],
  activeChatId: null,
  setChats: (chats) => set({ chats }),
  setActiveChatId: (id) => set({ activeChatId: id }),
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
