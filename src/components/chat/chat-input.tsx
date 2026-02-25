"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { Send, Square, Paperclip, X, FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChatFile } from "@/lib/types";

interface ChatInputProps {
  input: string;
  setInput: (input: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  isLoading: boolean;
  disabled?: boolean;
  chatId?: string;
  onFilesUploaded?: (files: ChatFile[]) => void;
}

export function ChatInput({
  input,
  setInput,
  onSubmit,
  onStop,
  isLoading,
  disabled,
  chatId,
  onFilesUploaded,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<string[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<ChatFile[]>([]);

  // Load chat files when chatId changes
  useEffect(() => {
    if (!chatId) {
      setUploadedFiles([]);
      return;
    }

    let cancelled = false;

    fetch(`/api/chat/files?chatId=${encodeURIComponent(chatId)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load files");
        return res.json();
      })
      .then((data: { files?: ChatFile[] }) => {
        if (cancelled) return;
        setUploadedFiles(data.files || []);
      })
      .catch(() => {
        if (!cancelled) {
          setUploadedFiles([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chatId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!isLoading && input.trim()) {
          onSubmit();
        }
      }
    },
    [input, isLoading, onSubmit]
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      // Auto-resize
      const textarea = e.target;
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
    },
    [setInput]
  );

  const uploadFile = useCallback(
    async (file: File) => {
      if (!chatId) return;

      setUploadingFiles((prev) => [...prev, file.name]);

      try {
        const formData = new FormData();
        formData.append("chatId", chatId);
        formData.append("file", file);

        const response = await fetch("/api/chat/files", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          throw new Error("Upload failed");
        }

        const data = await response.json();
        const uploadedFile = data.file as ChatFile;

        setUploadedFiles((prev) => [...prev, uploadedFile]);
        onFilesUploaded?.([uploadedFile]);
      } catch (error) {
        console.error("Failed to upload file:", error);
      } finally {
        setUploadingFiles((prev) => prev.filter((name) => name !== file.name));
      }
    },
    [chatId, onFilesUploaded]
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      for (const file of Array.from(files)) {
        await uploadFile(file);
      }

      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [uploadFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      for (const file of Array.from(files)) {
        await uploadFile(file);
      }
    },
    [uploadFile]
  );

  const removeUploadedFile = useCallback(
    async (filename: string) => {
      if (!chatId) return;

      try {
        await fetch(
          `/api/chat/files?chatId=${encodeURIComponent(chatId)}&filename=${encodeURIComponent(filename)}`,
          { method: "DELETE" }
        );
        setUploadedFiles((prev) => prev.filter((f) => f.name !== filename));
      } catch (error) {
        console.error("Failed to delete file:", error);
      }
    },
    [chatId]
  );

  return (
    <div
      className={`border-t bg-background p-4 transition-colors ${isDragging ? "bg-primary/5 border-primary" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="mx-auto max-w-3xl">
        {/* Uploaded files preview */}
        {(uploadedFiles.length > 0 || uploadingFiles.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-2">
            {uploadedFiles.map((file) => (
              <div
                key={file.name}
                className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
              >
                <FileIcon className="size-3" />
                <span className="max-w-[100px] truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => removeUploadedFile(file.name)}
                  className="hover:text-destructive"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {uploadingFiles.map((name) => (
              <div
                key={name}
                className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs opacity-50"
              >
                <FileIcon className="size-3 animate-pulse" />
                <span className="max-w-[100px] truncate">{name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Drag drop overlay hint */}
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10">
            <p className="text-primary font-medium">Drop files here</p>
          </div>
        )}

        <div className="relative">
          {/* File upload button */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />

          <div className="flex items-center gap-2 rounded-2xl border border-border/80 bg-background px-2 py-1.5 shadow-sm transition-colors focus-within:border-primary/40 focus-within:ring-4 focus-within:ring-primary/10">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || !chatId}
              className="h-10 w-10 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
              title={chatId ? "Attach files" : "Send a message first to attach files"}
            >
              <Paperclip className="size-4" />
            </Button>

            <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder={isDragging ? "Drop files here..." : "Send a message..."}
              disabled={disabled}
              rows={1}
              className="min-h-[30px] max-h-[200px] w-full translate-y-px resize-none border-0 bg-transparent px-1 pt-2.5 pb-1.5 text-sm leading-5 placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
            />
          </div>

            {isLoading ? (
              <Button
                variant="destructive"
                size="icon"
                onClick={onStop}
                className="h-10 w-10 shrink-0 rounded-xl"
              >
                <Square className="size-4" />
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={onSubmit}
                disabled={!input.trim() || disabled}
                className="h-10 w-10 shrink-0 rounded-xl"
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          AI agent with code execution, memory, and web search capabilities
        </p>
      </div>
    </div>
  );
}
