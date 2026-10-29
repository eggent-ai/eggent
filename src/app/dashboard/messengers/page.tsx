"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SettingsContent } from "@/components/settings-shell";
import { TelegramIntegrationManager } from "@/components/telegram-integration-manager";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { SidePanels } from "@/components/side-panels";
import { useI18n } from "@/i18n/provider";

export default function MessengersPage() {
  const { t } = useI18n();

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("messengers.title")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <SettingsContent>

              <div className="space-y-1.5">
                <h2 className="text-2xl/8 font-semibold tracking-tight">{t("messengers.heading")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("messengers.description")}
                </p>
              </div>

              <section className="rounded-lg border bg-card p-4 space-y-2">
                <h3 className="text-lg font-medium">{t("messengers.telegramCommands")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("messengers.availableCommands")}
                </p>
                <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                  <li>
                    <span className="font-mono">/start</span> - {t("messengers.command.start")}
                  </li>
                  <li>
                    <span className="font-mono">/help</span> - {t("messengers.command.help")}
                  </li>
                  <li>
                    <span className="font-mono">/code &lt;access_code&gt;</span> - {t("messengers.command.code")}
                  </li>
                  <li>
                    <span className="font-mono">/new</span> - {t("messengers.command.new")}
                  </li>
                  <li>
                    <span className="font-mono">/reset</span> - {t("messengers.command.reset")}
                  </li>
                  <li>
                    <span className="font-mono">/files</span> - {t("messengers.command.files")}
                  </li>
                </ul>
                <p className="text-xs text-muted-foreground">
                  {t("messengers.notes") }
                </p>
              </section>

              <TelegramIntegrationManager />
            </SettingsContent>
          </SidebarInset>
          <SidePanels />
        </div>
      </SidebarProvider>
    </div>
  );
}
