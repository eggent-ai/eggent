# Eggent

<p align="center">
  <a href="./docs/assets/eggent-banner.jpeg">
    <img src="./docs/assets/eggent-banner.jpeg" alt="Eggent banner" width="980" />
  </a>
</p>

Eggent is a local-first AI workspace with:
- project-based organization
- chat and tool-driven workflows
- memory and knowledge ingestion
- MCP server integration
- cron automation
- Telegram integration

The app runs as a Next.js service and stores runtime state on disk (`./data`).

## Installation (All Supported Paths)

| Path | Best for | Command |
| --- | --- | --- |
| One-command installer | Fastest setup, Docker-first | `curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh \| bash` |
| Local production | Run directly on your machine (Node + npm) | `npm run setup:local` |
| Docker isolated | Containerized runtime | `npm run setup:docker` |
| Manual setup | Full control | see [Manual Setup](#manual-setup) |

## 1) One-command Installer

```bash
curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh | bash
```

What it does:
- installs Docker (best-effort on macOS/Linux) if missing
- clones/updates Eggent in `~/.eggent`
- runs Docker deployment via `scripts/install-docker.sh`

Installer environment variables:
- `EGGENT_INSTALL_DIR`: target directory (default: `~/.eggent`)
- `EGGENT_BRANCH`: git branch (default: `main`)
- `EGGENT_REPO_URL`: git repo URL (default: `https://github.com/eggent-ai/eggent.git`)
- `EGGENT_AUTO_INSTALL_DOCKER`: `1`/`0` (default: `1`)
- `EGGENT_APP_BIND_HOST`: Docker published bind host (`Linux default: 0.0.0.0`, otherwise `127.0.0.1`)

Example:

```bash
EGGENT_INSTALL_DIR=~/apps/eggent \
EGGENT_BRANCH=main \
EGGENT_AUTO_INSTALL_DOCKER=1 \
curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh | bash
```

On Linux (including VPS installs), the one-command installer publishes app port on all interfaces by default, so app is reachable at `http://<server-ip>:3000`.

## 2) Local Production Setup (Node + npm)

```bash
npm run setup:local
```

This script:
- validates Node/npm availability
- validates `python3` availability (required for Code Execution with Python runtime)
- validates `curl` availability (required for terminal commands like `curl ...`)
- warns if recommended utilities are missing: `git`, `jq`, `pip3`, `rg`
- creates `.env` from `.env.example` if needed
- generates secure defaults for token placeholders
- installs dependencies
- builds production output
- runs a health smoke-check

Start the app:

```bash
npm run start
```

Open:
- `http://localhost:3000`

## 3) Docker Isolated Setup

```bash
npm run setup:docker
```

This script:
- validates Docker + Compose
- prepares `.env` and `data/`
- builds image and starts container
- waits for `GET /api/health` to succeed

Open:
- `http://localhost:3000`

Useful Docker commands:

```bash
docker compose logs -f app
docker compose restart app
docker compose down
```

## 4) Manual Setup

```bash
cp .env.example .env
# ensure python3 is installed and available in PATH
npm install
npm run build
npm run start
```

Open:
- `http://localhost:3000`

## 5) Development Mode

```bash
npm install
npm run dev
```

Open:
- `http://localhost:3000`

## Runtime Scripts

Defined in `package.json`:
- `npm run dev`: Next.js dev server
- `npm run build`: production build
- `npm run start`: production start
- `npm run lint`: ESLint
- `npm run setup:one`: one-command installer wrapper
- `npm run setup:local`: local production bootstrap
- `npm run setup:docker`: Docker production bootstrap

## Configuration

Base flow:
- copy `.env.example` to `.env`
- fill required keys

Main environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Usually yes | Default model provider key |
| `ANTHROPIC_API_KEY` | No | Anthropic provider |
| `GOOGLE_API_KEY` | No | Google provider |
| `OPENROUTER_API_KEY` | No | OpenRouter provider |
| `TAVILY_API_KEY` | No | Web search integration |
| `EXTERNAL_API_TOKEN` | No (auto-generated in setup scripts) | External message API auth token |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `TELEGRAM_WEBHOOK_SECRET` | No (auto-generated in setup scripts) | Telegram webhook secret |
| `TELEGRAM_DEFAULT_PROJECT_ID` | No | Default project for Telegram |
| `TELEGRAM_ALLOWED_USER_IDS` | No | Comma/space separated Telegram `user_id` allowlist |
| `APP_BASE_URL` | Recommended | Public app URL used by integrations |
| `APP_BIND_HOST` | No | Docker port bind host (default: `127.0.0.1`; set `0.0.0.0` for public access) |
| `APP_PORT` | No | Published app port (default: `3000`) |

## Data Persistence

- Runtime state lives in `./data`
- Docker mounts `./data` into `/app/data`
- Keep backups of `data/` and `.env` for disaster recovery

## Security Defaults

Docker defaults are security-oriented:
- compose default bind: `127.0.0.1:${APP_PORT:-3000}:3000` (`APP_BIND_HOST=0.0.0.0` exposes publicly)
- non-root container user (`node`)
- tmpfs for `/tmp`
- `node` user has passwordless `sudo` in container to allow AI-driven package installation

## Health Check

```bash
curl http://localhost:3000/api/health
```

Expected response shape:
- `status: "ok"`
- `timestamp`
- `version`

## VPS Production Checklist

1. Set at least one model API key in `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, or `OPENROUTER_API_KEY`).
2. Change default dashboard credentials (`admin / admin`) in Settings immediately after first login.
3. If using Telegram integration/webhooks, set public `APP_BASE_URL` (HTTPS URL reachable from the internet).
4. Keep `data/` persistent and writable by container runtime user.
5. Ensure outbound network access to provider APIs (`443/tcp`).

## Troubleshooting

1. App works on `localhost` but not on `127.0.0.1` (or vice versa)  
Use one host consistently. Browser storage/cookies are origin-scoped.

2. Docker container does not become healthy  
Run `docker compose logs --tail 200 app` and verify `.env` values.

3. Linux Docker permissions issues  
Try with `sudo docker ...` or add your user to the `docker` group.

4. Build fails after dependency changes  
Run `npm install` and retry `npm run build`.

5. `Process error: spawn python3 ENOENT` in Code Execution  
`python3` is missing in runtime environment.

For Docker deploys:
```bash
docker compose build --no-cache app
docker compose up -d app
docker compose exec app python3 --version
```

For local (non-Docker) deploys:
```bash
sudo apt-get update && sudo apt-get install -y python3
python3 --version
```

6. `sh: 1: curl: not found` in Code Execution (terminal runtime)  
`curl` is missing in runtime environment.

For Docker deploys:
```bash
docker compose build --no-cache app
docker compose up -d app
docker compose exec app curl --version
```

For local (non-Docker) deploys:
```bash
sudo apt-get update && sudo apt-get install -y curl
curl --version
```

7. `command not found` for common terminal/skill commands (`git`, `jq`, `rg`)  
Install recommended CLI utilities:
```bash
sudo apt-get update && sudo apt-get install -y git jq ripgrep
```

8. `ModuleNotFoundError: No module named 'requests'` in Python Code Execution  
`requests` is missing in runtime environment.

For Docker deploys:
```bash
docker compose build --no-cache app
docker compose up -d app
docker compose exec app python3 -c "import requests; print(requests.__version__)"
```

For local (non-Docker) deploys:
```bash
sudo apt-get update && sudo apt-get install -y python3-requests
python3 -c "import requests; print(requests.__version__)"
```

9. `/usr/bin/python3: No module named pip` when trying to install Python packages  
`pip` is missing in runtime environment.

For Docker deploys:
```bash
docker compose build --no-cache app
docker compose up -d app
docker compose exec app python3 -m pip --version
```

For local (non-Docker) deploys:
```bash
sudo apt-get update && sudo apt-get install -y python3-pip
python3 -m pip --version
```

10. `apt-get install ...` fails in Code Execution with `Permission denied`  
Use sudo in terminal runtime:
```bash
sudo apt-get update && sudo apt-get install -y ffmpeg
```

## Project Layout (High Level)

```text
src/                # App code (Next.js app router, components, libs)
scripts/            # Install and utility scripts
bundled-skills/     # Built-in skill packs
data/               # Runtime state (generated locally)
docs/               # Additional docs
docker-compose.yml  # Container runtime
Dockerfile          # Multi-stage production image build
```

## Notes

- The repository currently has no top-level `LICENSE` file.
