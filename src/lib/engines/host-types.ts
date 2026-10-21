/**
 * What the application that embeds core gives it for each engine: how to see
 * whether the program is there and signed in, how to sign in, and how to carry
 * out one request. Server side only; the shapes the screens read are in types.ts.
 */
import type { EngineAccess, EngineLimitWindow, EngineModelInfo, EngineStatus } from "@/lib/engines/types";

/** What an engine reports while a request runs. Text replaces what was reported before. */
export type EngineEvent =
  | { type: "session"; sessionId: string }
  /** The whole answer so far. */
  | { type: "text"; text: string }
  /** A tool the program is using or has used. `id` pairs a start with its end. */
  | { type: "step"; id: string; tool: string; target?: string; phase: "start" | "end"; failed?: boolean }
  /** What is happening now, in a few words. */
  | { type: "activity"; text: string }
  | { type: "limits"; windows: EngineLimitWindow[] };

export interface EngineRunRequest {
  /** What the person wrote, as the program should read it. */
  prompt: string;
  /** Instructions for a session that is only starting; never repeated on a resumed one. */
  brief: string;
  /** What was said in this chat before, for a session that is only starting. */
  recap: string;
  cwd: string;
  /** The program's own session to continue, or null to start one. */
  sessionId: string | null;
  /** An id from the engine's model list; empty for its default. */
  model: string;
  access: EngineAccess;
  /** A trial run: leave no session of the program's own behind. */
  ephemeral?: boolean;
  signal: AbortSignal;
  onEvent: (event: EngineEvent) => void;
}

export type EngineErrorCode =
  | "not-installed"
  | "signed-out"
  | "limit"
  | "unsupported-model"
  | "api-key"
  /** The program no longer has the session it was asked to continue. */
  | "session-lost"
  | "timeout"
  | "failed";

export interface EngineRunResult {
  ok: boolean;
  /** The answer, or what the program said last when it failed. */
  text: string;
  sessionId?: string;
  stopped?: boolean;
  error?: { code: EngineErrorCode; message: string };
  toolUses?: number;
  seconds?: number;
  /** Files the program wrote or edited, as paths. */
  files?: string[];
  /** When a limit stopped the run: the earliest time it opens again, unix seconds. */
  resetsAt?: number;
}

export interface EngineLogin {
  /** Settles with the status once the person has signed in, or the attempt has ended. */
  done: Promise<EngineStatus>;
  cancel: () => void;
}

export interface Engine {
  id: string;
  label: string;
  models: () => Promise<EngineModelInfo[]> | EngineModelInfo[];
  status: () => Promise<EngineStatus>;
  startLogin: () => Promise<EngineLogin>;
  run: (request: EngineRunRequest) => Promise<EngineRunResult>;
}

/** What a host module is handed to register its engines with. */
export interface EngineHostApi {
  registerEngine: (engine: Engine) => void;
}
