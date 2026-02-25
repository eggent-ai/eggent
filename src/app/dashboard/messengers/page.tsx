import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { TelegramIntegrationManager } from "@/components/telegram-integration-manager";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export default function MessengersPage() {
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="Messengers" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold">Messenger Integrations</h2>
                <p className="text-sm text-muted-foreground">
                  Connect external messengers to the agent. Telegram is available now.
                </p>
              </div>

              <section className="rounded-lg border bg-card p-4 space-y-2">
                <h3 className="text-lg font-medium">Telegram Commands</h3>
                <p className="text-sm text-muted-foreground">
                  Available commands in Telegram private chat:
                </p>
                <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                  <li>
                    <span className="font-mono">/start</span> - show help and connection status
                  </li>
                  <li>
                    <span className="font-mono">/help</span> - show help
                  </li>
                  <li>
                    <span className="font-mono">/code &lt;access_code&gt;</span> - activate access for your Telegram user_id
                  </li>
                  <li>
                    <span className="font-mono">/new</span> - start a new conversation and reset context
                  </li>
                </ul>
                <p className="text-xs text-muted-foreground">
                  Notes: only private chats are supported. Uploaded files are saved into chat files,
                  and you can ask the agent to send a local file back to Telegram.
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
