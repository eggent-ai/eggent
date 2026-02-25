"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  File,
  Download,
} from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { cn } from "@/lib/utils";
import { useBackgroundSync } from "@/hooks/use-background-sync";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size: number;
}

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "sh":
    case "json":
    case "yaml":
    case "yml":
      return FileCode;
    case "md":
    case "txt":
    case "csv":
      return FileText;
    default:
      return File;
  }
}

interface TreeNodeProps {
  projectId: string;
  name: string;
  relativePath: string; // full relative path from project root
  type: "file" | "directory";
  depth: number;
  refreshToken: number;
}

function TreeNode({
  projectId,
  name,
  relativePath,
  type,
  depth,
  refreshToken,
}: TreeNodeProps) {
  const { currentPath, setCurrentPath } = useAppStore();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const downloadHref = useMemo(() => {
    if (type !== "file") return "";
    const params = new URLSearchParams({
      project: projectId,
      path: relativePath,
    });
    return `/api/files/download?${params.toString()}`;
  }, [projectId, relativePath, type]);

  const isActive = type === "directory" && currentPath === relativePath;

  // Auto-expand if this folder is a parent of currentPath
  useEffect(() => {
    if (
      type === "directory" &&
      currentPath.startsWith(relativePath + "/") &&
      !expanded
    ) {
      setExpanded(true);
    }
  }, [currentPath, relativePath, type, expanded]);

  const loadChildren = useCallback(async (force = false, showLoader = true) => {
    if (!force && children !== null) return; // already loaded
    if (showLoader) {
      setLoading(true);
    }
    try {
      const params = new URLSearchParams({
        project: projectId,
        path: relativePath,
      });
      const res = await fetch(`/api/files?${params}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setChildren(data);
      }
    } catch {
      setChildren((prev) => (prev === null ? [] : prev));
    }
    if (showLoader) {
      setLoading(false);
    }
  }, [projectId, relativePath, children]);

  useEffect(() => {
    if (type !== "directory" || !expanded || children !== null) return;
    void loadChildren(false, true);
  }, [type, expanded, children, loadChildren]);

  useEffect(() => {
    if (type !== "directory" || !expanded) return;
    void loadChildren(true, false);
  }, [refreshToken, type, expanded, loadChildren]);

  const handleClick = () => {
    if (type === "directory") {
      const willExpand = !expanded;
      setExpanded(willExpand);
      if (willExpand) {
        void loadChildren(true, true);
      }
      setCurrentPath(relativePath);
    }
  };

  const Icon = type === "directory"
    ? (expanded ? FolderOpen : Folder)
    : getFileIcon(name);

  return (
    <div className="group/tree-node relative">
      <button
        onClick={handleClick}
        className={cn(
          "flex items-center gap-1 w-full text-left text-xs py-1 px-1 rounded-sm hover:bg-accent/50 transition-colors",
          type === "file" && "pr-7",
          isActive && "bg-accent text-accent-foreground font-medium"
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {type === "directory" ? (
          expanded ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="size-3 shrink-0" />
        )}
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            type === "directory"
              ? "text-blue-500"
              : "text-muted-foreground"
          )}
        />
        <span className="truncate">{name}</span>
      </button>
      {type === "file" && (
        <a
          href={downloadHref}
          download={name}
          className="absolute right-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover/tree-node:opacity-100"
          title={`Download ${name}`}
          aria-label={`Download ${name}`}
        >
          <Download className="size-3.5" />
        </a>
      )}

      {type === "directory" && expanded && (
        <div>
          {loading && (
            <span
              className="text-[10px] text-muted-foreground block"
              style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}
            >
              Loading...
            </span>
          )}
          {children?.map((child) => (
            <TreeNode
              key={child.name}
              projectId={projectId}
              name={child.name}
              relativePath={
                relativePath ? `${relativePath}/${child.name}` : child.name
              }
              type={child.type}
              depth={depth + 1}
              refreshToken={refreshToken}
            />
          ))}
          {children?.length === 0 && !loading && (
            <span
              className="text-[10px] text-muted-foreground block py-0.5"
              style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}
            >
              Empty
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface FileTreeProps {
  projectId: string;
}

export function FileTree({ projectId }: FileTreeProps) {
  const { currentPath, setCurrentPath } = useAppStore();
  const [rootEntries, setRootEntries] = useState<FileEntry[] | null>(null);
  const refreshToken = useBackgroundSync({
    topics: ["files", "projects", "global"],
    projectId: projectId === "none" ? null : projectId,
  });

  useEffect(() => {
    setRootEntries(null);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ project: projectId, path: "" });
    fetch(`/api/files?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data)) setRootEntries(data);
      })
      .catch(() => {
        if (!cancelled) {
          setRootEntries((prev) => (prev === null ? [] : prev));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshToken]);

  return (
    <div className="text-xs">
      {/* Project root button */}
      <button
        onClick={() => setCurrentPath("")}
        className={cn(
          "flex items-center gap-1 w-full text-left text-xs py-1 px-1 rounded-sm hover:bg-accent/50 transition-colors",
          currentPath === "" && "bg-accent text-accent-foreground font-medium"
        )}
      >
        <FolderOpen className="size-3.5 shrink-0 text-blue-500" />
        <span className="truncate font-medium">/</span>
      </button>

      {rootEntries === null ? (
        <span className="text-[10px] text-muted-foreground block pl-4 py-1">
          Loading...
        </span>
      ) : rootEntries.length === 0 ? (
        <span className="text-[10px] text-muted-foreground block pl-4 py-1">
          No files
        </span>
      ) : (
        rootEntries.map((entry) => (
          <TreeNode
            key={entry.name}
            projectId={projectId}
            name={entry.name}
            relativePath={entry.name}
            type={entry.type}
            depth={1}
            refreshToken={refreshToken}
          />
        ))
      )}
    </div>
  );
}
