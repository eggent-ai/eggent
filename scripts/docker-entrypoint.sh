#!/usr/bin/env bash
set -euo pipefail

fix_auth_dir() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  # data/ can be bind-mounted with root ownership from host;
  # fix only OAuth directories to keep startup fast and scoped.
  sudo chown node:node "$dir" >/dev/null 2>&1 || true
  sudo chmod 700 "$dir" >/dev/null 2>&1 || true
}

fix_auth_file() {
  local file_path="$1"
  if [[ ! -f "$file_path" ]]; then
    return 0
  fi

  sudo chown node:node "$file_path" >/dev/null 2>&1 || true
  sudo chmod 600 "$file_path" >/dev/null 2>&1 || true
}

# Bind-mounted ./data is often created as root on VPS hosts. The container runs
# as node (uid 1000), so fix ownership before creating settings/pi-agent/cache dirs.
DATA_ROOT="/app/data"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-/app/data/pi-agent}"
RUNTIME_DIRS=(
  "$PI_AGENT_DIR"
  "${TMPDIR:-/app/data/tmp}"
  "${PLAYWRIGHT_BROWSERS_PATH:-/app/data/ms-playwright}"
  "${npm_config_cache:-/app/data/npm-cache}"
  "${XDG_CACHE_HOME:-/app/data/.cache}"
)

# Do not hide mkdir failures here: continuing with missing runtime dirs only
# produces a less useful EACCES error later in ensure-pi-packages.mjs.
sudo mkdir -p "$DATA_ROOT" "${RUNTIME_DIRS[@]}"
# Fix the data tree, but tolerate read-only bind mounts under /app/data.
# Shared project folders can be mounted read-only by deployments
# (for example /app/data/projects/.shared/<folder>), and chown on those paths
# returns "Read-only file system". That must not make the container restart-loop.
sudo chown -R node:node "$DATA_ROOT" >/tmp/eggent-data-chown.log 2>&1 || true
sudo chmod u+rwX "$DATA_ROOT" >/dev/null 2>&1 || true
for dir in "${RUNTIME_DIRS[@]}"; do
  sudo chown -R node:node "$dir" >/dev/null 2>&1 || true
  sudo chmod u+rwX "$dir" >/dev/null 2>&1 || true
done

fix_auth_dir "/app/data/.codex"
fix_auth_dir "/app/data/.gemini"

fix_auth_file "/app/data/.codex/auth.json"
fix_auth_file "/app/data/.gemini/oauth_creds.json"
sudo chmod 700 "$PI_AGENT_DIR"

fix_auth_file "/app/data/.gemini/settings.json"

# Middleware runs in the Edge runtime and cannot read files. Generate a stable
# cookie-signing secret into the data volume, then expose it as env for both
# middleware verification and Node route handlers.
if [[ -z "${EGGENT_AUTH_SECRET:-}" ]]; then
  AUTH_SECRET_FILE="/app/data/settings/auth-secret"
  sudo mkdir -p "$(dirname "$AUTH_SECRET_FILE")"
  sudo chown node:node "$(dirname "$AUTH_SECRET_FILE")"
  if [[ ! -s "$AUTH_SECRET_FILE" ]]; then
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "$AUTH_SECRET_FILE"
  fi
  sudo chown node:node "$AUTH_SECRET_FILE"
  sudo chmod 600 "$AUTH_SECRET_FILE"
  export EGGENT_AUTH_SECRET="$(cat "$AUTH_SECRET_FILE")"
fi

node /app/scripts/ensure-pi-packages.mjs

exec npm run start
