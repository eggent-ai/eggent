/**
 * Words the runtime matches user intent against.
 *
 * These are not messages — nobody reads them. They are the vocabulary by which
 * code recognises "stop", "yes", or "show me the schedule" in what somebody
 * typed, and they belong here for one reason: a build should understand the
 * languages it ships in, and nothing else.
 *
 * Keeping them here is what lets the rest of the source stay identical across
 * the localised branches. Every matcher composes its pattern from this file, so
 * adding a language means editing this file and no other — which is the same
 * rule the message dictionary follows.
 *
 * Two things to hold to when editing:
 *
 * - **Stems, not whole words, where a language inflects.** In a language whose
 *   verbs take endings the speaker chooses without thinking, one stem catches
 *   every form of a verb, while a list of whole words catches only the forms
 *   somebody happened to think of.
 * - **A false positive is worse than a miss.** Several of these decide whether
 *   to abandon work in progress. Words that are ordinary in an ordinary
 *   sentence do not belong here.
 */

/** Whole-message ways of saying "stop what you are doing". */
export const STOP_PHRASES: readonly string[] = [
  "stop",
  "stop stop",
  "stop it",
  "stop please",
  "halt",
  "cancel",
  "abort",
  "wait",
  "hold on",
  "nevermind",
  "never mind",
  "enough",
  "quit",
];

/** Verbs meaning "end this run", matched inside a sentence rather than alone. */
export const INTERRUPT_VERBS: readonly string[] = [
  "stop",
  "terminate",
  "kill",
  "cancel",
  "abort",
  "end",
];

/** Stems of the same verbs, for the negated form ("do not stop"). */
export const INTERRUPT_VERB_STEMS: readonly string[] = [
  "stop",
  "terminate",
  "kill",
  "cancel",
  "abort",
];

/** Ways of saying "do not", for spotting a negated interrupt. */
export const NEGATIONS: readonly string[] = ["do not", "don't", "dont"];

/** Whole-message ways of agreeing. */
export const AFFIRMATIVES: readonly string[] = ["true", "yes", "y", "ok"];

/** How a turn that hands over a prompt tends to trail off. */
export const PROMPT_HANDOFF_PHRASES: readonly string[] = [
  "here is (?:the )?prompt",
];

/** Nouns that mean the user is talking about scheduled work. */
export const SCHEDULE_NOUNS: readonly string[] = [
  "scheduled",
  "schedule",
  "schedules",
  "reminder",
  "reminders",
  "job",
  "jobs",
];

/** Verbs that mean "inspect or change what is already scheduled". */
export const SCHEDULE_MANAGEMENT_VERBS: readonly string[] = [
  "cancel",
  "delete",
  "remove",
  "clear",
  "list",
  "show",
  "what",
  "which",
  "update",
  "change",
  "move",
  "reschedule",
  "edit",
];

/** The subset of the above that means "move it to another time". */
export const SCHEDULE_RETIME_VERBS: readonly string[] = [
  "update",
  "change",
  "move",
  "reschedule",
];

/** Words that mean "do this later" rather than "do this now". */
export const SCHEDULE_CREATION_PHRASES: readonly string[] = [
  "tomorrow",
  "tonight",
  "daily",
  "weekly",
  "monthly",
  "every\\s+\\w+",
  "remind\\s+me",
  "schedule",
];

/**
 * Whole regex fragments for "in N minutes", where the unit inflects and a word
 * list will not do. Empty when the build's language needs no fragment beyond
 * the English one the matcher always carries.
 */
export const RELATIVE_DELAY_PATTERNS: readonly string[] = [];

/**
 * Titles a chat carries before its first message names it.
 *
 * Matched so the first thing somebody says can replace the placeholder. The
 * placeholder itself is a translated string, so recognising it is vocabulary:
 * a build has to know the untitled-chat name in each language it ships.
 */
export const DEFAULT_CHAT_TITLES: readonly string[] = ["New Chat", "New chat"];

/**
 * Extra characters a slug may keep beyond `a-z0-9`.
 *
 * A pipeline named in this build's language should still produce a readable
 * slug rather than a row of dashes. Empty when the build has no alphabet of its
 * own to preserve.
 */
export const SLUG_EXTRA_CHARACTERS = "";

/**
 * Phrasings worth showing the model in a tool description, so it recognises the
 * same request written the way this build's users write it. Empty in a build
 * whose users write the language the description is already in.
 */
export const SCHEDULE_MANAGEMENT_EXAMPLES: readonly string[] = [];
export const USAGE_QUESTION_EXAMPLES: readonly string[] = [];

/**
 * Render example phrasings for a tool description, or nothing at all.
 *
 * A tool description is sent to the model on every turn, so a build whose users
 * write the language the description is already in should not pay for a list of
 * translations of it.
 */
export function localisedExamples(examples: readonly string[]): string {
  if (examples.length === 0) return "";
  return ` (for example ${examples.map((example) => `"${example}"`).join(", ")})`;
}

/** Join vocabulary into a regex alternation, ready to interpolate. */
export function alternation(words: readonly string[]): string {
  return words.join("|");
}

/**
 * A pattern that matches any of these words where a word can begin.
 *
 * `\b` is defined on `[A-Za-z0-9_]`, so it does not see the edge of a word in
 * any alphabet but the Latin one - `\bзадач\b` matches nothing, ever. That is
 * not a detail to remember at each call site, so it is decided here: an entry
 * written in ASCII is bounded on both sides, and an entry that is not is
 * matched wherever it appears.
 *
 * Matching a non-ASCII entry loosely is also what its authors intend. Those
 * entries are stems - the whole point of writing `останов` rather than three
 * conjugations is to catch the endings a speaker picks without thinking.
 */
export function wordPattern(words: readonly string[]): string {
  const ascii = words.filter((word) => /^[\x20-\x7e]*$/.test(word));
  const rest = words.filter((word) => !/^[\x20-\x7e]*$/.test(word));
  const parts: string[] = [];
  if (ascii.length > 0) parts.push(`\\b(?:${ascii.join("|")})\\b`);
  if (rest.length > 0) parts.push(`(?:${rest.join("|")})`);
  return parts.join("|");
}

/** The same, compiled, case-insensitive. Never matches when there are no words. */
export function wordMatcher(words: readonly string[]): RegExp {
  const pattern = wordPattern(words);
  return pattern ? new RegExp(pattern, "i") : /(?!)/;
}
