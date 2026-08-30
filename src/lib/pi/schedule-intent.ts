/**
 * Reading a message for what it wants done with schedules.
 *
 * Kept apart from the chat runner because it is pure text in, tool names out:
 * no runtime, no workspace, no model. That is what makes it testable, and this
 * logic has already shipped one defect that only a test would have caught.
 */
import {
  alternation,
  RELATIVE_DELAY_PATTERNS,
  SCHEDULE_CREATION_PHRASES,
  SCHEDULE_MANAGEMENT_VERBS,
  SCHEDULE_NOUNS,
  SCHEDULE_RETIME_VERBS,
} from "@/i18n/vocabulary";

const SCHEDULE_NOUN_RE = new RegExp(`\\b(?:${alternation(SCHEDULE_NOUNS)})\\b`, "i");
const MANAGEMENT_VERB_RE = new RegExp(`\\b(?:${alternation(SCHEDULE_MANAGEMENT_VERBS)})\\b`, "i");
const RETIME_VERB_RE = new RegExp(`\\b(?:${alternation(SCHEDULE_RETIME_VERBS)})\\b`, "i");
const CLOCK_TIME_RE = /\b\d{1,2}(?::|\s)\d{2}\b/;

export function hasScheduleManagementIntent(text: string): boolean {
  const mentionsSchedules = SCHEDULE_NOUN_RE.test(text);
  const managementVerb = MANAGEMENT_VERB_RE.test(text);
  const changesScheduledTime = RETIME_VERB_RE.test(text) && CLOCK_TIME_RE.test(text);
  return (mentionsSchedules && managementVerb) || changesScheduledTime;
}

const CREATION_PHRASE_RE = new RegExp(`\\b(?:${alternation(SCHEDULE_CREATION_PHRASES)})\\b`, "i");
const RELATIVE_DELAY_RE = new RegExp(
  `\\b(?:in|after)\\s+\\d+\\s*(?:seconds?|secs?|minutes?|mins?|hours?|days?)\\b`
  + (RELATIVE_DELAY_PATTERNS.length > 0 ? `|${alternation(RELATIVE_DELAY_PATTERNS)}` : ""),
  "i"
);
const CLOCK_AT_RE = /\b(?:at)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i;

export function hasScheduleIntent(text: string): boolean {
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
  text: string
) {
  const activeTools = session.getActiveToolNames();
  // The full set is the baseline; without it we can only ever take away.
  const allTools = session.getAllTools?.().map((tool) => tool.name) ?? activeTools;
  const withheld = hasScheduleManagementIntent(text)
    ? new Set(["Agent", "bash"])
    : hasScheduleIntent(text)
      ? new Set(["bash"])
      : new Set<string>();

  const next = allTools.filter((toolName) => !withheld.has(toolName));
  const unchanged =
    next.length === activeTools.length && next.every((toolName) => activeTools.includes(toolName));
  if (unchanged) return;
  session.setActiveToolsByName(next);
}

