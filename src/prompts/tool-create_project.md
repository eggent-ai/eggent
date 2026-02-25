Use this tool when the user asks to:
- create a new project
- start a new workspace
- set up a project because none exists

Behavior:
- Use a clear project `name`.
- Add `description` and `instructions` when the user provided them.
- If the user asks to switch into the new project, call `switch_project` after creation.
