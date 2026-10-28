# Eggent

<p align="center">
  <a href="./docs/assets/eggent-banner.png">
    <img src="./docs/assets/eggent-banner.png" alt="Eggent banner" width="980" />
  </a>
</p>

<p align="center">
  <strong>Local-first AI workspace for project agents, files, a task board, Telegram, and external API integrations.</strong><br />
  <strong>Current version: <a href="https://github.com/eggent-ai/eggent/releases/latest">0.8.0</a></strong>
</p>

Eggent is a browser-based AI workspace and orchestration layer. It gives you project-scoped agents, persistent files and memory, chat history, pasted image/file context, a task board, Telegram integration, and a simple HTTP API for external systems.

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
- [Email](#email)
- [Local Voice Transcription](#local-voice-transcription)
- [Task Board](#task-board)
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
- **Modern dashboard** — projects, files, settings, models, MCP, skills, schedules, API token management, Telegram, and the task board.
- **Chat with context** — upload files, paste screenshots/images, and keep attachments tied to the chat.
- **Task board** — hand work to the agent as cards; each runs in a chat of its own, can wait for other cards, and is moved by how its run ended.
- **File history** — every change to a text file or document in a project is kept as a version you can compare and restore, with who made it.
- **Pages and code** — an HTML file opens as it looks: pick its blocks for the agent, change its words in place, save it as PDF; code opens in an editor.
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
curl -fsSL https://get.eggent.ai | bash
```

This clones/updates Eggent in `~/.eggent`, installs Docker if possible, builds the image, starts the container, and waits for `/api/health`.

Safe default:

```text
http://127.0.0.1:3000
```

For a VPS that should be reachable directly from the network, opt in explicitly:

```bash
curl -fsSL https://get.eggent.ai \
  | EGGENT_APP_BIND_HOST=0.0.0.0 bash
```

You can also override install location, branch, repo, and port:

```bash
EGGENT_INSTALL_DIR=/opt/eggent \
EGGENT_BRANCH=main \
APP_PORT=3000 \
EGGENT_APP_BIND_HOST=127.0.0.1 \
bash -c "$(curl -fsSL https://get.eggent.ai)"
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

On first launch, sign in with `admin` / `admin`; you are asked to replace that login at once, then to pick a model. Provider API keys do not have to be placed in `.env`.

Optional local helper:

```bash
npm run setup:local
```

---

## Docker / VPS Deploy

### Run the published image

Nothing to clone and nothing to build. Take `docker-compose.ghcr.yml` on its
own - paste it into Portainer, or drop it on a VPS - and start it:

```bash
curl -O https://raw.githubusercontent.com/eggent-ai/eggent/main/docker-compose.ghcr.yml
docker compose -f docker-compose.ghcr.yml up -d
```

Images are published to `ghcr.io/eggent-ai/eggent` on every release. Pin one
with `EGGENT_VERSION` in `.env` (for example `EGGENT_VERSION=0.2.4`) rather than
tracking `latest`.

### Build from source

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

A reverse proxy also caps request bodies, and its cap is usually smaller than Eggent's: nginx allows 1 MB by default, so file uploads larger than that fail with `413` before they reach the app. Raise it to Eggent's 100 MB upload limit (`client_max_body_size 100m;` in nginx, `request_body { max_size 100MB }` in Caddy).

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

### Orchestrator

The orchestrator is the agent that answers when no project is selected. It is configured the same way, in its own working directory:

```text
data/projects/
  context.md    # orchestrator instructions/context
  memory.md     # orchestrator memory
  skills/       # orchestrator-local skills
  .mcp.json     # orchestrator MCP servers
  <projectId>/  # projects it coordinates
```

Its files sit next to the project directories, so the orchestrator can coordinate projects while keeping its own configuration separate from each of them. Context, memory tools, Pi skill discovery, `/skill:*` commands, bundled skill installation, and MCP servers all use this scope whenever no project is selected. The orchestrator has no `model.json`: it answers on the workspace default model.

### Chat

A chat stores messages, runtime stats, attached files, and the active project context. Uploaded and pasted chat files are exposed to the agent as readable context paths.

### Card

A card on the task board is a chat with a place in a queue. It is carried out by the same runner as every other turn, can wait for other cards and starts with their results, and the host moves it from how its run ended: done, waiting for your review, a question, a failure (retried once), a stall, a stop.

### Schedule

Schedules are surfaced in Eggent UI and stored in runtime schedule files. They are armed inside the running Eggent process and armed again when it starts; a run that falls due while the process is down is not replayed.

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
GET  /api/files/zip        # a folder (?path=) or several files (repeat ?path=) as one .zip
POST /api/files/upload
```

Upload files to a project workspace:

```bash
curl -X POST http://localhost:3000/api/files/upload \
  -F "project=<project-id>" \
  -F "path=." \
  -F "files=@./notes.md"
```

`conflict` decides what happens when the name is already taken: `skip` (the
default) leaves the existing file alone and reports the name back, `overwrite`
replaces it, and `rename` writes `notes (1).md` beside it.

```bash
curl -X POST http://localhost:3000/api/files/upload \
  -F "project=<project-id>" \
  -F "path=." \
  -F "conflict=rename" \
  -F "files=@./notes.md"
```

A whole folder goes in the same request: `relativePaths` says where each file
should land, pairing with `files` by position, and `directories` names the
folders to create - which is how an empty one survives the trip.

```bash
curl -X POST http://localhost:3000/api/files/upload \
  -F "project=<project-id>" \
  -F "path=." \
  -F "directories=docs/drafts" \
  -F "files=@./intro.md" -F "relativePaths=docs/intro.md" \
  -F "files=@./api.md" -F "relativePaths=docs/drafts/api.md"
```

Requests larger than 100 MB are rejected with `413` before the body is read. The
limit bounds a request rather than an upload: the dashboard sends a folder as
however many requests it takes to stay under it, so a folder larger than the
limit still uploads.

### Task board

```http
GET    /api/board                    # every card and the board's state (?archived=1 for put-away cards)
POST   /api/board/cards              # { title, body, projectId, after, review, start }
GET    /api/board/cards/:id
PATCH  /api/board/cards/:id          # edit it, or { move: { to, position } }
DELETE /api/board/cards/:id
POST   /api/board/cards/:id/stop
POST   /api/board/cards/:id/answer   # { text } answers the question on a card
POST   /api/board/start-all          # starts the inbox, optionally { projectId }
POST   /api/board/resume             # after the board paused itself
GET    /api/board/summary
```

These are dashboard routes: they take the signed-in session, a request from the same site and JSON bodies. Without `start` a new card waits in the inbox; `after` lists the cards it waits for.

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
- `/chats` - recent chats
- `/reset` - stop an answer that seems stuck, keeping the conversation
- `/files` - send the files the last answer made

A message that starts with `@` and a project's name hands the task to that project.

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

## Email

The agent can send email with the `eggent_email` tool when the deployment gives it a way to. On a server of your own that is your mail server:

```env
EGGENT_SMTP_URL=smtps://login:password@smtp.example.test:465
EGGENT_EMAIL_FROM="Assistant <assistant@example.test>"
EGGENT_EMAIL_OWNER=you@example.test
```

- `send_email` without a recipient writes to `EGGENT_EMAIL_OWNER` at once.
- A letter to anybody else needs your yes in the chat first. Where nobody can answer - Telegram, the external API, a schedule - such a letter is refused.
- **That yes is advice, not a lock.** The agent runs with a shell in this same environment and can read `EGGENT_SMTP_URL`, login included, so a determined or misled agent can send mail without the tool. Use a mailbox made for the agent, with sending limits of its own, rather than your personal one.
- There is no inbox on a server of your own: letters are only sent, and listed in `data/email/sent.jsonl`.

A hosted deployment can give each workspace a mailbox of its own instead (`EGGENT_EMAIL_API_URL`, `EGGENT_EMAIL_ADDRESS`, with the workspace's services token). There, letters to other people wait for the owner outside the workspace, letters that come in are kept by the service, and the workspace keeps its own list of them in `data/email/`. Whatever a letter says reaches the agent as information, never as instructions, and no letter starts a turn by itself.

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

## Task Board

Hand work to the agent as cards (**Board** in the sidebar): inbox, queue, working, waiting for you, done. Each card is carried out in a chat of its own, so it can be watched live, stopped and resumed after a restart, and the host reads how its run ended instead of waiting for the agent to say it is done. The agent can propose cards; only you start them.

A card can wait for others and starts with what they came to, which covers work that needs several projects in order:

- research → writing → review;
- backend → frontend → QA;
- support triage → draft response → final check;
- extraction → analysis → report.

At most 3 cards run at once and 1 per project, since cards in a project share its folder (`EGGENT_BOARD_MAX_RUNNING`, `EGGENT_BOARD_MAX_PER_PROJECT`); `EGGENT_BOARD=off` stops the board starting anything.

---

## Files and Images

Eggent context can come from:

- project files;
- chat uploads;
- pasted screenshots/images;
- `context.md`;
- `memory.md`;
- the file open beside the chat, and the lines selected in it.

Pasted images are stored as chat files and passed to the agent with file type and absolute path metadata.

Files already on your machine go into a project workspace from the Files panel,
the file tree opened from the header. Every folder in the tree carries two buttons: one opens a file
picker, the other a folder picker that takes the whole tree underneath it,
however deep, and rebuilds it in the workspace. Files and folders can also be
dropped onto a folder, which does the same thing.

A folder is sent as several requests, each under the 100 MB limit, so its
size is not capped by that limit - only each file in it is. Folder pickers are a
desktop-browser feature: where the browser has none (iOS Safari), the button
falls back to picking files.

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
  board/         # task board cards and state
  versions/      # file history: versions of project files
  email/         # the agent's letters: their list, the files they brought, what was sent
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
| `EGGENT_SMTP_URL` | unset | The agent's email through your own mail server (`smtp://` or `smtps://`, login inside). See [Email](#email). |
| `EGGENT_EMAIL_FROM` | unset | The address the agent's letters come from. |
| `EGGENT_EMAIL_OWNER` | unset | Your own address: where `send_email` writes without a recipient. |
| `EGGENT_STT_ENABLED` | `1` | Enable local speech transcription. |
| `EGGENT_STT_MODEL` | `base` | whisper.cpp ggml model name: `tiny`, `base`, `small`, `medium`. |
| `EGGENT_STT_AUTO_DOWNLOAD_MODEL` | `1` | Download missing ggml model on first use. |
| `EGGENT_STT_KEEP_AUDIO` | `0` | Keep temporary normalized audio/transcript files. |
| `PI_CODING_AGENT_DIR` | Docker: `/app/data/pi-agent` | Runtime config directory. |
| `EGGENT_VERSION` | `latest` | Image tag used by `docker-compose.ghcr.yml`. |
| `HTTPS_PROXY` / `HTTP_PROXY` | unset | Send outbound traffic through an egress proxy. `NO_PROXY` is honoured. Needs Node 22.23 or newer. |
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
src/lib/board/           # task board store and dispatcher
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
