Use this tool when the user asks to switch, move, or jump to another project.

How to call:
- Prefer `project_id` when user gave a specific id.
- Use `project_name` when user gave a name in natural language.
- If the user request is ambiguous, call the tool and use returned `matches` to clarify.

After success:
- Confirm to the user which project was selected.
- Continue the task in the new project context.
