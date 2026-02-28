FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm install --no-package-lock

FROM deps AS builder
WORKDIR /app

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PYTHON_VENV=/opt/eggent-python
ENV PATH="${PYTHON_VENV}/bin:${PATH}"
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_NO_CACHE_DIR=1
ENV TMPDIR=/app/data/tmp
ENV PLAYWRIGHT_BROWSERS_PATH=/app/data/ms-playwright
ENV npm_config_cache=/app/data/npm-cache
ENV XDG_CACHE_HOME=/app/data/.cache

RUN mkdir -p "${TMPDIR}" "${PLAYWRIGHT_BROWSERS_PATH}" "${npm_config_cache}" "${XDG_CACHE_HOME}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-requests \
    python3-venv \
    sudo \
    ripgrep \
  && python3 -m venv --system-site-packages "${PYTHON_VENV}" \
  && "${PYTHON_VENV}/bin/python3" -m pip --version \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-package-lock

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/bundled-skills ./bundled-skills
COPY --from=builder /app/src/prompts ./src/prompts

RUN mkdir -p /app/data/tmp /app/data/ms-playwright /app/data/npm-cache /app/data/.cache \
  && chown -R node:node /app "${PYTHON_VENV}"

# Install gosu for dropping privileges in entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Start as root so the entrypoint can fix volume permissions, then drop to node
EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["npm", "run", "start"]
