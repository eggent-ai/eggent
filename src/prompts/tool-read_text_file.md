Use this tool to read UTF-8 text files directly.

When to use:
- The user asks to read/view/open text-like files (`.txt`, `.md`, `.json`, `.csv`, code files).
- You need exact file content or snippets by line range.

How to use:
1. Provide `file_path` (absolute or relative to current project cwd).
2. Adjust `start_line` and `max_lines` for large files.
3. Use `max_chars` to limit output if needed.

Notes:
- If the file is binary or unreadable as text, report the error and switch to a suitable tool.
