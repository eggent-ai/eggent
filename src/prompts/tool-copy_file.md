Use this tool to duplicate a local file.

When to use:
- The user asks to duplicate/copy a file.
- You need to preserve the original and create another copy.

How to use:
1. Set `source_path` and `destination_path` (absolute or relative to current project cwd).
2. Use `overwrite=true` only when replacement is intended.

If copy fails:
- Report whether the issue is missing source, existing destination, or path error.
