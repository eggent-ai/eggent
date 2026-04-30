# Eggent

<p align="center">
  <a href="./docs/assets/eggent-banner.png">
    <img src="./docs/assets/eggent-banner.png" alt="Eggent banner" width="980" />
  </a>
</p>

Eggent is a local-first AI workspace for building a team of focused agents.

Create specialized agents with their own skill packs and MCP servers, switch between them in plain human language, and delegate each task to the agent best trained for it.

Built-in platform capabilities:
- project-based organization
- chat and tool-driven workflows
- memory and knowledge ingestion
- MCP server integration
- cron automation
- Telegram integration

The app runs as a Next.js service and stores runtime state on disk (`./data`).

## Releases

- Latest release snapshot: [0.1.6 - Telegram Long Polling](./docs/releases/0.1.6-telegram-long-polling.md)
- GitHub release body : [v0.1.6](./docs/releases/github-v0.1.6.md)
- Release archive: [docs/releases/README.md](./docs/releases/README.md)

## Contributing and Support

- Contributing guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Report a bug: [Bug report form](https://github.com/eggent-ai/eggent/issues/new?template=bug_report.yml)
- Request a feature: [Feature request form](https://github.com/eggent-ai/eggent/issues/new?template=feature_request.yml)
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- Security policy: [SECURITY.md](./SECURITY.md)

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

### Option A: One-command Installer (Recommended)

The fastest way to get Eggent running, especially on VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh | bash
```

What it does:
- Installs Docker (best-effort on macOS/Linux) if missing
- Clones/updates Eggent in `~/.eggent`
- Runs Docker deployment via `scripts/install-docker.sh`

**Environment variables:**

| Variable | Default | Description |
| --- | --- | --- |
| `EGGENT_INSTALL_DIR` | `~/.eggent` | Target directory |
| `EGGENT_BRANCH` | `main` | Git branch to use |
| `EGGENT_REPO_URL` | `https://github.com/eggent-ai/eggent.git` | Repository URL |
| `EGGENT_AUTO_INSTALL_DOCKER` | `1` | Auto-install Docker if missing |
| `EGGENT_APP_BIND_HOST` | `0.0.0.0` (Linux) / `127.0.0.1` | Docker bind host |

Example with custom options:

```bash
EGGENT_INSTALL_DIR=~/apps/eggent \
EGGENT_BRANCH=main \
EGGENT_AUTO_INSTALL_DOCKER=1 \
curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh | bash
```

On Linux (including VPS installs), the one-command installer publishes the app port on all interfaces by default, making it reachable at `http://<server-ip>:3000`.

### Option B: Manual Docker Setup

If you already have the repository cloned:

```bash
npm run setup:docker
```

This script:
- Validates Docker + Compose
- Prepares `.env` and `data/`
- Builds image and starts container
- Waits for `GET /api/health` to succeed

**Useful Docker commands:**

```bash
docker compose logs -f app      # View logs
docker compose restart app     # Restart app
docker compose down            # Stop and remove
docker compose up -d app       # Start in background
```

Open: `http://localhost:3000`

---

## Local/Node.js Deployment

Run Eggent directly on your machine with Node.js:

### Quick Start

```bash
npm run setup:local
```

This script:
- Validates Node/npm availability
- Validates `python3` availability (required for Code Execution with Python runtime)
- Validates `curl` availability (required for terminal commands)
- Warns if recommended utilities are missing: `git`, `jq`, `pip3`, `rg`
- Creates `.env` from `.env.example` if needed
- Generates secure defaults for token placeholders
- Installs dependencies
- Builds production output
- Runs a health smoke-check

Start the app:

```bash
npm run start
```

Open: `http://localhost:3000`

### PM2 Auto-start (Optional - Linux/macOS)

For production deployments with auto-restart on boot, use PM2:

**1. Install PM2 globally:**

```bash
npm install -g pm2
```

**2. Start Eggent with PM2:**

```bash
pm2 start npm --name eggent -- run start
```

**3. Save PM2 configuration:**

```bash
pm2 save
```

**4. Setup systemd auto-start:**

```bash
pm2 startup systemd
```

Copy and execute the command output (requires sudo).

**5. Verify auto-start works:**

```bash
sudo reboot
# After reboot:
pm2 status
```

**Alternative: Using ecosystem file**

Create `ecosystem.config.js` in your Eggent directory:

```javascript
module.exports = {
  apps: [
    {
      name: "eggent",
      cwd: "/home/YOUR_USERNAME/.eggent",
      script: "npm",
      args: "run start",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
}
```

Then start with:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd
```

**Common PM2 commands:**

```bash
pm2 status              # Check status
pm2 logs eggent         # View logs
pm2 restart eggent      # Restart app
pm2 stop eggent         # Stop app
pm2 delete eggent       # Remove from PM2
```

---

## Development Mode

For active development with hot reload:

```bash
npm install
npm run dev
```

Open: `http://localhost:3000`

### Manual Setup (Full Control)

If you prefer complete manual control:

```bash
cp .env.example .env
# Ensure python3 is installed and available in PATH
npm install
npm run build
npm run start
```

Open: `http://localhost:3000`

## Updating Eggent

Before updating, back up:
- `.env`
- `data/`

If you installed with the one-command installer, run the same command again:

```bash
curl -fsSL https://raw.githubusercontent.com/eggent-ai/eggent/main/scripts/install.sh | bash
```

It will update the repo in `~/.eggent` (or `EGGENT_INSTALL_DIR` if customized), then rebuild and restart Docker deployment.

If you run Eggent from this repo with Docker:

```bash
git pull --ff-only origin main
npm run setup:docker
```

If you run Eggent from this repo in local production mode (Node + npm):

```bash
git pull --ff-only origin main
npm run setup:local
```

Quick post-update check:

```bash
curl http://localhost:3000/api/health
```

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
| `APP_TMP_DIR` | No | Docker temp directory passed as `TMPDIR` (default: `/app/data/tmp`) |
| `PLAYWRIGHT_BROWSERS_PATH` | No | Browser install/cache path for Playwright (default: `/app/data/ms-playwright`) |
| `NPM_CONFIG_CACHE` | No | npm cache directory for runtime installs (default: `/app/data/npm-cache`) |
| `XDG_CACHE_HOME` | No | Generic CLI cache directory (default: `/app/data/.cache`) |
| `CODEX_AUTH_FILE` | No | Explicit path to Codex OAuth file (if unset, Eggent auto-discovers `.codex/auth.json` in common home dirs) |
| `GEMINI_OAUTH_CREDS_FILE` | No | Explicit path to Gemini OAuth creds file (if unset, Eggent auto-discovers `.gemini/oauth_creds.json` in common home dirs) |
| `GEMINI_SETTINGS_FILE` | No | Explicit path to Gemini settings file (if unset, Eggent auto-discovers `.gemini/settings.json` in common home dirs) |

## Data Persistence

- Runtime state lives in `./data`
- Docker mounts `./data` into `/app/data`
- Runtime temp/cache paths are persisted under `./data` (for example: `tmp/`, `ms-playwright/`, `npm-cache/`, `.cache/`)
- Keep backups of `data/` and `.env` for disaster recovery

## Security Defaults

Docker defaults are security-oriented:
- compose default bind: `127.0.0.1:${APP_PORT:-3000}:3000` (`APP_BIND_HOST=0.0.0.0` exposes publicly)
- non-root container user (`node`)
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

3. Codex/Gemini OAuth says "token file was not found" on VPS  
Eggent auto-discovers OAuth files in common home directories and in `data/.codex` + `data/.gemini`.
For Docker, place files in `data/.codex/auth.json`, `data/.gemini/oauth_creds.json`, `data/.gemini/settings.json`, then recreate container (`docker compose up -d --build --force-recreate app`) so startup hook can normalize file permissions for `node`.

4. Linux Docker permissions issues  
Try with `sudo docker ...` or add your user to the `docker` group.

5. Build fails after dependency changes  
Run `npm install` and retry `npm run build`.

6. Large downloads fail with `No space left on device` despite free server disk  
This usually means temp/cache paths are constrained in the runtime environment. Rebuild and restart with current compose defaults, then verify inside container:
```bash
docker compose build --no-cache app
docker compose up -d app
docker compose exec app sh -lc 'df -h /tmp /app/data && echo "TMPDIR=$TMPDIR" && echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"'
```

7. `Process error: spawn python3 ENOENT` in Code Execution  
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

8. `sh: 1: curl: not found` in Code Execution (terminal runtime)  
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

9. `command not found` for common terminal/skill commands (`git`, `jq`, `rg`)  
Install recommended CLI utilities:
```bash
sudo apt-get update && sudo apt-get install -y git jq ripgrep
```

10. `ModuleNotFoundError: No module named 'requests'` in Python Code Execution  
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

11. `/usr/bin/python3: No module named pip` when trying to install Python packages  
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

12. `apt-get install ...` fails in Code Execution with `Permission denied`  
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

- License: MIT. See `LICENSE` at the repository root.
