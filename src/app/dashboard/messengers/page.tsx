"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SettingsNavigation } from "@/components/settings-navigation";
import { TelegramIntegrationManager } from "@/components/telegram-integration-manager";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
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
            <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <SettingsNavigation />

              <div className="space-y-2">
                <h2 className="text-2xl font-semibold">{t("messengers.heading")}</h2>
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
                </ul>
                <p className="text-xs text-muted-foreground">
                  {t("messengers.notes") }
                </p>
              </section>

              <TelegramIntegrationManager />
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
