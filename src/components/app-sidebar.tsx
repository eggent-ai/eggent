"use client";

import * as React from "react";
import { useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  Bot,
  CalendarClock,
  Cloud,
  CornerDownRight,
  FolderOpen,
  Laptop,
  Mail,
  LifeBuoy,
  LogOut,
  MessageSquarePlus,
  Plus,
  Settings,
  SquareKanban,
  Trash2,
} from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { chatPath } from "@/lib/dashboard-routes";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { useActiveRuns } from "@/hooks/use-active-runs";
import { useRemoteStatus } from "@/hooks/use-remote-status";
import { useI18n } from "@/i18n/provider";
import { useArrivals } from "@/hooks/use-arrivals";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { UsageWidget } from "@/components/usage-widget";
import { MailNav } from "@/components/mail/mail-nav";
import { BoardNav } from "@/components/board/board-nav";
import { ApprovalsNav } from "@/components/approvals/approvals-nav";
import { SharesNav } from "@/components/shares/shares-nav";
import { CreateProjectForm } from "@/components/create-project-form";
import { CompanyProjectsNav } from "@/components/company-projects/company-projects-nav";
import { useCompanyProjects } from "@/components/company-projects/use-company-projects";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const { isMobile } = useSidebar();
  const companyProjects = useCompanyProjects();
  const hasCompanyProjects = Boolean(companyProjects?.enabled && companyProjects.projects.length > 0);
  // A company's project has a page of its own; while it is open, none of the
  // workspace's own projects is the one being looked at.
  const onCompanyProject = pathname.startsWith("/dashboard/company/");
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
  const remote = useRemoteStatus(chatsTick);
  // Whether a chat's home is the other side of the pair, from where this list is read.
  const isOtherSide = (home: string | undefined) => Boolean(home && remote.status?.enabled && home !== remote.status.node);
  // Only what just appeared animates in; a load or a project switch does not.
  const chatArrived = useArrivals(chats.map((chat) => chat.id));
  const projectArrived = useArrivals(projects.map((project) => project.id));

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

  // The wizard from Settings -> Projects, one click from where projects are
  // picked: no trip to settings, and no agent turn spent on making a folder.
  const [createOpen, setCreateOpen] = React.useState(false);
  const handleProjectCreated = async (projectId: string) => {
    setCreateOpen(false);
    try {
      const data = await fetch("/api/projects").then((r) => r.json());
      if (Array.isArray(data)) setProjects(data);
    } catch {
      // the background sync brings the list in shortly
    }
    // A new project has no chats yet: open an empty one in it, ready to type.
    setChats([]);
    goToChat(null, projectId);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("eggent-focus-chat-input", "1");
      window.dispatchEvent(new Event("eggent:focus-chat-input"));
    }
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
        {/* Everything up here starts on the same 16px line as the rows below,
            so icons read as one column down the whole sidebar. */}
        <div className="pt-1">
          <Button
            variant="outline"
            className="w-full justify-start gap-2 px-[7px] has-[>svg]:px-[7px]"
            onClick={handleNewChat}
          >
            <MessageSquarePlus className="size-4" />
            {t("nav.newChat")}
          </Button>
        </div>
        <div>
          <BoardNav />
          <ApprovalsNav />
          <SharesNav />
        </div>
      </SidebarHeader>

      <SidebarContent>

        {/* Messages with the company's people, when this workspace has them. */}
        <MailNav />

        {/* Project selector */}
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.project")}</SidebarGroupLabel>
          <Popover open={createOpen} onOpenChange={setCreateOpen}>
            <PopoverTrigger asChild>
              <SidebarGroupAction title={t("projects.new")}>
                <Plus />
                <span className="sr-only">{t("projects.new")}</span>
              </SidebarGroupAction>
            </PopoverTrigger>
            <PopoverContent
              side={isMobile ? "bottom" : "right"}
              align="start"
              collisionPadding={16}
              className="w-80 max-w-[calc(100vw-2rem)]"
            >
              <h3 className="mb-3 text-sm font-medium">{t("projects.createTitle")}</h3>
              <CreateProjectForm
                idPrefix="sidebar-project"
                autoFocus
                onCreated={handleProjectCreated}
                onCancel={() => setCreateOpen(false)}
              />
            </PopoverContent>
          </Popover>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={activeProjectId === null && !onCompanyProject}
                onClick={handleOrchestratorClick}
              >
                <Bot className="size-4" />
                <span className="truncate">{t("nav.orchestrator")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {projects.length === 0 && !hasCompanyProjects && (
              <SidebarMenuItem>
                <SidebarMenuButton disabled>
                  <span className="text-muted-foreground text-xs">
                    {t("nav.noProjects")}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {projects.map((project) => (
              <SidebarMenuItem key={project.id} className={projectArrived(project.id) ? "eggent-row-in" : undefined}>
                <SidebarMenuButton
                  isActive={activeProjectId === project.id && !onCompanyProject}
                  onClick={() => handleProjectClick(project.id)}
                >
                  <FolderOpen className="size-4" />
                  <span className="truncate">{project.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            {/* Projects the company opened to this person, when it has any. */}
            <CompanyProjectsNav />
          </SidebarMenu>
        </SidebarGroup>

        {/* File tree */}
        {/* Chat history */}
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.chats")}</SidebarGroupLabel>
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
              <SidebarMenuItem key={chat.id} className={chatArrived(chat.id) ? "eggent-row-in" : undefined}>
                <SidebarMenuButton
                  isActive={activeChatId === chat.id}
                  onClick={() => handleChatClick(chat.id)}
                  title={
                    chat.scheduledJob
                      ? t("nav.scheduledChat", { job: chat.scheduledJob })
                      : chat.visitFrom
                        ? t("nav.visitChat", { chat: chat.visitFrom })
                        : chat.mailReplyTo
                          ? t("nav.mailReplyChat", { name: chat.mailReplyTo })
                          : isOtherSide(chat.home)
                            ? chat.home === "cloud"
                              ? t("nav.homeCloud")
                              : t("nav.homeDevice", { name: remote.status?.devices.find((device) => device.node === chat.home)?.name ?? t("chat.runPlace.yourComputer") })
                            : chat.boardCard
                              ? t("nav.boardChat")
                              : undefined
                  }
                >
                  {/* A scheduled task reports into a chat a day, so these
                      would otherwise read as conversations nobody started. */}
                  {chat.scheduledJob ? (
                    <CalendarClock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : chat.visitFrom ? (
                    // Work this project did when another chat asked it with @.
                    <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : chat.mailReplyTo ? (
                    // A chat opened to answer a colleague's message.
                    <Mail aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : isOtherSide(chat.home) ? (
                    // A chat that runs on the other side of the pair, not where this list is read.
                    chat.home === "cloud"
                      ? <Cloud aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                      : <Laptop aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : chat.boardCard ? (
                    // The conversation of a card on the board.
                    <SquareKanban aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
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
        {/* The footer already pads; a second group padding put these icons 8px
            right of every other row. */}
        <SidebarGroup className="p-0">
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
                  href={t("nav.documentationUrl")}
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
