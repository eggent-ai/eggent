import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { learningLimits } from "@/lib/learning/config";
import { applyNoteOps, type NoteOp } from "@/lib/learning/notes";
import {
  createLearnedSkill,
  listOrchestratorSkills,
  patchLearnedSkill,
  viewSkill,
  writeLearnedSkillFile,
} from "@/lib/learning/skills";
import { noteSkillWritten } from "@/lib/learning/usage";
import type { LearnedChange } from "@/lib/learning/types";

/**
 * The two tools the reviewer has, and the only two.
 *
 * It gets no shell, no files, no web and no messaging: a reviewer that could
 * run anything would turn "read a conversation" into a way of acting on
 * whatever the conversation contained. Everything it can change is a note or a
 * learned skill, each checked on the way in (see guard.ts), and every change is
 * recorded so the person can be shown it.
 */

export const REVIEW_TOOL_NAMES = ["memory", "skill_manage"] as const;

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

const NoteOperation = Type.Object({
  action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")], {
    description: "add = a new entry; replace = rewrite one existing entry; remove = delete one.",
  }),
  target: Type.Union([Type.Literal("user"), Type.Literal("notes")], {
    description: "user = about the person; notes = about the workspace and the work.",
  }),
  content: Type.Optional(Type.String({ description: "The entry, for add and replace. One short sentence." })),
  match: Type.Optional(Type.String({ description: "For replace and remove: some text from the one existing entry you mean." })),
});

function describeUsage(notes: { user: string[]; notes: string[] }): string {
  const limits = learningLimits();
  const used = (entries: string[]) => entries.reduce((total, entry) => total + entry.length, 0);
  return `About the person: ${used(notes.user)} of ${limits.userChars} characters. About the workspace: ${used(notes.notes)} of ${limits.notesChars}.`;
}

function clipText(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}

export function createReviewTools(context: { chatId?: string; changes: LearnedChange[] }): ToolDefinition[] {
  const memory = defineTool({
    name: "memory",
    label: "Keep Notes",
    description:
      "Add, replace or remove short notes the assistant reads at the start of every future conversation. Send every change in one call as a batch; the batch is applied whole or not at all, and the size limit is checked on the result, so make room and add in the same call. Secrets are refused.",
    parameters: Type.Object({
      operations: Type.Optional(Type.Array(NoteOperation, { description: "The changes, in order. Up to 12." })),
      action: Type.Optional(Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")], { description: "A single change, if you are not sending a batch." })),
      target: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("notes")])),
      content: Type.Optional(Type.String()),
      match: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const ops: NoteOp[] = params.operations?.length
        ? params.operations.map((op) => ({ action: op.action, target: op.target, content: op.content, match: op.match }))
        : params.action && params.target
          ? [{ action: params.action, target: params.target, content: params.content, match: params.match }]
          : [];
      const result = await applyNoteOps(ops, { source: "review", chatId: context.chatId });
      if (!result.ok) return text(result.error);
      context.changes.push(...result.changes);
      const summary = result.changes.length
        ? `Saved ${result.changes.length} change(s).`
        : result.unchanged.length
          ? "Nothing changed: those entries were already there."
          : "Nothing changed.";
      return text(`${summary} ${describeUsage(result.notes)}`);
    },
  });

  const skills = defineTool({
    name: "skill_manage",
    label: "Manage Learned Skills",
    description:
      "Look at, create or improve a skill: a reusable procedure for a kind of task. action=view reads a skill (and lists its files). action=create makes a new learned skill from name, description and body. action=patch replaces an exact piece of text in a learned skill (old_string must appear once). action=write_file saves a support file under references/, templates/, scripts/ or assets/. Only skills marked [learned] can be changed.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("view"), Type.Literal("create"), Type.Literal("patch"), Type.Literal("write_file")]),
      name: Type.String({ description: "The skill's name: lowercase words joined by hyphens." }),
      description: Type.Optional(Type.String({ description: "For create: one sentence saying what the skill does and when to use it." })),
      body: Type.Optional(Type.String({ description: "For create: the skill text - when to use it, numbered steps, pitfalls, how to check." })),
      old_string: Type.Optional(Type.String({ description: "For patch: the exact text to replace; it must appear once." })),
      new_string: Type.Optional(Type.String({ description: "For patch: the replacement." })),
      file: Type.Optional(Type.String({ description: "For view, patch and write_file: a file inside the skill, such as references/checklist.md. Defaults to SKILL.md." })),
      content: Type.Optional(Type.String({ description: "For write_file: the file's text." })),
    }),
    execute: async (_toolCallId, params) => {
      const source = { source: "review" as const, chatId: context.chatId };
      const name = params.name.trim();

      if (params.action === "view") {
        const viewed = await viewSkill(name, params.file);
        if (!viewed.ok) return text(viewed.error);
        return text(
          `${viewed.learned ? "[learned] " : ""}${viewed.name} / ${viewed.file}\n\n${viewed.content}${
            viewed.files.length ? `\n\nSupport files: ${viewed.files.join(", ")}` : ""
          }`
        );
      }

      if (params.action === "create") {
        const created = await createLearnedSkill(
          { name, description: params.description ?? "", body: params.body ?? "" },
          source
        );
        if (!created.ok) return text(created.error);
        await noteSkillWritten(name, "created");
        context.changes.push({ kind: "skill", action: "created", text: name, detail: clipText(params.description ?? "", 120) });
        return text(`Created the skill "${name}".`);
      }

      if (params.action === "patch") {
        const patched = await patchLearnedSkill(
          { name, oldString: params.old_string ?? "", newString: params.new_string ?? "", file: params.file },
          source
        );
        if (!patched.ok) return text(patched.error);
        await noteSkillWritten(name, "patched");
        const known = (await listOrchestratorSkills()).find((skill) => skill.name === name);
        context.changes.push({ kind: "skill", action: "patched", text: name, detail: clipText(known?.description ?? "", 120) });
        return text(`Patched ${patched.file} in "${name}".`);
      }

      if (params.action === "write_file") {
        const written = await writeLearnedSkillFile({ name, file: params.file ?? "", content: params.content ?? "" }, source);
        if (!written.ok) return text(written.error);
        await noteSkillWritten(name, "patched");
        const known = (await listOrchestratorSkills()).find((skill) => skill.name === name);
        context.changes.push({ kind: "skill", action: "patched", text: name, detail: clipText(known?.description ?? "", 120) });
        return text(`Saved ${written.file} in "${name}".`);
      }

      return text('action must be "view", "create", "patch" or "write_file".');
    },
  });

  return [memory as unknown as ToolDefinition, skills as unknown as ToolDefinition];
}
