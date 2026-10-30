"use client";

import * as React from "react";
import { useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  Bot,
  Building2,
  CalendarClock,
  Cloud,
  CornerDownRight,
  FolderOpen,
  Laptop,
  Mail,
  LifeBuoy,
  Link2,
  LogOut,
  MessageSquarePlus,
  Plus,
  Settings,
  SquareKanban,
  Trash2,
} from "lucide-react";
import { useAppStore } from "@/store/app-store";
import type { ChatListItem } from "@/lib/types";
import type { ProjectSharingAnswer, ProjectSharingMark } from "@/lib/project-sharing/types";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { useMailContacts } from "@/components/mail/use-mail-contacts";
import { useEmailStatus } from "@/components/email/use-email-status";
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

/** How many of a project's chats it shows under its name before "show more". */
const RECENT_CHATS = 3;
/**
 * Where the person is, said more firmly than the stock active row: that one
 * fills with the same tint as a hovered row and, in light mode, is barely
 * darker than the sidebar itself, so "here" read like "under the pointer".
 * A deeper fill and a short bar at the left edge, in the sidebar's primary
 * colour, which hover never gets.
 */
const HERE_ROW = cn(
  "relative data-[active=true]:bg-sidebar-foreground/[0.08]",
  "before:pointer-events-none before:absolute before:inset-y-2 before:left-0.5 before:w-[3px] before:rounded-full before:bg-sidebar-primary before:opacity-0 data-[active=true]:before:opacity-100"
);

/** The longest the first draw waits for the Messages and company sections. */
const SIDE_SECTIONS_WAIT_MS = 2000;

/**
 * Where the project list will be, while it is on its way: rows of the same
 * height and indent as the real ones, so nothing below moves when they land.
 */
function SidebarRowsSkeleton() {
  const rows: Array<{ chat: boolean; width: string }> = [
    { chat: false, width: "w-24" },
    { chat: true, width: "w-32" },
    { chat: true, width: "w-28" },
    { chat: true, width: "w-36" },
    { chat: false, width: "w-20" },
    { chat: true, width: "w-28" },
  ];
  return (
    <div aria-hidden="true">
      {rows.map((row, index) => (
        <div key={index} className={cn("flex h-8 items-center gap-2 px-2", row.chat ? "pl-8" : index > 0 && "mt-2")}>
          {/* The sidebar's ground is close to the accent the default skeleton
              uses, so it takes a tint of its own text colour instead. */}
          {row.chat ? null : <Skeleton className="bg-sidebar-foreground/10 size-4 shrink-0 rounded-sm" />}
          <Skeleton className={cn("bg-sidebar-foreground/10 h-3", row.width)} />
        </div>
      ))}
    </div>
  );
}

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
  const [chatsLoaded, setChatsLoaded] = React.useState(false);

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

  // Which projects are shared - by a public link or with the company's people -
  // asked on the same tick as the list, so the marks arrive with the rows.
  const [sharing, setSharing] = React.useState<ProjectSharingAnswer | null>(null);
  useEffect(() => {
    fetch("/api/project-sharing")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((data: ProjectSharingAnswer) => setSharing(data))
      .catch(() => setSharing((current) => current ?? { enabled: false }));
  }, [projectsTick]);

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

  // Every project's chats, not only the open one's: each project lists its
  // recent ones, so a chat elsewhere is one click away.
  useEffect(() => {
    fetch("/api/chat/history")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) return;
        setChats(data);
        setChatsLoaded(true);
      })
      .catch(() => {});
  }, [setChats, chatsTick]);

  // The list is drawn once, whole: projects, their chats and the Messages
  // section above them arrive from four requests in whatever order they
  // finish, and drawing each as it came moved the list three times on every
  // load. Until then the rows' own shape stands in. The side sections are
  // waited for at most SIDE_SECTIONS_WAIT_MS - a failed one answers nothing,
  // and the list must not wait on it. Once drawn, it stays drawn: a later
  // refresh updates rows in place.
  const mailAnswer = useMailContacts();
  const emailAnswer = useEmailStatus();
  const sidesIn = mailAnswer !== null && emailAnswer !== null && companyProjects !== null && sharing !== null;
  const [sidesTimedOut, setSidesTimedOut] = React.useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSidesTimedOut(true), SIDE_SECTIONS_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const [listReady, setListReady] = React.useState(false);
  if (!listReady && projectsLoaded && chatsLoaded && (sidesIn || sidesTimedOut)) {
    setListReady(true);
  }

  const handleNewChat = () => {
    goToChat(null);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("eggent-focus-chat-input", "1");
      window.dispatchEvent(new Event("eggent:focus-chat-input"));
    }
  };

  // A chat may sit under another project than the open one, and opening it
  // makes that project the open one.
  const handleChatClick = (chat: ChatListItem) => {
    goToChat(chat.id, chat.projectId ?? null);
  };

  // A project's name starts a new conversation in it: its recent chats are
  // already listed under it, so reopening the latest one would only repeat a
  // row that is one click away.
  const handleProjectClick = (projectId: string | null) => {
    goToChat(null, projectId);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("eggent-focus-chat-input", "1");
      window.dispatchEvent(new Event("eggent:focus-chat-input"));
    }
  };

  // Chats by the project they belong to, newest first (the list arrives in
  // that order). The orchestrator's are under "".
  const chatsByProject = React.useMemo(() => {
    const groups = new Map<string, ChatListItem[]>();
    for (const chat of chats) {
      const key = chat.projectId ?? "";
      const group = groups.get(key);
      if (group) group.push(chat);
      else groups.set(key, [chat]);
    }
    return groups;
  }, [chats]);
  // Projects whose whole list was asked for, until the page is left.
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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

  const renderChat = (chat: ChatListItem) => (
    <SidebarMenuItem key={chat.id} className={chatArrived(chat.id) ? "eggent-row-in" : undefined}>
      {/* Indented to the project's name, so the list reads as its own. */}
      <SidebarMenuButton
        className={cn("pl-8", HERE_ROW)}
        isActive={activeChatId === chat.id}
        onClick={() => handleChatClick(chat)}
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
        aria-label={t("nav.deleteChat")}
        className="md:opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );

  /**
   * Small marks after a project's name: the company's building when it is open
   * to the company's people (the same mark their own sidebar gives it), a link
   * when it has a public one. They never shrink; a long name gives way first.
   */
  const renderShareMarks = (mark: ProjectSharingMark | undefined) => {
    if (!mark) return null;
    const company = mark.company;
    const companyLabel = !company
      ? null
      : company.all
        ? t("nav.sharedCompanyAll")
        : company.teams.length + company.people.length > 0
          ? t("nav.sharedCompanyTo", { who: [...company.teams.map((team) => t("nav.sharedTeam", { name: team })), ...company.people].join(", ") })
          : t("nav.sharedCompany");
    if (!companyLabel && !mark.public) return null;
    return (
      <span className="text-muted-foreground flex shrink-0 items-center gap-1">
        {companyLabel ? (
          <span role="img" aria-label={companyLabel} title={companyLabel} className="flex">
            <Building2 aria-hidden className="size-3.5" />
          </span>
        ) : null}
        {mark.public ? (
          <span role="img" aria-label={t("nav.sharedPublic")} title={t("nav.sharedPublic")} className="flex">
            <Link2 aria-hidden className="size-3.5" />
          </span>
        ) : null}
      </span>
    );
  };

  /**
   * A project's row and, under it, its newest chats. The row itself starts a
   * new chat there and reads as the open one only while that new chat is on
   * screen; once a conversation is open, its own row carries the mark.
   */
  const renderProject = (projectId: string | null, name: string, icon: React.ReactNode) => {
    const key = projectId ?? "";
    const list = chatsByProject.get(key) ?? [];
    const isOpen = expanded.has(key);
    let shown = isOpen ? list : list.slice(0, RECENT_CHATS);
    // The open conversation stays in sight even when it is older than the few.
    if (!isOpen && activeChatId && !shown.some((chat) => chat.id === activeChatId)) {
      const active = list.find((chat) => chat.id === activeChatId);
      if (active) shown = [...shown, active];
    }
    const hidden = list.length - shown.length;
    // The project the open conversation belongs to: its name carries weight,
    // so the two rows read as one path - this project, this chat.
    const holdsOpenChat = activeProjectId === projectId && activeChatId !== null && !onCompanyProject;
    return (
      <React.Fragment key={key || "orchestrator"}>
        {/* A little air above each project after the first, so its chats read
            as its own and not as the tail of the one above. */}
        <SidebarMenuItem
          className={cn(projectId !== null && "mt-2", projectId && projectArrived(projectId) && "eggent-row-in")}
        >
          <SidebarMenuButton
            className={cn(HERE_ROW, holdsOpenChat && "font-medium")}
            isActive={activeProjectId === projectId && activeChatId === null && !onCompanyProject}
            onClick={() => handleProjectClick(projectId)}
            title={t("nav.newChatIn", { project: name })}
          >
            {icon}
            <span className="min-w-0 truncate">{name}</span>
            {projectId ? renderShareMarks(sharing && sharing.enabled ? sharing.projects[projectId] : undefined) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
        {shown.map(renderChat)}
        {hidden > 0 || isOpen ? (
          list.length > RECENT_CHATS ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="pl-8 text-xs text-muted-foreground"
                aria-expanded={isOpen}
                onClick={() => toggleExpanded(key)}
              >
                <span>{isOpen ? t("nav.showFewerChats") : t("nav.showMoreChats", { count: hidden })}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null
        ) : null}
      </React.Fragment>
    );
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
        {listReady ? <MailNav className="eggent-surface-in" /> : null}

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
          {listReady ? (
          <SidebarMenu className="eggent-surface-in">
            {renderProject(null, t("nav.orchestrator"), <Bot className="size-4" />)}
            {projects.length === 0 && !hasCompanyProjects && (
              <SidebarMenuItem>
                <SidebarMenuButton disabled>
                  <span className="text-muted-foreground text-xs">
                    {t("nav.noProjects")}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {projects.map((project) =>
              renderProject(project.id, project.name, <FolderOpen className="size-4" />)
            )}
            {/* Projects the company opened to this person, when it has any. */}
            <CompanyProjectsNav />
          </SidebarMenu>
          ) : (
            <SidebarRowsSkeleton />
          )}
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
