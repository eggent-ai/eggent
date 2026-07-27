
"use client";

import { useState, useEffect, useRef } from "react";
import { FileText, Upload, File, Image as ImageIcon, Loader2, Trash2, MessageCircle, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from "@/components/ui/sheet";
import { useI18n } from "@/i18n/provider";

interface KnowledgeChunk {
    id: string;
    text: string;
    index: number;
}

interface KnowledgeFile {
    name: string;
    size: number;
    createdAt: string;
    chunkCount: number;
}

interface MemoryEntry {
    id: string;
    text: string;
    createdAt?: string;
    area?: string;
}

interface KnowledgeSectionProps {
    projectId: string;
}

export function KnowledgeSection({ projectId }: KnowledgeSectionProps) {
    const { t } = useI18n();
    const [files, setFiles] = useState<KnowledgeFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [memories, setMemories] = useState<MemoryEntry[]>([]);
    const [memoriesLoading, setMemoriesLoading] = useState(false);
    const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);
    const [chunksOpen, setChunksOpen] = useState(false);
    const [chunksFile, setChunksFile] = useState<string | null>(null);
    const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
    const [chunksLoading, setChunksLoading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        loadFiles();
        loadMemories();
        // loadFiles/loadMemories intentionally re-run only when the selected project changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    async function loadFiles() {
        try {
            setLoading(true);
            const res = await fetch(`/api/projects/${projectId}/knowledge`);
            const data = await res.json();
            if (Array.isArray(data)) {
                setFiles(data);
            }
        } catch (error) {
            console.error("Failed to load files:", error);
        } finally {
            setLoading(false);
        }
    }

    async function loadMemories() {
        try {
            setMemoriesLoading(true);
            const res = await fetch(`/api/memory?subdir=${encodeURIComponent(projectId)}`);
            const data = await res.json();

            if (Array.isArray(data)) {
                const entries: MemoryEntry[] = data
                    .filter((m) => m && m.metadata?.area !== "knowledge")
                    .map((m) => ({
                        id: m.id,
                        text: m.text,
                        createdAt: typeof m.metadata?.createdAt === "string" ? m.metadata.createdAt : undefined,
                        area: typeof m.metadata?.area === "string" ? m.metadata.area : undefined,
                    }));

                setMemories(entries);
            } else {
                setMemories([]);
            }
        } catch (error) {
            console.error("Failed to load memories:", error);
        } finally {
            setMemoriesLoading(false);
        }
    }

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;

        // Reset input value so same file can be selected again
        e.target.value = "";

        try {
            setUploading(true);
            const formData = new FormData();
            formData.append("file", file);

            const res = await fetch(`/api/projects/${projectId}/knowledge`, {
                method: "POST",
                body: formData,
            });

            if (!res.ok) {
                throw new Error(t("knowledge.uploadFailed"));
            }

            await loadFiles();
        } catch (error) {
            console.error("Upload error:", error);
            alert(t("knowledge.uploadFailed"));
        } finally {
            setUploading(false);
        }
    }

    async function handleDelete(filename: string) {
        if (!confirm(t("knowledge.confirmDeleteFile", { filename }))) return;

        try {
            setDeleting(filename);
            const res = await fetch(`/api/projects/${projectId}/knowledge`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename }),
            });

            if (!res.ok) {
                throw new Error(t("knowledge.deleteFailed"));
            }

            await loadFiles();
        } catch (error) {
            console.error("Delete error:", error);
            alert(t("knowledge.deleteFailed"));
        } finally {
            setDeleting(null);
        }
    }

    async function handleDeleteMemory(id: string) {
        if (!confirm(t("knowledge.confirmDeleteMemory"))) return;

        try {
            setDeletingMemoryId(id);
            const res = await fetch(
                `/api/memory?id=${encodeURIComponent(id)}&subdir=${encodeURIComponent(projectId)}`,
                {
                    method: "DELETE",
                }
            );

            if (!res.ok) {
                throw new Error(t("knowledge.deleteMemoryFailed"));
            }

            await loadMemories();
        } catch (error) {
            console.error("Delete memory error:", error);
            alert(t("knowledge.deleteMemoryFailed"));
        } finally {
            setDeletingMemoryId(null);
        }
    }

    function formatSize(bytes: number) {
        if (bytes === 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
    }

    function getFileIcon(filename: string) {
        const ext = filename.split(".").pop()?.toLowerCase();
        if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext || "")) return ImageIcon;
        if (["pdf", "docx"].includes(ext || "")) return FileText;
        return File;
    }

    async function handleViewChunks(filename: string) {
        setChunksFile(filename);
        setChunksOpen(true);
        setChunksLoading(true);
        setChunks([]);
        try {
            const res = await fetch(
                `/api/projects/${projectId}/knowledge/chunks?filename=${encodeURIComponent(filename)}`
            );
            const data = await res.json();
            if (data.chunks) setChunks(data.chunks);
        } catch (e) {
            console.error("Failed to load chunks", e);
        } finally {
            setChunksLoading(false);
        }
    }

    function formatDate(value?: string) {
        if (!value) return "";
        try {
            return new Date(value).toLocaleString();
        } catch {
            return value;
        }
    }

    function getMemoryTitle(memory: MemoryEntry, index: number) {
        const created = formatDate(memory.createdAt);
        const prefix = memory.area ? memory.area.charAt(0).toUpperCase() + memory.area.slice(1) : t("knowledge.memory");
        if (created) {
            return `${prefix} #${index + 1} • ${created}`;
        }
        return `${prefix} #${index + 1}`;
    }

    function handleViewMemory(memory: MemoryEntry, index: number) {
        setChunksFile(getMemoryTitle(memory, index));
        setChunksOpen(true);
        setChunksLoading(false);
        setChunks([
            {
                id: memory.id,
                text: memory.text,
                index: 1,
            },
        ]);
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-medium flex items-center gap-2">
                    {t("knowledge.title")}
                </h3>
                <div>
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleUpload}
                        className="hidden"
                        accept=".txt,.md,.json,.csv,.pdf,.docx,.png,.jpg,.jpeg,.gif,.bmp,.webp"
                    />
                    <Button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        variant="outline"
                        className="gap-2"
                    >
                        {uploading ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Upload className="size-4" />
                        )}
                        {uploading ? t("knowledge.uploading") : t("knowledge.uploadFile")}
                    </Button>
                </div>
            </div>

            <div className="border rounded-lg bg-card">
                <div className="flex items-center justify-between px-4 py-3 border-b">
                    <h4 className="text-sm font-medium">{t("knowledge.filesMemory")}</h4>
                </div>
                {loading ? (
                    <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
                        <Loader2 className="size-4 animate-spin" />
                        {t("knowledge.loadingFiles")}
                    </div>
                ) : files.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">
                        <FolderOpen className="size-10 mx-auto mb-3 opacity-20" />
                        <p>{t("knowledge.noFilesTitle")}</p>
                        <p className="text-xs mt-1">{t("knowledge.noFilesDescription")}</p>
                    </div>
                ) : (
                    <div className="divide-y">
                        {files.map((file) => {
                            const Icon = getFileIcon(file.name);
                            return (
                                <div
                                    key={file.name}
                                    className="p-3 flex items-center justify-between hover:bg-muted/50 transition-colors gap-2 cursor-pointer"
                                    onClick={() => {
                                        if ((file.chunkCount ?? 0) > 0) {
                                            handleViewChunks(file.name);
                                        }
                                    }}
                                >
                                    <div className="flex items-center gap-3 min-w-0 flex-1">
                                        <div className="bg-primary/10 p-2 rounded shrink-0">
                                            <Icon className="size-4 text-primary" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="font-medium text-sm truncate max-w-[200px] sm:max-w-md">
                                                {file.name}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {formatSize(file.size)} • {new Date(file.createdAt).toLocaleDateString()}
                                                {(file.chunkCount ?? 0) > 0 && (
                                                    <span> • {t("knowledge.chunkCount", { count: file.chunkCount })}</span>
                                                )}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="text-muted-foreground hover:text-destructive"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDelete(file.name);
                                            }}
                                            disabled={deleting === file.name}
                                            title={t("knowledge.delete")}
                                        >
                                            {deleting === file.name ? (
                                                <Loader2 className="size-4 animate-spin" />
                                            ) : (
                                                <Trash2 className="size-4" />
                                            )}
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Chat / agent memory entries for this project */}
            <div className="border rounded-lg bg-card">
                <div className="flex items-center justify-between px-4 py-3 border-b">
                    <div className="flex items-center gap-2">
                        <h4 className="text-sm font-medium">{t("knowledge.chatMemory")}</h4>
                    </div>
                </div>

                {memoriesLoading ? (
                    <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
                        <Loader2 className="size-4 animate-spin" />
                        {t("knowledge.loadingMemory")}
                    </div>
                ) : memories.length === 0 ? (
                    <div className="p-4 text-sm text-muted-foreground">
                        {t("knowledge.noChatMemory")}
                    </div>
                ) : (
                    <div className="divide-y">
                        {memories.map((memory, index) => (
                            <div
                                key={memory.id}
                                className="p-3 flex items-center justify-between hover:bg-muted/50 transition-colors gap-2"
                            >
                                <div
                                    className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer"
                                    onClick={() => handleViewMemory(memory, index)}
                                >
                                    <div className="bg-primary/10 p-2 rounded shrink-0">
                                        <MessageCircle className="size-4 text-primary" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="font-medium text-sm truncate">
                                            {getMemoryTitle(memory, index)}
                                        </p>
                                        <p className="text-xs text-muted-foreground line-clamp-2">
                                            {memory.text}
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="text-muted-foreground hover:text-destructive"
                                        onClick={() => handleDeleteMemory(memory.id)}
                                        disabled={deletingMemoryId === memory.id}
                                        title={t("knowledge.deleteMemory")}
                                    >
                                        {deletingMemoryId === memory.id ? (
                                            <Loader2 className="size-4 animate-spin" />
                                        ) : (
                                            <Trash2 className="size-4" />
                                        )}
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <Sheet open={chunksOpen} onOpenChange={setChunksOpen}>
                <SheetContent
                    side="right"
                    className="w-full sm:max-w-2xl flex flex-col"
                >
                    <SheetHeader>
                        <SheetTitle className="truncate pr-8">
                            {t("knowledge.chunksTitle", { file: chunksFile ?? "" })}
                        </SheetTitle>
                        <SheetDescription>
                            {t("knowledge.chunksDescription", { count: chunks.length })}
                        </SheetDescription>
                    </SheetHeader>
                    <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
                        {chunksLoading ? (
                            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                                <Loader2 className="size-4 animate-spin" />
                                {t("knowledge.loadingChunks")}
                            </div>
                        ) : chunks.length === 0 ? (
                            <p className="text-sm text-muted-foreground py-4">
                                {t("knowledge.noChunks")}
                            </p>
                        ) : (
                            chunks.map((chunk) => (
                                <div
                                    key={chunk.id}
                                    className="rounded-lg border bg-muted/30 p-3 text-sm"
                                >
                                    <p className="font-medium text-xs text-muted-foreground mb-2">
                                        {t("knowledge.chunk", { index: chunk.index })}
                                    </p>
                                    <pre className="whitespace-pre-wrap wrap-break-word font-sans text-foreground max-h-48 overflow-y-auto">
                                        {chunk.text}
                                    </pre>
                                </div>
                            ))
                        )}
                    </div>
                </SheetContent>
            </Sheet>
        </div>
    );
}
