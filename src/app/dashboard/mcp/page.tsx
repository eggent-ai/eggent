"use client";

import { useEffect, useMemo, useState } from "react";
import { Globe, Loader2, Terminal, Wrench } from "lucide-react";
import { SettingsScopeSelect, useSettingsScope } from "@/components/settings-scope";
import { SettingsPageHeader, SettingsShell } from "@/components/settings-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { Textarea } from "@/components/ui/textarea";
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
  const scope = useSettingsScope();
  const { scopeId } = scope;
  const [servers, setServers] = useState<McpServerItem[]>([]);
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState(EMPTY_MCP_JSON);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<"success" | "error" | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    // Only the scope still selected may fill the page, however the answers
    // arrive.
    let current = true;

    function showNothing(message: string) {
      setStatusMessage(message);
      setStatusTone("error");
      setServers([]);
      setRawContent(null);
      setDraftContent(EMPTY_MCP_JSON);
    }

    async function load() {
      setLoading(true);
      setStatusMessage(null);
      setStatusTone(null);
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(scopeId)}/mcp`);
        const payload = await res.json().catch(() => null);
        if (!current) return;
        if (!res.ok) {
          showNothing(typeof payload?.error === "string" ? payload.error : t("mcp.errors.load"));
          return;
        }
        const content = typeof payload?.content === "string" ? payload.content : null;
        setRawContent(content);
        setDraftContent(content ?? EMPTY_MCP_JSON);
        setServers(normalizeServers(payload?.servers));
      } catch {
        if (current) showNothing(t("mcp.errors.load"));
      } finally {
        if (current) setLoading(false);
      }
    }

    void load();
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId]);

  async function handleSaveRawContent() {
    try {
      setSaving(true);
      setStatusMessage(null);
      setStatusTone(null);

      const res = await fetch(`/api/projects/${encodeURIComponent(scopeId)}/mcp`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draftContent }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : t("mcp.errors.save"));
      }

      const content = typeof payload?.content === "string" ? payload.content : draftContent;
      setRawContent(content);
      setDraftContent(content);
      setServers(normalizeServers(payload?.servers));
      setStatusMessage(t("mcp.saved"));
      setStatusTone("success");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t("mcp.errors.save"));
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
    <SettingsShell title={t("mcp.title")}>
      <SettingsPageHeader
        title={t("mcp.heading")}
        description={t("mcp.description", { file: ".mcp.json" })}
        scope={<SettingsScopeSelect scope={scope} />}
      />

      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t("mcp.searchPlaceholder")}
        aria-label={t("mcp.searchPlaceholder")}
        className="sm:max-w-sm"
      />

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
          {!loading ? (
            <span className="text-xs text-muted-foreground">
              {t("mcp.total", { count: servers.length })}
            </span>
          ) : null}
        </div>

        {loading ? (
          <SkeletonList rows={2} className="p-4" />
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
              <div key={server.id} className="space-y-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {server.transport === "http" ? (
                      <Globe className="size-4 shrink-0 text-primary" />
                    ) : (
                      <Terminal className="size-4 shrink-0 text-primary" />
                    )}
                    <p className="truncate font-medium">{server.id}</p>
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
                        <pre className="mt-2 whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 font-mono text-xs">
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
                        <pre className="mt-2 whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 font-mono text-xs">
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

      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-medium">{t("mcp.raw")}</h3>
          {!loading ? <span className="text-xs text-muted-foreground">{t("mcp.editJson")}</span> : null}
        </div>
        <div className="space-y-3 p-4">
          {!loading && !rawContent ? (
            <p className="text-xs text-muted-foreground">{t("mcp.createHint")}</p>
          ) : null}
          <Textarea
            aria-label=".mcp.json"
            value={draftContent}
            onChange={(event) => setDraftContent(event.target.value)}
            placeholder='{"mcpServers": {}}'
            rows={10}
            spellCheck={false}
            disabled={loading || saving}
            className="min-h-64 font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <Button onClick={handleSaveRawContent} disabled={loading || saving || !canSaveDraft} className="gap-2">
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
    </SettingsShell>
  );
}
