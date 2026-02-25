Use this tool when the user asks to **edit**, **revise**, or **update** an existing skill's `SKILL.md`.

You can update any subset of fields:
- `description` (frontmatter)
- `body` (markdown instructions)
- `compatibility` (frontmatter; set to `null` to remove)
- `license` (frontmatter; set to `null` to remove)

Rules:
1. Use the exact `skill_name`.
2. If updating `description`, keep it specific about both capability and trigger scenarios.
3. If no changes are needed, do not call this tool.
4. If the tool reports "not found", check `<available_skills>` and retry with the exact name.

