"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { OrchestratorFilesNavigation } from "@/components/orchestrator-files-navigation";
import { ProjectFileEditor } from "@/components/project-file-editor";
import { SettingsNavigation } from "@/components/settings-navigation";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ORCHESTRATOR_SCOPE_ID } from "@/lib/orchestrator-scope";
import { useI18n } from "@/i18n/provider";

export default function OrchestratorContextPage() {
  const { t } = useI18n();

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("context.title")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 p-4 md:p-6">
              <SettingsNavigation />
              <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-semibold">{t("context.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("context.description")}</p>
              </div>
              <OrchestratorFilesNavigation />
              <ProjectFileEditor
                projectId={ORCHESTRATOR_SCOPE_ID}
                endpoint="context"
                filename="context.md"
                title="context.md"
                description={t("context.editorDescription")}
              />
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
