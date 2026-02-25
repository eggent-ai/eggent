Use this tool when the user asks to **delete** or **remove** an MCP server from `.meta/mcp/servers.json`.

Rules:
1. Pass the exact `server_id`.
2. Delete only the requested server entry.
3. If not found, report which id was missing and ask for the correct one.

