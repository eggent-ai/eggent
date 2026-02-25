
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2 } from "lucide-react";
import { KnowledgeSection } from "@/components/knowledge-section";
import { ProjectContextSection } from "@/components/project-context-section";
import { CronSection } from "@/components/cron-section";
import type { Project } from "@/lib/types";

export default function ProjectDetailsPage() {
    const params = useParams();
    const router = useRouter();
    const id = params.id as string;
    const [project, setProject] = useState<Project | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch(`/api/projects/${id}`)
            .then((res) => {
                if (!res.ok) throw new Error("Project not found");
                return res.json();
            })
            .then((data: Project) => {
                setProject(data);
                setLoading(false);
            })
            .catch(() => {
                setProject(null); // Explicitly set null on error
                setLoading(false);
            });
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
                <h1 className="text-2xl font-bold">Project Not Found</h1>
                <Button onClick={() => router.push("/dashboard/projects")}>
                    Back to Projects
                </Button>
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
                        <div className="flex flex-1 flex-col gap-6 p-4 md:p-8 max-w-5xl mx-auto w-full">
                            {/* Header */}
                            <div className="flex items-start justify-between">
                                <div>
                                    <div className="flex items-center gap-2 mb-2">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="-ml-2 h-8 w-8"
                                            onClick={() => router.push("/dashboard/projects")}
                                        >
                                            <ArrowLeft className="size-4" />
                                        </Button>
                                        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
                                    </div>
                                    <p className="text-muted-foreground">
                                        {project.description || "No description provided."}
                                    </p>
                                </div>
                                {/* Could handle project settings here */}
                                {/* <Button variant="outline" size="sm" className="gap-2">
                  <Settings className="size-4" />
                  Settings
                </Button> */}
                            </div>

                            {/* Instructions */}
                            <div className="space-y-2">
                                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                                    Instructions
                                </h3>
                                <div className="bg-muted/50 p-4 rounded-lg text-sm font-mono whitespace-pre-wrap">
                                    {project.instructions || "No custom instructions defined."}
                                </div>
                            </div>

                            {/* MCP + Skills */}
                            <ProjectContextSection projectId={project.id} />

                            {/* Cron Jobs */}
                            <CronSection projectId={project.id} />

                            {/* Knowledge Base */}
                            <KnowledgeSection projectId={project.id} />

                        </div>
                    </SidebarInset>
                </div>
            </SidebarProvider>
        </div>
    );
}
