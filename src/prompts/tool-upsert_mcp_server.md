Use this tool to **add** or **update** one MCP server in the project's `.meta/mcp/servers.json`.

Choose transport by server type:
- `stdio`: local command-based MCP server (`command`, optional `args`, `env`, `cwd`)
- `http`: remote MCP endpoint (`url`, optional `headers`)

Rules:
1. Use a stable `id` (letters/numbers/dot/underscore/hyphen).
2. For `stdio`, provide a non-empty `command`.
3. For `http`, provide a non-empty `url`.
4. If the user provides `env` (stdio) or `headers` (http), copy all provided key/value pairs exactly.
5. Prefer updating a single server at a time rather than rewriting unrelated entries.
