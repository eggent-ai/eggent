import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ExternalApiTokenManager } from "@/components/external-api-token-manager";
import { SiteHeader } from "@/components/site-header";
import { SettingsNavigation } from "@/components/settings-navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="rounded-lg border bg-muted/40 p-3 text-xs overflow-x-auto whitespace-pre-wrap">
      <code>{code}</code>
    </pre>
  );
}

function InfoCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4 space-y-3">
      <h3 className="text-lg font-medium">{title}</h3>
      {children}
    </section>
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
              <SettingsNavigation />

              <div className="space-y-2">
                <h2 className="text-2xl font-semibold">External Message API</h2>
                <p className="text-sm text-muted-foreground">
                  Send messages to Eggent from your app, workflow, bot, or webhook. Eggent keeps
                  session state by <span className="font-mono">sessionId</span>, so follow-up calls
                  can continue the same project/chat context.
                </p>
              </div>

              <InfoCard title="1. Generate an API token">
                <ExternalApiTokenManager />
              </InfoCard>

              <InfoCard title="2. Connect to the endpoint">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border bg-muted px-2 py-0.5 text-xs font-medium">
                    POST
                  </span>
                  <span className="font-mono text-sm">/api/external/message</span>
                </div>
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p>
                    Auth header: <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>
                  </p>
                  <p>
                    Required body fields: <span className="font-mono">sessionId</span> and{" "}
                    <span className="font-mono">message</span>.
                  </p>
                </div>
                <CodeBlock
                  code={`curl -X POST http://localhost:3000/api/external/message \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $EGGENT_API_TOKEN" \\
  -d '{
    "sessionId": "user-42",
    "message": "Summarize the current project status",
    "projectName": "optional project name"
  }'`}
                />
              </InfoCard>

              <InfoCard title="Request fields">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="text-left text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-2 pr-4 font-medium">Field</th>
                        <th className="py-2 pr-4 font-medium">Required</th>
                        <th className="py-2 font-medium">Purpose</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">sessionId</td>
                        <td className="py-2 pr-4">Yes</td>
                        <td className="py-2 text-muted-foreground">Stable external user/thread id. Used to remember context.</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">message</td>
                        <td className="py-2 pr-4">Yes</td>
                        <td className="py-2 text-muted-foreground">Text to send to the Eggent agent.</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">projectId</td>
                        <td className="py-2 pr-4">No</td>
                        <td className="py-2 text-muted-foreground">Pin or switch this external session to a project by id. Also accepts an exact unique project name.</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">projectName</td>
                        <td className="py-2 pr-4">No</td>
                        <td className="py-2 text-muted-foreground">Pin or switch by exact project name when you do not know the id.</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">chatId</td>
                        <td className="py-2 pr-4">No</td>
                        <td className="py-2 text-muted-foreground">Reuse a specific Eggent chat instead of auto-created session chat.</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">currentPath</td>
                        <td className="py-2 pr-4">No</td>
                        <td className="py-2 text-muted-foreground">Optional relative path hint inside the selected project.</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </InfoCard>

              <InfoCard title="Main use cases">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                    <h4 className="text-sm font-medium">Ask inside a project</h4>
                    <CodeBlock
                      code={`{
  "sessionId": "user-42",
  "projectName": "Backend",
  "message": "What should I work on next?"
}`}
                    />
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                    <h4 className="text-sm font-medium">Continue the same external thread</h4>
                    <CodeBlock
                      code={`{
  "sessionId": "user-42",
  "message": "Continue from the previous answer"
}`}
                    />
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                    <h4 className="text-sm font-medium">Use a fixed Eggent chat</h4>
                    <CodeBlock
                      code={`{
  "sessionId": "support-user-42",
  "chatId": "existing-chat-id",
  "message": "Append this to the support chat"
}`}
                    />
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                    <h4 className="text-sm font-medium">Send path context</h4>
                    <CodeBlock
                      code={`{
  "sessionId": "deploy-hook",
  "projectName": "Backend",
  "currentPath": "services/api",
  "message": "Check the deployment notes here"
}`}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  If <span className="font-mono">projectId</span> / <span className="font-mono">projectName</span> is omitted, Eggent uses the
                  session&apos;s last active project. If there is no active project and multiple projects
                  exist, the API returns <span className="font-mono">409</span> with available projects.
                </p>
              </InfoCard>

              <InfoCard title="JavaScript example">
                <CodeBlock
                  code={`const res = await fetch("https://your-eggent.example.com/api/external/message", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": ` + "`Bearer ${process.env.EGGENT_API_TOKEN}`" + `,
  },
  body: JSON.stringify({
    sessionId: "user-42",
    projectName: "Backend",
    message: "Create a short release summary",
  }),
});

const data = await res.json();
console.log(data.reply);`}
                />
              </InfoCard>

              <InfoCard title="Successful response">
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
  }
}`}
                />
              </InfoCard>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
