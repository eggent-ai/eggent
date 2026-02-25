#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE_FILE="$ROOT_DIR/.env.example"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

warn_if_missing_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "WARNING: Recommended utility is missing: $1" >&2
  fi
}

check_node_version() {
  local version major
  version="$(node -p "process.versions.node")"
  major="${version%%.*}"
  if [[ "$major" -lt 20 ]]; then
    echo "Node.js 20+ is required (found $version)." >&2
    exit 1
  fi
}

upsert_env() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp found line
  tmp="$(mktemp)"
  found=0

  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "$key="* ]]; then
        printf '%s=%s\n' "$key" "$value" >>"$tmp"
        found=1
      else
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$file"
  fi

  if [[ "$found" -eq 0 ]]; then
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi

  mv "$tmp" "$file"
}

get_env_value() {
  local file="$1"
  local key="$2"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true
}

looks_placeholder() {
  local value="$1"
  if [[ -z "$value" ]]; then
    return 0
  fi
  case "$value" in
    replace-with-* | *replace-with* | changeme | example | ... )
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

random_hex() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return 0
  fi

  node -e "process.stdout.write(require('node:crypto').randomBytes(${bytes}).toString('hex'))"
}

wait_for_health() {
  local url="$1"
  local retries="$2"
  local delay="$3"
  local i

  for i in $(seq 1 "$retries"); do
    if command -v curl >/dev/null 2>&1; then
      if curl --silent --show-error --fail "$url" >/dev/null 2>&1; then
        return 0
      fi
    else
      if node -e "fetch(process.argv[1]).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$url"; then
        return 0
      fi
    fi
    sleep "$delay"
  done

  return 1
}

echo "==> Local production setup (npm)"
require_cmd node
require_cmd npm
require_cmd python3
require_cmd curl
check_node_version

warn_if_missing_cmd git
warn_if_missing_cmd jq
warn_if_missing_cmd pip3
warn_if_missing_cmd rg

cd "$ROOT_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_EXAMPLE_FILE" ]]; then
    echo "Missing template file: $ENV_EXAMPLE_FILE" >&2
    exit 1
  fi
  cp "$ENV_EXAMPLE_FILE" "$ENV_FILE"
  echo "Created .env from .env.example"
fi

EXTERNAL_API_TOKEN_VALUE="$(get_env_value "$ENV_FILE" "EXTERNAL_API_TOKEN")"
if looks_placeholder "$EXTERNAL_API_TOKEN_VALUE"; then
  upsert_env "$ENV_FILE" "EXTERNAL_API_TOKEN" "$(random_hex 32)"
  echo "Generated EXTERNAL_API_TOKEN in .env"
fi

TELEGRAM_WEBHOOK_SECRET_VALUE="$(get_env_value "$ENV_FILE" "TELEGRAM_WEBHOOK_SECRET")"
if looks_placeholder "$TELEGRAM_WEBHOOK_SECRET_VALUE"; then
  upsert_env "$ENV_FILE" "TELEGRAM_WEBHOOK_SECRET" "$(random_hex 24)"
  echo "Generated TELEGRAM_WEBHOOK_SECRET in .env"
fi

EGGENT_AUTH_SECRET_VALUE="$(get_env_value "$ENV_FILE" "EGGENT_AUTH_SECRET")"
if looks_placeholder "$EGGENT_AUTH_SECRET_VALUE"; then
  upsert_env "$ENV_FILE" "EGGENT_AUTH_SECRET" "$(random_hex 32)"
  echo "Generated EGGENT_AUTH_SECRET in .env"
fi

chmod 600 "$ENV_FILE" 2>/dev/null || true
mkdir -p "$ROOT_DIR/data"

echo "==> Installing dependencies"
npm install --no-package-lock

echo "==> Building production bundle"
npm run build

HEALTH_PORT="${HEALTH_PORT:-3077}"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/api/health"
START_LOG="$ROOT_DIR/.install-local-start.log"

echo "==> Running smoke check: $HEALTH_URL"
PORT="$HEALTH_PORT" HOSTNAME="127.0.0.1" npm run start >"$START_LOG" 2>&1 &
START_PID=$!

cleanup() {
  if kill -0 "$START_PID" >/dev/null 2>&1; then
    kill "$START_PID" >/dev/null 2>&1 || true
    wait "$START_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! wait_for_health "$HEALTH_URL" 45 1; then
  echo "Smoke check failed. Server log tail:" >&2
  tail -n 120 "$START_LOG" >&2 || true
  exit 1
fi

rm -f "$START_LOG"
cleanup
trap - EXIT

echo ""
echo "Setup complete."
echo "Run in production mode:"
echo "  npm run start"
echo ""
echo "App URL:"
echo "  http://127.0.0.1:3000"
