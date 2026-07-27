import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { ChatPanel } from "@/components/chat/chat-panel"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { getServerMessage } from "@/i18n/server"
import { listBundledSkills } from "@/lib/storage/bundled-skills-store"
export const dynamic = "force-dynamic"

export default async function DashboardPage() {
  const quickSkills = await listBundledSkills()
  const title = await getServerMessage("dashboard.chatTitle")

  return (
    <div className="[--header-height:calc(--spacing(14))] h-svh overflow-hidden">
      <SidebarProvider className="flex h-full flex-col">
        <SiteHeader title={title} />
        <div className="flex min-h-0 flex-1">
          <AppSidebar />
          <SidebarInset className="min-h-0">
            <div className="flex min-h-0 flex-1 flex-col">
              <ChatPanel initialQuickSkills={quickSkills} />
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  )
}
