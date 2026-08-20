## Eggent v0.2.1 - Published Image and Model Recovery

Eggent can now be deployed from a published container image instead of a local build, and a workspace can always find its way back to a working model.

### Highlights

- **Published container image.** `ghcr.io/eggent-ai/eggent`, with `docker-compose.ghcr.yml` that pulls instead of building - paste it into Portainer or drop it on a host. linux/amd64 for now.
- **Outbound proxy support.** `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are honoured, so a deployment behind a mandatory egress proxy works: provider calls, Telegram polling and the web tools alike.
- **Coming back to the included model repairs its configuration**, instead of leaving a workspace with a valid credential and no model to run it on.
- **A failing provider says what is actually wrong** - a dead address, a rejected key, or a model id the provider does not have, naming the ones it does.
- **Telegram project switching works**, and an attachment no longer silently binds the session to an arbitrary project.
- **Schedules survive a restart**, and editing one re-arms it.
- **The workspace itself has context, memory, skills and MCP**, so there is somewhere to work before a project exists.

### Platform Coverage

- Dashboard: settings screen states what is connected; a finished file can be opened, not only downloaded; stopped turns keep their work; quick-start cards on an empty chat.
- API: `?raw=1` returns the file on disk; external project switch/create signals persist.
- Integrations: channel publishing, images sent as images, bot connect completes, delivery outlives the request that started it.

### Upgrade Notes

- Compatibility: no data migration is required.
- Migration: none. Sessions holding a valid project keep it.
- Operational changes: Docker still binds `127.0.0.1` by default. Use `docker-compose.ghcr.yml` with `EGGENT_VERSION` to run a pinned published image. Proxy support needs Node 22.23 or newer; on older runtimes the startup log says so and the workspace still starts. Workspace-level context, memory, skills and MCP live in `data/projects/`.

### Thanks

- @nimph977 for #19, #20 and #21 - three verified reports from a self-hosted deployment, one with a patch.
- @nekufa for #17, which turned out to be the missing release pipeline.

### Links

- Full notes: `docs/releases/0.2.1-published-image-and-model-recovery.md`
- README: `README.md`
