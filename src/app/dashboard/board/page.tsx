"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { BoardView } from "@/components/board/board-view";
import { SiteHeader } from "@/components/site-header";
import { SidePanels } from "@/components/side-panels";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useI18n } from "@/i18n/provider";

export default function BoardPage() {
  const { t } = useI18n();
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("board.pageTitle")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset className="min-w-0">
            <BoardView />
          </SidebarInset>
          <SidePanels />
        </div>
      </SidebarProvider>
    </div>
  );
}
