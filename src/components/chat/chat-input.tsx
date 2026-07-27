"use client";

import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { Send, Square, Paperclip, X, FileIcon, ImageIcon, Mic, MicOff, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import type { ChatFile } from "@/lib/types";
import type { PiRuntimeStats } from "@/lib/pi/types";
import type { PiPendingInteraction } from "@/lib/pi/interaction-types";

function formatTokenCount(value?: number | null) {
  if (value === undefined || value === null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatContextUsage(stats?: PiRuntimeStats | null) {
  const context = stats?.context;
  if (!context) return "ctx —";
  const tokens = context.tokens === null ? "—" : formatTokenCount(context.tokens);
  const window = formatTokenCount(context.contextWindow);
  const percent = context.percent === null ? "—" : `${Math.round(context.percent)}%`;
  return `ctx ${tokens}/${window} (${percent})`;
}

function formatModelName(stats?: PiRuntimeStats | null) {
  const model = stats?.model;
  if (!model) return "model —";
  const id = model.name || model.id || "unknown";
  return model.provider ? `${model.provider}/${id}` : id;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/png") return "png";
  return "png";
}

function buildClipboardImageName(mimeType: string, index: number): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  const ext = extensionForMimeType(mimeType);
  return `clipboard-image-${timestamp}-${index + 1}.${ext}`;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function chatFileKey(file: Pick<ChatFile, "name" | "type" | "size">): string {
  return `${file.name}:${file.type}:${file.size}`;
}

function mergeUniqueChatFiles(current: ChatFile[], incoming: ChatFile[]): ChatFile[] {
  const seen = new Set(current.map(chatFileKey));
  const next = [...current];
  for (const file of incoming) {
    const key = chatFileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }
  return next;
}

function getVoiceInputUnavailableMessage(t: (key: MessageKey) => string): string | null {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return t("chat.voiceHttpsRequired");
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return t("chat.voiceUnsupportedBrowser");
  }
  if (typeof MediaRecorder === "undefined") {
    return t("chat.audioUnsupportedBrowser");
  }
  return null;
}

function getVoiceInputErrorMessage(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return t("chat.microphoneBlocked");
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return t("chat.microphoneMissing");
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return t("chat.microphoneBusy");
    }
  }
  return error instanceof Error ? error.message : t("chat.recordingFailed");
}

interface SlashCommand {
  name: string;
  title?: string;
  description?: string;
  argumentHint?: string;
  source: "skill" | "prompt" | string;
  location?: string;
  path?: string;
}

interface ChatInputProps {
  input: string;
  setInput: (input: string) => void;
  onSubmit: (messageOverride?: string) => void;
  onStop?: () => void;
  isLoading: boolean;
  pendingInteraction?: PiPendingInteraction | null;
  disabled?: boolean;
  chatId?: string;
  projectId?: string | null;
  currentPath?: string;
  onFilesUploaded?: (files: ChatFile[]) => void;
  focusSignal?: number;
  runtimeStats?: PiRuntimeStats | null;
}

export function ChatInput({
  input,
  setInput,
  onSubmit,
  onStop,
  isLoading,
  pendingInteraction,
  disabled,
  chatId,
  projectId,
  currentPath,
  onFilesUploaded,
  focusSignal,
  runtimeStats,
}: ChatInputProps) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashCommandItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const latestInputRef = useRef(input);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<string[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<ChatFile[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);

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
        const files = data.files || [];
        setUploadedFiles(mergeUniqueChatFiles([], files));
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

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (currentPath) params.set("currentPath", currentPath);
    setSlashCommandsLoading(true);
    fetch(`/api/pi-commands?${params.toString()}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load commands");
        return res.json() as Promise<{ commands?: SlashCommand[] }>;
      })
      .then((data) => {
        if (!cancelled) setSlashCommands(Array.isArray(data.commands) ? data.commands : []);
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([]);
      })
      .finally(() => {
        if (!cancelled) setSlashCommandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, currentPath]);

  useEffect(() => {
    latestInputRef.current = input;
  }, [input]);

  const slashQuery = useMemo(() => {
    if (!input.startsWith("/")) return null;
    if (input.includes("\n")) return null;
    const afterSlash = input.slice(1);
    if (/\s/.test(afterSlash)) return null;
    return afterSlash.toLowerCase();
  }, [input]);

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery;
    return slashCommands
      .filter((command) => {
        const haystack = [
          command.name,
          command.title,
          command.description,
          command.source,
        ].filter(Boolean).join(" ").toLowerCase();
        return !query || command.name.toLowerCase().startsWith(query) || haystack.includes(query);
      })
      .slice(0, 8);
  }, [slashCommands, slashQuery]);

  const showSlashMenu = !slashMenuDismissed && slashQuery !== null && (filteredSlashCommands.length > 0 || slashCommandsLoading);

  useEffect(() => {
    setSlashMenuDismissed(false);
    setSelectedCommandIndex(0);
  }, [slashQuery, filteredSlashCommands.length]);

  useEffect(() => {
    slashCommandItemRefs.current.length = filteredSlashCommands.length;
  }, [filteredSlashCommands.length]);

  useEffect(() => {
    if (!showSlashMenu) return;
    const selectedItem = slashCommandItemRefs.current[selectedCommandIndex];
    selectedItem?.scrollIntoView({ block: "nearest" });
  }, [showSlashMenu, selectedCommandIndex]);

  useEffect(() => {
    if (!showSlashMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (slashMenuRef.current?.contains(target)) return;
      setSlashMenuDismissed(true);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [showSlashMenu]);

  const applySlashCommand = useCallback((command: SlashCommand) => {
    const commandText = `/${command.name} `;
    setInput(commandText);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(commandText.length, commandText.length);
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
    });
  }, [setInput]);

  const canSubmit = pendingInteraction
    ? Boolean(input.trim()) || pendingInteraction.kind === "confirm"
    : Boolean(input.trim()) || uploadedFiles.length > 0;
  const submitCurrentMessage = useCallback(() => {
    if (!canSubmit) return;
    if (!pendingInteraction && isLoading) return;
    if (pendingInteraction) {
      onSubmit();
      return;
    }
    onSubmit(input.trim() ? undefined : t("chat.attachmentOnlyPrompt"));
  }, [canSubmit, input, isLoading, onSubmit, pendingInteraction, t]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showSlashMenu && filteredSlashCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedCommandIndex((index) => (index + 1) % filteredSlashCommands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedCommandIndex((index) => (index - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          applySlashCommand(filteredSlashCommands[selectedCommandIndex] || filteredSlashCommands[0]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setInput("");
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitCurrentMessage();
      }
    },
    [
      showSlashMenu,
      filteredSlashCommands,
      selectedCommandIndex,
      applySlashCommand,
      setInput,
      submitCurrentMessage,
    ]
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

        setUploadedFiles((prev) => mergeUniqueChatFiles(prev, [uploadedFile]));
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

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled || isLoading || !chatId) return;

      const clipboardFiles = Array.from(e.clipboardData.files).filter(isImageFile);
      const itemFiles = Array.from(e.clipboardData.items)
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));

      const seen = new Set<string>();
      const images = [...clipboardFiles, ...itemFiles].filter((file) => {
        const key = `${file.type}:${file.size}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (images.length === 0) return;
      e.preventDefault();

      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        const name = image.name && image.name !== "image.png"
          ? image.name
          : buildClipboardImageName(image.type, index);
        const upload = new File([image], name, {
          type: image.type || "image/png",
          lastModified: Date.now(),
        });
        await uploadFile(upload);
      }
    },
    [chatId, disabled, isLoading, uploadFile]
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

  const appendTranscriptToInput = useCallback((transcript: string) => {
    const current = latestInputRef.current.trim();
    const next = current ? `${current}\n\n${transcript}` : transcript;
    setInput(next);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
    });
  }, [setInput]);

  const stopAudioTracks = useCallback(() => {
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
  }, []);

  const transcribeRecording = useCallback(async (blob: Blob) => {
    setIsTranscribing(true);
    setSpeechError(null);
    try {
      const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("webm") ? "webm" : "audio";
      const file = new File([blob], `dictation-${Date.now()}.${ext}`, { type: blob.type || "audio/webm" });
      const formData = new FormData();
      formData.append("file", file);
      formData.append("language", "auto");

      const response = await fetch("/api/speech/transcribe", {
        method: "POST",
        body: formData,
      });
      const data = await response.json().catch(() => null) as { transcript?: string; error?: string } | null;
      if (!response.ok || !data?.transcript) {
        throw new Error(data?.error || "Failed to transcribe audio");
      }
      appendTranscriptToInput(data.transcript);
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : "Failed to transcribe audio");
    } finally {
      setIsTranscribing(false);
    }
  }, [appendTranscriptToInput]);

  const startRecording = useCallback(async () => {
    if (disabled || isLoading || isRecording || isTranscribing) return;
    const unavailableMessage = getVoiceInputUnavailableMessage(t);
    if (unavailableMessage) {
      setSpeechError(unavailableMessage);
      return;
    }

    setSpeechError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setSpeechError(getVoiceInputErrorMessage(error, t));
      return;
    }
    audioStreamRef.current = stream;
    audioChunksRef.current = [];

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
        ? "audio/ogg;codecs=opus"
        : "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
      audioChunksRef.current = [];
      stopAudioTracks();
      if (blob.size > 0) void transcribeRecording(blob);
    };
    recorder.start();
    setIsRecording(true);
  }, [disabled, isLoading, isRecording, isTranscribing, stopAudioTracks, transcribeRecording, t]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      stopAudioTracks();
    }
    setIsRecording(false);
  }, [stopAudioTracks]);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      void startRecording().catch((error) => {
        stopAudioTracks();
        setIsRecording(false);
        setSpeechError(getVoiceInputErrorMessage(error, t));
      });
    }
  }, [isRecording, startRecording, stopAudioTracks, stopRecording, t]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      stopAudioTracks();
    };
  }, [stopAudioTracks]);

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

  useEffect(() => {
    if (input.length > 0) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset textarea height back to a single-row composer after submit/clear.
    textarea.style.height = "auto";
  }, [input]);

  useEffect(() => {
    if (!focusSignal) return;
    const textarea = textareaRef.current;
    if (!textarea || disabled) return;
    requestAnimationFrame(() => textarea.focus());
  }, [focusSignal, disabled]);

  return (
    <div
      className={`sticky bottom-0 z-20 shrink-0 border-t bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 transition-colors ${isDragging ? "bg-primary/5 border-primary" : ""}`}
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
                {file.type.startsWith("image/") ? (
                  <ImageIcon className="size-3" />
                ) : (
                  <FileIcon className="size-3" />
                )}
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
            <p className="text-primary font-medium">{t("chat.dropFiles")}</p>
          </div>
        )}

        <div className="relative">
          {showSlashMenu && (
            <div
              ref={slashMenuRef}
              className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-xl"
            >
              <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                {slashCommandsLoading ? t("chat.loadingCommands") : t("chat.slashCommands")}
              </div>
              {filteredSlashCommands.length > 0 ? (
                <div className="max-h-72 overflow-y-auto py-1">
                  {filteredSlashCommands.map((command, index) => {
                    const selected = index === selectedCommandIndex;
                    const isSkill = command.source === "skill";
                    return (
                      <button
                        key={`${command.source}:${command.name}:${command.path || index}`}
                        ref={(node) => {
                          slashCommandItemRefs.current[index] = node;
                        }}
                        type="button"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          applySlashCommand(command);
                        }}
                        className={`flex w-full items-start gap-3 px-3 py-2 text-left text-sm transition-colors ${selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
                      >
                        <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${isSkill ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                          <Sparkles className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <code className="font-mono text-xs">/{command.name}</code>
                            {command.argumentHint && (
                              <span className="font-mono text-[11px] text-muted-foreground">{command.argumentHint}</span>
                            )}
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              {isSkill ? t("chat.skill") : t("chat.prompt")}
                            </span>
                          </span>
                          {command.description && (
                            <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                              {command.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="px-3 py-3 text-sm text-muted-foreground">{t("chat.noMatchingCommands")}</div>
              )}
              <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                {t("chat.commandHelp")}
              </div>
            </div>
          )}

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
              disabled={disabled || Boolean(pendingInteraction) || !chatId}
              className="h-10 w-10 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
              title={chatId ? t("chat.attachFiles") : t("chat.attachFilesDisabled")}
            >
              <Paperclip className="size-4" />
            </Button>

            <Button
              variant={isRecording ? "destructive" : "ghost"}
              size="icon"
              onClick={toggleRecording}
              disabled={disabled || Boolean(pendingInteraction) || isLoading || isTranscribing}
              className="h-10 w-10 shrink-0 rounded-xl text-muted-foreground hover:text-foreground disabled:opacity-50"
              title={isRecording ? t("chat.stopDictation") : t("chat.dictate")}
            >
              {isTranscribing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : isRecording ? (
                <MicOff className="size-4" />
              ) : (
                <Mic className="size-4" />
              )}
            </Button>

            <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={pendingInteraction
                ? pendingInteraction.placeholder || (pendingInteraction.kind === "confirm" ? t("chat.confirmPlaceholder") : t("chat.waitingToolPlaceholder"))
                : isDragging ? t("chat.dropFilesPlaceholder") : t("chat.placeholder")}
              disabled={disabled}
              rows={1}
              className="min-h-[30px] max-h-[200px] w-full translate-y-px resize-none border-0 bg-transparent px-1 pt-2.5 pb-1.5 text-sm leading-5 placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
            />
          </div>

            {isLoading && !pendingInteraction ? (
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
                onClick={submitCurrentMessage}
                disabled={!canSubmit || disabled}
                className="h-10 w-10 shrink-0 rounded-xl"
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
        </div>
        {(isRecording || isTranscribing || speechError) && (
          <div className={`mt-2 text-center text-xs ${speechError ? "text-destructive" : "text-muted-foreground"}`}>
            {speechError || (isRecording ? t("chat.recording") : t("chat.transcribing"))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="font-mono">{formatModelName(runtimeStats)}</span>
          <span className="font-mono">in {formatTokenCount(runtimeStats?.session?.input ?? runtimeStats?.lastTurn?.input)}</span>
          <span className="font-mono">out {formatTokenCount(runtimeStats?.session?.output ?? runtimeStats?.lastTurn?.output)}</span>
          <span className="font-mono">{formatContextUsage(runtimeStats)}</span>
        </div>
      </div>
    </div>
  );
}
