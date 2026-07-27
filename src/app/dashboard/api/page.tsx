import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ExternalApiTokenManager } from "@/components/external-api-token-manager";
import { SiteHeader } from "@/components/site-header";
import { SettingsNavigation } from "@/components/settings-navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getServerTranslator } from "@/i18n/server";

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
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {children}
      </CardContent>
    </Card>
  );
}

export default async function ApiPage() {
  const t = await getServerTranslator();

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("apiDocs.title")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <SettingsNavigation />

              <div className="space-y-2">
                <h2 className="text-2xl font-semibold">{t("apiDocs.heading")}</h2>
                <p className="text-sm text-muted-foreground">{t("apiDocs.description")}</p>
              </div>

              <InfoCard title={t("apiDocs.generateToken")}>
                <ExternalApiTokenManager />
              </InfoCard>

              <InfoCard title={t("apiDocs.connectEndpoint")}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">POST</Badge>
                  <span className="font-mono text-sm">/api/external/message</span>
                </div>
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p>
                    {t("apiDocs.authHeader")} <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>
                  </p>
                  <p>
                    {t("apiDocs.requiredFields")}
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

              <InfoCard title={t("apiDocs.requestFields")}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="text-left text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-2 pr-4 font-medium">{t("apiDocs.field")}</th>
                        <th className="py-2 pr-4 font-medium">{t("apiDocs.required")}</th>
                        <th className="py-2 font-medium">{t("apiDocs.purpose")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">sessionId</td>
                        <td className="py-2 pr-4">{t("apiDocs.yes")}</td>
                        <td className="py-2 text-muted-foreground">{t("apiDocs.field.sessionId")}</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">message</td>
                        <td className="py-2 pr-4">{t("apiDocs.yes")}</td>
                        <td className="py-2 text-muted-foreground">{t("apiDocs.field.message")}</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">projectId</td>
                        <td className="py-2 pr-4">{t("apiDocs.no")}</td>
                        <td className="py-2 text-muted-foreground">{t("apiDocs.field.projectId")}</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">projectName</td>
                        <td className="py-2 pr-4">{t("apiDocs.no")}</td>
                        <td className="py-2 text-muted-foreground">{t("apiDocs.field.projectName")}</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">chatId</td>
                        <td className="py-2 pr-4">{t("apiDocs.no")}</td>
                        <td className="py-2 text-muted-foreground">{t("apiDocs.field.chatId")}</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-mono text-xs">currentPath</td>
                        <td className="py-2 pr-4">{t("apiDocs.no")}</td>
                        <td className="py-2 text-muted-foreground">{t("apiDocs.field.currentPath")}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </InfoCard>

              <InfoCard title={t("apiDocs.useCases")}>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                    <h4 className="text-sm font-medium">{t("apiDocs.useCase.project")}</h4>
                    <CodeBlock
                      code={`{
  "sessionId": "user-42",
  "projectName": "Backend",
  "message": "What should I work on next?"
}`}
                    />
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                    <h4 className="text-sm font-medium">{t("apiDocs.useCase.thread")}</h4>
                    <CodeBlock
                      code={`{
  "sessionId": "user-42",
  "message": "Continue from the previous answer"
}`}
                    />
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                    <h4 className="text-sm font-medium">{t("apiDocs.useCase.fixedChat")}</h4>
                    <CodeBlock
                      code={`{
  "sessionId": "support-user-42",
  "chatId": "existing-chat-id",
  "message": "Append this to the support chat"
}`}
                    />
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                    <h4 className="text-sm font-medium">{t("apiDocs.useCase.path")}</h4>
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
                  {t("apiDocs.omittedProjectNote")}
                </p>
              </InfoCard>

              <InfoCard title={t("apiDocs.jsExample")}>
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

              <InfoCard title={t("apiDocs.successResponse")}>
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
