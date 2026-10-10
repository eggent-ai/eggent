/**
 * What the agent has learned, as the rest of the app sees it.
 *
 * Type-only on purpose: the chat screen and the settings page import these, and
 * a client bundle must not pull the file system in with them.
 */

/** The two places a short note can live. */
export type LearnedTarget = "user" | "notes";

export type LearnedChangeKind = "user" | "note" | "skill";

export type LearnedChangeAction = "added" | "updated" | "removed" | "created" | "patched";

/**
 * One thing the agent saved after a conversation, in the words it is shown to
 * the person: the note itself, or the name of the skill.
 */
export interface LearnedChange {
  kind: LearnedChangeKind;
  action: LearnedChangeAction;
  /** The note as written, or the skill's name. Clipped for display. */
  text: string;
  /** For a skill: what it is for, in a few words. */
  detail?: string;
}

/** Kept with the assistant message the review was about. */
export interface LearnedNotice {
  at: string;
  items: LearnedChange[];
}

/** The notes as the settings page lists them. */
export interface LearnedNotesView {
  user: string[];
  notes: string[];
  limits: { user: number; notes: number };
  used: { user: number; notes: number };
}

export interface LearnedSkillView {
  name: string;
  description: string;
  state: "active" | "stale";
  useCount: number;
  lastUsedAt?: string;
}

export interface LearningView {
  /** The deployment allows learning at all. */
  available: boolean;
  /** The person has it switched on. */
  enabled: boolean;
  notes: LearnedNotesView;
  skills: LearnedSkillView[];
  archived: number;
}
