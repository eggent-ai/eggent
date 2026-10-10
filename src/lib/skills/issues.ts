/**
 * Why a skill upload was turned away, and what it was let through with.
 *
 * Each problem has a code of its own and not a sentence, so the one place that
 * finds it does not have to know which language the person reads: the route
 * turns a code and its details into the workspace's language, and a screen can
 * act on a code (an existing skill is a question to ask, a damaged archive is
 * not). The message table below is checked against the list of codes, so a code
 * added without a sentence does not compile.
 */
import type { MessageKey } from "@/i18n/messages";

export type SkillIssueCode =
  // The file as a whole.
  | "unsupportedType"
  | "empty"
  | "tooLarge"
  // The archive.
  | "notZip"
  | "zipUnsupported"
  | "zipEncrypted"
  | "zipCorrupt"
  | "tooManyFiles"
  | "unpackedTooLarge"
  | "unsafePath"
  | "link"
  | "duplicatePath"
  // Finding the skill in it.
  | "skillMdMissing"
  | "skillMdCase"
  | "skillMdNested"
  | "severalSkills"
  // SKILL.md itself.
  | "skillMdNotText"
  | "skillMdTooLarge"
  | "frontmatterMissing"
  | "frontmatterUnclosed"
  | "frontmatterYaml"
  | "frontmatterNotMap"
  | "fieldMissing"
  | "fieldNotText"
  | "fieldTooLong"
  | "nameInvalid"
  | "learnedMarker";

export type SkillIssueParams = Record<string, string | number>;

export interface SkillIssue {
  code: SkillIssueCode;
  params?: SkillIssueParams;
}

export const SKILL_ISSUE_MESSAGES = {
  unsupportedType: "skills.upload.error.unsupportedType",
  empty: "skills.upload.error.empty",
  tooLarge: "skills.upload.error.tooLarge",
  notZip: "skills.upload.error.notZip",
  zipUnsupported: "skills.upload.error.zipUnsupported",
  zipEncrypted: "skills.upload.error.zipEncrypted",
  zipCorrupt: "skills.upload.error.zipCorrupt",
  tooManyFiles: "skills.upload.error.tooManyFiles",
  unpackedTooLarge: "skills.upload.error.unpackedTooLarge",
  unsafePath: "skills.upload.error.unsafePath",
  link: "skills.upload.error.link",
  duplicatePath: "skills.upload.error.duplicatePath",
  skillMdMissing: "skills.upload.error.skillMdMissing",
  skillMdCase: "skills.upload.error.skillMdCase",
  skillMdNested: "skills.upload.error.skillMdNested",
  severalSkills: "skills.upload.error.severalSkills",
  skillMdNotText: "skills.upload.error.skillMdNotText",
  skillMdTooLarge: "skills.upload.error.skillMdTooLarge",
  frontmatterMissing: "skills.upload.error.frontmatterMissing",
  frontmatterUnclosed: "skills.upload.error.frontmatterUnclosed",
  frontmatterYaml: "skills.upload.error.frontmatterYaml",
  frontmatterNotMap: "skills.upload.error.frontmatterNotMap",
  fieldMissing: "skills.upload.error.fieldMissing",
  fieldNotText: "skills.upload.error.fieldNotText",
  fieldTooLong: "skills.upload.error.fieldTooLong",
  nameInvalid: "skills.upload.error.nameInvalid",
  learnedMarker: "skills.upload.error.learnedMarker",
} as const satisfies Record<SkillIssueCode, MessageKey>;

/**
 * Things worth telling the person about a skill that was installed.
 *
 * Neither stops anything. Both are about what was done to their file, or what
 * it turned out to hold, and a silent edit is the one thing an upload should
 * not make.
 */
export type SkillNoteCode = "learnedMarkerRemoved" | "emptyBody";

export const SKILL_NOTE_MESSAGES = {
  learnedMarkerRemoved: "skills.upload.note.learnedMarkerRemoved",
  emptyBody: "skills.upload.note.emptyBody",
} as const satisfies Record<SkillNoteCode, MessageKey>;
