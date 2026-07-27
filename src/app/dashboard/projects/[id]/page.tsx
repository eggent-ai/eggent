"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SettingsNavigation } from "@/components/settings-navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Bot,
  FileJson,
  FileText,
  Loader2,
  MessageSquare,
  Puzzle,
  Settings2,
  Wrench,
} from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import type { Project } from "@/lib/types";

const projectFiles: Array<{ name: string; titleKey: MessageKey; descriptionKey: MessageKey; href: string; icon: typeof FileText }> = [
  {
    name: "context.md",
    titleKey: "projectDetail.file.context.title",
    descriptionKey: "projectDetail.file.context.description",
    href: "context",
    icon: FileText,
  },
  {
    name: "memory.md",
    titleKey: "projectDetail.file.memory.title",
    descriptionKey: "projectDetail.file.memory.description",
    href: "memory",
    icon: FileText,
  },
  {
    name: "skills/",
    titleKey: "projectDetail.file.skills.title",
    descriptionKey: "projectDetail.file.skills.description",
    href: "skills",
    icon: Puzzle,
  },
  {
    name: ".mcp.json",
    titleKey: "projectDetail.file.mcp.title",
    descriptionKey: "projectDetail.file.mcp.description",
    href: "mcp",
    icon: Wrench,
  },
  {
    name: "model.json",
    titleKey: "projectDetail.file.model.title",
    descriptionKey: "projectDetail.file.model.description",
    href: "settings",
    icon: Settings2,
  },
];

export default function ProjectDetailsPage() {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatCount, setChatCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [projectRes, chatsRes] = await Promise.all([
          fetch(`/api/projects/${id}`, { cache: "no-store" }),
          fetch(`/api/chat/history?projectId=${encodeURIComponent(id)}`, { cache: "no-store" }),
        ]);
        if (!projectRes.ok) throw new Error(t("projectDetail.errors.notFound"));
        const projectJson = await projectRes.json();
        const chatsJson = await chatsRes.json().catch(() => []);
        if (cancelled) return;
        setProject(projectJson);
        setChatCount(Array.isArray(chatsJson) ? chatsJson.length : 0);
      } catch {
        if (!cancelled) setProject(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold">{t("projectDetail.notFound")}</h1>
        <Button onClick={() => router.push("/dashboard/projects")}>{t("projectDetail.backToProjects")}</Button>
      </div>
    );
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={project.name} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 md:p-8">
              <SettingsNavigation />

              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <Button variant="ghost" size="icon" className="-ml-2 h-8 w-8" onClick={() => router.push("/dashboard/projects")}>
                      <ArrowLeft className="size-4" />
                    </Button>
                    <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
                    <Badge variant="secondary">{t("projectDetail.directoryBacked")}</Badge>
                  </div>
                  <p className="text-muted-foreground">{project.description || t("projectDetail.noDescription")}</p>
                  <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                    {t("projectDetail.description")}
                  </p>
                </div>
                <Button asChild className="gap-2">
                  <Link href="/dashboard">
                    <Bot className="size-4" /> {t("projectDetail.openChat")}
                  </Link>
                </Button>
              </div>

              <section className="rounded-xl border bg-card p-4 md:p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{t("projectDetail.projectFolder")}</h2>
                    <p className="text-sm text-muted-foreground">data/projects/{project.id}/</p>
                  </div>
                  <Button variant="outline" asChild className="gap-2">
                    <Link href="/dashboard">
                      <MessageSquare className="size-4" /> {chatCount !== null ? t("projectDetail.chats", { count: `(${chatCount})` }) : t("projectDetail.chats", { count: "" })}
                    </Link>
                  </Button>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {projectFiles.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.name}
                        href={`/dashboard/projects/${project.id}/${item.href}`}
                        className="group rounded-lg border p-4 transition hover:border-primary/50 hover:bg-muted/40"
                      >
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <Icon className="size-4 text-primary" />
                            <span className="font-medium">{t(item.titleKey)}</span>
                          </div>
                          <Badge variant="outline" className="font-mono text-[11px]">
                            {item.name}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{t(item.descriptionKey)}</p>
                      </Link>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-xl border bg-card p-4 md:p-5">
                <div className="mb-3 flex items-center gap-2">
                  <FileJson className="size-4 text-primary" />
                  <h2 className="text-lg font-semibold">{t("projectDetail.runtimeModel")}</h2>
                </div>
                <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">{`Eggent UI/API
  -> data/projects/${project.id}/context.md
  -> data/projects/${project.id}/memory.md
  -> data/projects/${project.id}/skills/
  -> data/projects/${project.id}/.mcp.json
  -> data/projects/${project.id}/model.json
  -> Eggent agent runtime`}</pre>
              </section>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
