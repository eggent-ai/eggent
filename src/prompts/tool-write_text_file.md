Use this tool to create or update UTF-8 text files.

When to use:
- The user asks to create a note, markdown, config, or code file.
- You need deterministic file writing without relying on external runtimes.

How to use:
1. Provide `file_path` (absolute or relative to current project cwd).
2. Pass full file `content`.
3. Set `overwrite=false` to avoid replacing existing files.

After writing:
- Confirm file path and whether it was created or overwritten.
