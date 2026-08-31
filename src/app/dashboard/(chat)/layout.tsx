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

/**
 * The chat screen, shared by `/dashboard` and `/dashboard/<chatId>`.
 *
 * It is a layout rather than a page so that moving between those two addresses
 * is not a page load: a layout is kept across its own routes, so the composer,
 * the sidebar and a turn already streaming all survive the address changing
 * under them. That matters most in the one moment they coincide - the first
 * message of a new chat, which gives the conversation its id and its address
 * while the answer is already arriving.
 *
 * The pages underneath render nothing. Their job is to say which chat the
 * address means, which is why they are pages at all: only a page sees the route
 * parameter, and only the server can say which project the chat belongs to.
 */
export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
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
      {children}
    </div>
  )
}
