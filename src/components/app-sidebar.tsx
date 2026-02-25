"use client";

import * as React from "react";
import { useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  CalendarClock,
  Cable,
  Bot,
  Brain,
  FolderOpen,
  LifeBuoy,
  LogOut,
  MessageSquarePlus,
  MessagesSquare,
  Puzzle,
  Settings2,
  Trash2,
  Wrench,
} from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { FileTree } from "@/components/file-tree";
import { useBackgroundSync } from "@/hooks/use-background-sync";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    chats,
    setChats,
    activeChatId,
    setActiveChatId,
    removeChat,
    projects,
    setProjects,
    activeProjectId,
    setActiveProjectId,
  } = useAppStore();
  const projectsTick = useBackgroundSync({
    topics: ["projects", "global"],
  });
  const chatsTick = useBackgroundSync({
    topics: ["chat", "projects", "global"],
    projectId: activeProjectId ?? null,
  });

  const isOnChatPage = pathname === "/dashboard";

  // Navigate to chat page when not already there (e.g. from settings/projects/memory)
  const goToChatIfNeeded = React.useCallback(() => {
    if (!isOnChatPage) router.push("/dashboard");
  }, [isOnChatPage, router]);

  // Keep projects list in sync with background updates.
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setProjects(data);
      })
      .catch(() => {});
  }, [setProjects, projectsTick]);

  // Keep active project aligned with available projects.
  useEffect(() => {
    if (projects.length === 0) {
      if (activeProjectId !== null) setActiveProjectId(null);
      return;
    }

    const activeExists = activeProjectId
      ? projects.some((project) => project.id === activeProjectId)
      : false;

    if (!activeExists) {
      setActiveProjectId(projects[0].id);
    }
  }, [projects, activeProjectId, setActiveProjectId]);

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
    setActiveChatId(null);
    goToChatIfNeeded();
  };

  const handleChatClick = (chatId: string) => {
    setActiveChatId(chatId);
    goToChatIfNeeded();
  };

  const handleProjectClick = (projectId: string) => {
    const params = new URLSearchParams({ projectId });
    fetch(`/api/chat/history?${params}`)
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setChats(list);
        setActiveProjectId(projectId);
        setActiveChatId(list[0]?.id ?? null);
        goToChatIfNeeded();
      })
      .catch(() => {
        setActiveProjectId(projectId);
        setActiveChatId(null);
        goToChatIfNeeded();
      });
  };

  const handleDeleteChat = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/chat/history?id=${id}`, { method: "DELETE" });
    removeChat(id);
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
                  <span className="truncate text-xs">Agent Terminal</span>
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
            New Chat
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent>

        {/* Project selector */}
        <SidebarGroup>
          <SidebarGroupLabel>Project</SidebarGroupLabel>
          <SidebarMenu>
            {projects.length === 0 && (
              <SidebarMenuItem>
                <SidebarMenuButton disabled>
                  <span className="text-muted-foreground text-xs">
                    No projects yet
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
            Files
          </SidebarGroupLabel>
          <div className="px-2">
            <FileTree projectId={activeProjectId ?? "none"} />
          </div>
        </SidebarGroup>

        {/* Chat history */}
        <SidebarGroup>
          <SidebarGroupLabel>
            <MessagesSquare className="size-3.5 mr-1" />
            Chats
          </SidebarGroupLabel>
          <SidebarMenu>
            {chats.length === 0 && (
              <SidebarMenuItem>
                <SidebarMenuButton disabled>
                  <span className="text-muted-foreground text-xs">
                    No chats yet
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
                <SidebarMenuAction
                  onClick={(e) => handleDeleteChat(chat.id, e)}
                  className="opacity-0 group-hover/menu-item:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </SidebarMenuAction>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

      </SidebarContent>

      <SidebarFooter>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/dashboard/projects">
                  <FolderOpen className="size-4" />
                  <span>Projects</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/dashboard/memory">
                  <Brain className="size-4" />
                  <span>Memory</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/dashboard/skills">
                  <Puzzle className="size-4" />
                  <span>Skills</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/dashboard/mcp">
                  <Wrench className="size-4" />
                  <span>MCP</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/dashboard/cron">
                  <CalendarClock className="size-4" />
                  <span>Cron Jobs</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/dashboard/settings">
                  <Settings2 className="size-4" />
                  <span>Settings</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/dashboard/api">
                  <Cable className="size-4" />
                  <span>API</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/dashboard/messengers">
                  <MessagesSquare className="size-4" />
                  <span>Messengers</span>
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
                  <span>Documentation</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={handleLogout}>
                <LogOut className="size-4" />
                <span>Logout</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarFooter>
    </Sidebar>
  );
}
