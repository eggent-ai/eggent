#!/bin/bash
set -e

# Fix ownership of the data volume mount.
# Railway (and other PaaS) may mount volumes as root, but the app runs as
# the unprivileged "node" user.  Ensure /app/data is writable.
if [ "$(id -u)" = "0" ]; then
  # Running as root — fix permissions then drop to "node"
  chown -R node:node /app/data 2>/dev/null || true
  exec su-exec node "$@" 2>/dev/null || exec gosu node "$@" 2>/dev/null || exec "$@"
else
  # Already running as non-root — just make sure subdirectories exist
  mkdir -p /app/data/tmp /app/data/settings /app/data/projects /app/data/chats 2>/dev/null || true
  exec "$@"
fi
