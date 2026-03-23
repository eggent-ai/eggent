# Changelog

All notable changes to this project will be documented in this file.

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
