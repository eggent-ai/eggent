"use client";

import { useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Input } from "@/components/ui/input";
import { Globe, Loader2, Terminal, Wrench } from "lucide-react";
import { useAppStore } from "@/store/app-store";

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

export default function McpPage() {
  const { projects, setProjects, activeProjectId } = useAppStore();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [servers, setServers] = useState<McpServerItem[]>([]);
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId("");
      return;
    }

    const hasCurrent = projects.some((project) => project.id === selectedProjectId);
    if (hasCurrent) return;

    const activeFromSidebar = activeProjectId
      ? projects.find((project) => project.id === activeProjectId)
      : null;

    if (activeFromSidebar) {
      setSelectedProjectId(activeFromSidebar.id);
      return;
    }

    setSelectedProjectId(projects[0].id);
  }, [projects, selectedProjectId, activeProjectId]);

  useEffect(() => {
    loadProjectMcp(selectedProjectId);
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
      setStatusMessage(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setStatusMessage(null);
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/mcp`);
      const payload = await res.json();

      if (!res.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : "Failed to load MCP servers";
        setStatusMessage(message);
        setServers([]);
        setRawContent(null);
        return;
      }

      setRawContent(typeof payload?.content === "string" ? payload.content : null);
      setServers(normalizeServers(payload?.servers));
    } catch {
      setStatusMessage("Failed to load MCP servers");
      setServers([]);
      setRawContent(null);
    } finally {
      setLoading(false);
    }
  }

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
        <SiteHeader title="MCP" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold">MCP Servers</h2>
                <p className="text-sm text-muted-foreground">
                  View MCP servers configured for each project from
                  <span className="font-mono"> .meta/mcp/servers.json </span>
                  and switch between projects.
                </p>
              </div>

              <div className="flex flex-col md:flex-row gap-3">
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="rounded-md border bg-background px-3 py-2 text-sm md:w-96"
                  disabled={projectsLoading || projects.length === 0}
                >
                  {projectsLoading && (
                    <option value="">Loading projects...</option>
                  )}
                  {!projectsLoading && projects.length === 0 && (
                    <option value="">No projects available</option>
                  )}
                  {!projectsLoading &&
                    projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name} ({project.id})
                      </option>
                    ))}
                </select>

                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search MCP servers..."
                  className="md:max-w-sm"
                />
              </div>

              {statusMessage && (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  {statusMessage}
                </div>
              )}

              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Wrench className="size-4 text-primary" />
                    <h3 className="text-sm font-medium">Servers In Project</h3>
                  </div>
                  {!loading && selectedProjectId && (
                    <span className="text-xs text-muted-foreground">
                      {servers.length} total
                    </span>
                  )}
                </div>

                {loading ? (
                  <div className="py-12 text-center text-muted-foreground flex items-center justify-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    Loading MCP servers...
                  </div>
                ) : !selectedProjectId ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Select a project to view MCP servers.
                  </div>
                ) : filteredServers.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No MCP servers found for this project.
                  </div>
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
                          <span className="rounded border px-2 py-0.5 text-xs text-muted-foreground shrink-0">
                            {server.transport}
                          </span>
                        </div>

                        {server.transport === "stdio" ? (
                          <div className="space-y-1 text-sm text-muted-foreground">
                            <p>
                              Command: <span className="font-mono">{server.command || "-"}</span>
                            </p>
                            {server.args && server.args.length > 0 ? (
                              <p>
                                Args: <span className="font-mono">{server.args.join(" ")}</span>
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
                                  Environment ({Object.keys(server.env).length})
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
                                  Headers ({Object.keys(server.headers).length})
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

              {rawContent ? (
                <div className="rounded-lg border bg-card">
                  <div className="border-b px-4 py-3">
                    <h3 className="text-sm font-medium">Raw servers.json</h3>
                  </div>
                  <div className="p-4">
                    <pre className="max-h-[360px] overflow-auto rounded-lg border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-words">
                      {rawContent}
                    </pre>
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
