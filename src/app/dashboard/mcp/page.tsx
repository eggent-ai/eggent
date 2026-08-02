"use client";

import { useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { OrchestratorFilesNavigation } from "@/components/orchestrator-files-navigation";
import { SettingsNavigation } from "@/components/settings-navigation";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Globe, Loader2, Terminal, Wrench } from "lucide-react";
import { ORCHESTRATOR_SCOPE_ID } from "@/lib/orchestrator-scope";
import { useAppStore } from "@/store/app-store";
import { useI18n } from "@/i18n/provider";

interface McpServerItem {
  id: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

function normalizeServers(input: unknown): McpServerItem[] {
  if (!Array.isArray(input)) return [];

  const servers: McpServerItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id : "";
    const transport = raw.transport;

    if (!id || (transport !== "stdio" && transport !== "http")) continue;

    if (transport === "stdio") {
      servers.push({
        id,
        transport,
        command: typeof raw.command === "string" ? raw.command : undefined,
        args: Array.isArray(raw.args)
          ? raw.args.filter((arg): arg is string => typeof arg === "string")
          : undefined,
        env:
          raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
            ? Object.fromEntries(
                Object.entries(raw.env).filter(
                  ([key, value]) =>
                    typeof key === "string" && typeof value === "string"
                )
              )
            : undefined,
        cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      });
    } else {
      servers.push({
        id,
        transport,
        url: typeof raw.url === "string" ? raw.url : undefined,
        headers:
          raw.headers &&
          typeof raw.headers === "object" &&
          !Array.isArray(raw.headers)
            ? Object.fromEntries(
                Object.entries(raw.headers).filter(
                  ([key, value]) =>
                    typeof key === "string" && typeof value === "string"
                )
              )
            : undefined,
      });
    }
  }

  return servers;
}

const EMPTY_MCP_JSON = JSON.stringify({ mcpServers: {} }, null, 2);

export default function McpPage() {
  const { t } = useI18n();
  const { projects, setProjects, activeProjectId } = useAppStore();
  // The orchestrator has a .mcp.json of its own, and it is the scope in use
  // whenever no project is selected.
  const [selectedProjectId, setSelectedProjectId] = useState(
    activeProjectId ?? ORCHESTRATOR_SCOPE_ID
  );
  const [servers, setServers] = useState<McpServerItem[]>([]);
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState(EMPTY_MCP_JSON);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<"success" | "error" | null>(null);
  const [search, setSearch] = useState("");
  const isOrchestratorSelected = selectedProjectId === ORCHESTRATOR_SCOPE_ID;

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isOrchestratorSelected) return;
    if (projects.some((project) => project.id === selectedProjectId)) return;
    setSelectedProjectId(
      activeProjectId && projects.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : ORCHESTRATOR_SCOPE_ID
    );
  }, [projects, selectedProjectId, activeProjectId, isOrchestratorSelected]);

  useEffect(() => {
    loadProjectMcp(selectedProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  async function loadProjects() {
    try {
      setProjectsLoading(true);
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (Array.isArray(data)) setProjects(data);
    } catch {
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }

  async function loadProjectMcp(projectId: string) {
    if (!projectId) {
      setServers([]);
      setRawContent(null);
      setDraftContent(EMPTY_MCP_JSON);
      setStatusMessage(null);
      setStatusTone(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setStatusMessage(null);
      setStatusTone(null);
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/mcp`);
      const payload = await res.json();

      if (!res.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : t("mcp.errors.load");
        setStatusMessage(message);
        setStatusTone("error");
        setServers([]);
        setRawContent(null);
        setDraftContent(EMPTY_MCP_JSON);
        return;
      }

      const content =
        typeof payload?.content === "string" ? payload.content : null;
      setRawContent(content);
      setDraftContent(content ?? EMPTY_MCP_JSON);
      setServers(normalizeServers(payload?.servers));
    } catch {
      setStatusMessage(t("mcp.errors.load"));
      setStatusTone("error");
      setServers([]);
      setRawContent(null);
      setDraftContent(EMPTY_MCP_JSON);
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveRawContent() {
    if (!selectedProjectId) return;

    try {
      setSaving(true);
      setStatusMessage(null);
      setStatusTone(null);

      const res = await fetch(
        `/api/projects/${encodeURIComponent(selectedProjectId)}/mcp`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: draftContent }),
        }
      );
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : t("mcp.errors.save")
        );
      }

      const content =
        typeof payload?.content === "string" ? payload.content : draftContent;
      setRawContent(content);
      setDraftContent(content);
      setServers(normalizeServers(payload?.servers));
      setStatusMessage(t("mcp.saved"));
      setStatusTone("success");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : t("mcp.errors.save")
      );
      setStatusTone("error");
    } finally {
      setSaving(false);
    }
  }

  const baselineContent = rawContent ?? EMPTY_MCP_JSON;
  const hasDraftChanges = draftContent !== baselineContent;
  const canSaveDraft = rawContent === null || hasDraftChanges;

  const filteredServers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return servers;

    return servers.filter((server) => {
      const parts = [server.id, server.transport, server.command, server.url]
        .filter((value): value is string => typeof value === "string")
        .join("\n")
        .toLowerCase();
      return parts.includes(query);
    });
  }, [servers, search]);

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("mcp.title")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <SettingsNavigation />
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold">{t("mcp.heading")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("mcp.description", { file: ".mcp.json" })}
                </p>
              </div>

              {isOrchestratorSelected ? <OrchestratorFilesNavigation /> : null}

              <div className="flex flex-col md:flex-row gap-3">
                <Select
                  value={selectedProjectId}
                  onValueChange={setSelectedProjectId}
                  disabled={projectsLoading}
                >
                  <SelectTrigger className="md:w-96">
                    <SelectValue placeholder={projectsLoading ? t("mcp.loadingProjects") : t("mcp.selectProject")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ORCHESTRATOR_SCOPE_ID}>
                        {t("common.orchestrator")}
                      </SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name} ({project.id})
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("mcp.searchPlaceholder")}
                  className="md:max-w-sm"
                />
              </div>

              {statusMessage ? (
                <Alert variant={statusTone === "error" ? "destructive" : "default"}>
                  <AlertDescription>{statusMessage}</AlertDescription>
                </Alert>
              ) : null}

              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Wrench className="size-4 text-primary" />
                    <h3 className="text-sm font-medium">{t("mcp.serversInWorkspace")}</h3>
                  </div>
                  {!loading && selectedProjectId && (
                    <span className="text-xs text-muted-foreground">
                      {t("mcp.total", { count: servers.length })}
                    </span>
                  )}
                </div>

                {loading ? (
                  <div className="py-12 text-center text-muted-foreground flex items-center justify-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    {t("mcp.loadingServers")}
                  </div>
                ) : !selectedProjectId ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><Wrench /></EmptyMedia>
                      <EmptyTitle>{t("mcp.selectProjectTitle")}</EmptyTitle>
                      <EmptyDescription>{t("mcp.selectProjectDescription")}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : filteredServers.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><Wrench /></EmptyMedia>
                      <EmptyTitle>{t("mcp.noServersTitle")}</EmptyTitle>
                      <EmptyDescription>{t("mcp.noServersDescription")}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="divide-y">
                    {filteredServers.map((server) => (
                      <div key={server.id} className="p-4 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            {server.transport === "http" ? (
                              <Globe className="size-4 text-primary shrink-0" />
                            ) : (
                              <Terminal className="size-4 text-primary shrink-0" />
                            )}
                            <p className="font-medium truncate">{server.id}</p>
                          </div>
                          <Badge variant="outline" className="shrink-0">{server.transport}</Badge>
                        </div>

                        {server.transport === "stdio" ? (
                          <div className="space-y-1 text-sm text-muted-foreground">
                            <p>
                              {t("mcp.command")} <span className="font-mono">{server.command || "-"}</span>
                            </p>
                            {server.args && server.args.length > 0 ? (
                              <p>
                                {t("mcp.args")} <span className="font-mono">{server.args.join(" ")}</span>
                              </p>
                            ) : null}
                            {server.cwd ? (
                              <p>
                                CWD: <span className="font-mono">{server.cwd}</span>
                              </p>
                            ) : null}
                            {server.env && Object.keys(server.env).length > 0 ? (
                              <details className="pt-1">
                                <summary className="cursor-pointer text-xs">
                                  {t("mcp.environment", { count: Object.keys(server.env).length })}
                                </summary>
                                <pre className="mt-2 rounded border bg-muted/30 p-2 text-xs font-mono whitespace-pre-wrap break-words">
                                  {JSON.stringify(server.env, null, 2)}
                                </pre>
                              </details>
                            ) : null}
                          </div>
                        ) : (
                          <div className="space-y-1 text-sm text-muted-foreground">
                            <p>
                              URL: <span className="font-mono">{server.url || "-"}</span>
                            </p>
                            {server.headers && Object.keys(server.headers).length > 0 ? (
                              <details className="pt-1">
                                <summary className="cursor-pointer text-xs">
                                  {t("mcp.headers", { count: Object.keys(server.headers).length })}
                                </summary>
                                <pre className="mt-2 rounded border bg-muted/30 p-2 text-xs font-mono whitespace-pre-wrap break-words">
                                  {JSON.stringify(server.headers, null, 2)}
                                </pre>
                              </details>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {selectedProjectId ? (
                <div className="rounded-lg border bg-card">
                  <div className="flex items-center justify-between border-b px-4 py-3">
                    <h3 className="text-sm font-medium">{t("mcp.raw")}</h3>
                    {!loading && (
                      <span className="text-xs text-muted-foreground">
                        {t("mcp.editJson")}
                      </span>
                    )}
                  </div>
                  <div className="space-y-3 p-4">
                    {!loading && !rawContent && (
                      <p className="text-xs text-muted-foreground">
                        {t("mcp.createHint")}
                      </p>
                    )}
                    <Textarea
                      value={draftContent}
                      onChange={(e) => setDraftContent(e.target.value)}
                      placeholder='{"mcpServers": {}}'
                      rows={10}
                      disabled={loading || saving}
                      className="min-h-64 font-mono text-xs"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={handleSaveRawContent}
                        disabled={loading || saving || !canSaveDraft}
                        className="gap-2"
                      >
                        {saving ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            {t("common.saving")}
                          </>
                        ) : (
                          t("mcp.save")
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setDraftContent(baselineContent)}
                        disabled={loading || saving || !hasDraftChanges}
                      >
                        {t("mcp.reset")}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
