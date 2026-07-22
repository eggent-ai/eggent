# Eggent

<p align="center">
  <a href="./docs/assets/eggent-banner.png">
    <img src="./docs/assets/eggent-banner.png" alt="Eggent banner" width="980" />
  </a>
</p>

<p align="center">
  <strong>Local-first AI workspace for project agents, files, pipelines, Telegram, and external API integrations.</strong>
</p>

Eggent is a browser-based AI workspace and orchestration layer. It gives you project-scoped agents, persistent files and memory, chat history, pasted image/file context, pipelines, Telegram integration, and a simple HTTP API for external systems.

The user-facing product is Eggent. Internally, Eggent uses an agent runtime and extension packages for model execution, tools, skills, MCP, scheduling, and web access.

---

## Contents

- [Highlights](#highlights)
- [Quick Start](#quick-start)
- [Docker / VPS Deploy](#docker--vps-deploy)
- [Core Concepts](#core-concepts)
- [External API](#external-api)
- [Other Useful APIs](#other-useful-apis)
- [Telegram](#telegram)
- [Local Voice Transcription](#local-voice-transcription)
- [Pipelines](#pipelines)
- [Files and Images](#files-and-images)
- [MCP, Skills, and Models](#mcp-skills-and-models)
- [Data Layout](#data-layout)
- [Environment Variables](#environment-variables)
- [Security Notes](#security-notes)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## Highlights

- **Project agents** — every project has its own instructions, files, memory, skills, MCP config, and model settings.
- **Local-first storage** — app data lives under `data/` and can be backed up as normal files.
- **Modern dashboard** — projects, files, settings, models, MCP, skills, schedules, API token management, Telegram, and pipelines.
- **Chat with context** — upload files, paste screenshots/images, and keep attachments tied to the chat.
- **Pipelines** — run multiple project agents in sequence with artifact handoff.
- **External API** — send messages from another service and preserve session/project/chat context between calls.
- **Telegram bot** — use Eggent from Telegram with formatted responses, voice message transcription, and progress updates during long runs.
- **Local voice input** — dictate in the Eggent chat UI or send Telegram voice messages; transcription runs locally via whisper.cpp.
- **Docker friendly** — optional `.env`, persistent volume, safe localhost bind by default.
- **Credentials in UI** — provider keys can be configured during onboarding/settings; `.env` is optional.

---

## Quick Start

### Requirements

- Node.js 20+
- npm
- Git

### One-command Docker install

```bash
curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh | bash
```

This clones/updates Eggent in `~/.eggent`, installs Docker if possible, builds the image, starts the container, and waits for `/api/health`.

Safe default:

```text
http://127.0.0.1:3000
```

For a VPS that should be reachable directly from the network, opt in explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh \
  | EGGENT_APP_BIND_HOST=0.0.0.0 bash
```

You can also override install location, branch, repo, and port:

```bash
EGGENT_INSTALL_DIR=/opt/eggent \
EGGENT_BRANCH=main \
APP_PORT=3000 \
EGGENT_APP_BIND_HOST=127.0.0.1 \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh)"
```

If the repository is private, use an authenticated GitHub session/token or clone manually and run `npm run setup:docker`.

### Local development

```bash
git clone https://github.com/eggent-ai/eggent.git
cd eggent
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

On first launch, configure login/model credentials in the UI. Provider API keys do not have to be placed in `.env`.

Optional local helper:

```bash
npm run setup:local
```

---

## Docker / VPS Deploy

### Run with Docker Compose

```bash
git clone https://github.com/eggent-ai/eggent.git
cd eggent
cp .env.example .env # optional
docker compose up -d --build
```

Docker mounts persistent data here:

```text
./data -> /app/data
```

### Important bind default

By default Eggent binds only to localhost:

```env
APP_BIND_HOST=127.0.0.1
APP_PORT=3000
```

This is intentional and safer for VPS installs behind a reverse proxy.

If you really want to expose the container directly:

```env
APP_BIND_HOST=0.0.0.0
APP_PORT=3000
APP_BASE_URL=https://your-domain.example
```

Then recreate:

```bash
docker compose up -d --build --force-recreate
```

For production, prefer Caddy/Nginx/Traefik with HTTPS and keep `APP_BIND_HOST=127.0.0.1`.

---

## Core Concepts

### Project

An Eggent project is a directory-backed agent configuration:

```text
data/projects/<projectId>/
  context.md    # project instructions/context
  memory.md     # project memory
  skills/       # project-local skills
  .mcp.json     # project MCP servers
  model.json    # project model override or inherited global model
```

When a project is selected, Eggent runs the agent with that project as context. Sidebar folder selection is UI-only and does not silently change the agent working directory.

### Chat

A chat stores messages, runtime stats, attached files, and the active project context. Uploaded and pasted chat files are exposed to the agent as readable context paths.

### Pipeline

A pipeline is a saved sequence of project-agent steps. Steps run top-to-bottom and can use artifacts from previous steps.

### Schedule

Schedules are surfaced in Eggent UI and stored in runtime schedule files. Current limitation: scheduled jobs run while the Eggent process is alive; automatic rehydration after restart is not fully implemented yet.

---

## External API

The External API is the recommended way to connect Eggent to other products: bots, CRMs, internal tools, websites, background jobs, no-code automations, and backend services.

It accepts a message, runs Eggent, and returns the final text reply. Eggent keeps external session state across calls: active project, active chat, and current path.

### Endpoint

```http
POST /api/external/message
Authorization: Bearer <external-api-token>
Content-Type: application/json
```

This endpoint does not require a browser login cookie, but it **always** requires a bearer token.

### Create an API token

Recommended:

1. Open Eggent.
2. Go to **Settings → API**.
3. Generate an External API token.
4. Store it in your external service as a secret.

Alternative server fallback:

```env
EXTERNAL_API_TOKEN=replace-with-a-long-random-token
```

A token generated in the UI is stored in `data/settings/` and takes precedence over `EXTERNAL_API_TOKEN`.

### Minimal curl example

```bash
curl -X POST http://localhost:3000/api/external/message \
  -H "Authorization: Bearer $EGGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "customer-42",
    "message": "Summarize what Eggent can do"
  }'
```

### Use a project by name

```bash
curl -X POST http://localhost:3000/api/external/message \
  -H "Authorization: Bearer $EGGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "telegram-user-123",
    "projectName": "Support Agent",
    "message": "Draft a reply asking the customer for logs"
  }'
```

### Use a project by id

```bash
curl -X POST http://localhost:3000/api/external/message \
  -H "Authorization: Bearer $EGGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "job:daily-report",
    "projectId": "research-agent",
    "message": "Read the project files and prepare a short report",
    "currentPath": "./"
  }'
```

`projectId` may be either the actual project id or an exact project name if it resolves to one project. Prefer `projectName` when passing names.

### JavaScript example

```ts
const response = await fetch("https://eggent.example.com/api/external/message", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.EGGENT_API_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    sessionId: "crm:customer-123",
    projectName: "Sales Assistant",
    message: "Write a concise follow-up email based on the latest notes.",
  }),
});

if (!response.ok) {
  throw new Error(await response.text());
}

const result = await response.json();
console.log(result.reply);
```

### Request body

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `sessionId` | Yes | string | Stable external session key. Use one per user, thread, customer, or job. |
| `message` | Yes | string | The task/message to send to Eggent. Must be non-empty. |
| `projectId` | No | string | Project id, or exact project name when unique. |
| `projectName` | No | string | Exact project name. Useful for readable integrations. |
| `chatId` | No | string | Existing Eggent chat id. Must match the same project context. Usually omit. |
| `currentPath` | No | string | Optional working path hint for file-oriented tasks. |

### Response body

```json
{
  "success": true,
  "sessionId": "customer-42",
  "reply": "Here is the answer...",
  "context": {
    "activeProjectId": "support-agent",
    "activeProjectName": "Support Agent",
    "activeChatId": "0a2f...",
    "currentPath": ""
  },
  "switchedProject": null,
  "createdProject": null
}
```

If Eggent switches or creates a project during the run, the response includes that information:

```json
{
  "switchedProject": {
    "toProjectId": "new-project-id",
    "toProjectName": "New Project"
  },
  "createdProject": {
    "id": "new-project-id",
    "name": "New Project"
  }
}
```

### How `sessionId` works

Eggent stores external session state by `sessionId`:

- active project;
- active chat for each project/orchestrator context;
- current path for each context.

Good session id examples:

```text
telegram:<user-id>
slack:<workspace-id>:<channel-id>:<thread-ts>
crm:<customer-id>
job:<workflow-id>
```

Reuse the same `sessionId` to continue the same external conversation.

### Common API errors

| Status | Meaning | Fix |
| --- | --- | --- |
| `400` | Missing `sessionId` or `message` | Send both as non-empty strings. |
| `401` | Missing/invalid bearer token | Check `Authorization: Bearer ...`. |
| `404` | Project or chat not found | Verify ids/names in the UI or `/api/projects`. |
| `409` | Ambiguous project name or chat/project mismatch | Use exact `projectId` or omit `chatId`. |
| `503` | External token is not configured | Generate token in Settings → API or set `EXTERNAL_API_TOKEN`. |

### Production integration tips

- Use HTTPS.
- Never expose the bearer token in frontend/browser code.
- Call Eggent from your backend, worker, or serverless function.
- Use one stable `sessionId` per real conversation/thread/job.
- Set a generous client timeout; complex agent runs can take minutes.
- The External API returns a final reply, not a streaming response.

---

## Other Useful APIs

Most dashboard APIs require an authenticated Eggent browser session. For server-to-server messaging, use `/api/external/message`.

### Health

```http
GET /api/health
```

### Projects

```http
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PUT    /api/projects/:id
DELETE /api/projects/:id
```

Create project payload:

```json
{
  "name": "Support Agent",
  "description": "Handles support drafts and triage",
  "instructions": "Be concise and ask for logs when needed.",
  "memoryMode": "global"
}
```

### Project configuration

```http
GET/PUT /api/projects/:id/context
GET/PUT /api/projects/:id/memory
GET/PUT /api/projects/:id/model
GET     /api/projects/:id/pi-config
GET/POST/DELETE /api/projects/:id/skills
GET/PUT /api/projects/:id/mcp
```

### Chat and chat files

```http
POST /api/chat              # streaming UI chat endpoint
GET  /api/chat/history
GET/POST/DELETE /api/chat/files
```

Upload a chat file:

```bash
curl -X POST http://localhost:3000/api/chat/files \
  -F "chatId=<chat-id>" \
  -F "file=@./screenshot.png"
```

### Project files

```http
GET  /api/files
GET  /api/files/content
GET  /api/files/download
POST /api/files/upload
```

Upload files to a project workspace:

```bash
curl -X POST http://localhost:3000/api/files/upload \
  -F "project=<project-id>" \
  -F "path=." \
  -F "files=@./notes.md"
```

### Pipelines

```http
GET    /api/pipelines
POST   /api/pipelines
GET    /api/pipelines/:id
PUT    /api/pipelines/:id
DELETE /api/pipelines/:id
GET    /api/pipeline-runs
GET    /api/pipeline-runs/:id
GET    /api/pipeline-runs/:id/artifacts
```

Example pipeline payload:

```json
{
  "name": "Research then Write",
  "description": "Collect context in one project, draft in another.",
  "steps": [
    {
      "id": "research",
      "name": "Research",
      "projectId": "research-agent",
      "prompt": "Research the topic and save useful findings as artifacts."
    },
    {
      "id": "draft",
      "name": "Draft",
      "projectId": "writing-agent",
      "prompt": "Use previous artifacts to write the final draft."
    }
  ]
}
```

### External token management

```http
GET  /api/external/token
POST /api/external/token
```

These are dashboard-authenticated. Use the Settings → API page unless you are automating with an authenticated session.

### Schedules

```http
GET /api/pi-schedules
```

Returns discovered schedule files across orchestrator/project contexts.

---

## Telegram

Eggent can connect to a Telegram bot and route messages into Eggent sessions.

Supported commands:

- `/start`
- `/help`
- `/code`
- `/new`

Telegram replies use safe HTML formatting for common Markdown patterns such as bold text, inline code, code blocks, and links. Long runs send typing actions and sparse progress messages so the bot does not feel stuck.

Voice messages are downloaded, saved into the active chat files, transcribed locally, and then sent into the same Eggent chat as a normal user message.

Configure in the UI or via env:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_DEFAULT_PROJECT_ID=
APP_BASE_URL=https://your-domain.example
```

---

## Local Voice Transcription

Eggent supports voice without external speech APIs.

Flow:

```text
Telegram voice / browser microphone
  -> save audio locally
  -> ffmpeg normalization
  -> local whisper.cpp transcription
  -> transcript becomes a normal Eggent message
```

Docker builds include `ffmpeg` and `whisper-cli`. The model is stored locally under:

```text
data/models/whisper/
```

By default Eggent uses `base` and downloads `ggml-base.bin` on first transcription if it is missing. This download is only for the model file; inference runs locally.

Useful env vars:

```env
EGGENT_STT_ENABLED=1
EGGENT_STT_MODEL=base
EGGENT_STT_LANGUAGE=auto
EGGENT_STT_AUTO_DOWNLOAD_MODEL=1
EGGENT_STT_KEEP_AUDIO=0
# EGGENT_STT_MODEL_PATH=/app/data/models/whisper/ggml-base.bin
# EGGENT_STT_BINARY=whisper-cli
# EGGENT_FFMPEG_BINARY=ffmpeg
```

For local non-Docker development, install `ffmpeg` and `whisper.cpp`, or set `EGGENT_STT_BINARY` to your `whisper-cli` path.

---

## Pipelines

Use pipelines when a task needs several project agents in a fixed order.

Examples:

- research → writing → review;
- backend → frontend → QA;
- support triage → draft response → final check;
- extraction → analysis → report.

Each step should set `projectId`. Artifacts from earlier steps are available to later steps.

---

## Files and Images

Eggent context can come from:

- project files;
- chat uploads;
- pasted screenshots/images;
- `context.md`;
- `memory.md`;
- pipeline artifacts.

Pasted images are stored as chat files and passed to the agent with file type and absolute path metadata.

---

## MCP, Skills, and Models

### MCP

Per-project MCP configuration:

```text
data/projects/<projectId>/.mcp.json
```

Manage it from the dashboard MCP pages.

### Skills

Project-local skills:

```text
data/projects/<projectId>/skills/<skill-name>/SKILL.md
```

Eggent core does not ship a built-in skill catalog. Deployments may provide an optional `bundled-skills/` directory at runtime; when present, those skills appear in the dashboard and can be copied into a project.

### Models

Project model configuration:

```text
data/projects/<projectId>/model.json
```

Model credentials can be configured in the UI. Environment provider keys are optional fallback credentials.

---

## Data Layout

```text
data/
  settings/      # auth secret, external API token, app settings
  projects/      # project workspaces and project config
  chats/         # chat history
  chat-files/    # uploaded/pasted chat attachments
  memory/        # memory namespaces
  pipelines/     # pipeline definitions, runs, artifacts
  pi-agent/      # embedded runtime config in Docker by default
```

Back up `data/` before upgrades or migrations.

---

## Environment Variables

See `.env.example` for the full list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_BIND_HOST` | `127.0.0.1` | Docker host bind. Use `0.0.0.0` only intentionally. |
| `APP_PORT` | `3000` | Docker host port. |
| `APP_BASE_URL` | `http://localhost:3000` | Public URL for integrations/webhooks. |
| `EGGENT_AUTH_SECRET` | generated in `data/settings/auth-secret` | App auth signing secret. |
| `EXTERNAL_API_TOKEN` | unset | Optional fallback token for `/api/external/message`. |
| `TELEGRAM_BOT_TOKEN` | unset | Telegram bot token. |
| `TELEGRAM_WEBHOOK_SECRET` | unset | Optional Telegram webhook secret. |
| `TELEGRAM_DEFAULT_PROJECT_ID` | unset | Default project for Telegram. |
| `EGGENT_STT_ENABLED` | `1` | Enable local speech transcription. |
| `EGGENT_STT_MODEL` | `base` | whisper.cpp ggml model name: `tiny`, `base`, `small`, `medium`. |
| `EGGENT_STT_AUTO_DOWNLOAD_MODEL` | `1` | Download missing ggml model on first use. |
| `EGGENT_STT_KEEP_AUDIO` | `0` | Keep temporary normalized audio/transcript files. |
| `PI_CODING_AGENT_DIR` | Docker: `/app/data/pi-agent` | Runtime config directory. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY` | unset | Optional provider fallback keys. |

---

## Security Notes

- Keep Docker bound to `127.0.0.1` when using a reverse proxy.
- Use HTTPS for public deployments.
- Treat External API tokens like passwords.
- Do not expose bearer tokens in browser/frontend code.
- Back up and protect `data/`; it contains chats, files, memory, settings, and tokens.

---

## Development

```bash
npm install
npm run dev
npm run lint
npm run build
```

Useful paths:

```text
src/app/dashboard/       # dashboard pages
src/app/api/             # API routes
src/components/chat/     # chat UI
src/components/ui/       # shared UI primitives
src/lib/pi/              # agent runtime integration
src/lib/pipelines/       # pipeline store/runner
src/lib/telegram/        # Telegram integration
src/lib/storage/         # filesystem-backed stores
```

---

## Troubleshooting

### I cannot access Docker from another machine

Default bind is localhost. Use a reverse proxy or set:

```env
APP_BIND_HOST=0.0.0.0
```

### External API returns `503`

No External API token is configured. Generate one in Settings → API or set `EXTERNAL_API_TOKEN`.

### External API returns `409`

The project name is ambiguous or the supplied `chatId` belongs to another project. Use exact `projectId` or omit `chatId`.

### The agent does not see a file

Make sure the file is uploaded/pasted into the active chat or stored inside the selected project workspace.

### Telegram feels silent during long runs

Check bot configuration and polling/webhook status in the dashboard. Eggent sends typing actions and progress updates during long runs.

### Schedules after restart

Runtime schedule files are stored under `.pi/subagent-schedules/` inside each context, but automatic rehydration after process restart is still limited.

---

## License

MIT License. See [LICENSE](./LICENSE).
