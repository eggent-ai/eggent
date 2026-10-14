/**
 * Reading a message for what it wants done with schedules.
 *
 * Kept apart from the chat runner because it is pure text in, tool names out:
 * no runtime, no workspace, no model. That is what makes it testable, and this
 * logic has already shipped one defect that only a test would have caught.
 */
import {
  alternation,
  wordMatcher,
  RELATIVE_DELAY_PATTERNS,
  SCHEDULE_CREATION_PHRASES,
  SCHEDULE_MANAGEMENT_VERBS,
  SCHEDULE_NOUNS,
  SCHEDULE_RETIME_VERBS,
} from "@/i18n/vocabulary";

const SCHEDULE_NOUN_RE = wordMatcher(SCHEDULE_NOUNS);
const MANAGEMENT_VERB_RE = wordMatcher(SCHEDULE_MANAGEMENT_VERBS);
const RETIME_VERB_RE = wordMatcher(SCHEDULE_RETIME_VERBS);
const CLOCK_TIME_RE = /\b\d{1,2}(?::|\s)\d{2}\b/;

/**
 * Past this length a message is a document - pasted instructions, a brief, a
 * transcript - not a request about schedules, and is not read for one.
 *
 * The words below are common: a 25 KB deployment runbook (in Russian) said
 * "task" in its heading, "show" in a rule and "every image" in a step, so the turn lost
 * `bash` and the agent told the person it had no terminal. Somebody who wants
 * to see or change a schedule asks in a sentence or two. A long message that
 * does ask for one still has every tool, `Agent` with its schedule parameter
 * included; only the extra guard is skipped.
 */
export const MAX_SCHEDULE_INTENT_CHARS = 1500;

function readableForIntent(text: string): boolean {
  return text.trim().length <= MAX_SCHEDULE_INTENT_CHARS;
}

/** Sentences, so a noun in one and a verb in another do not make a request. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?\u2026])\s+|\n+/).filter((part) => part.trim().length > 0);
}

export function hasScheduleManagementIntent(text: string): boolean {
  if (!readableForIntent(text)) return false;
  return sentences(text).some((sentence) => {
    const mentionsSchedules = SCHEDULE_NOUN_RE.test(sentence);
    const managementVerb = MANAGEMENT_VERB_RE.test(sentence);
    const changesScheduledTime = RETIME_VERB_RE.test(sentence) && CLOCK_TIME_RE.test(sentence);
    return (mentionsSchedules && managementVerb) || changesScheduledTime;
  });
}

const CREATION_PHRASE_RE = wordMatcher(SCHEDULE_CREATION_PHRASES);
const RELATIVE_DELAY_RE = new RegExp(
  `\\b(?:in|after)\\s+\\d+\\s*(?:seconds?|secs?|minutes?|mins?|hours?|days?)\\b`
  + (RELATIVE_DELAY_PATTERNS.length > 0 ? `|${alternation(RELATIVE_DELAY_PATTERNS)}` : ""),
  "i"
);
const CLOCK_AT_RE = /\b(?:at)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i;

export function hasScheduleIntent(text: string): boolean {
  if (!readableForIntent(text)) return false;
  if (hasScheduleManagementIntent(text)) return false;
  return RELATIVE_DELAY_RE.test(text) || CREATION_PHRASE_RE.test(text) || CLOCK_AT_RE.test(text);
}

/**
 * Which tools this turn may use, decided from scratch every turn.
 *
 * Managing schedules and creating them want different tool sets: a request to
 * list or cancel must go through eggent_manage_schedules, so Agent and bash are
 * withheld, or the model edits the store by hand and the armed cron keeps the
 * old time.
 *
 * This used to subtract from whatever survived the previous turn and only ever
 * added `bash` back, so `Agent` - the one tool that creates a schedule - was
 * gone for good after a single management turn. Asking for the list and then
 * asking for a new reminder produced "the scheduling tool is currently
 * unavailable", while the model poked at get_subagent_result looking for
 * something that was still installed and merely switched off. Three schedules
 * had been created in the same conversation minutes earlier.
 *
 * So the set is computed from the session's full tool list each time. Anything
 * withheld for one turn comes back on the next.
 */
export function applySchedulingToolPolicy(
  session: {
    getActiveToolNames: () => string[];
    setActiveToolsByName: (toolNames: string[]) => void;
    getAllTools?: () => Array<{ name: string }>;
    getToolDefinition?: (toolName: string) => unknown;
  },
  text: string,
  platform: string = process.platform
) {
  const activeTools = session.getActiveToolNames();
  // The full set is the baseline; without it we can only ever take away.
  const allTools = session.getAllTools?.().map((tool) => tool.name) ?? activeTools;
  const withheld = hasScheduleManagementIntent(text)
    ? new Set(["Agent", "bash"])
    : hasScheduleIntent(text)
      ? new Set(["bash"])
      : new Set<string>();
  // The runtime offers `powershell` on every platform and it answers only
  // "available on Windows" elsewhere. A model that finds `bash` withheld
  // reaches for it, gets that sentence, and tells the person there is no
  // terminal. Its schema is also billed every turn for nothing.
  if (platform !== "win32") withheld.add("powershell");

  const next = allTools.filter((toolName) => !withheld.has(toolName));
  const unchanged =
    next.length === activeTools.length && next.every((toolName) => activeTools.includes(toolName));
  if (unchanged) return;
  session.setActiveToolsByName(next);
}

