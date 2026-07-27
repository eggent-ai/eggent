"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Terminal,
  Brain,
  Search,
  Globe,
  FileText,
  Bot,
  Puzzle,
  FolderOpen,
  ImageIcon,
} from "lucide-react";
import { CodeBlock } from "./code-block";

interface ToolOutputProps {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
}

interface GeneratedImagePreview {
  path: string;
  url: string;
  filename: string;
}

function generatedImageUrlFromPath(rawPath: unknown): GeneratedImagePreview | null {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  const normalized = rawPath.trim().replace(/\\/g, "/");
  const marker = "/data/projects/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) return null;
  const relativePath = normalized.slice(markerIndex + marker.length).replace(/^\/+/, "");
  if (!relativePath || relativePath.includes("..")) return null;
  if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(relativePath)) return null;
  const params = new URLSearchParams({ project: "none", path: relativePath });
  const filename = relativePath.split("/").pop() || "image";
  return { path: normalized, url: `/api/files/download?${params.toString()}`, filename };
}

function addPreview(previews: GeneratedImagePreview[], seen: Set<string>, rawPath: unknown): void {
  const preview = generatedImageUrlFromPath(rawPath);
  if (!preview || seen.has(preview.url)) return;
  seen.add(preview.url);
  previews.push(preview);
}

function collectGeneratedImagePreviews(value: unknown, previews: GeneratedImagePreview[], seen: Set<string>, depth = 0): void {
  if (depth > 4 || value == null) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return;
    addPreview(previews, seen, trimmed);
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
    try {
      collectGeneratedImagePreviews(JSON.parse(trimmed), previews, seen, depth + 1);
    } catch {
      // Not JSON; plain text may still contain a path but generatedImageUrlFromPath handles exact paths only.
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectGeneratedImagePreviews(item, previews, seen, depth + 1);
    return;
  }

  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;

  addPreview(previews, seen, record.path);

  const images = Array.isArray(record.images) ? record.images : [];
  for (const image of images) {
    const imageRecord = image && typeof image === "object" && !Array.isArray(image) ? image as Record<string, unknown> : null;
    addPreview(previews, seen, imageRecord?.path);
  }

  collectGeneratedImagePreviews(record.details, previews, seen, depth + 1);
  collectGeneratedImagePreviews(record.content, previews, seen, depth + 1);
  if (typeof record.text === "string") collectGeneratedImagePreviews(record.text, previews, seen, depth + 1);
}

function parseGeneratedImagePreviews(toolName: string, result: string): GeneratedImagePreview[] {
  if (toolName !== "eggent_generate_image" || !result.trim()) return [];
  const previews: GeneratedImagePreview[] = [];
  const seen = new Set<string>();
  collectGeneratedImagePreviews(result, previews, seen);
  return previews;
}

const TOOL_ICONS: Record<string, React.ElementType> = {
  code_execution: Terminal,
  memory_save: Brain,
  memory_load: Brain,
  memory_delete: Brain,
  search_web: Search,
  web_search: Search,
  fetch_content: Globe,
  get_search_content: FileText,
  web_fetch: Globe,
  knowledge_query: FileText,
  call_subordinate: Bot,
  load_skill: Puzzle,
  load_skill_resource: Puzzle,
  install_skill_from_github: Puzzle,
  create_skill: Puzzle,
  update_skill: Puzzle,
  delete_skill: Puzzle,
  write_skill_file: Puzzle,
  upsert_mcp_server: Puzzle,
  delete_mcp_server: Puzzle,
  mcp: Puzzle,
  list_projects: FolderOpen,
  get_current_project: FolderOpen,
  switch_project: FolderOpen,
  create_project: FolderOpen,
};

const TOOL_LABELS: Record<string, string> = {
  code_execution: "Code Execution",
  memory_save: "Memory Save",
  memory_load: "Memory Load",
  memory_delete: "Memory Delete",
  search_web: "Web Search",
  web_search: "Web Search",
  fetch_content: "Fetch Content",
  get_search_content: "Get Search Content",
  web_fetch: "Web Fetch",
  knowledge_query: "Knowledge Query",
  call_subordinate: "Subordinate Agent",
  load_skill: "Load Skill",
  load_skill_resource: "Load Skill Resource",
  install_skill_from_github: "Install Skill From GitHub",
  create_skill: "Create Skill",
  update_skill: "Update Skill",
  delete_skill: "Delete Skill",
  write_skill_file: "Write Skill File",
  upsert_mcp_server: "Upsert MCP Server",
  delete_mcp_server: "Delete MCP Server",
  mcp: "MCP",
  list_projects: "List Projects",
  get_current_project: "Current Project",
  switch_project: "Switch Project",
  create_project: "Create Project",
  response: "Response",
};

export function ToolOutput({ toolName, args, result }: ToolOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICONS[toolName] || Terminal;
  const label = TOOL_LABELS[toolName] || toolName;
  const imagePreviews = parseGeneratedImagePreviews(toolName, result);

  // Don't render the response tool visually
  if (toolName === "response") return null;

  return (
    <div className="border rounded-lg my-2 overflow-hidden bg-card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0" />
        ) : (
          <ChevronRight className="size-4 shrink-0" />
        )}
        <Icon className="size-4 shrink-0 text-primary" />
        <span className="font-medium">{label}</span>
        {toolName === "code_execution" && args.runtime ? (
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {String(args.runtime)}
          </span>
        ) : null}
        {(toolName === "search_web" || toolName === "web_search") && args.query ? (
          <span className="text-xs text-muted-foreground truncate">
            &quot;{String(args.query)}&quot;
          </span>
        ) : null}
        {(toolName === "web_fetch" || toolName === "fetch_content") && args.url ? (
          <span className="text-xs text-muted-foreground truncate">
            {String(args.url)}
          </span>
        ) : null}
        {imagePreviews.length > 0 ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
            <ImageIcon className="size-3" /> {imagePreviews.length}
          </span>
        ) : null}
      </button>

      {imagePreviews.length > 0 ? (
        <div className="border-t bg-muted/20 px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {imagePreviews.map((preview) => (
              <a
                key={preview.url}
                href={preview.url}
                target="_blank"
                rel="noreferrer"
                className="group block overflow-hidden rounded-lg border bg-background"
                title={preview.path}
              >
                <img
                  src={preview.url}
                  alt={preview.filename}
                  className="max-h-80 w-full object-contain transition group-hover:scale-[1.01]"
                  loading="lazy"
                />
                <div className="truncate border-t px-2 py-1 text-xs text-muted-foreground">
                  {preview.filename}
                </div>
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {expanded && (
        <div className="border-t px-3 py-2 space-y-2">
          {/* Tool arguments */}
          {toolName === "code_execution" && args.code ? (
            <CodeBlock
              code={String(args.code)}
              language={
                args.runtime === "python"
                  ? "python"
                  : args.runtime === "nodejs"
                    ? "javascript"
                    : "bash"
              }
            />
          ) : null}

          {/* Tool result */}
          {result ? (
            <div className="text-sm">
              <p className="text-xs text-muted-foreground mb-1 font-medium">
                Output:
              </p>
              <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
                {result}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
