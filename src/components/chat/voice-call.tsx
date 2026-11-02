"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AudioLines, Bot, Captions, Check, ChevronDown, ChevronUp, Loader2, Mic, MicOff, PhoneOff, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import {
  buildSummaryInstructions,
  buildVoiceInstructions,
  functionCallOf,
  sessionUpdate,
  turnDetectionUpdate,
  gateMic,
  rmsOf,
  isAnswerPace,
  PACE_MS,
  type AnswerPace,
  type VoiceProtocol,
  formatCallLength,
  recentForVoice,
  runVoiceTool,
  questionUpdate,
  isAmendment,
  type LastDelegate,
  endingNote,
  IDLE_WARNING_NOTE,
  watchCall,
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
  /** Where the chat is, for the call panel to point at the work; and whether the person is looking at it. */
  chatHref: string;
  onChatPage: boolean;
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

/** What the call handed to the agent, and where it is happening. */
interface CallWork {
  href: string;
  projectName: string | null;
  done: boolean;
}

interface CallState {
  phase: Phase;
  work: CallWork | null;
  floor: Floor;
  seconds: number;
  muted: boolean;
  error: string | null;
  lines: Array<VoiceTranscriptLine & { id: string; final: boolean }>;
  /** What a minute costs and what is left of the balance, as the deployment wrote them. */
  price: string | null;
  balance: string | null;
}

const INITIAL: CallState = { work: null, phase: "idle", floor: "listening", seconds: 0, muted: false, error: null, lines: [], price: null, balance: null };

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

const PACE_KEY = "eggent.voice.pace";

/** The person's own answer speed, if they chose one in this browser. */
function storedPace(): AnswerPace | null {
  try {
    const value = window.localStorage.getItem(PACE_KEY);
    return isAnswerPace(value) ? value : null;
  } catch {
    return null;
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
  const handledCalls = useRef(new Set<string>());
  /** The task this call handed over last, so that the rest of the same request is not handed over again as a new one. */
  const lastDelegate = useRef<LastDelegate | null>(null);
  const protocolRef = useRef<VoiceProtocol>("xai");
  const thresholdRef = useRef(0.5);
  /** The answer being played; audio of any other is dropped. Null after the person cut in, until the next answer starts. */
  const currentResponse = useRef<string | null>(null);
  const droppingAudio = useRef(false);
  const gateOpenUntil = useRef(0);
  const [pace, setPaceState] = useState<AnswerPace | null>(null);
  useEffect(() => { setPaceState(storedPace()); }, []);
  const beatNow = useRef<() => void>(() => undefined);
  const watchNow = useRef<() => void>(() => undefined);
  const lastPersonAt = useRef(0);
  const lastAgentAt = useRef(0);
  const mutedSince = useRef<number | null>(null);
  const warnedAt = useRef<number | null>(null);
  const ending = useRef(false);
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
    // The id is settled outside the state update: React may run an updater twice, and it must not depend on what the first run did.
    let id = lineIds.current.get(key);
    if (!id) {
      id = `${role}-${key}`;
      lineIds.current.set(key, id);
    }
    const lineId = id;
    setState((current) => {
      const lines = [...current.lines];
      let index = lines.findIndex((line) => line.id === lineId);
      if (index < 0) {
        // Some providers report each pause as a new item carrying the whole phrase so far: a person's
        // line that only continues the one before it replaces that one rather than repeating it.
        const last = lines[lines.length - 1];
        const continues = role === "user" && last?.role === "user" && last.text.trim() !== "" && text.trim().startsWith(last.text.trim());
        if (continues) {
          lines[lines.length - 1] = { ...last, id: lineId };
        } else {
          lines.push({ id: lineId, role, text: "", final: false });
        }
        index = lines.length - 1;
      }
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
        lastPersonAt.current = Date.now();
        warnedAt.current = null;
        // The person talks over the answer: it stops here at once, and the
        // provider is told to drop it rather than finish it unheard.
        stopPlayback();
        if (responding.current) send({ type: "response.cancel" });
        // What is still on its way of the answer cut off is not played.
        currentResponse.current = null;
        droppingAudio.current = true;
        speechStoppedAt.current = null;
        setState((current) => ({ ...current, floor: "listening" }));
        break;
      case "input_audio_buffer.speech_stopped":
        lastPersonAt.current = Date.now();
        speechStoppedAt.current = performance.now();
        setState((current) => ({ ...current, floor: "thinking" }));
        break;
      case "response.created": {
        responding.current = true;
        const id = (event.response as { id?: string } | undefined)?.id ?? null;
        // One answer at a time: a new one stops whatever of the last is still playing.
        if (id && currentResponse.current && id !== currentResponse.current) stopPlayback();
        currentResponse.current = id;
        droppingAudio.current = false;
        if (summary.current && summary.current.responseId === null && id) summary.current.responseId = id;
        break;
      }
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const from = typeof event.response_id === "string" ? event.response_id : null;
        if (droppingAudio.current || (from && currentResponse.current && from !== currentResponse.current)) break;
        if (speechStoppedAt.current !== null) {
          const waited = Math.round(performance.now() - speechStoppedAt.current);
          stats().firstAudioMs.push(waited);
          console.info(`[voice] first audio ${waited} ms after the person stopped`);
          speechStoppedAt.current = null;
        }
        lastAgentAt.current = Date.now();
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
        // Yandex closes the answer with an empty transcript (its words came as text deltas): an empty one replaces nothing.
        if (typeof event.transcript === "string" && event.transcript.trim()) upsertLine(String(event.item_id || event.response_id || "agent"), "agent", event.transcript, "replace", true);
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
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const fn = functionCallOf(event);
        // Both events can announce one call: it runs once.
        if (!fn || handledCalls.current.has(fn.callId)) break;
        handledCalls.current.add(fn.callId);
        const { name, callId } = fn;
        const output = await runVoiceTool(name, fn.arguments, {
          delegate: (task, amends) => {
            call.current?.delegated.push(task);
            const b = bindingsRef.current;
            const now = Date.now();
            const amend = isAmendment({ task, amends, last: lastDelegate.current, now });
            // A correction goes to the same work as one, said plainly, so the agent fixes what it made rather than making it again.
            const text = amend ? t("voice.amend", { task }) : task;
            lastDelegate.current = amend && lastDelegate.current
              ? { task: `${lastDelegate.current.task} ${task}`, at: now, endedAt: null }
              : { task, at: now, endedAt: null };
            // The work starts in this chat: the panel says where, so the person can go and watch.
            setState((current) => ({ ...current, work: { href: b.chatHref, projectName: b.projectName ?? null, done: false } }));
            const how = b.delegate(text);
            return amend && how !== "answered" ? "amended" : how;
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
  }, [flushUpdate, play, send, stopPlayback, t, upsertLine]);

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
    if (!call.current || ending.current) return;
    ending.current = true;
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

  /**
   * The call ends for a reason the person did not choose (money, time): the
   * voice says so first, in their language, and the line closes once it has
   * been heard - at most ten seconds later.
   */
  const sayThenHangUp = useCallback(async (note: string, reason: MessageKey) => {
    if (!call.current || ending.current || ws.current?.readyState !== WebSocket.OPEN) {
      await hangUp(reason);
      return;
    }
    if (responding.current) send({ type: "response.cancel" });
    stopPlayback();
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 10_000);
      const startedAt = Date.now();
      const poll = window.setInterval(() => {
        const a = audio.current;
        const playing = a ? a.nextTime - a.ctx.currentTime > 0.05 : false;
        // Done once the answer has come and been played out.
        if (Date.now() - startedAt > 800 && !responding.current && !playing) {
          window.clearInterval(poll);
          window.clearTimeout(timer);
          resolve();
        }
      }, 200);
      send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: note }] } });
      send({ type: "response.create" });
    });
    await hangUp(reason);
  }, [hangUp, send, stopPlayback]);

  const start = useCallback(async () => {
    if (call.current || state.phase !== "idle") return;
    ignoreAudio.current = false;
    muted.current = false;
    lineIds.current.clear();
    handledCalls.current.clear();
    lastDelegate.current = null;
    currentResponse.current = null;
    droppingAudio.current = false;
    gateOpenUntil.current = 0;
    setState({ ...INITIAL, phase: "connecting" });
    const startedAt = performance.now();
    let stream: MediaStream | null = null;
    try {
      if (!window.isSecureContext && location.hostname !== "localhost" && !location.hostname.endsWith(".localhost")) throw new Error(t("chat.voiceHttpsRequired"));
      // Asked first: the call starts the minute's count, the microphone question should not.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const response = await fetch("/api/voice/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) throw new Error(answer.code === "balance" ? t("voice.error.balance") : String(answer.error || t("voice.error.failed")));
      const callId = String(answer.callId || "");
      const secret = typeof answer.secret === "string" ? answer.secret : "";
      const realtimeUrl = String(answer.realtimeUrl || "");
      // Through the deployment (the URL carries a one-use token), or straight to the provider with a secret.
      const relayed = answer.mode === "relay";
      const protocol: VoiceProtocol = answer.protocol === "openai-ga" ? "openai-ga" : "xai";
      const chosen = storedPace();
      const silenceMs = chosen ? PACE_MS[chosen] : Math.min(2000, Math.max(200, Number(answer.silenceMs) || 600));
      protocolRef.current = protocol;
      const vadThreshold = Math.min(0.95, Math.max(0.1, Number(answer.vadThreshold) || 0.5));
      thresholdRef.current = vadThreshold;
      if (!callId || !realtimeUrl || (!relayed && !secret)) throw new Error(t("voice.error.failed"));
      setState((current) => ({
        ...current,
        price: typeof answer.pricePerMinute === "string" ? answer.pricePerMinute : null,
        balance: typeof answer.balanceLeft === "string" ? answer.balanceLeft : null,
      }));
      lastPersonAt.current = Date.now();
      lastAgentAt.current = Date.now();
      mutedSince.current = null;
      warnedAt.current = null;
      ending.current = false;

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
      const outLevel = new Float32Array(outAnalyser.fftSize);
      out.connect(outAnalyser);
      outAnalyser.connect(ctx.destination);
      audio.current = { ctx, stream, micAnalyser, outAnalyser, out, nextTime: 0, sources: new Set() };

      // ~40 ms frames: small enough for a quick turn, large enough not to flood the socket.
      let pending: Float32Array[] = [];
      let pendingLength = 0;
      capture.port.onmessage = (message: MessageEvent<Float32Array>) => {
        if (ws.current?.readyState !== WebSocket.OPEN) return;
        beatNow.current();
        watchNow.current();
        let chunk = muted.current ? new Float32Array(message.data.length) : message.data;
        // While our answer plays, its echo must not reach the provider as the person's voice.
        const a = audio.current;
        if (a && !muted.current) {
          const playing = a.nextTime + 0.3 > a.ctx.currentTime;
          let outRms = 0;
          if (playing) {
            a.outAnalyser.getFloatTimeDomainData(outLevel);
            outRms = rmsOf(outLevel);
          }
          const verdict = gateMic({ now: Date.now(), playing, micRms: rmsOf(chunk), outRms, openUntil: gateOpenUntil.current });
          gateOpenUntil.current = verdict.openUntil;
          if (!verdict.pass) chunk = new Float32Array(chunk.length);
        }
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

      const socket = relayed ? new WebSocket(realtimeUrl) : new WebSocket(realtimeUrl, [`xai-client-secret.${secret}`]);
      ws.current = socket;
      call.current = { id: callId, startedAt: Date.now(), beat: null, tick: null, delegated: [] };
      socket.onopen = () => {
        stats().connectMs = Math.round(performance.now() - startedAt);
        const b = bindingsRef.current;
        send(sessionUpdate({
          protocol,
          voice: typeof answer.voice === "string" && answer.voice ? answer.voice : "eve",
          instructions: buildVoiceInstructions({ locale, projectName: b.projectName, recent: recentForVoice(b.recent()) }),
          silenceMs,
          threshold: vadThreshold,
        }));
        // The agent speaks first, as somebody who picked up the phone does.
        send({ type: "response.create" });
        setState((current) => ({ ...current, phase: "live", floor: "thinking" }));
      };
      socket.onmessage = async (message) => {
        // A relay may hand text frames over as blobs.
        const text = typeof message.data === "string" ? message.data : message.data instanceof Blob ? await message.data.text() : "";
        if (!text) return;
        try {
          void handleEvent(JSON.parse(text) as Record<string, unknown>);
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
          .then((beat: { continue?: boolean; reason?: string; balanceLeft?: string | null }) => {
            if (typeof beat.balanceLeft === "string") setState((current) => ({ ...current, balance: beat.balanceLeft as string }));
            if (beat.continue !== false || !call.current) return;
            if (beat.reason === "balance") void sayThenHangUp(endingNote("balance"), "voice.error.balance");
            else if (beat.reason === "time up") void sayThenHangUp(endingNote("time"), "voice.error.timeUp");
            else void hangUp(beat.reason === "replaced" ? "voice.error.ended" : "voice.error.dropped");
          })
          .catch(() => undefined);
      };
      // Nobody on the line: checked from the timer and from the microphone's
      // frames, which keep coming in a background tab.
      watchNow.current = () => {
        if (!call.current || ending.current) return;
        const verdict = watchCall({ now: Date.now(), lastPersonAt: lastPersonAt.current, lastAgentAt: lastAgentAt.current, mutedSince: mutedSince.current, warnedAt: warnedAt.current });
        if (verdict === "warn") {
          warnedAt.current = Date.now();
          pendingUpdate.current = IDLE_WARNING_NOTE;
          flushUpdate();
        } else if (verdict === "end-idle") {
          void hangUp("voice.error.idle");
        } else if (verdict === "end-muted") {
          void hangUp("voice.error.mutedTooLong");
        }
      };
      lastBeatAt.current = Date.now();
      call.current.beat = window.setInterval(() => beatNow.current(), beatSeconds * 1000);
      call.current.tick = window.setInterval(() => {
        const c = call.current;
        if (c) setState((current) => ({ ...current, seconds: Math.floor((Date.now() - c.startedAt) / 1000) }));
        watchNow.current();
      }, 500);
    } catch (error) {
      if (stream && !audio.current) for (const track of stream.getTracks()) track.stop();
      const message = error instanceof DOMException ? t(errorKey(error)) : error instanceof Error ? error.message : t("voice.error.failed");
      if (call.current) await finish([], "");
      cleanup();
      setState({ ...INITIAL, error: message });
    }
  }, [cleanup, finish, flushUpdate, handleEvent, hangUp, locale, send, sayThenHangUp, state.phase, t]);

  // The agent finished what the call handed it: the voice model is told, so it
  // can say so without being asked.
  const wasRunning = useRef(bindings.running);
  useEffect(() => {
    const before = wasRunning.current;
    wasRunning.current = bindings.running;
    if (!before || bindings.running || state.phase !== "live" || !call.current?.delegated.length) return;
    setState((current) => (current.work ? { ...current, work: { ...current.work, done: true } } : current));
    if (lastDelegate.current) lastDelegate.current = { ...lastDelegate.current, endedAt: Date.now() };
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

  /** The person's answer speed: remembered in this browser, and applied at once to a call in progress. */
  const setPace = useCallback((next: AnswerPace) => {
    setPaceState(next);
    try {
      window.localStorage.setItem(PACE_KEY, next);
    } catch {
      // Not remembered; still applied to this call.
    }
    if (call.current) send(turnDetectionUpdate(protocolRef.current, PACE_MS[next], thresholdRef.current));
  }, [send]);

  const toggleMute = useCallback(() => {
    muted.current = !muted.current;
    mutedSince.current = muted.current ? Date.now() : null;
    // Back from mute: the person is here, the silence starts again.
    if (!muted.current) {
      lastPersonAt.current = Date.now();
      warnedAt.current = null;
    }
    setState((current) => ({ ...current, muted: muted.current }));
  }, []);

  // Leaving the page ends the call at once, so nothing is paid for a tab that
  // has gone; the deployment would stop at the last beat anyway, 45 s later.
  useEffect(() => {
    const leave = () => {
      const c = call.current;
      if (!c) return;
      call.current = null;
      const transcript = linesRef.current.filter((line) => line.text.trim()).map((line) => ({ role: line.role, text: line.text.trim() }));
      void fetch(`/api/voice/call/${c.id}/end`, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: bindingsRef.current.chatId, projectId: bindingsRef.current.projectId, seconds: (Date.now() - c.startedAt) / 1000, transcript: transcript.slice(-80), summary: "", delegated: c.delegated }),
      }).catch(() => undefined);
      cleanup();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      if (call.current) void finish([], "");
    };
  }, [cleanup, finish]);

  const dismissError = useCallback(() => setState((current) => ({ ...current, error: null })), []);

  return { state, start, hangUp, toggleMute, dismissError, audio, pace, setPace };
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
  const { state, start, hangUp, toggleMute, dismissError, audio, pace, setPace } = useVoiceCall(bindings);
  const [showSettings, setShowSettings] = useState(false);
  const [showTranscript, setShowTranscript] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const inCallNow = state.phase !== "idle";
  // Open only where it fits beside the conversation: the composer is as wide as
  // the chat column, and the panel needs 20 rem plus its margin to its right.
  // Elsewhere it starts as the pill, which covers no more than a line or two.
  useEffect(() => {
    if (!inCallNow) return;
    const column = document.querySelector('[data-slot="chat-composer-footer"]')?.getBoundingClientRect();
    const room = column ? window.innerWidth - column.right : 0;
    setExpanded(window.matchMedia("(min-width: 768px)").matches && room >= 352);
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
            expanded ? "gap-3 rounded-2xl p-3 md:w-80" : state.work ? "gap-1.5 rounded-3xl p-1.5 md:w-80" : "rounded-full p-1.5 md:w-auto"
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
                <span className="truncate text-xs/4 tabular-nums text-muted-foreground">
                  {formatCallLength(state.seconds)}
                  {state.price ? ` · ${t("voice.pricePerMinute", { price: state.price })}` : ""}
                  {state.balance && expanded ? ` · ${t("voice.balanceLeft", { balance: state.balance })}` : ""}
                </span>
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
          {state.work ? (
            <div data-voice-call-work className={`flex min-h-9 items-center gap-2 rounded-xl bg-muted/50 px-3 py-1.5 text-xs/4 ${expanded ? "" : "mx-0.5 mb-0.5"}`}>
              {state.work.done ? <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" /> : <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">
                {t(state.work.done ? "voice.work.done" : "voice.work.running")}
                {state.work.projectName ? <span className="text-muted-foreground"> · {state.work.projectName}</span> : null}
              </span>
              {bindings.onChatPage && state.work.href === bindings.chatHref ? (
                <span className="shrink-0 text-muted-foreground">{t("voice.work.here")}</span>
              ) : (
                <Link href={state.work.href} className="shrink-0 font-medium underline underline-offset-2">{t("voice.work.open")}</Link>
              )}
            </div>
          ) : null}
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
              {showSettings ? (
                <div className="flex flex-col gap-1.5" role="group" aria-label={t("voice.pace.title")}>
                  <span className="text-xs font-medium text-muted-foreground">{t("voice.pace.title")}</span>
                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                    {(["fast", "normal", "calm"] as const).map((option) => {
                      const active = (pace ?? "normal") === option;
                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setPace(option)}
                          aria-pressed={active}
                          className={`min-h-9 rounded-md px-2 text-xs/4 transition-colors ${active ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                        >
                          {t(`voice.pace.${option}`)}
                          <span className="block text-[11px]/4 tabular-nums text-muted-foreground">{t("voice.pace.ms", { ms: String(PACE_MS[option]) })}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="flex items-center justify-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setShowSettings((value) => !value)}
                  aria-pressed={showSettings}
                  aria-label={t("voice.settings")}
                  title={t("voice.settings")}
                  className="size-11 rounded-full"
                >
                  <Settings2 className="size-5" />
                </Button>
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
