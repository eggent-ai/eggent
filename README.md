# Eggent

<p align="center">
  <a href="./docs/assets/eggent-banner.png">
    <img src="./docs/assets/eggent-banner.png" alt="Eggent banner" width="980" />
  </a>
</p>

Eggent is a local-first AI workspace and orchestration layer for **pi SDK agents**.

Eggent provides the browser UI, APIs, project configuration, persistent storage, and multi-agent pipelines. The actual agent runtime — model loop, tools, skills, session behavior, compaction, retry, and execution events — is powered by [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

In the current architecture:

```text
Eggent UI + API
  -> Eggent project config
  -> pi SDK AgentSession
  -> pi tools / skills / sessions / model runtime
```

The most important concept:

```text
Eggent Project = a directory-backed pi Agent configuration
Eggent Pipeline = sequence of Eggent Projects
```

Every project directory contains the runtime files Eggent exposes in the UI:

```text
data/projects/<projectId>/
  context.md    # pi agent instructions/context
  memory.md     # plain Markdown persistent memory
  skills/       # project-local Agent Skills
  mcp.json      # project-local MCP servers
  cron.json     # scheduled project-agent turns
  model.json    # project model override or global inheritance
```

RAG/knowledge ingestion has been removed. Pipelines and agents pass long-lived state through project files, `memory.md`, and pipeline artifacts.

---

## What Eggent Does

Eggent is responsible for:

- a convenient chat UI for pi agents;
- directory-backed project/agent configuration;
- project-local context files, memory files, skills, MCP servers, cron, and model settings;
- persistent chat and pi session storage;
- external/Telegram/cron entrypoints;
- multi-agent pipelines with artifact handoff;
- project and pipeline management APIs.

pi SDK is responsible for:

- the agent loop;
- tool calling;
- skill loading and activation;
- context files;
- model resolution;
- retries and compaction;
- session lifecycle;
- streaming events.

---

## Core Architecture

```text
User
  -> Eggent Chat UI
  -> POST /api/chat
  -> createPiChatUIMessageStream()
  -> createEggentPiSession()
  -> pi AgentSession.prompt()
  -> pi events
  -> Eggent UI stream
```

Main files:

```text
src/app/api/chat/route.ts         # Main chat API; pi backend by default
src/lib/pi/session.ts             # Builds pi AgentSession from Eggent project config
src/lib/pi/chat-runner.ts         # Streams pi events to Eggent UI and stores messages
src/lib/pi/eggent-tools.ts        # Eggent bridge tools exposed to pi
src/lib/pi/project-config.ts      # Introspection of project -> pi config
src/lib/pipelines/runner.ts       # Sequential project-agent pipeline runner
```

Legacy Eggent agent code still exists as a fallback, but it is no longer the default runtime.

To force the old runtime:

```bash
EGGENT_AGENT_BACKEND=legacy npm run dev
```

Without that variable, `/api/chat` runs through pi SDK.

---

## Eggent Projects Are pi Agent Configs

An Eggent project is now a full configuration for a pi agent.

A project can define:

| Eggent Project Setting | How it reaches pi |
| --- | --- |
| Project instructions | Injected as a virtual pi context file |
| Project files | Used as pi `cwd` |
| Project skills | Passed as pi `additionalSkillPaths` |
| Project MCP servers | Exposed as `eggent_mcp_*` tools |
| Project memory file | Exposed as `eggent_memory_*` tools over `memory.md` |
| | Project model settings | Resolved through pi `ModelRegistry` where possible |

Project data lives under:

```text
data/projects/<projectId>/
  context.md
  memory.md
  skills/
  mcp.json
  cron.json
  model.json
```

When a project is launched as an agent, Eggent builds a pi session with that project as the runtime context.

---

## Project Context Injection

Project instructions are converted into a virtual context file for pi.

Conceptually:

```text
context.md
```

It contains:

```text
# Eggent project context

This Eggent project is the configuration for the current pi agent.

Project id: ...
Project name: ...
Project description: ...
Working directory: ...
Memory namespace: ...

Project instructions:
...

Available Eggent bridge tools:
- eggent_memory_search / eggent_memory_save / eggent_memory_delete
- eggent_mcp_*
- eggent_list_pipelines / eggent_start_pipeline
```

This lets pi treat each Eggent project as a proper agent environment.

---

## Skills

Eggent skills are project-local pi skills.

They are stored as Agent Skills-compatible directories:

```text
data/projects/<projectId>/skills/<skill-name>/SKILL.md
```

When a project is launched, Eggent passes those `SKILL.md` files into pi as additional skill paths.

You can manage skills from the Eggent UI, but the runtime behavior is pi's skill system.

---

## MCP

MCP servers are configured per Eggent project:

```text
data/projects/<projectId>/mcp.json
```

When that project runs as a pi agent, Eggent connects to the configured MCP servers and exposes their tools to pi as bridge tools:

```text
eggent_mcp_<serverId>_<toolName>
```

Example:

```text
eggent_mcp_notion_search
eggent_mcp_crm_get_contact
eggent_mcp_signature_send
```

pi can also configure project MCP via tools:

```text
upsert_mcp_server
delete_mcp_server
```

---

## Memory

Eggent memory is exposed to pi through bridge tools:

```text
eggent_memory_save
eggent_memory_search
eggent_memory_delete
```

Memory storage remains local under:

```text
data/memory/
```

Project memory behavior:

| Project memory mode | Namespace |
| --- | --- |
| `isolated` | `data/memory/<projectId>/` |
| `global` | `data/memory/main/` |

So memory is still stored and indexed by Eggent, but accessed by pi.

---

## Knowledge / RAG

RAG has been removed from Eggent. Use project files, `memory.md`, skills, MCP tools, and pipeline artifacts instead.

---

## Eggent Bridge Tools Exposed to pi

When a pi agent is created by Eggent, it receives Eggent bridge tools such as:

```text
list_projects
create_project
switch_project

create_skill

upsert_mcp_server
delete_mcp_server

eggent_memory_save
eggent_memory_search
eggent_memory_delete


eggent_list_pipelines
eggent_start_pipeline

eggent_mcp_*
```

This means pi can manage Eggent configuration through normal tool calls.

Example user request:

```text
Create a new agent for NDA review with a legal-review skill and a signature MCP server.
```

The pi agent can call:

```text
create_project
create_skill
upsert_mcp_server
```

---

## Chat Sessions

Eggent stores chat messages for UI rendering under:

```text
data/chats/
```

pi sessions are persisted separately under:

```text
data/pi-sessions/
```

This gives Eggent a UI-friendly chat history while preserving pi's own session lifecycle and context handling.

---

## Pipelines

A pipeline is a sequence of Eggent projects.

Because each Eggent project is a pi agent configuration, a pipeline is effectively a sequence of pi agents.

```text
Pipeline
  -> Project A as pi agent
  -> Project B as pi agent
  -> Project C as pi agent
```

Pipeline steps look like:

```json
{
  "id": "review",
  "name": "Review NDA",
  "projectId": "nda-reviewer",
  "instructions": "Read nda-draft.md and save nda-reviewed.md."
}
```

The `projectId` is the key field: it tells Eggent which project/pi-agent config to launch for that step.

---

## Pipeline Handoff Model

Agents in a pipeline pass information through artifacts, not through one huge chat context.

Each run gets:

```text
data/pipeline-runs/run_xxx/
  run.json
  artifacts/
```

A typical NDA pipeline might create:

```text
data/pipeline-runs/run_xxx/artifacts/
  nda-draft.md
  nda-reviewed.md
  nda-review.md
  signers.json
  send-package.md
  send-result.json
```

This lets pipelines scale to many agents because each agent can read and write files instead of carrying the entire history in model context.

---

## Pipeline UI

Pipeline management is available at:

```text
/dashboard/pipelines
```

Run details are available at:

```text
/dashboard/pipeline-runs/<runId>
```

The UI supports:

- pipeline definitions;
- JSON step editing;
- generating a pipeline from current projects;
- starting runs;
- run status;
- per-step project/agent status;
- artifact listing;
- artifact preview;
- continue/retry.

---

## Pipeline APIs

```text
GET    /api/pipelines
POST   /api/pipelines
GET    /api/pipelines/[id]
PUT    /api/pipelines/[id]
DELETE /api/pipelines/[id]

GET    /api/pipeline-runs
POST   /api/pipeline-runs
GET    /api/pipeline-runs/[id]
POST   /api/pipeline-runs/[id]

GET    /api/pipeline-runs/[id]/artifacts
GET    /api/pipeline-runs/[id]/artifacts?path=<artifactPath>
```

Project-to-pi introspection:

```text
GET /api/projects/[id]/pi-config
```

---

## Example: NDA Workflow

A good NDA workflow is now modeled as multiple projects:

```text
nda-drafter      # drafts the document
nda-reviewer     # checks legal consistency
signers-agent    # identifies signers and signing order
send-agent       # sends or prepares send package
```

Each project has its own directory-backed files:

```text
context.md
memory.md
skills/
mcp.json
cron.json
model.json
regular project files
```

The pipeline is just the sequence:

```json
{
  "id": "nda-send",
  "name": "Send NDA",
  "steps": [
    {
      "id": "draft",
      "name": "Draft NDA",
      "projectId": "nda-drafter",
      "instructions": "Create nda-draft.md."
    },
    {
      "id": "review",
      "name": "Review NDA",
      "projectId": "nda-reviewer",
      "instructions": "Review nda-draft.md and create nda-reviewed.md."
    },
    {
      "id": "signers",
      "name": "Collect Signers",
      "projectId": "signers-agent",
      "instructions": "Create signers.json."
    },
    {
      "id": "send",
      "name": "Send NDA",
      "projectId": "send-agent",
      "instructions": "Send or prepare the signature package."
    }
  ]
}
```

---

## Releases

- Latest release snapshot: [0.1.6 - Telegram Long Polling](./docs/releases/0.1.6-telegram-long-polling.md)
- GitHub release body: [v0.1.6](./docs/releases/github-v0.1.6.md)
- Release archive: [docs/releases/README.md](./docs/releases/README.md)

---

## Installation

Choose the deployment method that best fits your needs:

| Method | Best For | Command |
| --- | --- | --- |
| **Docker** (One-command) | Fastest setup, VPS, production | `curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh \| bash` |
| **Docker** (Manual) | Containerized runtime, full control | `npm run setup:docker` |
| **Local/Node.js** | Run directly on your machine | `npm run setup:local` |
| **Development** | Active development, hot reload | `npm run dev` |

---

## Docker Deployment

### Option A: One-command Installer

```bash
curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh | bash
```

What it does:

- installs Docker best-effort on macOS/Linux if missing;
- clones/updates Eggent in `~/.eggent`;
- runs Docker deployment via `scripts/install-docker.sh`.

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `EGGENT_INSTALL_DIR` | `~/.eggent` | Target directory |
| `EGGENT_BRANCH` | `main` | Git branch to use |
| `EGGENT_REPO_URL` | `https://github.com/eggent-ai/eggent.git` | Repository URL |
| `EGGENT_AUTO_INSTALL_DOCKER` | `1` | Auto-install Docker if missing |
| `EGGENT_APP_BIND_HOST` | `0.0.0.0` on Linux / `127.0.0.1` elsewhere | Docker bind host |

Example:

```bash
EGGENT_INSTALL_DIR=~/apps/eggent \
EGGENT_BRANCH=main \
EGGENT_AUTO_INSTALL_DOCKER=1 \
curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh | bash
```

Open:

```text
http://localhost:3000
```

On Linux/VPS, the one-command installer publishes the app on all interfaces by default.

### Option B: Manual Docker Setup

```bash
npm run setup:docker
```

Useful commands:

```bash
docker compose logs -f app
docker compose restart app
docker compose down
docker compose up -d app
```

---

## Local/Node.js Deployment

```bash
npm run setup:local
npm run start
```

Open:

```text
http://localhost:3000
```

Manual setup:

```bash
cp .env.example .env
npm install
npm run build
npm run start
```

---

## Development

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

Development scripts:

```bash
npm run lint
npm run build
```

`npm run build` intentionally uses webpack (`next build --no-lint`), not Turbopack. Turbopack can hard-fail on out-of-root symlinks in `data/` project virtual environments.

---

## Updating Eggent

Back up before updating:

```text
.env
data/
```

One-command installer users can rerun:

```bash
curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh | bash
```

Manual repo update:

```bash
git pull --ff-only origin main
npm install
npm run build
npm run start
```

Health check:

```bash
curl http://localhost:3000/api/health
```

---

## Runtime Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build |
| `npm run start` | Production server |
| `npm run lint` | ESLint |
| `npm run setup:one` | One-command installer wrapper |
| `npm run setup:local` | Local production bootstrap |
| `npm run setup:docker` | Docker production bootstrap |

---

## Configuration

Base flow:

```bash
cp .env.example .env
```

Main environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | No | Optional pi OpenAI provider key; can also be stored in pi `auth.json` |
| `ANTHROPIC_API_KEY` | No | Optional pi Anthropic provider key; can also be stored in pi `auth.json` |
| `GOOGLE_API_KEY` | No | Optional pi Google provider key; can also be stored in pi `auth.json` |
| `OPENROUTER_API_KEY` | No | Optional pi OpenRouter provider key; can also be stored in pi `auth.json` |
| `TAVILY_API_KEY` | No | Web search integration |
| `EXTERNAL_API_TOKEN` | No, auto-generated by setup scripts | External message API auth token |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `TELEGRAM_WEBHOOK_SECRET` | No, auto-generated by setup scripts | Telegram webhook secret |
| `TELEGRAM_DEFAULT_PROJECT_ID` | No | Default project/pi-agent config for Telegram |
| `TELEGRAM_ALLOWED_USER_IDS` | No | Comma/space separated Telegram `user_id` allowlist |
| `APP_BASE_URL` | Recommended | Public app URL used by integrations |
| `APP_BIND_HOST` | No | Docker port bind host |
| `APP_PORT` | No | Published app port; default `3000` |
| `APP_TMP_DIR` | No | Docker temp directory passed as `TMPDIR` |
| `PLAYWRIGHT_BROWSERS_PATH` | No | Browser install/cache path |
| `NPM_CONFIG_CACHE` | No | npm cache directory |
| `XDG_CACHE_HOME` | No | Generic CLI cache directory |
| `CODEX_AUTH_FILE` | No | Explicit path to Codex OAuth file |
| `GEMINI_OAUTH_CREDS_FILE` | No | Explicit path to Gemini OAuth creds file |
| `GEMINI_SETTINGS_FILE` | No | Explicit path to Gemini settings file |
| `EGGENT_AGENT_BACKEND` | No | Set to `legacy` to use old Eggent agent instead of pi |

Model connections are owned by pi, not by Eggent. Use Eggent Settings as a UI for pi `~/.pi/agent/auth.json` and `~/.pi/agent/models.json`, or configure pi directly with `/login`, environment variables, or custom `models.json`.

---

## Data Persistence

Runtime state lives in `./data`.

Important directories:

```text
data/chats/             # Eggent UI chat history
data/pi-sessions/       # pi session files per Eggent chat / pipeline step
data/projects/          # Eggent projects = pi agent configs
data/projects/<id>/memory.md # plain Markdown project memory
data/pipelines/         # pipeline definitions
data/pipeline-runs/     # pipeline runs and artifacts
data/settings/          # app settings
data/integrations/      # integration state
```

Docker mounts `./data` into `/app/data`.

Back up `data/` and `.env` for disaster recovery.

---

## Security Defaults

Docker defaults are security-oriented:

- default bind: `127.0.0.1:${APP_PORT:-3000}:3000` unless configured otherwise;
- non-root container user (`node`);
- `node` user has passwordless `sudo` in the container for AI-driven package installation.

Project-local skills, MCP servers, and files can influence agent behavior. Treat project configuration as trusted workspace configuration.

---

## Health Check

```bash
curl http://localhost:3000/api/health
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "...",
  "version": "..."
}
```

---

## VPS Production Checklist

1. Configure at least one pi model connection in Eggent Settings, pi `/login`, `~/.pi/agent/auth.json`, or environment variables.
2. Change default dashboard credentials immediately after first login.
3. If using Telegram/webhooks, set public HTTPS `APP_BASE_URL`.
4. Keep `data/` persistent and writable.
5. Ensure outbound network access to provider APIs and MCP services.
6. Back up `data/` and `.env`.

---

## Troubleshooting

### App works on `localhost` but not on `127.0.0.1`

Use one host consistently. Browser storage/cookies are origin-scoped.

### Docker container does not become healthy

```bash
docker compose logs --tail 200 app
```

Verify `.env` values and pi model connections.

### pi model/provider cannot authenticate

Check that a provider key is configured through pi. Eggent Settings edits pi `auth.json` and `models.json` directly. You can also use pi CLI `/login` or environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`.

### Pipeline step does not use the expected agent

Check the pipeline step has the correct `projectId`:

```json
{
  "projectId": "my-agent-project"
}
```

Then inspect:

```text
GET /api/projects/<projectId>/pi-config
```

### MCP tool is missing in chat

Verify project MCP config:

```text
data/projects/<projectId>/mcp.json
```

Then restart the chat/session. MCP tools appear as:

```text
eggent_mcp_<serverId>_<toolName>
```

### Skill is not being used

Verify the skill has a valid `SKILL.md`:

```text
data/projects/<projectId>/skills/<skill-name>/SKILL.md
```

The skill must have valid frontmatter with a name and description.

### Build fails after dependency changes

```bash
npm install
npm run build
```

### Turbopack fails on symlinks in `data/`

Use the configured build script:

```bash
npm run build
```

It uses webpack instead of Turbopack.

### Docker permissions issues

Try with `sudo docker ...` or add your user to the `docker` group.

### `python3`, `curl`, `git`, `jq`, or `rg` missing

Install recommended CLI utilities:

```bash
sudo apt-get update && sudo apt-get install -y python3 curl git jq ripgrep
```

---

## Project Layout

```text
src/app/                 # Next.js routes and API endpoints
src/components/          # UI components
src/lib/pi/              # Eggent -> pi SDK integration
src/lib/pipelines/       # Pipeline definitions, storage, runner
src/lib/storage/         # Disk stores for projects, chats, settings, integrations
src/lib/memory/          # Legacy vector/RAG backend, no longer part of default pi runtime
src/lib/mcp/             # MCP connection backend exposed to pi
src/lib/agent/           # Legacy Eggent agent fallback
src/lib/tools/           # Legacy/bridge utility wrappers
bundled-skills/          # Built-in skill packs installable into projects
data/                    # Runtime state, generated locally
scripts/                 # Install and utility scripts
docs/                    # Additional docs
docker-compose.yml       # Container runtime
Dockerfile               # Production image build
```

---

## Contributing and Support

- Contributing guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Report a bug: [Bug report form](https://github.com/eggent-ai/eggent/issues/new?template=bug_report.yml)
- Request a feature: [Feature request form](https://github.com/eggent-ai/eggent/issues/new?template=feature_request.yml)
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- Security policy: [SECURITY.md](./SECURITY.md)

---

## Notes

- License: MIT. See `LICENSE`.
- Eggent is local-first: runtime state is kept on disk under `./data`.
- pi SDK is the default agent runtime.
