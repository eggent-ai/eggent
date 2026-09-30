import type { AgentSession, ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { isAgentToolName } from "@/lib/pi/subagent-format";

/**
 * How subagents work in Eggent: a helper belongs to the turn that started it.
 *
 * pi-subagents is written for a terminal that stays open. Its Agent tool
 * detaches by default, returns "started in background", and later delivers the
 * result by starting a new turn in the parent session. Eggent disposes a chat's
 * session when its turn ends, so that later turn had nowhere to happen: the
 * helpers kept working for a parent that no longer existed, their results were
 * written to transcript files nobody read, a helper still waiting for a slot
 * never started because starting it went through the disposed parent, and the
 * chat said the work was done while it was still running.
 *
 * So an Agent call here always waits for its helper and hands the full result
 * back in the same turn. Calls in one message run at the same time, the parent
 * picks up from the results, and the turn ends only when there is an answer.
 * A scheduled Agent is the one exception - it is detached by nature and has its
 * own host (schedule-host.ts).
 */

/**
 * How many helpers one turn may run at once. The extension's own background
 * queue capped this at 4; waiting helpers skip that queue, so the cap moves here.
 * Every helper is a whole agent session in the workspace container, with its own
 * extensions and model stream, and the container has a memory limit.
 */
export const MAX_PARALLEL_SUBAGENTS = 6;

function scheduleOf(input: Record<string, unknown>): string {
  return typeof input.schedule === "string" ? input.schedule.trim() : "";
}

/**
 * Makes an Agent call wait for its helper. Returns whether the call was
 * changed; a scheduled call is left alone.
 */
export function keepSubagentInTurn(input: Record<string, unknown>): boolean {
  if (scheduleOf(input)) return false;
  if (input.run_in_background === false) return false;
  input.run_in_background = false;
  return true;
}

export function subagentLimitReason(limit: number): string {
  return `Not started: Eggent runs at most ${limit} subagents at the same time and ${limit} are already running in this turn. Nothing was lost - launch this one again once the running ones have reported back.`;
}

/** A helper that has not finished yet. */
export interface RunningSubagent {
  id: string;
  type?: string;
  description?: string;
  startedAt: number;
}

/**
 * The helpers a session has that have not finished, read from the extension's
 * own lifecycle events on that session's bus. The global registry the
 * extension also offers is claimed by whichever session in the process
 * activated it first and is never released here, so it describes nobody in
 * particular - which is why the schedule host could not trust it.
 */
type Bus = {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: (data: unknown) => void) => () => void;
};

/** How long a session being disposed waits for the extension to confirm its stops. */
const STOP_CONFIRM_MS = 1000;

export class SubagentMonitor {
  private readonly unfinished = new Map<string, RunningSubagent>();
  private bus: Bus | null = null;

  attach(bus: Bus): void {
    this.bus = bus;
  }

  /**
   * A helper that exists and is not finished: queued ("created", detached only)
   * or running ("started" - which is also the only event a scheduled job gets,
   * because the scheduler spawns without going through the Agent tool). A helper
   * inside a turn is counted too while it works; that turn waits for it anyway.
   */
  onStarted(data: unknown, requireDetached: boolean): void {
    const record = asRecord(data);
    const id = typeof record?.id === "string" ? record.id : "";
    if (!id || (requireDetached && record?.isBackground !== true)) return;
    if (this.unfinished.has(id)) return;
    this.unfinished.set(id, {
      id,
      type: typeof record?.type === "string" ? record.type : undefined,
      description: typeof record?.description === "string" ? record.description : undefined,
      startedAt: Date.now(),
    });
  }

  onFinished(data: unknown): void {
    const id = asRecord(data)?.id;
    if (typeof id === "string") this.unfinished.delete(id);
  }

  hasRunning(): boolean {
    return this.unfinished.size > 0;
  }

  running(): RunningSubagent[] {
    return [...this.unfinished.values()];
  }

  /**
   * Stops every unfinished helper through the extension's own RPC, so nothing
   * keeps working - and spending - for a session that is about to go away.
   * `settled` resolves once the extension has answered every stop, or after a
   * second: it answers on the session's bus, so the session must still be alive
   * to hear it, or the answer fails against a disposed session instead.
   */
  stopAll(): { count: number; settled: Promise<void> } {
    const bus = this.bus;
    const agents = [...this.unfinished.values()];
    this.unfinished.clear();
    if (!bus || agents.length === 0) return { count: 0, settled: Promise.resolve() };
    const answers: Promise<void>[] = [];
    let count = 0;
    for (const agent of agents) {
      const requestId = `eggent-stop-${agent.id}`;
      try {
        answers.push(new Promise<void>((resolve) => {
          const off = bus.on(`subagents:rpc:stop:reply:${requestId}`, () => {
            off();
            resolve();
          });
        }));
        bus.emit("subagents:rpc:stop", { requestId, agentId: agent.id });
        count += 1;
      } catch {
        // The bus of a session that is already gone; nothing left to stop there.
      }
    }
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_CONFIRM_MS);
      timer.unref?.();
    });
    return { count, settled: Promise.race([Promise.all(answers).then(() => undefined), timeout]) };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const monitors = new WeakMap<AgentSession, SubagentMonitor>();

export function bindSubagentMonitor(session: AgentSession, monitor: SubagentMonitor): void {
  monitors.set(session, monitor);
}

export function subagentMonitorFor(session: AgentSession): SubagentMonitor | undefined {
  return monitors.get(session);
}

export function createSubagentPolicyExtension(options: {
  monitor?: SubagentMonitor;
  maxParallel?: number;
} = {}): InlineExtension {
  const limit = Math.max(1, options.maxParallel ?? MAX_PARALLEL_SUBAGENTS);
  return {
    name: "eggent-subagents",
    hidden: true,
    factory: (pi) => {
      // Calls admitted in this session that have not reported back yet.
      const inTurn = new Set<string>();

      pi.on("tool_call", (event) => {
        if (!isAgentToolName(event.toolName)) return undefined;
        const input = event.input as Record<string, unknown>;
        if (scheduleOf(input)) return undefined;
        if (inTurn.size >= limit) {
          return { block: true, reason: subagentLimitReason(limit) };
        }
        keepSubagentInTurn(input);
        inTurn.add(event.toolCallId);
        return undefined;
      });

      pi.on("tool_execution_end", (event) => {
        inTurn.delete(event.toolCallId);
      });

      // Every call of a finished run has settled, reported or not; a retained
      // session lives through many runs and must not carry a count over.
      pi.on("agent_end", () => {
        inTurn.clear();
      });

      if (options.monitor) watchSubagents(pi, options.monitor);
    },
  };
}

/** Feeds a monitor from the extension's lifecycle events on this session's bus. */
export function watchSubagents(pi: ExtensionAPI, monitor: SubagentMonitor): void {
  monitor.attach({
    emit: (channel, data) => pi.events.emit(channel, data),
    on: (channel, handler) => pi.events.on(channel, handler),
  });
  pi.events.on("subagents:created", (data) => monitor.onStarted(data, true));
  pi.events.on("subagents:started", (data) => monitor.onStarted(data, false));
  pi.events.on("subagents:completed", (data) => monitor.onFinished(data));
  pi.events.on("subagents:failed", (data) => monitor.onFinished(data));
}
