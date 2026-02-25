import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { ChatPanel } from "@/components/chat/chat-panel"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { redirect } from "next/navigation"
import {
  getAllProjects,
} from "@/lib/storage/project-store"

export const dynamic = "force-dynamic"

export default async function DashboardPage() {
  const projects = await getAllProjects()

  if (projects.length === 0) {
    redirect("/dashboard/projects")
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="Chat" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col h-[calc(100svh-var(--header-height))]">
              <ChatPanel />
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  )
}
