#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${EGGENT_REPO_URL:-https://github.com/eggent-ai/eggent.git}"
BRANCH="${EGGENT_BRANCH:-main}"
INSTALL_DIR="${EGGENT_INSTALL_DIR:-$HOME/.eggent}"
AUTO_INSTALL_DOCKER="${EGGENT_AUTO_INSTALL_DOCKER:-1}"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    if ! command -v sudo >/dev/null 2>&1; then
      fail "sudo is required to install system packages"
    fi
    sudo "$@"
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

docker_compose_ready() {
  if command_exists docker && docker compose version >/dev/null 2>&1; then
    return 0
  fi

  if command_exists sudo && command_exists docker && sudo docker compose version >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

install_curl_if_missing() {
  if command_exists curl; then
    return
  fi

  if command_exists apt-get; then
    run_root apt-get update
    run_root apt-get install -y curl
  elif command_exists dnf; then
    run_root dnf install -y curl
  elif command_exists yum; then
    run_root yum install -y curl
  else
    fail "curl is required for Docker fallback install"
  fi
}

install_docker_via_official_script() {
  local tmp_script
  install_curl_if_missing
  tmp_script="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$tmp_script"
  run_root sh "$tmp_script"
  rm -f "$tmp_script"
}

install_git_if_missing() {
  if command_exists git; then
    return
  fi

  local os
  os="$(uname -s)"
  log "==> Installing git"

  case "$os" in
    Darwin)
      command_exists brew || fail "Homebrew is required to install git automatically"
      brew install git
      ;;
    Linux)
      if command_exists apt-get; then
        run_root apt-get update
        run_root apt-get install -y git
      elif command_exists dnf; then
        run_root dnf install -y git
      elif command_exists yum; then
        run_root yum install -y git
      else
        fail "Unsupported Linux package manager for git auto-install"
      fi
      ;;
    *)
      fail "Unsupported OS: $os"
      ;;
  esac
}

install_docker_if_missing() {
  if docker_compose_ready; then
    return
  fi

  if [[ "$AUTO_INSTALL_DOCKER" != "1" ]]; then
    fail "Docker is not installed. Install Docker manually and rerun."
  fi

  local os
  os="$(uname -s)"
  log "==> Installing Docker (best-effort)"

  case "$os" in
    Darwin)
      command_exists brew || fail "Homebrew is required for automatic Docker install on macOS"
      brew install --cask docker
      if command_exists open; then
        open -a Docker >/dev/null 2>&1 || true
      fi
      ;;
    Linux)
      if command_exists apt-get; then
        run_root apt-get update
        if ! run_root apt-get install -y docker.io docker-compose-plugin; then
          log "==> docker-compose-plugin is unavailable, trying docker-compose-v2"
          if ! run_root apt-get install -y docker.io docker-compose-v2; then
            log "==> distro Docker packages did not provide Compose v2"
          fi
        fi
      elif command_exists dnf; then
        run_root dnf install -y docker docker-compose-plugin || true
      elif command_exists yum; then
        run_root yum install -y docker docker-compose-plugin || true
      else
        fail "Unsupported Linux package manager for Docker auto-install"
      fi
      if command_exists systemctl; then
        run_root systemctl enable --now docker >/dev/null 2>&1 || true
      fi
      if ! docker_compose_ready; then
        log "==> Docker Compose v2 is still unavailable, trying official Docker installer"
        install_docker_via_official_script
        if command_exists systemctl; then
          run_root systemctl enable --now docker >/dev/null 2>&1 || true
        fi
      fi
      ;;
    *)
      fail "Unsupported OS: $os"
      ;;
  esac

  if ! docker_compose_ready; then
    fail "Docker was installed but Compose v2 is unavailable. Install Docker manually and verify: docker compose version"
  fi
}

pick_docker_bin() {
  if docker info >/dev/null 2>&1; then
    printf '%s' "docker"
    return
  fi

  if sudo docker info >/dev/null 2>&1; then
    printf '%s' "sudo docker"
    return
  fi

  fail "Docker daemon is not available. Start Docker Desktop/service and rerun."
}

ensure_repo() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "==> Updating existing repo in $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch origin "$BRANCH" --depth 1
    git -C "$INSTALL_DIR" checkout "$BRANCH"
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
    return
  fi

  if [[ -d "$INSTALL_DIR" ]]; then
    fail "Directory exists and is not a git repo: $INSTALL_DIR"
  fi

  log "==> Cloning repo to $INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
}

main() {
  log "==> Eggent one-command installer"
  log "Repo: $REPO_URL"
  log "Branch: $BRANCH"
  log "Install dir: $INSTALL_DIR"

  install_git_if_missing
  install_docker_if_missing
  ensure_repo

  local docker_bin
  local default_bind_host app_bind_host app_port
  app_port="${APP_PORT:-3000}"
  default_bind_host="127.0.0.1"
  if [[ "$(uname -s)" == "Linux" ]]; then
    # One-command installs are often used on VPS hosts where the app should be reachable remotely.
    default_bind_host="0.0.0.0"
  fi
  app_bind_host="${EGGENT_APP_BIND_HOST:-$default_bind_host}"

  docker_bin="$(pick_docker_bin)"

  cd "$INSTALL_DIR"
  chmod +x ./scripts/install-docker.sh

  log "==> Running Docker deployment"
  APP_BIND_HOST="$app_bind_host" APP_PORT="$app_port" DOCKER_BIN="$docker_bin" ./scripts/install-docker.sh

  log ""
  log "Done."
  if [[ "$app_bind_host" == "0.0.0.0" ]]; then
    log "Open: http://<server-ip>:${app_port}"
  else
    log "Open: http://127.0.0.1:${app_port}"
  fi
}

main "$@"
