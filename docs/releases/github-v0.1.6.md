## Eggent v0.1.6 - Telegram Long Polling

Patch release focused on making Telegram integration usable without a public HTTPS webhook.

### Highlights

- Added Telegram long polling support with status/start/stop API controls.
- Shared Telegram update handling between webhook and polling modes.
- Added Telegram connection modes: `auto`, `webhook`, and `polling`.
- Auto mode now chooses polling for local, private, or non-HTTPS URLs.
- Moved Telegram lifecycle startup into Next.js instrumentation so polling can resume on server startup.
- Stopped polling during Telegram disconnect.
- Updated installation documentation for Docker, local Node.js, development, and PM2 setups.
- Version bump to `0.1.6` across package metadata and `GET /api/health`.

### Upgrade Notes

- No migration required.
- Existing webhook configurations continue to work.
- Use `Auto` or `Long Polling` for installs without a public HTTPS URL.

### Links

- Full release snapshot: `docs/releases/0.1.6-telegram-long-polling.md`
- Installation and update guide: `README.md`
