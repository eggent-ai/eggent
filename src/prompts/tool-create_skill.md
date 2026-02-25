Use this tool when the user asks to **create**, **add**, or **write** a skill for the current project.

**Before calling create_skill:**

1. **skill_name** — Must follow Agent Skills spec:
   - Only lowercase letters (a-z), numbers (0-9), and hyphens (-)
   - Cannot start or end with a hyphen
   - No consecutive hyphens (e.g. use `pdf-processing`, not `pdf--processing`)
   - 1–64 characters
   - Example: `code-review`, `api-conventions`, `pdf-extraction`

2. **description** — 1–1024 characters. Describe both what the skill does and when to use it. Include keywords so the agent can match user tasks to this skill later.

3. **body** — Markdown instructions the agent will follow when the skill is activated: step-by-step instructions, examples, and common edge cases. Be clear and actionable.

If the user describes what they want the skill to do but does not give a name, invent a short slug (e.g. "extract PDF tables" → `pdf-table-extraction`). If the tool returns a validation error (e.g. invalid name), fix the parameters and try again. If the skill already exists, use `update_skill` instead of creating a duplicate.

**Only SKILL.md is created by create_skill.** Scripts, references, and assets are optional. If the user asks to add a script, reference doc, or other file to the skill, use **write_skill_file** after creating the skill (e.g. `scripts/extract.py`, `references/REFERENCE.md`, `assets/template.json`).
