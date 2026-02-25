import { AppSidebar } from "@/components/app-sidebar";
import { ExternalApiTokenManager } from "@/components/external-api-token-manager";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="rounded-lg border bg-muted/40 p-3 text-xs overflow-x-auto whitespace-pre-wrap">
      <code>{code}</code>
    </pre>
  );
}

export default function ApiPage() {
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="API" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold">External Message API</h2>
                <p className="text-sm text-muted-foreground">
                  Endpoint for sending messages from external integrations (Telegram, bots, webhooks)
                  with persistent project/chat context.
                </p>
              </div>

              <section className="rounded-lg border bg-card p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="rounded border bg-muted px-2 py-0.5 text-xs font-medium">
                    POST
                  </span>
                  <span className="font-mono text-sm">/api/external/message</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Required fields: <span className="font-mono">sessionId</span>,{" "}
                  <span className="font-mono">message</span>.
                </p>
                <p className="text-sm text-muted-foreground">
                  Auth: header <span className="font-mono">Authorization: Bearer &lt;token&gt;</span> (from Token Management or <span className="font-mono">EXTERNAL_API_TOKEN</span>).
                </p>
                <CodeBlock
                  code={`{
  "sessionId": "user-42",
  "message": "hello",
  "projectId": "my-project-id",
  "chatId": "optional-chat-id",
  "currentPath": "optional/relative/path"
}`}
                />
              </section>

              <section className="rounded-lg border bg-card p-4 space-y-3">
                <h3 className="text-lg font-medium">Telegram Webhook</h3>
                <p className="text-sm text-muted-foreground">
                  Telegram endpoint: <span className="font-mono">POST /api/integrations/telegram</span>.
                  It reuses the same external session context engine as{" "}
                  <span className="font-mono">/api/external/message</span>.
                </p>
                <p className="text-sm text-muted-foreground">
                  Configure credentials in <span className="font-mono">Dashboard -&gt; Messengers</span>
                  (bot token is enough; webhook secret/url are configured automatically).
                </p>
                <CodeBlock
                  code={`curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://YOUR_PUBLIC_BASE_URL/api/integrations/telegram",
    "secret_token": "'$TELEGRAM_WEBHOOK_SECRET'"
  }'`}
                />
                <p className="text-sm text-muted-foreground">
                  Supported commands: <span className="font-mono">/start</span>,{" "}
                  <span className="font-mono">/help</span>,{" "}
                  <span className="font-mono">/code &lt;access_code&gt;</span>,{" "}
                  <span className="font-mono">/new</span>.
                </p>
              </section>

              <section className="rounded-lg border bg-card p-4 space-y-3">
                <h3 className="text-lg font-medium">API Token Management</h3>
                <ExternalApiTokenManager />
              </section>

              <section className="rounded-lg border bg-card p-4 space-y-3">
                <h3 className="text-lg font-medium">How Project Context Is Resolved</h3>
                <ol className="list-decimal pl-5 space-y-1 text-sm text-muted-foreground">
                  <li>If request includes <span className="font-mono">projectId</span>, it is used and saved as active for this session.</li>
                  <li>Otherwise API uses session&apos;s current active project.</li>
                  <li>If active project is missing and only one project exists, it is selected automatically.</li>
                  <li>If multiple projects exist and message is not about project navigation, API returns <span className="font-mono">409</span> with available projects.</li>
                </ol>
              </section>

              <section className="rounded-lg border bg-card p-4 space-y-3">
                <h3 className="text-lg font-medium">Project Navigation via Natural Language</h3>
                <p className="text-sm text-muted-foreground">
                  The agent can answer project questions and switch projects using tools:
                  <span className="font-mono"> list_projects</span>,{" "}
                  <span className="font-mono"> get_current_project</span>,{" "}
                  <span className="font-mono"> switch_project</span>,{" "}
                  <span className="font-mono"> create_project</span>.
                  When switch/create succeeds, session context is updated automatically for next requests.
                </p>
              </section>

              <section className="rounded-lg border bg-card p-4 space-y-3">
                <h3 className="text-lg font-medium">Examples</h3>
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium mb-1">1. Ask for projects</p>
                    <CodeBlock
                      code={`curl -X POST http://localhost:3000/api/external/message \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $EXTERNAL_API_TOKEN" \\
  -d '{
    "sessionId": "user-42",
    "message": "what projects are available?"
  }'`}
                    />
                  </div>

                  <div>
                    <p className="text-sm font-medium mb-1">2. Switch by name</p>
                    <CodeBlock
                      code={`curl -X POST http://localhost:3000/api/external/message \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $EXTERNAL_API_TOKEN" \\
  -d '{
    "sessionId": "user-42",
    "message": "switch to the backend project"
  }'`}
                    />
                  </div>

                  <div>
                    <p className="text-sm font-medium mb-1">3. Send normal message after switch</p>
                    <CodeBlock
                      code={`curl -X POST http://localhost:3000/api/external/message \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $EXTERNAL_API_TOKEN" \\
  -d '{
    "sessionId": "user-42",
    "message": "hello"
  }'`}
                    />
                  </div>

                  <div>
                    <p className="text-sm font-medium mb-1">4. Create a new project from chat</p>
                    <CodeBlock
                      code={`curl -X POST http://localhost:3000/api/external/message \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $EXTERNAL_API_TOKEN" \\
  -d '{
    "sessionId": "user-42",
    "message": "create a new project named crm-support"
  }'`}
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-lg border bg-card p-4 space-y-3">
                <h3 className="text-lg font-medium">Successful Response Shape</h3>
                <CodeBlock
                  code={`{
  "success": true,
  "sessionId": "user-42",
  "reply": "assistant response",
  "context": {
    "activeProjectId": "backend",
    "activeProjectName": "Backend",
    "activeChatId": "b86f...",
    "currentPath": ""
  },
  "switchedProject": {
    "toProjectId": "backend",
    "toProjectName": "Backend"
  },
  "createdProject": null
}`}
                />
              </section>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
