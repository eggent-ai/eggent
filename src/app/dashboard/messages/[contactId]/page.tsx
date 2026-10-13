"use client";

import { use } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidePanels } from "@/components/side-panels";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { MailThreadView } from "@/components/mail/mail-thread-view";
import { useI18n } from "@/i18n/provider";

/** One conversation, laid out like the chat screen: the thread scrolls, the box to write in stays. */
export default function MessageThreadPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = use(params);
  const { t } = useI18n();
  return (
    <div className="[--header-height:calc(--spacing(14))] h-svh overflow-hidden">
      <SidebarProvider className="flex h-full flex-col">
        <SiteHeader title={t("mail.pageTitle")} />
        <div className="flex min-h-0 flex-1">
          <AppSidebar />
          <SidebarInset className="min-h-0">
            <div className="flex min-h-0 flex-1 flex-col">
              <MailThreadView key={contactId} contactId={decodeURIComponent(contactId)} />
            </div>
          </SidebarInset>
          <SidePanels />
        </div>
      </SidebarProvider>
    </div>
  );
}
