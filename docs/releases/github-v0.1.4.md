## Eggent v0.1.4 - Web Search Autostart

Patch release focused on making web search available immediately on startup, without mandatory external search tool setup.

### Highlights

- Added `auto` web search provider mode with priority routing:
  - Tavily (when key exists),
  - SearXNG (when URL is configured),
  - DuckDuckGo keyless fallback.
- Added built-in DuckDuckGo web search backend (no API key required).
- Enabled web search by default for fresh installs (`search.enabled=true`, `search.provider=auto`).
- Updated Settings UI with new provider options: `Auto` and `DuckDuckGo`.
- Version bump to `0.1.4` across package metadata and `GET /api/health`.

### Upgrade Notes

- No data migration required.
- To opt in on existing installs, set provider to `Auto` in `Dashboard -> Settings -> Web Search`.

### Links

- Full release snapshot: `docs/releases/0.1.4-web-search-autostart.md`
- Installation and update guide: `README.md`
