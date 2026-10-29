"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MicLevelRings } from "@/components/chat/mic-level-rings";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";

/**
 * Speaking instead of typing, wherever there is a field to fill.
 *
 * The composer had it alone, so a question card - the one place the agent is
 * waiting for exactly what the person has to say - could only be typed into.
 * One hook and one button now serve both: record, send the whole recording to
 * /api/speech/transcribe, hand the text to whoever asked.
 */

function voiceInputUnavailableMessage(t: (key: MessageKey) => string): string | null {
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

function voiceInputErrorMessage(error: unknown, t: (key: MessageKey) => string): string {
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

export interface Dictation {
  isRecording: boolean;
  isTranscribing: boolean;
  error: string | null;
  /** The live microphone while recording, for the rings. */
  stream: MediaStream | null;
  toggle: () => void;
  /** Throw away what is being recorded or transcribed; nothing reaches the field. */
  cancel: () => void;
}

export function useDictation(onTranscript: (text: string) => void, blocked = false): Dictation {
  const { t } = useI18n();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // Gone from the screen: a recording still in flight must not land anywhere.
  const discardRef = useRef(false);
  // This recording was cancelled (Escape): its audio is never sent.
  const cancelledRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    setIsTranscribing(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("webm") ? "webm" : "audio";
      const file = new File([blob], `dictation-${Date.now()}.${ext}`, { type: blob.type || "audio/webm" });
      const formData = new FormData();
      formData.append("file", file);
      formData.append("language", "auto");
      const response = await fetch("/api/speech/transcribe", { method: "POST", body: formData, signal: controller.signal });
      const data = await response.json().catch(() => null) as { transcript?: string; error?: string } | null;
      if (!response.ok || !data?.transcript) {
        throw new Error(data?.error || "Failed to transcribe audio");
      }
      if (!discardRef.current && !controller.signal.aborted) onTranscriptRef.current(data.transcript);
    } catch (err) {
      if (!discardRef.current && !controller.signal.aborted) setError(err instanceof Error ? err.message : "Failed to transcribe audio");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!discardRef.current && !controller.signal.aborted) setIsTranscribing(false);
    }
  }, []);

  const start = useCallback(async () => {
    if (blocked || isRecording || isTranscribing) return;
    const unavailable = voiceInputUnavailableMessage(t);
    if (unavailable) {
      setError(unavailable);
      return;
    }
    setError(null);
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setError(voiceInputErrorMessage(err, t));
      return;
    }
    streamRef.current = media;
    setStream(media);
    chunksRef.current = [];
    cancelledRef.current = false;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
        ? "audio/ogg;codecs=opus"
        : "";
    const recorder = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      chunksRef.current = [];
      stopTracks();
      if (blob.size > 0 && !discardRef.current && !cancelledRef.current) void transcribe(blob);
    };
    recorder.start();
    setIsRecording(true);
  }, [blocked, isRecording, isTranscribing, stopTracks, transcribe, t]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else stopTracks();
    setIsRecording(false);
  }, [stopTracks]);

  const toggle = useCallback(() => {
    if (isRecording) {
      stop();
      return;
    }
    void start().catch((err) => {
      stopTracks();
      setIsRecording(false);
      setError(voiceInputErrorMessage(err, t));
    });
  }, [isRecording, start, stop, stopTracks, t]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      cancelledRef.current = true;
      chunksRef.current = [];
      recorder.stop();
    } else {
      stopTracks();
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setIsRecording(false);
    setIsTranscribing(false);
    setError(null);
  }, [stopTracks]);

  // Escape cancels, from anywhere on the page: the pointer is usually still on
  // the button and the caret in the field. Taken in the capture phase so the
  // same press does not also close a panel or clear what is typed.
  const busy = isRecording || isTranscribing;
  useEffect(() => {
    if (!busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, cancel]);

  useEffect(() => {
    discardRef.current = false;
    return () => {
      discardRef.current = true;
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      abortRef.current?.abort();
      stopTracks();
    };
  }, [stopTracks]);

  return { isRecording, isTranscribing, error, stream, toggle, cancel };
}

/** The microphone button, with the rings that show it is hearing. */
export function DictationButton({
  dictation,
  disabled = false,
  className = "h-10 w-10 rounded-xl",
}: {
  dictation: Dictation;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const { isRecording, isTranscribing, stream, toggle } = dictation;
  return (
    <span className={`relative isolate shrink-0 ${className}`}>
      {isRecording && stream && <MicLevelRings stream={stream} />}
      <Button
        type="button"
        variant={isRecording ? "destructive" : "ghost"}
        size="icon"
        onClick={toggle}
        disabled={(disabled && !isRecording) || isTranscribing}
        className={`relative shrink-0 disabled:opacity-50 ${className} ${isRecording ? "" : "text-muted-foreground hover:text-foreground"}`}
        title={isRecording ? t("chat.stopDictation") : t("chat.dictate")}
        aria-pressed={isRecording}
      >
        {isTranscribing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : isRecording ? (
          <MicOff className="size-4" />
        ) : (
          <Mic className="size-4" />
        )}
      </Button>
    </span>
  );
}

/** One quiet line under a field: recording, transcribing, or what went wrong. */
export function DictationStatus({ dictation, className = "" }: { dictation: Dictation; className?: string }) {
  const { t } = useI18n();
  const { isRecording, isTranscribing, error } = dictation;
  if (!isRecording && !isTranscribing && !error) return null;
  return (
    <div className={`text-xs ${error ? "text-destructive" : "text-muted-foreground"} ${className}`}>
      {error || (isRecording ? t("chat.recording") : t("chat.transcribingCancel"))}
    </div>
  );
}
