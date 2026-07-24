Use this tool to **add** or **update** one MCP server in the project's `.mcp.json`.

Eggent stores MCP configuration in the standard `{ "mcpServers": { ... } }` format. At runtime, pi-mcp-adapter exposes those servers through the `mcp` proxy tool.

After this tool changes `.mcp.json`, Eggent queues a Pi MCP runtime reload so the `mcp` proxy can see the new/updated server. Prefer retrying `mcp({ connect: "<server>" })` after the reload note instead of searching the web for the MCP server you just configured.
