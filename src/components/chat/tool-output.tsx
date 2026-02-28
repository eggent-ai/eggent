"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Terminal,
  Brain,
  Search,
  FileText,
  Bot,
  Puzzle,
  CalendarClock,
  FolderOpen,
} from "lucide-react";
import { CodeBlock } from "./code-block";

interface ToolOutputProps {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
}

const TOOL_ICONS: Record<string, React.ElementType> = {
  code_execution: Terminal,
  memory_save: Brain,
  memory_load: Brain,
  memory_delete: Brain,
  search_web: Search,
  knowledge_query: FileText,
  call_subordinate: Bot,
  load_skill: Puzzle,
  load_skill_resource: Puzzle,
  create_skill: Puzzle,
  update_skill: Puzzle,
  delete_skill: Puzzle,
  write_skill_file: Puzzle,
  upsert_mcp_server: Puzzle,
  delete_mcp_server: Puzzle,
  cron: CalendarClock,
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
  knowledge_query: "Knowledge Query",
  call_subordinate: "Subordinate Agent",
  load_skill: "Load Skill",
  load_skill_resource: "Load Skill Resource",
  create_skill: "Create Skill",
  update_skill: "Update Skill",
  delete_skill: "Delete Skill",
  write_skill_file: "Write Skill File",
  upsert_mcp_server: "Upsert MCP Server",
  delete_mcp_server: "Delete MCP Server",
  cron: "Cron",
  list_projects: "List Projects",
  get_current_project: "Current Project",
  switch_project: "Switch Project",
  create_project: "Create Project",
};

export function ToolOutput({ toolName, args, result }: ToolOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICONS[toolName] || Terminal;
  const label = TOOL_LABELS[toolName] || toolName;

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
        {toolName === "search_web" && args.query ? (
          <span className="text-xs text-muted-foreground truncate">
            &quot;{String(args.query)}&quot;
          </span>
        ) : null}
      </button>

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
