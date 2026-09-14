"use client"

import { SidebarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useSidebar } from "@/components/ui/sidebar"
import { FilesPanelTrigger } from "@/components/files-panel"

export function SiteHeader({ title }: { title?: string }) {
  const { toggleSidebar } = useSidebar()

  return (
    <header className="sticky top-0 z-50 flex w-full items-center border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex h-(--header-height) w-full items-center gap-2 px-4">
        <Button
          className="size-8"
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
        >
          <SidebarIcon />
        </Button>
        <Separator orientation="vertical" className="mr-2 h-4" />
        <h1 className="text-sm font-medium tracking-tight">
          {title || "Eggent"}
        </h1>
        {/* Right corner, opposite the sidebar toggle: the two are the same
            kind of control, one for each side of the screen. */}
        <div className="ml-auto flex items-center gap-1">
          <FilesPanelTrigger />
        </div>
      </div>
    </header>
  )
}
