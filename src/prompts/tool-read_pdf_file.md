Use this tool to extract text from PDF files without Python.

When to use:
- The user asks what is written in a PDF.
- You need to parse PDF text from project/chat uploaded files.

How to use:
1. Provide `file_path` (absolute or relative to current project cwd).
2. Set `max_chars` to control response size.
3. After extraction, summarize or answer the user's question based on `content`.

If extraction fails:
- Report the exact tool error.
- Check file path and that the file is a valid PDF.
