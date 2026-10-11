/**
 * Notices a turn that has gone silent, and says so before the person has to.
 *
 * A turn that hangs looks exactly like one that is thinking. Nothing on a
 * messenger tells them apart: the draft says "thinking" for as long as the
 * connection is open, which for a turn stuck in a prompt nobody can answer, a
 * tool that waits on input, or a provider that stopped talking is for ever.
 * The person's own words sit behind it in a queue, so even "stop" cannot get
 * through. This watches for the one thing that is true of every such turn - no
 * event of any kind for a long time - and acts on it.
 *
 * Silence is measured per phase, because what is normal differs by several
 * orders: a session still being built should speak within a minute or two, a
 * model that is thinking may take minutes before its first word, and a command
 * that is simply running - a build, a render, a download - may print nothing
 * for a long while and be perfectly healthy. Every event the session emits
 * counts as speech, including thinking and a helper's progress.
 *
 * A turn that is waiting for the person to answer is not silent, it is waiting,
 * and is never stopped for it.
 *
 * Pure apart from its own timer: the clock and the tick are injectable, so the
 * rules can be tested without waiting for them.
 */

export type TurnPhase = "starting" | "model" | "tool";

export interface WatchdogThresholds {
  /** Silence after which the person is told the turn is still going, and how to stop it. */
  softMs: number;
  /** Silence at which a turn still being set up is given up on. */
  startingMs: number;
  /** Silence at which a turn waiting for the model is given up on. */
  modelMs: number;
  /** Silence at which a turn running a command or helper is given up on. */
  toolMs: number;
}

const DEFAULTS: WatchdogThresholds = {
  softMs: 90_000,
  startingMs: 3 * 60_000,
  modelMs: 6 * 60_000,
  toolMs: 20 * 60_000,
};

function seconds(value: string | undefined, fallbackMs: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed * 1000 : fallbackMs;
}

/** The limits in force, or null when the deployment has switched the watchdog off. */
export function watchdogThresholds(env: Record<string, string | undefined> = process.env): WatchdogThresholds | null {
  if ((env.EGGENT_TURN_WATCHDOG ?? "").trim().toLowerCase() === "off") return null;
  return {
    softMs: seconds(env.EGGENT_TURN_SILENCE_SOFT_SECONDS, DEFAULTS.softMs),
    startingMs: seconds(env.EGGENT_TURN_SILENCE_START_SECONDS, DEFAULTS.startingMs),
    modelMs: seconds(env.EGGENT_TURN_SILENCE_MODEL_SECONDS, DEFAULTS.modelMs),
    toolMs: seconds(env.EGGENT_TURN_SILENCE_TOOL_SECONDS, DEFAULTS.toolMs),
  };
}

/** How often to look. Seconds are plenty; a test shortens it so it need not wait for the next look. */
export function watchdogTickMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.EGGENT_TURN_WATCHDOG_TICK_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 20 ? parsed : 5_000;
}

export interface StalledTurn {
  phase: TurnPhase;
  silentMs: number;
}

export interface TurnWatchdog {
  /** Something happened: the session spoke. */
  touch(): void;
  /** What the turn is doing now; also counts as speech. */
  setPhase(phase: TurnPhase): void;
  /** Look now rather than at the next tick. For tests. */
  check(): void;
  /** Where the turn was given up on, once it was. */
  readonly stalled: StalledTurn | null;
  stop(): void;
}

export function startTurnWatchdog(options: {
  thresholds: WatchdogThresholds;
  /** True while a question to the person is open. Such a turn is waiting, not stuck. */
  isWaitingForHuman?: () => boolean;
  /** Once per stretch of silence, when it passes the soft threshold. */
  onSoft?: (phase: TurnPhase, silentMs: number) => void;
  /** The turn spoke again after `onSoft` had been told. */
  onResume?: () => void;
  /** The turn has been silent for too long; the caller stops it. */
  onStall: (stalled: StalledTurn) => void;
  now?: () => number;
  /** How often to look. Tests pass 0 to look only when asked. */
  tickMs?: number;
}): TurnWatchdog {
  const now = options.now ?? Date.now;
  let phase: TurnPhase = "starting";
  let lastSpoke = now();
  let softSent = false;
  let stalled: StalledTurn | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const limitFor = (current: TurnPhase) =>
    current === "starting" ? options.thresholds.startingMs : current === "model" ? options.thresholds.modelMs : options.thresholds.toolMs;

  const check = () => {
    if (stalled) return;
    const silentMs = now() - lastSpoke;
    if (options.isWaitingForHuman?.()) {
      // Waiting is not silence: the clock starts again when the answer arrives.
      lastSpoke = now();
      softSent = false;
      return;
    }
    if (silentMs >= limitFor(phase)) {
      stalled = { phase, silentMs };
      stop();
      options.onStall(stalled);
      return;
    }
    if (!softSent && silentMs >= options.thresholds.softMs) {
      softSent = true;
      options.onSoft?.(phase, silentMs);
    }
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const tickMs = options.tickMs ?? 5_000;
  if (tickMs > 0) {
    timer = setInterval(check, tickMs);
    // A watchdog must never be what keeps a process alive.
    (timer as { unref?: () => void }).unref?.();
  }

  const spoke = () => {
    lastSpoke = now();
    if (softSent) {
      softSent = false;
      options.onResume?.();
    }
  };

  return {
    touch: spoke,
    setPhase(next) {
      phase = next;
      spoke();
    },
    check,
    get stalled() {
      return stalled;
    },
    stop,
  };
}

/**
 * Feed a session event to the watchdog: which phase it moves the turn into, and
 * that the session spoke at all.
 */
export function noteSessionEvent(watchdog: TurnWatchdog, record: { type?: unknown }): void {
  switch (record.type) {
    case "tool_execution_start":
      watchdog.setPhase("tool");
      return;
    case "tool_execution_end":
      watchdog.setPhase("model");
      return;
    case "agent_start":
    case "turn_start":
      watchdog.setPhase("model");
      return;
    default:
      // Streamed text, thinking, a helper's progress, a message finishing: speech.
      watchdog.touch();
  }
}
