#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE_FILE="$ROOT_DIR/.env.example"
DOCKER_BIN="${DOCKER_BIN:-docker}"
read -r -a DOCKER_CMD <<<"$DOCKER_BIN"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
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

docker_cmd() {
  "${DOCKER_CMD[@]}" "$@"
}

prepare_data_dir() {
  local data_dir="$ROOT_DIR/data"
  mkdir -p "$data_dir"

  # The runtime container runs as user "node" (uid/gid 1000).
  # If setup is executed as root, fix bind-mount ownership to avoid EACCES at runtime.
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -R 1000:1000 "$data_dir" 2>/dev/null || true
  fi

  if [[ ! -w "$data_dir" ]]; then
    echo "WARNING: $data_dir is not writable. App may fail with 500 on /dashboard." >&2
    echo "Run: sudo chown -R 1000:1000 $data_dir" >&2
  fi
}

ensure_data_dir_writable_for_runtime() {
  local data_dir="$ROOT_DIR/data"

  if docker_cmd run --rm --user 1000:1000 -v "$data_dir:/target" eggent:local \
    sh -lc "test -w /target" >/dev/null 2>&1; then
    return 0
  fi

  docker_cmd run --rm --user 0:0 -v "$data_dir:/target" eggent:local \
    sh -lc "chown -R 1000:1000 /target" >/dev/null 2>&1 || true

  if docker_cmd run --rm --user 1000:1000 -v "$data_dir:/target" eggent:local \
    sh -lc "test -w /target" >/dev/null 2>&1; then
    return 0
  fi

  echo "ERROR: data directory is not writable for runtime user (uid 1000)." >&2
  echo "Fix and rerun:" >&2
  echo "  sudo chown -R 1000:1000 $data_dir" >&2
  exit 1
}

echo "==> Docker setup (isolated)"
require_cmd "${DOCKER_CMD[0]}"
if ! docker_cmd compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required (docker compose ...)." >&2
  exit 1
fi

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
prepare_data_dir

APP_PORT="${APP_PORT:-$(get_env_value "$ENV_FILE" "APP_PORT")}"
APP_PORT="${APP_PORT:-3000}"
APP_BIND_HOST="${APP_BIND_HOST:-$(get_env_value "$ENV_FILE" "APP_BIND_HOST")}"
APP_BIND_HOST="${APP_BIND_HOST:-127.0.0.1}"
upsert_env "$ENV_FILE" "APP_PORT" "$APP_PORT"
upsert_env "$ENV_FILE" "APP_BIND_HOST" "$APP_BIND_HOST"
HEALTH_URL="http://127.0.0.1:${APP_PORT}/api/health"

echo "==> Building image"
docker_cmd compose build app

echo "==> Verifying data directory permissions"
ensure_data_dir_writable_for_runtime

echo "==> Starting container"
docker_cmd compose up -d app

echo "==> Waiting for health: $HEALTH_URL"
if ! wait_for_health "$HEALTH_URL" 90 1; then
  echo "Container did not become healthy. Recent logs:" >&2
  docker_cmd compose logs --tail 120 app >&2 || true
  exit 1
fi

echo ""
echo "Docker setup complete."
echo "App URL:"
if [[ "$APP_BIND_HOST" == "0.0.0.0" ]]; then
  echo "  http://<server-ip>:${APP_PORT}"
else
  echo "  http://localhost:${APP_PORT}"
fi
echo ""
echo "Useful commands:"
echo "  docker compose logs -f app"
echo "  docker compose restart app"
echo "  docker compose down"
