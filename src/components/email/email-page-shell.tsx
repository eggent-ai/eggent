"use client";

import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidePanels } from "@/components/side-panels";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useI18n } from "@/i18n/provider";
import { useEmailStatus } from "./use-email-status";

/** The frame of the Mail screens: the dashboard's sidebar and header, and the mailbox's address. */
export function EmailPageShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const status = useEmailStatus();
  const address = status && status.enabled ? status.address : null;
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("email.pageTitle")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-8">
              <div className="space-y-1.5">
                <h2 className="text-2xl/8 font-semibold tracking-tight">{t("email.heading")}</h2>
                <p className="text-sm text-muted-foreground">
                  {address ? t("email.description", { address }) : t("email.descriptionNoAddress")}
                </p>
              </div>
              {children}
            </div>
          </SidebarInset>
          <SidePanels />
        </div>
      </SidebarProvider>
    </div>
  );
}
