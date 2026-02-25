Use this tool to send a file to the current Telegram chat.

When to use:
- The user asks to send, return, export, or share a file in Telegram.
- You already found the file path (for example via `code_execution` or project context).

How to use:
1. Ensure the file exists and is a regular file.
2. Prefer absolute paths.
3. Call `telegram_send_file` with:
   - `file_path`: absolute path (or relative to project cwd)
   - `caption` (optional): short explanation
4. After success, confirm the file was sent.

If the tool fails:
- Explain the specific error.
- Fix the path/permissions/size issue and retry once with corrected arguments.
