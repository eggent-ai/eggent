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

fix_auth_dir "/app/data/.codex"
fix_auth_dir "/app/data/.gemini"

fix_auth_file "/app/data/.codex/auth.json"
fix_auth_file "/app/data/.gemini/oauth_creds.json"
mkdir -p "${PI_CODING_AGENT_DIR:-/app/data/pi-agent}" >/dev/null 2>&1 || true
sudo chown -R node:node "${PI_CODING_AGENT_DIR:-/app/data/pi-agent}" >/dev/null 2>&1 || true
sudo chmod 700 "${PI_CODING_AGENT_DIR:-/app/data/pi-agent}" >/dev/null 2>&1 || true

fix_auth_file "/app/data/.gemini/settings.json"

exec npm run start
