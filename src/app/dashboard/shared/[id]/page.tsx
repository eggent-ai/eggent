"use client";

import { use } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidePanels } from "@/components/side-panels";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { SharedFile } from "@/components/shares/shared-file";
import { useI18n } from "@/i18n/provider";

export default function SharedFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("shares.pageTitle")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 md:p-6">
              <SharedFile key={id} shareId={decodeURIComponent(id)} />
            </div>
          </SidebarInset>
          <SidePanels />
        </div>
      </SidebarProvider>
    </div>
  );
}
