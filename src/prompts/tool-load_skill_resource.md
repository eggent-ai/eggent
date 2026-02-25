Use this tool to read one additional file from an activated skill.

1. First call `load_skill` to get the skill instructions and list of available resource files.
2. Choose only the resource files relevant to the current task.
3. Call `load_skill_resource` with exact `skill_name` and `relative_path`.
4. Use the returned file content as part of the skill instructions.

Rules:
- Do not load every resource file by default; load selectively.
- Use only paths inside the skill directory (for example `references/`, `scripts/`, `assets/`).
- If a required file is missing or unreadable, report that blocker clearly.
