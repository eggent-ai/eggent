"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidePanels } from "@/components/side-panels";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { MailContactsList } from "@/components/mail/mail-contacts-list";
import { useI18n } from "@/i18n/provider";

export default function MessagesPage() {
  const { t } = useI18n();
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("mail.pageTitle")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
              <div className="space-y-1.5">
                <h2 className="text-2xl/8 font-semibold tracking-tight">{t("mail.heading")}</h2>
                <p className="text-sm text-muted-foreground">{t("mail.description")}</p>
              </div>
              <MailContactsList />
            </div>
          </SidebarInset>
          <SidePanels />
        </div>
      </SidebarProvider>
    </div>
  );
}
