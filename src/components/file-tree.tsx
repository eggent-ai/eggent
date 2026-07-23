"use client";

import { useState, useEffect, useCallback, useMemo, useRef, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  File,
  Download,
  FilePlus,
  FolderPlus,
  Trash2,
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

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types || []).includes("Files");
}

interface BrowserFileSystemEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

interface BrowserFileSystemFileEntry extends BrowserFileSystemEntry {
  isFile: true;
  file: (successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void) => void;
}

interface BrowserFileSystemDirectoryReader {
  readEntries: (
    successCallback: (entries: BrowserFileSystemEntry[]) => void,
    errorCallback?: (error: DOMException) => void
  ) => void;
}

interface BrowserFileSystemDirectoryEntry extends BrowserFileSystemEntry {
  isDirectory: true;
  createReader: () => BrowserFileSystemDirectoryReader;
}

interface DroppedUploadFile {
  file: File;
  relativePath: string;
}

interface DroppedUploadItems {
  files: DroppedUploadFile[];
  directories: string[];
}

function getDataTransferEntry(item: DataTransferItem): BrowserFileSystemEntry | null {
  const maybeWithEntry = item as DataTransferItem & {
    webkitGetAsEntry?: () => BrowserFileSystemEntry | null;
  };
  return maybeWithEntry.webkitGetAsEntry?.() ?? null;
}

function safeDroppedRelativePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function readFileEntry(entry: BrowserFileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readAllDirectoryEntries(entry: BrowserFileSystemDirectoryEntry): Promise<BrowserFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: BrowserFileSystemEntry[] = [];

  while (true) {
    const batch = await new Promise<BrowserFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    entries.push(...batch);
  }

  return entries;
}

async function collectEntryUploads(
  entry: BrowserFileSystemEntry,
  parentPath = ""
): Promise<DroppedUploadItems> {
  const relativePath = safeDroppedRelativePath(parentPath ? `${parentPath}/${entry.name}` : entry.name);

  if (entry.isFile) {
    const file = await readFileEntry(entry as BrowserFileSystemFileEntry);
    return { files: [{ file, relativePath: relativePath || file.name }], directories: [] };
  }

  if (entry.isDirectory) {
    const files: DroppedUploadFile[] = [];
    const directories = relativePath ? [relativePath] : [];
    const children = await readAllDirectoryEntries(entry as BrowserFileSystemDirectoryEntry);
    for (const child of children) {
      const nested = await collectEntryUploads(child, relativePath);
      files.push(...nested.files);
      directories.push(...nested.directories);
    }
    return { files, directories };
  }

  return { files: [], directories: [] };
}

async function getDroppedItems(event: DragEvent): Promise<DroppedUploadItems> {
  const dataTransferItems = Array.from(event.dataTransfer.items || []);
  const files: DroppedUploadFile[] = [];
  const directories: string[] = [];

  if (dataTransferItems.length > 0) {
    for (const item of dataTransferItems) {
      if (item.kind !== "file") continue;
      const entry = getDataTransferEntry(item);
      if (entry) {
        const collected = await collectEntryUploads(entry);
        files.push(...collected.files);
        directories.push(...collected.directories);
        continue;
      }

      const file = item.getAsFile();
      if (file) {
        files.push({ file, relativePath: safeDroppedRelativePath(file.name) || file.name });
      }
    }

    return { files, directories };
  }

  for (const file of Array.from(event.dataTransfer.files || [])) {
    const maybeWithRelativePath = file as File & { webkitRelativePath?: string };
    files.push({
      file,
      relativePath: safeDroppedRelativePath(maybeWithRelativePath.webkitRelativePath || file.name) || file.name,
    });
  }

  return { files, directories };
}

async function uploadFilesToDirectory(projectId: string, targetPath: string, items: DroppedUploadItems) {
  const formData = new FormData();
  formData.append("project", projectId);
  formData.append("path", targetPath);
  for (const directory of items.directories) {
    formData.append("directories", directory);
  }
  for (const item of items.files) {
    formData.append("files", item.file, item.file.name);
    formData.append("relativePaths", item.relativePath);
  }

  const res = await fetch("/api/files/upload", {
    method: "POST",
    body: formData,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Failed to upload files");
  }
  return payload as {
    uploaded?: Array<{ name: string; path: string; size: number }>;
    errors?: Array<{ name: string; error: string }>;
  };
}

interface TreeNodeProps {
  projectId: string;
  name: string;
  relativePath: string; // full relative path from project root
  type: "file" | "directory";
  depth: number;
  refreshToken: number;
  onCreated?: () => void;
}

function TreeNode({
  projectId,
  name,
  relativePath,
  type,
  depth,
  refreshToken,
  onCreated,
}: TreeNodeProps) {
  const router = useRouter();
  const { currentPath } = useAppStore();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const childrenRef = useRef<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
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

  useEffect(() => {
    childrenRef.current = children;
  }, [children]);

  const loadChildren = useCallback(async (force = false, showLoader = true) => {
    if (!force && childrenRef.current !== null) return; // already loaded
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
        childrenRef.current = data;
        setChildren(data);
      }
    } catch {
      setChildren((prev) => {
        if (prev === null) {
          childrenRef.current = [];
          return [];
        }
        return prev;
      });
    }
    if (showLoader) {
      setLoading(false);
    }
  }, [projectId, relativePath]);

  useEffect(() => {
    if (type !== "directory" || !expanded || children !== null) return;
    void loadChildren(false, true);
  }, [type, expanded, children, loadChildren]);

  useEffect(() => {
    if (type !== "directory" || !expanded) return;
    void loadChildren(true, false);
  }, [refreshToken, type, expanded, loadChildren]);

  const createEntry = async (entryType: "file" | "directory") => {
    const label = entryType === "file" ? "file" : "folder";
    const name = window.prompt(`New ${label} name`);
    const trimmed = name?.trim();
    if (!trimmed) return;

    const nextPath = relativePath ? `${relativePath}/${trimmed}` : trimmed;
    const res = await fetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: projectId, path: nextPath, type: entryType }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      window.alert(typeof payload.error === "string" ? payload.error : `Failed to create ${label}`);
      return;
    }

    setExpanded(true);
    await loadChildren(true, true);
    onCreated?.();
    if (entryType === "file") {
      const params = new URLSearchParams({ project: projectId, path: nextPath });
      router.push(`/dashboard/files?${params.toString()}`);
    }
  };

  const deleteEntry = async () => {
    const label = type === "directory" ? "folder" : "file";
    if (!window.confirm(`Delete ${label} "${relativePath}"?${type === "directory" ? " This will delete all files inside." : ""}`)) {
      return;
    }

    const params = new URLSearchParams({ project: projectId, path: relativePath });
    const res = await fetch(`/api/files?${params.toString()}`, { method: "DELETE" });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      window.alert(typeof payload.error === "string" ? payload.error : `Failed to delete ${label}`);
      return;
    }

    onCreated?.();
    router.push("/dashboard");
  };

  const uploadDroppedItems = async (items: DroppedUploadItems) => {
    if (type !== "directory" || (items.files.length === 0 && items.directories.length === 0)) return;
    try {
      const result = await uploadFilesToDirectory(projectId, relativePath, items);
      const errors = result.errors ?? [];
      if (errors.length > 0) {
        window.alert(errors.map((item) => `${item.name}: ${item.error}`).join("\n"));
      }
      setExpanded(true);
      await loadChildren(true, true);
      onCreated?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to upload files");
    }
  };

  const handleDragOver = (event: DragEvent) => {
    if (type !== "directory" || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    if (type !== "directory") return;
    event.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (event: DragEvent) => {
    if (type !== "directory" || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    void getDroppedItems(event)
      .then(uploadDroppedItems)
      .catch((error) => window.alert(error instanceof Error ? error.message : "Failed to read dropped folder"));
  };

  const handleClick = () => {
    if (type === "file") {
      const params = new URLSearchParams({ project: projectId, path: relativePath });
      router.push(`/dashboard/files?${params.toString()}`);
      return;
    }

    if (type === "directory") {
      if (relativePath === "skills" && projectId !== "none") {
        router.push(`/dashboard/projects/${projectId}/skills`);
        return;
      }
      const willExpand = !expanded;
      setExpanded(willExpand);
      if (willExpand) {
        void loadChildren(true, true);
      }
    }
  };

  const Icon = type === "directory"
    ? (expanded ? FolderOpen : Folder)
    : getFileIcon(name);

  return (
    <div
      className={cn(
        type === "directory" && isDragOver && "rounded-sm bg-primary/10 ring-1 ring-primary/40"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="group/tree-node relative">
        <button
          onClick={handleClick}
          className={cn(
            "flex items-center gap-1 w-full text-left text-xs py-1 px-1 rounded-sm hover:bg-accent/50 transition-colors",
            type === "file" && "pr-12",
            type === "directory" && "pr-16",
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
        <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-sm bg-background/80 group-hover/tree-node:flex">
          <a
            href={downloadHref}
            download={name}
            onClick={(event) => event.stopPropagation()}
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
            title={`Download ${name}`}
            aria-label={`Download ${name}`}
          >
            <Download className="size-3.5" />
          </a>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void deleteEntry();
            }}
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={`Delete ${name}`}
            aria-label={`Delete ${name}`}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
        )}
        {type === "directory" && (
        <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-sm bg-background/80 group-hover/tree-node:flex">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void createEntry("file");
            }}
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            title={`New file in ${name}`}
            aria-label={`New file in ${name}`}
          >
            <FilePlus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void createEntry("directory");
            }}
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            title={`New folder in ${name}`}
            aria-label={`New folder in ${name}`}
          >
            <FolderPlus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void deleteEntry();
            }}
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={`Delete ${name}`}
            aria-label={`Delete ${name}`}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
        )}
      </div>

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
              onCreated={onCreated}
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
  const router = useRouter();
  const { currentPath, setCurrentPath } = useAppStore();
  const [rootEntries, setRootEntries] = useState<FileEntry[] | null>(null);
  const [isRootDragOver, setIsRootDragOver] = useState(false);
  const refreshToken = useBackgroundSync({
    topics: ["files", "projects", "global"],
    projectId: projectId === "none" ? null : projectId,
  });

  useEffect(() => {
    setRootEntries(null);
  }, [projectId]);

  const loadRootEntries = useCallback(async () => {
    const params = new URLSearchParams({ project: projectId, path: "" });
    const res = await fetch(`/api/files?${params}`);
    const data = await res.json();
    if (Array.isArray(data)) setRootEntries(data);
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

  const createRootEntry = async (entryType: "file" | "directory") => {
    const label = entryType === "file" ? "file" : "folder";
    const name = window.prompt(`New ${label} name`);
    const trimmed = name?.trim();
    if (!trimmed) return;

    const res = await fetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: projectId, path: trimmed, type: entryType }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      window.alert(typeof payload.error === "string" ? payload.error : `Failed to create ${label}`);
      return;
    }

    await loadRootEntries();
    if (entryType === "file") {
      const params = new URLSearchParams({ project: projectId, path: trimmed });
      router.push(`/dashboard/files?${params.toString()}`);
    }
  };

  const uploadDroppedRootItems = async (items: DroppedUploadItems) => {
    if (items.files.length === 0 && items.directories.length === 0) return;
    try {
      const result = await uploadFilesToDirectory(projectId, "", items);
      const errors = result.errors ?? [];
      if (errors.length > 0) {
        window.alert(errors.map((item) => `${item.name}: ${item.error}`).join("\n"));
      }
      await loadRootEntries();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to upload files");
    }
  };

  const handleRootDragOver = (event: DragEvent) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setIsRootDragOver(true);
  };

  const handleRootDragLeave = (event: DragEvent) => {
    event.stopPropagation();
    setIsRootDragOver(false);
  };

  const handleRootDrop = (event: DragEvent) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsRootDragOver(false);
    void getDroppedItems(event)
      .then(uploadDroppedRootItems)
      .catch((error) => window.alert(error instanceof Error ? error.message : "Failed to read dropped folder"));
  };

  return (
    <div className="text-xs">
      {/* Project root button */}
      <div
        className={cn(
          "group/root relative",
          isRootDragOver && "rounded-sm bg-primary/10 ring-1 ring-primary/40"
        )}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
      >
        <button
          onClick={() => setCurrentPath("")}
          className={cn(
            "flex items-center gap-1 w-full text-left text-xs py-1 px-1 pr-12 rounded-sm hover:bg-accent/50 transition-colors",
            currentPath === "" && "bg-accent text-accent-foreground font-medium"
          )}
        >
          <FolderOpen className="size-3.5 shrink-0 text-blue-500" />
          <span className="truncate font-medium">/</span>
        </button>
        <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-sm bg-background/80 group-hover/root:flex">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void createRootEntry("file");
            }}
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            title="New file"
            aria-label="New file"
          >
            <FilePlus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void createRootEntry("directory");
            }}
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            title="New folder"
            aria-label="New folder"
          >
            <FolderPlus className="size-3.5" />
          </button>
        </div>
      </div>

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
            onCreated={loadRootEntries}
          />
        ))
      )}
    </div>
  );
}
