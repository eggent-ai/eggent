Use this tool when the user asks to **delete** or **remove** a skill from the current project.

This permanently removes:
- `SKILL.md`
- optional files under `scripts/`, `references/`, `assets/`, and any other files in that skill folder

Safety:
1. Set `confirm=true` only when the user's intent to delete is clear.
2. Use the exact `skill_name`.
3. If the skill is not found, check `<available_skills>` and retry with an exact name.

