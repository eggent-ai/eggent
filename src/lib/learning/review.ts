import "@/lib/pi/env";
import fs from "fs/promises";
import path from "path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { learningEnabled, learningLimits, reviewLimits, reviewModelOverride } from "@/lib/learning/config";
import { buildDigest } from "@/lib/learning/digest";
import { readLearned } from "@/lib/learning/notes";
import { attachLearnedNotice, sendTelegramNotice, telegramTargetFrom, type TelegramTarget } from "@/lib/learning/notice";
import { orchestratorDir } from "@/lib/learning/paths";
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from "@/lib/learning/prompts";
import { decideReview, skillsUsedIn, type ReviewDecision, type TurnFacts, type TurnTool } from "@/lib/learning/signals";
import { listOrchestratorSkills } from "@/lib/learning/skills";
import { countTurn, noteReviewStarted, reviewAllowed } from "@/lib/learning/state";
import { createReviewTools, REVIEW_TOOL_NAMES } from "@/lib/learning/tools";
import type { LearnedChange } from "@/lib/learning/types";
import { noteSkillsUsed, runCurator } from "@/lib/learning/usage";
import { fallbackRuntimeModel, getPiModelRegistry, getPiModelRuntime } from "@/lib/pi/config-store";
import type { PiToolRecord } from "@/lib/pi/types";
import { redactSecrets } from "@/lib/pi/provider-failure";
import { getChat } from "@/lib/storage/chat-store";
import { currentBudgetLevel } from "@/lib/usage/budget-level";

/**
 * Looking back over a conversation, once it is over, and keeping what is worth
 * keeping.
 *
 * It runs after the answer has gone out and never delays it: a turn queues one
 * of these and returns. The work itself is a second, small agent with two tools
 * (see tools.ts) that reads a digest of what just happened and either writes a
 * note, writes or improves a skill, or - far more often - does nothing.
 *
 * What it costs is decided in three places and nowhere else. Whether to look at
 * all is decided from the turn's plain facts (signals.ts). How much it sees is
 * the digest, not the history. And how often is a gap and a daily cap
 * (state.ts). What it does not do is anything at all to a conversation that
 * must not be learned from: a public share, a light chat, a scheduled run.
 */

export interface LearningTurn {
  chatId: string;
  projectId?: string;
  /** What the person wrote, without anything the host appended. */
  userMessage: string;
  assistantText: string;
  tools: PiToolRecord[];
  /** The model that answered, so the review can use the same provider. */
  model?: { provider?: string; id?: string };
  /** When the turn began; the answer written after it is where the notice goes. */
  startedAt: string;
  /** Set when the turn arrived through Telegram, so it can be told what was saved. */
  telegram?: TelegramTarget;
}

function factsOf(turn: LearningTurn): TurnFacts {
  const tools: TurnTool[] = turn.tools
    .filter((tool) => tool.status !== "running")
    .map((tool) => ({
      name: tool.toolName,
      status: tool.status,
      args: tool.input && typeof tool.input === "object" && !Array.isArray(tool.input) ? (tool.input as Record<string, unknown>) : {},
    }));
  return { userMessage: turn.userMessage, assistantText: turn.assistantText, tools };
}

// --- The model --------------------------------------------------------------

async function pickReviewModel(preferred?: { provider?: string; id?: string }) {
  const runtime = await getPiModelRuntime();
  const registry = await getPiModelRegistry(runtime);
  await registry.refresh();
  const available = registry.getAvailable();

  const override = reviewModelOverride();
  if (override) {
    const slash = override.indexOf("/");
    const provider = slash > 0 ? override.slice(0, slash) : undefined;
    const id = slash > 0 ? override.slice(slash + 1) : override;
    const matches = available.filter((model) => model.id === id && (!provider || model.provider === provider));
    const named = matches.find((model) => model.provider === preferred?.provider) ?? matches[0];
    if (named) return { model: named, runtime };
  }
  const same = preferred?.id
    ? available.find((model) => model.provider === preferred.provider && model.id === preferred.id)
    : undefined;
  if (same) return { model: same, runtime };
  const fallback = await fallbackRuntimeModel(available);
  return fallback ? { model: fallback, runtime } : null;
}

// --- One review -------------------------------------------------------------

export interface ReviewOutcome {
  changes: LearnedChange[];
  toolCalls: number;
  /** What the reviewer said when it finished. */
  verdict: string;
  error?: string;
}

async function standingInstructions(): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(orchestratorDir(), "context.md"), "utf-8");
    return raw.length > 1500 ? `${raw.slice(0, 1500)}\u2026` : raw;
  } catch {
    return "";
  }
}

function digestTurns(decision: ReviewDecision, sinceReview: number): number {
  if (decision.reason === "periodic") return Math.min(6, Math.max(3, sinceReview));
  if (decision.reason === "asked" || decision.reason === "corrected") return 3;
  return 2;
}

/**
 * Run the reviewer over a conversation. Exported for the tests and for the
 * settings page's "look now"; the turn hook goes through queueLearning.
 */
export async function runReview(
  turn: LearningTurn,
  decision: ReviewDecision & { run: true; reason: NonNullable<ReviewDecision["reason"]>; focus: NonNullable<ReviewDecision["focus"]> },
  sinceReview = 1
): Promise<ReviewOutcome> {
  const limits = reviewLimits();
  const changes: LearnedChange[] = [];
  const chat = await getChat(turn.chatId);
  if (!chat) return { changes, toolCalls: 0, verdict: "", error: "The chat is gone." };
  const digest = buildDigest(chat.messages, {
    maxChars: limits.digestChars,
    userTurns: digestTurns(decision, sinceReview),
  });
  if (!digest) return { changes, toolCalls: 0, verdict: "" };

  const picked = await pickReviewModel(turn.model);
  if (!picked) return { changes, toolCalls: 0, verdict: "", error: "No model is available for a review." };

  const [notes, skills, instructions] = await Promise.all([readLearned(), listOrchestratorSkills(), standingInstructions()]);
  const noteLimits = learningLimits();
  const prompt = buildReviewPrompt({
    reason: decision.reason,
    focus: decision.focus,
    standingInstructions: instructions,
    notes,
    limits: { userChars: noteLimits.userChars, notesChars: noteLimits.notesChars },
    skills,
    digest,
  });

  const cwd = orchestratorDir();
  await fs.mkdir(cwd, { recursive: true });
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => REVIEW_SYSTEM_PROMPT,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await resourceLoader.reload();

  const tools = createReviewTools({ chatId: turn.chatId, changes });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: picked.model,
    modelRuntime: picked.runtime,
    resourceLoader,
    thinkingLevel: "off",
    // Only these two exist for it: no shell, no files, no web.
    tools: [...REVIEW_TOOL_NAMES],
    customTools: tools,
    sessionManager: SessionManager.inMemory(cwd),
  });

  let toolCalls = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    void session.abort().catch(() => undefined);
  };
  const unsubscribe = session.subscribe((event: unknown) => {
    const record = event as { type?: string } | null;
    if (record?.type === "tool_execution_start") {
      toolCalls += 1;
      if (toolCalls > limits.maxToolCalls) stop();
    }
  });
  const timer = setTimeout(stop, limits.timeoutMs);

  try {
    await session.prompt(prompt);
    // An aborted run ends quietly rather than throwing, so the reason it ended
    // has to be remembered from the moment it was stopped.
    if (stopped) {
      return { changes, toolCalls, verdict: "", error: "The review ran past its limits and was stopped." };
    }
    return { changes, toolCalls, verdict: (session.getLastAssistantText() ?? "").trim().slice(0, 200) };
  } catch (error) {
    return {
      changes,
      toolCalls,
      verdict: "",
      error: stopped ? "The review ran past its limits and was stopped." : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    unsubscribe();
    session.dispose();
  }
}

// --- The turn hook ----------------------------------------------------------

async function processTurn(turn: LearningTurn): Promise<void> {
  if (!(await learningEnabled())) return;

  const facts = factsOf(turn);
  const used = skillsUsedIn(facts);
  if (used.length > 0) await noteSkillsUsed(used);

  await runCurator().catch((error) => console.warn("Learning housekeeping failed:", error));

  const limits = reviewLimits();
  const counters = await countTurn(turn.chatId);
  const decision = decideReview(facts, counters, { everyTurns: limits.everyTurns, effortToolCalls: limits.effortToolCalls });
  if (!decision.run || !decision.reason || !decision.focus) return;

  // A request to remember something is the one thing that should not wait for
  // the gap to pass; everything else can.
  const allowed = await reviewAllowed(Date.now(), { ignoreGap: decision.reason === "asked" });
  if (!allowed.ok) return;
  // Housekeeping is not worth spending what is left of an allowance on.
  if ((await currentBudgetLevel()) === "low") return;

  await noteReviewStarted(turn.chatId);
  const outcome = await runReview(turn, { ...decision, run: true, reason: decision.reason, focus: decision.focus }, counters.sinceReview);
  // One line per look-back, so what the agent decided can be read back from the
  // container log. The verdict is its own closing line, a few words, masked.
  const said = redactSecrets(outcome.verdict).replace(/\s+/g, " ").slice(0, 80);
  console.info(
    `[learning] ${decision.reason} look-back on chat ${turn.chatId.slice(0, 8)}: ${outcome.changes.length} saved, ${outcome.toolCalls} tool call(s)${said ? `, said "${said}"` : ""}${outcome.error ? `, ended with: ${outcome.error}` : ""}`
  );
  if (outcome.changes.length === 0) return;

  await attachLearnedNotice({ chatId: turn.chatId, since: turn.startedAt, changes: outcome.changes });
  if (turn.telegram) await sendTelegramNotice(turn.telegram, outcome.changes);
}

interface QueueHolder {
  __eggentLearningQueue?: { tail: Promise<void>; pending: number };
}

const MAX_PENDING = 8;

/**
 * Hand a finished turn to the learning pass.
 *
 * Returns at once and never throws. Turns are processed one at a time, in
 * order, because a review reads and writes the same two files; and a backlog
 * is dropped rather than grown, since a review of a conversation from a minute
 * ago is only worth running if somebody is still waiting for nothing else.
 */
export function queueLearning(turn: LearningTurn): void {
  try {
    const holder = globalThis as unknown as QueueHolder;
    const queue = (holder.__eggentLearningQueue ??= { tail: Promise.resolve(), pending: 0 });
    if (queue.pending >= MAX_PENDING) return;
    queue.pending += 1;
    queue.tail = queue.tail
      .then(() => processTurn(turn))
      .catch((error) => {
        console.warn("Learning pass failed:", error);
      })
      .finally(() => {
        queue.pending -= 1;
      });
  } catch (error) {
    console.warn("Could not queue the learning pass:", error);
  }
}

/**
 * What a finished turn tells the learning pass, and which turns must never be
 * learned from.
 *
 * A light chat has no memory to speak of and costs almost nothing by design; a
 * public share is somebody else talking, not the owner of this workspace.
 */
export interface FinishedTurn {
  chatId: string;
  projectId?: string;
  contextMode?: "full" | "plain" | "files";
  isPublicShare?: boolean;
  userMessage: string;
  assistantText: string;
  tools: Iterable<PiToolRecord>;
  model?: { provider?: string; id?: string };
  startedAt: string;
  toolRuntimeData?: Record<string, unknown>;
}

/** Returns whether the turn was handed on. */
export function learnFromTurn(turn: FinishedTurn): boolean {
  if (turn.contextMode === "plain" || turn.contextMode === "files") return false;
  if (turn.isPublicShare) return false;
  if (!turn.userMessage.trim()) return false;
  queueLearning({
    chatId: turn.chatId,
    projectId: turn.projectId,
    userMessage: turn.userMessage,
    assistantText: turn.assistantText,
    tools: [...turn.tools],
    model: turn.model ? { provider: turn.model.provider, id: turn.model.id } : undefined,
    startedAt: turn.startedAt,
    telegram: telegramTargetFrom(turn.toolRuntimeData),
  });
  return true;
}

/** Resolves when everything queued so far has been looked at. For the tests. */
export function learningIdle(): Promise<void> {
  const holder = globalThis as unknown as QueueHolder;
  return holder.__eggentLearningQueue?.tail ?? Promise.resolve();
}
