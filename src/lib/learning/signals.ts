import { CORRECTION_PHRASES, MEMORY_REQUEST_PHRASES, wordMatcher } from "@/i18n/vocabulary";

/**
 * Is there anything in this turn worth a second look?
 *
 * A look back is a model call. Most turns are a question and an answer, and
 * the right outcome of looking at them is "nothing to keep" - so the cheap
 * question comes first, answered from what the turn plainly contains: did the
 * person ask for something to be kept, did they correct the agent, did it hit
 * an error and get past it, did it do real work. Conversations that show none
 * of these are still looked at now and then, so a slow accumulation of small
 * facts is not missed, but not after every sentence.
 *
 * Pure text in, decision out: no runtime, no model, no disk. That is what makes
 * it testable, and this is where the cost of the whole feature is decided.
 */

const ASKED_TO_REMEMBER = wordMatcher(MEMORY_REQUEST_PHRASES);
const CORRECTION = wordMatcher(CORRECTION_PHRASES);

export interface TurnTool {
  name: string;
  status: "completed" | "error" | "running";
  args: Record<string, unknown>;
}

export interface TurnFacts {
  userMessage: string;
  assistantText: string;
  tools: TurnTool[];
}

export type ReviewReason = "asked" | "corrected" | "recovered" | "effort" | "periodic";
export type ReviewFocus = "memory" | "skills" | "both";

export interface ReviewDecision {
  run: boolean;
  reason?: ReviewReason;
  focus?: ReviewFocus;
}

/** The skills a turn read or was told to use, by name. */
export function skillsUsedIn(facts: Pick<TurnFacts, "userMessage" | "tools">): string[] {
  const names = new Set<string>();
  const command = /^\s*\/skill:([a-z0-9][a-z0-9-]*)/i.exec(facts.userMessage);
  if (command) names.add(command[1].toLowerCase());
  for (const tool of facts.tools) {
    if (tool.name !== "read") continue;
    const target = typeof tool.args.path === "string" ? tool.args.path : "";
    const match = /(?:^|\/)skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md$/.exec(target.replace(/\\/g, "/"));
    if (match) names.add(match[1]);
  }
  return [...names];
}

/** An error that a later call got past. */
function recoveredFromError(tools: TurnTool[]): boolean {
  const firstError = tools.findIndex((tool) => tool.status === "error");
  if (firstError < 0) return false;
  return tools.slice(firstError + 1).some((tool) => tool.status === "completed");
}

export function decideReview(
  facts: TurnFacts,
  counters: { turns: number; sinceReview: number },
  limits: { everyTurns: number; effortToolCalls: number }
): ReviewDecision {
  const message = facts.userMessage;
  const usedSkills = skillsUsedIn(facts).length > 0;
  const hasAnswer = facts.assistantText.trim().length > 0;

  if (ASKED_TO_REMEMBER.test(message)) {
    return { run: true, reason: "asked", focus: "both" };
  }
  // The first message of a chat has nothing before it to be wrong about.
  if (counters.turns >= 2 && CORRECTION.test(message)) {
    return { run: true, reason: "corrected", focus: usedSkills ? "skills" : "both" };
  }
  if (hasAnswer && recoveredFromError(facts.tools)) {
    return { run: true, reason: "recovered", focus: "skills" };
  }
  if (hasAnswer && facts.tools.length >= limits.effortToolCalls && !facts.tools.some((tool) => tool.status === "error")) {
    return { run: true, reason: "effort", focus: "skills" };
  }
  if (counters.sinceReview >= limits.everyTurns) {
    return { run: true, reason: "periodic", focus: "memory" };
  }
  return { run: false };
}
