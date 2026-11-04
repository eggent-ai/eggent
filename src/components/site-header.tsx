"use client"

import { Maximize2, SidebarIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useSidebar } from "@/components/ui/sidebar"
import { FilesPanelTrigger } from "@/components/files-panel"
import { TerminalPanelTrigger } from "@/components/terminal-panel"
import { BrowserPanelTrigger } from "@/components/browser-panel"
import { useI18n } from "@/i18n/provider"
import { setFocusMode } from "@/lib/focus-mode"

export function SiteHeader({ title, focusToggle = false }: { title?: string; focusToggle?: boolean }) {
  const { toggleSidebar } = useSidebar()
  const { t } = useI18n()
  const [cloudMenuReady, setCloudMenuReady] = useState(false)

  // The injected menu must join the toolbar after React has hydrated it.
  useEffect(() => setCloudMenuReady(true), [])

  return (
    <header data-slot="site-header" data-cloud-menu="toolbar" className="sticky top-0 z-30 flex w-full items-center border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/90">
      <div className="flex min-h-(--header-height) w-full min-w-0 items-center gap-2 px-3 sm:px-5">
        <Button
          className="size-8"
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label="Toggle navigation"
        >
          <SidebarIcon />
        </Button>
        <Separator orientation="vertical" className="mx-1 h-4 shrink-0" />
        <h1 className="min-w-0 truncate text-sm leading-5 font-semibold tracking-tight">
          {title || "Eggent"}
        </h1>
        {/* Right corner, opposite the sidebar toggle: the two are the same
            kind of control, one for each side of the screen. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <BrowserPanelTrigger />
          <TerminalPanelTrigger />
          <FilesPanelTrigger />
          {/* Focus mode, on the chat screen only: the chat alone on screen. */}
          {focusToggle && (
            <Button
              className="size-8"
              variant="ghost"
              size="icon"
              onClick={() => setFocusMode(true)}
              aria-label={t("chat.focus.enter")}
              title={t("chat.focus.enter")}
            >
              <Maximize2 />
            </Button>
          )}
          {/* The cloud menu joins the toolbar instead of covering the composer. */}
          {cloudMenuReady && <div data-slot="cloud-menu-anchor" className="flex shrink-0 items-center empty:hidden" />}
        </div>
      </div>
    </header>
  )
}
