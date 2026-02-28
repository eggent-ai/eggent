#!/bin/bash
set -e

DATA_DIRS="/app/data/tmp /app/data/settings /app/data/projects /app/data/chats"

if [ "$(id -u)" = "0" ]; then
  # Running as root — create data subdirectories, fix permissions, then drop to "node"
  mkdir -p $DATA_DIRS 2>/dev/null || true
  chown -R node:node /app/data 2>/dev/null || true
  exec gosu node "$@"
else
  # Already running as non-root — just make sure subdirectories exist
  mkdir -p $DATA_DIRS 2>/dev/null || true
  exec "$@"
fi
