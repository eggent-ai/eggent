"use client";

import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SettingsNavigation } from "@/components/settings-navigation";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { SidePanels } from "@/components/side-panels";

/**
 * The frame every settings tab shares.
 *
 * One width, one padding and one gap on every tab is what keeps the project
 * switcher in the same place: it sits in the heading's top-right corner, and a
 * tab with more room above its heading would move it out from under the hand
 * that is about to use it again.
 */
export function SettingsShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={title} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <SettingsContent>{children}</SettingsContent>
          </SidebarInset>
          <SidePanels />
        </div>
      </SidebarProvider>
    </div>
  );
}

/** One responsive navigation/content layout, including standalone settings pages. */
export function SettingsContent({ children }: { children: ReactNode }) {
  return (
    <div className="settings-surface mx-auto w-full min-w-0 max-w-[1280px] flex-1 p-4 md:p-8">
      <div className="settings-layout">
        <SettingsNavigation />
        <div className="settings-body flex min-w-0 flex-col gap-6">{children}</div>
      </div>
    </div>
  );
}

/**
 * A tab's title and one sentence about it, with its controls on the right.
 *
 * The project switcher comes last so that it hugs the right edge on every tab;
 * a page's own action goes to its left and never pushes it along.
 */
export function SettingsPageHeader({
  title,
  description,
  actions,
  scope,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  scope?: ReactNode;
}) {
  return (
    <div className="settings-page-header flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0 space-y-1.5">
        <h2 className="text-2xl leading-8 font-semibold tracking-tight">{title}</h2>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions || scope ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:max-w-[45%] lg:justify-end">
          {actions}
          {scope}
        </div>
      ) : null}
    </div>
  );
}
