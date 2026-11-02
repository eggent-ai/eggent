"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AudioLines, Bot, Captions, ChevronDown, ChevronUp, Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import {
  buildSummaryInstructions,
  buildVoiceInstructions,
  formatCallLength,
  recentForVoice,
  runVoiceTool,
  VOICE_TOOLS,
  questionUpdate,
  type DelegateResult,
  type TurnStatus,
  type VoiceQuestion,
  type VoiceContextMessage,
  type VoiceTranscriptLine,
} from "@/lib/voice/tools";

/**
 * A live voice call with the agent.
 *
 * The page talks to the voice model directly - each hop adds to the wait
 * before the first word - with a short-lived secret the deployment mints for
 * this one call. The microphone goes up as 24 kHz PCM, the answer comes back
 * the same way and is played as it arrives; the person can talk over it. Real
 * work goes to the ordinary agent in this chat through `delegate`; when the
 * call ends, a card with what was said and a short summary is put into the
 * chat.
 */

/** What the chat gives a call: where it is held and how to reach the agent working in it. */
export interface VoiceCallBindings {
  chatId: string;
  projectId: string | null;
  projectName?: string | null;
  recent(): VoiceContextMessage[];
  delegate(task: string): DelegateResult;
  turn(): TurnStatus;
  /** Whether the agent is working in the chat now. */
  running: boolean;
  /** The question the agent waits on, if any: the voice model is told when one appears. */
  question: VoiceQuestion | null;
}

const RATE = 24000;

type Phase = "idle" | "connecting" | "live" | "ending";

/** Who has the floor, for the status line. */
type Floor = "listening" | "thinking" | "speaking";

let availability: Promise<boolean> | null = null;

/** Whether this deployment offers calls; asked once per page. */
function voiceOffered(): Promise<boolean> {
  availability ??= fetch("/api/voice/call", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : { available: false }))
    .then((json: { available?: boolean }) => Boolean(json.available))
    .catch(() => false);
  return availability;
}

export function useVoiceOffered(): boolean {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    let alive = true;
    void voiceOffered().then((value) => { if (alive) setOffered(value); });
    return () => { alive = false; };
  }, []);
  return offered;
}

// --- audio helpers -------------------------------------------------------

const CAPTURE_WORKLET = `
class EggentCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("eggent-capture", EggentCapture);
`;

/** Linear resampling to 24 kHz: speech loses nothing a voice model hears. */
function resample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === RATE) return input;
  const ratio = fromRate / RATE;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const at = i * ratio;
    const left = Math.floor(at);
    const right = Math.min(left + 1, input.length - 1);
    output[i] = input[left] + (input[right] - input[left]) * (at - left);
  }
  return output;
}

function floatToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function pcm16Base64ToFloat(base64: string): Float32Array {
  const binary = atob(base64);
  const length = binary.length >> 1;
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let value = (hi << 8) | lo;
    if (value >= 0x8000) value -= 0x10000;
    output[i] = value / 0x8000;
  }
  return output;
}

function errorKey(error: unknown): MessageKey {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "chat.microphoneBlocked";
    if (error.name === "NotFoundError") return "chat.microphoneMissing";
    if (error.name === "NotReadableError") return "chat.microphoneBusy";
  }
  return "voice.error.failed";
}

// --- the call ------------------------------------------------------------

interface CallState {
  phase: Phase;
  floor: Floor;
  seconds: number;
  muted: boolean;
  error: string | null;
  lines: Array<VoiceTranscriptLine & { id: string; final: boolean }>;
}

const INITIAL: CallState = { phase: "idle", floor: "listening", seconds: 0, muted: false, error: null, lines: [] };

/** For checking a call by hand: the measured waits before the first word of each answer. */
interface VoiceStats {
  firstAudioMs: number[];
  connectMs: number | null;
  events: Record<string, number>;
}

declare global {
  interface Window {
    __eggentVoiceStats?: VoiceStats;
  }
}

function useVoiceCall(bindings: VoiceCallBindings) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<CallState>(INITIAL);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  const ws = useRef<WebSocket | null>(null);
  const audio = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    micAnalyser: AnalyserNode;
    outAnalyser: AnalyserNode;
    out: GainNode;
    nextTime: number;
    sources: Set<AudioBufferSourceNode>;
  } | null>(null);
  const call = useRef<{ id: string; startedAt: number; beat: number | null; tick: number | null; delegated: string[] } | null>(null);
  const muted = useRef(false);
  const ignoreAudio = useRef(false);
  const speechStoppedAt = useRef<number | null>(null);
  const responding = useRef(false);
  const pendingUpdate = useRef<string | null>(null);
  /** The summary at the end: only the response asked for it counts, never one cancelled before it. */
  const summary = useRef<{ text: string; responseId: string | null; done: () => void } | null>(null);
  const lineIds = useRef(new Map<string, string>());
  const beatNow = useRef<() => void>(() => undefined);
  const lastBeatAt = useRef(0);
  const linesRef = useRef<CallState["lines"]>([]);
  useEffect(() => { linesRef.current = state.lines; }, [state.lines]);

  const stats = (): VoiceStats => {
    window.__eggentVoiceStats ??= { firstAudioMs: [], connectMs: null, events: {} };
    return window.__eggentVoiceStats;
  };

  const send = useCallback((event: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(event));
  }, []);

  const stopPlayback = useCallback(() => {
    const a = audio.current;
    if (!a) return;
    for (const source of a.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    a.sources.clear();
    a.nextTime = a.ctx.currentTime;
  }, []);

  const play = useCallback((base64: string) => {
    const a = audio.current;
    if (!a || ignoreAudio.current) return;
    const samples = pcm16Base64ToFloat(base64);
    if (!samples.length) return;
    const buffer = a.ctx.createBuffer(1, samples.length, RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = a.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(a.out);
    const at = Math.max(a.ctx.currentTime + 0.02, a.nextTime);
    source.start(at);
    a.nextTime = at + buffer.duration;
    a.sources.add(source);
    source.onended = () => a.sources.delete(source);
  }, []);

  /** One transcript line per item, updated in place as its text grows. */
  const upsertLine = useCallback((key: string, role: VoiceTranscriptLine["role"], text: string, mode: "append" | "replace", final: boolean) => {
    setState((current) => {
      let id = lineIds.current.get(key);
      const lines = [...current.lines];
      if (!id) {
        id = `${role}-${key}`;
        lineIds.current.set(key, id);
        lines.push({ id, role, text: "", final: false });
      }
      const index = lines.findIndex((line) => line.id === id);
      if (index < 0) return current;
      const line = lines[index];
      lines[index] = { ...line, text: mode === "append" ? line.text + text : text, final: final || line.final };
      return { ...current, lines };
    });
  }, []);

  const flushUpdate = useCallback(() => {
    const text = pendingUpdate.current;
    if (!text || responding.current) return;
    pendingUpdate.current = null;
    send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    send({ type: "response.create" });
  }, [send]);

  const handleEvent = useCallback(async (event: Record<string, unknown>) => {
    const type = String(event.type || "");
    const counts = stats().events;
    counts[type] = (counts[type] || 0) + 1;
    switch (type) {
      case "input_audio_buffer.speech_started":
        // The person talks over the answer: it stops here at once.
        stopPlayback();
        speechStoppedAt.current = null;
        setState((current) => ({ ...current, floor: "listening" }));
        break;
      case "input_audio_buffer.speech_stopped":
        speechStoppedAt.current = performance.now();
        setState((current) => ({ ...current, floor: "thinking" }));
        break;
      case "response.created": {
        responding.current = true;
        const id = (event.response as { id?: string } | undefined)?.id ?? null;
        if (summary.current && summary.current.responseId === null && id) summary.current.responseId = id;
        break;
      }
      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (speechStoppedAt.current !== null) {
          const waited = Math.round(performance.now() - speechStoppedAt.current);
          stats().firstAudioMs.push(waited);
          console.info(`[voice] first audio ${waited} ms after the person stopped`);
          speechStoppedAt.current = null;
        }
        if (typeof event.delta === "string") play(event.delta);
        if (!ignoreAudio.current) setState((current) => (current.floor === "speaking" ? current : { ...current, floor: "speaking" }));
        break;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
      case "response.output_text.delta":
      case "response.text.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (summary.current) {
          if (summary.current.responseId && event.response_id === summary.current.responseId) summary.current.text += delta;
          break;
        }
        upsertLine(String(event.item_id || event.response_id || "agent"), "agent", delta, "append", false);
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        if (summary.current) {
          if (summary.current.responseId && event.response_id === summary.current.responseId && typeof event.transcript === "string" && event.transcript.length > summary.current.text.length) summary.current.text = event.transcript;
          break;
        }
        if (typeof event.transcript === "string") upsertLine(String(event.item_id || event.response_id || "agent"), "agent", event.transcript, "replace", true);
        break;
      }
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.completed": {
        const text = typeof event.transcript === "string" ? event.transcript : "";
        if (text) upsertLine(String(event.item_id || "user"), "user", text, "replace", type.endsWith("completed"));
        break;
      }
      case "conversation.item.input_audio_transcription.delta": {
        if (typeof event.delta === "string") upsertLine(String(event.item_id || "user"), "user", event.delta, "append", false);
        break;
      }
      case "response.function_call_arguments.done": {
        const name = String(event.name || "");
        const callId = String(event.call_id || "");
        const output = await runVoiceTool(name, typeof event.arguments === "string" ? event.arguments : "", {
          delegate: (task) => {
            call.current?.delegated.push(task);
            return bindingsRef.current.delegate(task);
          },
          turn: () => bindingsRef.current.turn(),
        });
        send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
        send({ type: "response.create" });
        break;
      }
      case "response.done": {
        responding.current = false;
        const id = (event.response as { id?: string } | undefined)?.id ?? null;
        if (summary.current?.responseId && id === summary.current.responseId) summary.current.done();
        setState((current) => (current.floor === "speaking" ? { ...current, floor: "listening" } : current));
        flushUpdate();
        break;
      }
      case "error": {
        const detail = event.error as { message?: string } | undefined;
        console.warn("[voice] error from the voice model:", detail?.message || event);
        if (summary.current?.responseId) summary.current.done();
        break;
      }
    }
  }, [flushUpdate, play, send, stopPlayback, upsertLine]);

  const cleanup = useCallback(() => {
    const c = call.current;
    if (c?.beat) window.clearInterval(c.beat);
    if (c?.tick) window.clearInterval(c.tick);
    try { ws.current?.close(); } catch { /* closed */ }
    ws.current = null;
    const a = audio.current;
    if (a) {
      for (const track of a.stream.getTracks()) track.stop();
      void a.ctx.close().catch(() => undefined);
    }
    audio.current = null;
    summary.current = null;
    responding.current = false;
    pendingUpdate.current = null;
  }, []);

  const finish = useCallback(async (linesAtEnd: CallState["lines"], summaryText: string) => {
    const c = call.current;
    call.current = null;
    cleanup();
    if (!c) return;
    const seconds = (Date.now() - c.startedAt) / 1000;
    const transcript = linesAtEnd.filter((line) => line.text.trim()).map((line) => ({ role: line.role, text: line.text.trim() }));
    await fetch(`/api/voice/call/${c.id}/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: bindingsRef.current.chatId,
        projectId: bindingsRef.current.projectId,
        seconds,
        transcript,
        summary: summaryText,
        delegated: c.delegated,
      }),
    }).catch(() => undefined);
  }, [cleanup]);

  const hangUp = useCallback(async (reason?: MessageKey) => {
    const snapshot = linesRef.current;
    setState((current) => ({ ...current, phase: "ending", error: reason ? t(reason) : current.error }));
    // A short summary for the chat, written by the voice model from what was
    // said; nothing is played while it writes. Only when somebody spoke.
    let summaryText = "";
    if (ws.current?.readyState === WebSocket.OPEN && snapshot.some((line) => line.role === "user" && line.text.trim())) {
      ignoreAudio.current = true;
      stopPlayback();
      if (responding.current) send({ type: "response.cancel" });
      summaryText = await new Promise<string>((resolve) => {
        const timer = window.setTimeout(() => resolve(summary.current?.text ?? ""), 12_000);
        summary.current = {
          text: "",
          responseId: null,
          done: () => {
            window.clearTimeout(timer);
            resolve(summary.current?.text ?? "");
          },
        };
        // As a message, not a per-response instruction: the voice model ignored the latter.
        send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `[Call ended - not from the person] ${buildSummaryInstructions()}` }] } });
        send({ type: "response.create" });
      });
    }
    await finish(snapshot, summaryText.trim());
    setState((current) => ({ ...INITIAL, error: current.error }));
  }, [finish, send, stopPlayback, t]);

  const start = useCallback(async () => {
    if (call.current || state.phase !== "idle") return;
    ignoreAudio.current = false;
    muted.current = false;
    lineIds.current.clear();
    setState({ ...INITIAL, phase: "connecting" });
    const startedAt = performance.now();
    let stream: MediaStream | null = null;
    try {
      if (!window.isSecureContext && location.hostname !== "localhost" && !location.hostname.endsWith(".localhost")) throw new Error(t("chat.voiceHttpsRequired"));
      // Asked first: the call starts the minute's count, the microphone question should not.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const response = await fetch("/api/voice/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(answer.error || t("voice.error.failed")));
      const callId = String(answer.callId || "");
      const secret = String(answer.secret || "");
      const realtimeUrl = String(answer.realtimeUrl || "");
      if (!callId || !secret || !realtimeUrl) throw new Error(t("voice.error.failed"));

      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" })));
      const mic = ctx.createMediaStreamSource(stream);
      const micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 256;
      const capture = new AudioWorkletNode(ctx, "eggent-capture");
      mic.connect(micAnalyser);
      mic.connect(capture);
      const out = ctx.createGain();
      const outAnalyser = ctx.createAnalyser();
      outAnalyser.fftSize = 256;
      out.connect(outAnalyser);
      outAnalyser.connect(ctx.destination);
      audio.current = { ctx, stream, micAnalyser, outAnalyser, out, nextTime: 0, sources: new Set() };

      // ~40 ms frames: small enough for a quick turn, large enough not to flood the socket.
      let pending: Float32Array[] = [];
      let pendingLength = 0;
      capture.port.onmessage = (message: MessageEvent<Float32Array>) => {
        if (ws.current?.readyState !== WebSocket.OPEN) return;
        beatNow.current();
        const chunk = muted.current ? new Float32Array(message.data.length) : message.data;
        pending.push(chunk);
        pendingLength += chunk.length;
        if (pendingLength < ctx.sampleRate * 0.04) return;
        const joined = new Float32Array(pendingLength);
        let offset = 0;
        for (const part of pending) { joined.set(part, offset); offset += part.length; }
        pending = [];
        pendingLength = 0;
        send({ type: "input_audio_buffer.append", audio: floatToPcm16Base64(resample(joined, ctx.sampleRate)) });
      };

      const socket = new WebSocket(realtimeUrl, [`xai-client-secret.${secret}`]);
      ws.current = socket;
      call.current = { id: callId, startedAt: Date.now(), beat: null, tick: null, delegated: [] };
      socket.onopen = () => {
        stats().connectMs = Math.round(performance.now() - startedAt);
        const b = bindingsRef.current;
        send({
          type: "session.update",
          session: {
            voice: answer.voice || "eve",
            instructions: buildVoiceInstructions({ locale, projectName: b.projectName, recent: recentForVoice(b.recent()) }),
            turn_detection: { type: "server_vad" },
            reasoning: { effort: "none" },
            audio: {
              input: { format: { type: "audio/pcm", rate: RATE }, transcription: { model: "grok-transcribe" } },
              output: { format: { type: "audio/pcm", rate: RATE } },
            },
            tools: VOICE_TOOLS,
          },
        });
        // The agent speaks first, as somebody who picked up the phone does.
        send({ type: "response.create" });
        setState((current) => ({ ...current, phase: "live", floor: "thinking" }));
      };
      socket.onmessage = (message) => {
        if (typeof message.data !== "string") return;
        try {
          void handleEvent(JSON.parse(message.data) as Record<string, unknown>);
        } catch {
          // Not JSON: nothing to act on.
        }
      };
      socket.onclose = (event) => {
        // Said in the console: a drop the person did not ask for is what to look into.
        if (call.current) console.warn(`[voice] the voice model closed the call: ${event.code} ${event.reason || ""}`.trim());
        if (call.current) void hangUp("voice.error.dropped");
      };
      socket.onerror = () => {
        console.warn("[voice] the connection to the voice model failed");
      };

      const beatSeconds = Math.max(5, Number(answer.beatSeconds) || 10);
      // Timers of a page in the background can be held back for a minute or
      // more, which the deployment would read as a call that has gone. The
      // microphone's frames come from the audio thread whatever the page is
      // doing, so a beat is also sent from there when one is due.
      beatNow.current = () => {
        const c = call.current;
        if (!c || Date.now() - lastBeatAt.current < beatSeconds * 1000 - 500) return;
        lastBeatAt.current = Date.now();
        void fetch(`/api/voice/call/${c.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
          .then((r) => r.json())
          .then((beat: { continue?: boolean; reason?: string }) => {
            if (beat.continue === false && call.current) void hangUp(beat.reason === "time up" ? "voice.error.timeUp" : beat.reason === "replaced" ? "voice.error.ended" : "voice.error.dropped");
          })
          .catch(() => undefined);
      };
      lastBeatAt.current = Date.now();
      call.current.beat = window.setInterval(() => beatNow.current(), beatSeconds * 1000);
      call.current.tick = window.setInterval(() => {
        const c = call.current;
        if (c) setState((current) => ({ ...current, seconds: Math.floor((Date.now() - c.startedAt) / 1000) }));
      }, 500);
    } catch (error) {
      if (stream && !audio.current) for (const track of stream.getTracks()) track.stop();
      const message = error instanceof DOMException ? t(errorKey(error)) : error instanceof Error ? error.message : t("voice.error.failed");
      if (call.current) await finish([], "");
      cleanup();
      setState({ ...INITIAL, error: message });
    }
  }, [cleanup, finish, handleEvent, hangUp, locale, send, state.phase, t]);

  // The agent finished what the call handed it: the voice model is told, so it
  // can say so without being asked.
  const wasRunning = useRef(bindings.running);
  useEffect(() => {
    const before = wasRunning.current;
    wasRunning.current = bindings.running;
    if (!before || bindings.running || state.phase !== "live" || !call.current?.delegated.length) return;
    const turn = bindingsRef.current.turn();
    pendingUpdate.current = `[Agent update] The agent has finished working. Its latest message in the chat: ${turn.latestText || "(no text)"}`;
    flushUpdate();
  }, [bindings.running, flushUpdate, state.phase]);

  // The agent asked the person something on screen: the voice model asks it aloud.
  const toldQuestion = useRef<string | null>(null);
  useEffect(() => {
    const question = bindings.question;
    if (!question || state.phase !== "live" || toldQuestion.current === question.id) return;
    toldQuestion.current = question.id;
    pendingUpdate.current = questionUpdate(question);
    flushUpdate();
  }, [bindings.question, flushUpdate, state.phase]);

  const toggleMute = useCallback(() => {
    muted.current = !muted.current;
    setState((current) => ({ ...current, muted: muted.current }));
  }, []);

  // Leaving the page ends the call; the deployment stops counting at the last beat anyway.
  useEffect(() => () => {
    if (call.current) void finish([], "");
  }, [finish]);

  const dismissError = useCallback(() => setState((current) => ({ ...current, error: null })), []);

  return { state, start, hangUp, toggleMute, dismissError, audio };
}

// --- the screen ----------------------------------------------------------

function Waveform({ audio, active, className }: { audio: ReturnType<typeof useVoiceCall>["audio"]; active: boolean; className: string }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const bins = new Uint8Array(128);
    const bins2 = new Uint8Array(128);
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const element = canvas.current;
      const a = audio.current;
      if (!element || !a) return;
      const g = element.getContext("2d");
      if (!g) return;
      const width = element.clientWidth;
      const height = element.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      if (element.width !== Math.round(width * ratio)) { element.width = Math.round(width * ratio); element.height = Math.round(height * ratio); }
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.clearRect(0, 0, width, height);
      a.micAnalyser.getByteFrequencyData(bins);
      a.outAnalyser.getByteFrequencyData(bins2);
      const bars = Math.max(5, Math.min(28, Math.floor(width / 10)));
      const gap = width < 120 ? 2 : 3;
      const barWidth = (width - gap * (bars - 1)) / bars;
      g.fillStyle = getComputedStyle(element).color;
      for (let i = 0; i < bars; i += 1) {
        const index = 2 + Math.floor((i / bars) * 60);
        const level = Math.max(bins[index], bins2[index]) / 255;
        const barHeight = Math.max(3, level * height);
        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;
        g.beginPath();
        g.roundRect(x, y, barWidth, barHeight, barWidth / 2);
        g.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [active, audio]);
  return <canvas ref={canvas} className={`text-foreground ${className}`} aria-hidden="true" />;
}

/** The waveform button beside the microphone, and the call panel it opens. */
export function VoiceCallControl({ bindings, disabled }: { bindings: VoiceCallBindings; disabled?: boolean }) {
  const { t } = useI18n();
  const offered = useVoiceOffered();
  const { state, start, hangUp, toggleMute, dismissError, audio } = useVoiceCall(bindings);
  const [showTranscript, setShowTranscript] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const inCallNow = state.phase !== "idle";
  useEffect(() => {
    if (inCallNow) setExpanded(window.matchMedia("(min-width: 768px)").matches);
  }, [inCallNow]);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "nearest" });
  }, [state.lines]);

  if (!offered) return null;
  const inCall = state.phase !== "idle";
  const status = state.phase === "connecting"
    ? t("voice.status.connecting")
    : state.phase === "ending"
      ? t("voice.status.ending")
      : bindings.running && state.floor === "listening"
        ? t("voice.status.agentWorking")
        : t(state.floor === "speaking" ? "voice.status.speaking" : state.floor === "thinking" ? "voice.status.thinking" : "voice.status.listening");

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        data-composer-action="voice-call"
        onClick={() => void start()}
        disabled={disabled || inCall}
        aria-label={t("voice.call")}
        title={t("voice.call")}
        className="size-11 shrink-0 rounded-full"
      >
        <AudioLines className="size-5" strokeWidth={1.75} />
      </Button>
      {typeof document !== "undefined"
        ? createPortal(
            <>
      {state.error && !inCall ? (
        <div role="alert" className="fixed inset-x-2 top-14 z-50 rounded-xl border bg-popover px-4 py-3 text-sm shadow-lg md:inset-x-auto md:right-4 md:top-16 md:w-80">
          <p>{state.error}</p>
          <button type="button" onClick={dismissError} className="mt-1 text-xs text-muted-foreground underline underline-offset-2">{t("voice.dismiss")}</button>
        </div>
      ) : null}
      {inCall ? (
        <div
          role="dialog"
          aria-label={t("voice.panel")}
          data-voice-call-panel
          data-expanded={expanded ? "true" : "false"}
          className={`fixed inset-x-2 top-14 z-50 flex flex-col border bg-popover text-popover-foreground shadow-lg md:inset-x-auto md:right-4 md:top-16 ${
            expanded ? "gap-3 rounded-2xl p-3 md:w-80" : "rounded-full p-1.5 md:w-auto"
          }`}
        >
          {/* The call's own row: who, the sound, how long, and the way out. Collapsed, it is all there is. */}
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              aria-label={t(expanded ? "voice.collapse" : "voice.expand")}
              title={t(expanded ? "voice.collapse" : "voice.expand")}
              className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-full text-left"
            >
              <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                <Bot className="size-4" aria-hidden="true" />
                {state.phase === "connecting" || state.phase === "ending" ? (
                  <Loader2 className="absolute -right-0.5 -bottom-0.5 size-3.5 animate-spin rounded-full bg-popover text-foreground" aria-hidden="true" />
                ) : (
                  <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-popover bg-success" aria-hidden="true" />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm/5 font-medium" aria-live="polite">{status}</span>
                <span className="text-xs/4 tabular-nums text-muted-foreground">{t("voice.card.title")} · {formatCallLength(state.seconds)}</span>
              </span>
              {expanded ? null : <Waveform audio={audio} active={state.phase === "live"} className="h-6 w-14 shrink-0" />}
              {expanded ? <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            </button>
            {expanded ? null : (
              <Button
                size="icon"
                onClick={() => void hangUp()}
                disabled={state.phase === "ending"}
                aria-label={t("voice.hangUp")}
                title={t("voice.hangUp")}
                className="size-9 shrink-0 rounded-full bg-destructive text-white hover:bg-destructive/90"
              >
                <PhoneOff className="size-4" />
              </Button>
            )}
          </div>
          {expanded ? (
            <>
              <Waveform audio={audio} active={state.phase === "live"} className="h-10 w-full" />
              {showTranscript && state.lines.some((line) => line.text.trim()) ? (
                <div className="max-h-[min(40vh,18rem)] overflow-y-auto rounded-lg bg-muted/40 px-3 py-2 text-sm/6">
                  {state.lines.filter((line) => line.text.trim()).slice(-12).map((line) => (
                    <p key={line.id} className={line.role === "user" ? "text-muted-foreground" : ""}>
                      <span className="font-medium">{t(line.role === "user" ? "voice.card.you" : "voice.card.agent")}: </span>
                      {line.text}
                    </p>
                  ))}
                  <div ref={transcriptEnd} />
                </div>
              ) : null}
              <div className="flex items-center justify-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={toggleMute}
                  disabled={state.phase !== "live"}
                  aria-pressed={state.muted}
                  aria-label={t(state.muted ? "voice.unmute" : "voice.mute")}
                  title={t(state.muted ? "voice.unmute" : "voice.mute")}
                  className="size-11 rounded-full"
                >
                  {state.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setShowTranscript((value) => !value)}
                  aria-pressed={showTranscript}
                  aria-label={t("voice.transcript")}
                  title={t("voice.transcript")}
                  className="size-11 rounded-full"
                >
                  <Captions className="size-5" />
                </Button>
                <Button
                  size="icon"
                  onClick={() => void hangUp()}
                  disabled={state.phase === "ending"}
                  aria-label={t("voice.hangUp")}
                  title={t("voice.hangUp")}
                  className="size-11 rounded-full bg-destructive text-white hover:bg-destructive/90"
                >
                  <PhoneOff className="size-5" />
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
            </>,
            // Above the page, not inside the composer: a parent there makes its own frame for fixed elements.
            document.body
          )
        : null}
    </>
  );
}
