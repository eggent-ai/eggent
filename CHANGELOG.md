# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-07-22

### Added
- Pi SDK runtime integration for project agents, tools, models, skills, MCP, and schedules.
- Project workspace management for files, context, memory, model settings, MCP, and skills.
- Pipeline definitions, pipeline runs, and artifact handoff APIs.
- Local whisper.cpp speech-to-text for browser dictation and Telegram voice messages.
- Telegram polling activation, progress updates, and formatted replies.

### Changed
- Replaced legacy cron runtime with Pi-backed schedules.
- Docker install defaults to localhost binding and keeps runtime/cache data under `data/`.
- One-command installer and docs now target the public `eggent-ai/eggent` repository.
- Core no longer ships bundled skill content; deployments can provide an optional runtime `bundled-skills/` catalog.
- Package/app health version updated to `0.2.0`.

### Fixed
- Sidebar folder selection no longer changes the agent working directory.
- Docker whisper.cpp build is pinned and ARM64-safe.
- TypeScript project check now passes with `npx tsc --noEmit`.

## [0.1.6] - 2026-04-30

### Added
- Telegram long polling mode for local/VPS installs without public HTTPS.
- Telegram polling status/start/stop controls.

### Changed
- Telegram webhook and polling processing now share the same message handling path.
- Installation docs were reworked around Docker, local Node.js, and VPS deployment paths.

### Fixed
- Telegram lifecycle starts from server instrumentation and stops cleanly on disconnect.
- Health endpoint version updated to `0.1.6`.

## [0.1.5] - 2026-03-23

### Added
- New `web_fetch` tool for direct URL reading and page extraction.
- New prompt guide `tool-web_fetch.md` for link-specific workflows.

### Changed
- `search_web` is now explicitly discovery-oriented; direct links should use `web_fetch`.
- Chat tool output UI now shows `Web Fetch` calls with the target URL.
- Request lifecycle docs updated with `web_fetch` in tool catalog.

### Fixed
- Direct link requests no longer degrade into generic search queries.
- Health endpoint version updated to `0.1.5`.

## [0.1.4] - 2026-03-23

### Added
- Keyless DuckDuckGo web search backend with HTML results parsing and Instant Answer fallback.
- New web search providers in settings: `Auto` and `DuckDuckGo (no API key)`.

### Changed
- Web search now defaults to enabled with provider `auto`.
- Auto search routing now prioritizes Tavily (if key exists), then SearXNG (if URL is configured), then falls back to DuckDuckGo.
- Settings UI now supports optional Tavily key / SearXNG URL in `Auto` mode.

### Fixed
- `search_web` tool no longer requires external provider setup to be usable on fresh installs.
- Health endpoint version updated to `0.1.4`.

## [0.1.2] - 2026-03-06

### Added
- Dark mode toggle in `Dashboard -> Settings -> Appearance`.
- Saved theme is applied on app layout load (`<html class="dark">`) for consistent rendering.

### Changed
- Python code execution now prefers project-local virtualenv interpreters (`.venv`/`venv`) when present.
- Python dependency recovery now includes project-local venv fallback for environments where system pip is blocked.
- Prompt guidance updated to use `install_packages(kind=python)` and virtualenv fallback when needed.

### Fixed
- Project file tree now hides `.venv` and `venv` directories alongside `.meta`.

## [0.1.1] - 2026-03-03

### Added
- `PUT /api/projects/[id]/mcp` endpoint for saving raw MCP config content.
- Inline MCP JSON editor with save/reset in `Dashboard -> MCP`.
- Inline MCP JSON editor with save/reset in project details context panel.
- Editable project instructions with save/reset in project details.
- Release documentation set in `docs/releases/`.

### Changed
- MCP content validation and normalization before writing `.meta/mcp/servers.json`.
- Package/app health version updated to `0.1.1`.
