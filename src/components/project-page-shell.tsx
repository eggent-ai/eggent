"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";

interface ProjectPageShellProps {
  projectId: string;
  title: string;
  description?: string;
  children: ReactNode;
}

export function ProjectPageShell({ projectId, title, description, children }: ProjectPageShellProps) {
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={title} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 p-4 md:p-6">
              <div className="space-y-2">
                <Button variant="ghost" size="sm" asChild className="-ml-2 gap-2">
                  <Link href={`/dashboard/projects/${projectId}`}>
                    <ArrowLeft className="size-4" /> Back to project
                  </Link>
                </Button>
                <div>
                  <div className="text-xs font-mono text-muted-foreground">project: {projectId}</div>
                  <h1 className="text-2xl font-semibold">{title}</h1>
                  {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
                </div>
              </div>
              {children}
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
