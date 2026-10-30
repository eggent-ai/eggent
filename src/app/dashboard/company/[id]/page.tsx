"use client";

import { Suspense, use } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { CompanyProjectChat } from "@/components/company-projects/company-project-chat";
import { useI18n } from "@/i18n/provider";

export default function CompanyProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("companyProjects.pageTitle")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex h-[calc(100svh-var(--header-height))] w-full max-w-5xl flex-col">
              <Suspense>
                <CompanyProjectChat key={id} projectId={decodeURIComponent(id)} />
              </Suspense>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
