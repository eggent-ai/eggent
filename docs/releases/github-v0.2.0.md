## Eggent v0.2.0 - Pi Runtime Workspace

### Highlights

- Pi SDK runtime powers project chat, model settings, tools, skills, MCP, and schedules.
- Project workspace UX now includes stronger files, context, memory, model, MCP, skills, Telegram, and API flows.
- Pipelines can run multi-step project-agent workflows with artifact handoff.
- Local voice transcription works through whisper.cpp for browser dictation and Telegram voice messages.
- Docker release hardening keeps the safe localhost bind default and pins whisper.cpp for reproducible ARM64 builds.

### Upgrade Notes

- No data migration is required.
- Schedules are now Pi-backed and stored under `.pi/subagent-schedules/` inside their context.
- Docker still binds to `127.0.0.1` by default. Use `APP_BIND_HOST=0.0.0.0` only when direct public exposure is intended.
- Provider credentials can be configured in the UI; `.env` is optional.

### Verification

- `npm run lint`
- `npx tsc --noEmit`
- `npm run build`
- Docker build smoke check

### Links

- Full notes: `docs/releases/0.2.0-pi-runtime-workspace.md`
- README: `README.md`
