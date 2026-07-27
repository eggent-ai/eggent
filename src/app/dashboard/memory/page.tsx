"use client";

import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

export default function MemoryPage() {
  const { t } = useI18n();

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("memory.title")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
              <section className="rounded-xl border bg-card p-5 space-y-3">
                <h1 className="text-2xl font-semibold">{t("memory.removedTitle")}</h1>
                <p className="text-sm text-muted-foreground">
                  {t("memory.removedDescription", { file: "memory.md" })}
                </p>
                <Button asChild>
                  <Link href="/dashboard/projects">{t("memory.openProjects")}</Link>
                </Button>
              </section>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
