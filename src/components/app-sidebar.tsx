"use client";

import * as React from "react";
import { useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  Bot,
  FolderOpen,
  LifeBuoy,
  LogOut,
  MessageSquarePlus,
  MessagesSquare,
  Settings,
  Trash2,
} from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { chatPath } from "@/lib/dashboard-routes";
import { FileTree } from "@/components/file-tree";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { useActiveRuns } from "@/hooks/use-active-runs";
import { useI18n } from "@/i18n/provider";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { UsageWidget } from "@/components/usage-widget";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const {
    chats,
    setChats,
    activeChatId,
    openChat,
    removeChat,
    projects,
    setProjects,
    activeProjectId,
  } = useAppStore();
  const projectsTick = useBackgroundSync({
    topics: ["projects", "global"],
  });
  const chatsTick = useBackgroundSync({
    topics: ["chat", "projects", "global"],
    projectId: activeProjectId ?? null,
  });
  const activeRuns = useActiveRuns();

  /**
   * Open a conversation, in the store and in the address bar.
   *
   * Both, and in that order: the store is what the screen reads, so writing it
   * first is what makes the click feel immediate, and the address follows so
   * the conversation can be linked to, reopened and found again with Back. The
   * route confirms the same two values when it arrives.
   *
   * `projectId` undefined leaves the project alone - a chat picked out of the
   * list is already in the project whose list it came from.
   */
  const goToChat = React.useCallback(
    (chatId: string | null, projectId?: string | null) => {
      openChat(chatId, projectId);
      router.push(chatPath(chatId));
    },
    [openChat, router]
  );

  // Until the list has actually arrived once, "this project is not in the list"
  // means nothing - see the guard below.
  const [projectsLoaded, setProjectsLoaded] = React.useState(false);

  // Keep projects list in sync with background updates.
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) return;
        setProjects(data);
        setProjectsLoaded(true);
      })
      .catch(() => {
        // Leave the flag alone: a failed fetch is not evidence that a project
        // is gone, and acting on it would close the chat that is open.
      });
  }, [setProjects, projectsTick]);

  // Keep active project aligned with available projects, but keep the
  // orchestrator (activeProjectId === null) as a valid persistent mode.
  //
  // Only once the list is known. An empty list is the ordinary first state of a
  // page load, and treating it as proof meant that opening a project's chat
  // from a link raced this: the address set the project, this fired against the
  // not-yet-loaded list, decided the project was gone and sent the person back
  // to an empty composer in the orchestrator.
  useEffect(() => {
    if (!projectsLoaded) return;
    if (activeProjectId === null) return;

    const activeExists = projects.some((project) => project.id === activeProjectId);
    if (!activeExists) {
      // The project went away and took its chats with it, so the address has to
      // move too - otherwise the screen shows an empty composer while the
      // browser still names a conversation that is gone.
      goToChat(null, null);
    }
  }, [projects, projectsLoaded, activeProjectId, goToChat]);

  // Keep chat list synced for the active project.
  useEffect(() => {
    const params = new URLSearchParams();
    if (activeProjectId) {
      params.set("projectId", activeProjectId);
    } else {
      params.set("projectId", "none");
    }
    fetch(`/api/chat/history?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setChats(data);
      })
      .catch(() => {});
  }, [activeProjectId, setChats, chatsTick]);

  const handleNewChat = () => {
    goToChat(null);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("eggent-focus-chat-input", "1");
      window.dispatchEvent(new Event("eggent:focus-chat-input"));
    }
  };

  const handleChatClick = (chatId: string) => {
    goToChat(chatId);
  };

  const handleOrchestratorClick = () => {
    const params = new URLSearchParams({ projectId: "none" });
    fetch(`/api/chat/history?${params}`)
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setChats(list);
        goToChat(list[0]?.id ?? null, null);
      })
      .catch(() => {
        goToChat(null, null);
      });
  };

  const handleProjectClick = (projectId: string) => {
    const params = new URLSearchParams({ projectId });
    fetch(`/api/chat/history?${params}`)
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setChats(list);
        goToChat(list[0]?.id ?? null, projectId);
      })
      .catch(() => {
        goToChat(null, projectId);
      });
  };

  const handleDeleteChat = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const wasOpen = activeChatId === id;
    await fetch(`/api/chat/history?id=${id}`, { method: "DELETE" });
    removeChat(id);
    // The address still names the chat that was just deleted; leaving it there
    // would make Reload reopen an empty conversation under a dead id.
    if (wasOpen) goToChat(null);
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore logout request errors and continue redirect
    } finally {
      router.push("/login");
      router.refresh();
    }
  };

  return (
    <Sidebar
      className="top-(--header-height) h-[calc(100svh-var(--header-height))]!"
      {...props}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/dashboard">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <Bot className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Eggent</span>
                  <span className="truncate text-xs">{t("app.tagline")}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {/* New Chat button */}
        <div className="px-3 pt-2">
          <Button
            variant="outline"
            className="w-full justify-start gap-2"
            onClick={handleNewChat}
          >
            <MessageSquarePlus className="size-4" />
            {t("nav.newChat")}
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent>

        {/* Project selector */}
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.project")}</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={activeProjectId === null}
                onClick={handleOrchestratorClick}
              >
                <Bot className="size-4" />
                <span className="truncate">{t("nav.orchestrator")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {projects.length === 0 && (
              <SidebarMenuItem>
                <SidebarMenuButton disabled>
                  <span className="text-muted-foreground text-xs">
                    {t("nav.noProjects")}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {projects.map((project) => (
              <SidebarMenuItem key={project.id}>
                <SidebarMenuButton
                  isActive={activeProjectId === project.id}
                  onClick={() => handleProjectClick(project.id)}
                >
                  <FolderOpen className="size-4" />
                  <span className="truncate">{project.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        {/* File tree */}
        <SidebarGroup>
          <SidebarGroupLabel>
            <FolderOpen className="size-3.5 mr-1" />
            {t("nav.files")}
          </SidebarGroupLabel>
          <div className="px-2">
            <FileTree projectId={activeProjectId ?? "none"} />
          </div>
        </SidebarGroup>

        {/* Chat history */}
        <SidebarGroup>
          <SidebarGroupLabel>
            <MessagesSquare className="size-3.5 mr-1" />
            {t("nav.chats")}
          </SidebarGroupLabel>
          <SidebarMenu>
            {chats.length === 0 && (
              <SidebarMenuItem>
                <SidebarMenuButton disabled>
                  <span className="text-muted-foreground text-xs">
                    {t("nav.noChats")}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {chats.map((chat) => (
              <SidebarMenuItem key={chat.id}>
                <SidebarMenuButton
                  isActive={activeChatId === chat.id}
                  onClick={() => handleChatClick(chat.id)}
                >
                  <span className="truncate">{chat.title}</span>
                </SidebarMenuButton>
                {/* The mark and the delete button share the right edge, so the
                    mark gives it up on hover: the pointer is there to act on
                    the row, and the state it was reporting is still one click
                    away inside the chat. */}
                {activeRuns.byChat.has(chat.id) ? (
                  <SidebarMenuBadge className="top-1.5 transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0">
                    <span
                      data-eggent-live
                      role="status"
                      aria-label={t("nav.chatWorking")}
                      className="bg-primary size-2 rounded-full"
                    />
                  </SidebarMenuBadge>
                ) : null}
                <SidebarMenuAction
                  onClick={(e) => handleDeleteChat(chat.id, e)}
                  className="md:opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </SidebarMenuAction>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

      </SidebarContent>

      <SidebarFooter>
        <UsageWidget />
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={
                  pathname.startsWith("/dashboard/settings") ||
                  pathname.startsWith("/dashboard/projects") ||
                  pathname.startsWith("/dashboard/context") ||
                  pathname.startsWith("/dashboard/memory") ||
                  pathname.startsWith("/dashboard/skills") ||
                  pathname.startsWith("/dashboard/mcp") ||
                  pathname.startsWith("/dashboard/pipelines") ||
                  pathname.startsWith("/dashboard/pipeline-runs") ||
                  pathname.startsWith("/dashboard/schedules") ||
                  pathname.startsWith("/dashboard/messengers") ||
                  pathname.startsWith("/dashboard/api")
                }
              >
                <Link href="/dashboard/settings">
                  <Settings className="size-4" />
                  <span>{t("nav.settings")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <a
                  href="https://github.com/eggent-ai/eggent"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <LifeBuoy className="size-4" />
                  <span>{t("nav.documentation")}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={handleLogout}>
                <LogOut className="size-4" />
                <span>{t("nav.logout")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarFooter>
    </Sidebar>
  );
}
