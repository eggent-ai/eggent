Use this tool when the user's request matches one of the skills listed in `<available_skills>`.

1. Choose the skill whose **description** best matches the task.
2. Call `load_skill` with that skill's **name** (exactly as in `<name>`).
3. Treat the returned SKILL.md content as authoritative instructions.
4. If `load_skill` returns **Available Skill Resources**, load only the files you need using `load_skill_resource`.
5. After loading any required resources, follow the skill instructions step by step to complete the task.
6. If no skill fits the request, proceed without activating a skill.

Do not call `load_skill` for every message — only when the task clearly matches a skill's description.
