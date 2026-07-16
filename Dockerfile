FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package*.json ./
RUN npm ci

FROM deps AS builder
WORKDIR /app

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS whisper
WORKDIR /tmp/whisper.cpp
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    cmake \
    git \
  && git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git /tmp/whisper.cpp \
  && cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
  && cmake --build /tmp/whisper.cpp/build --config Release -j"$(nproc)" \
  && cp /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli \
  && rm -rf /var/lib/apt/lists/* /tmp/whisper.cpp

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
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
    ffmpeg \
    git \
    jq \
    libgomp1 \
    libasound2 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libdbus-1-3 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    python3 \
    python3-requests \
    python3-venv \
    sudo \
    ripgrep \
  && python3 -m venv --system-site-packages "${PYTHON_VENV}" \
  && "${PYTHON_VENV}/bin/python3" -m pip --version \
  && rm -rf /var/lib/apt/lists/*

RUN echo "node ALL=(root) NOPASSWD: ALL" > /etc/sudoers.d/eggent-node \
  && chmod 440 /etc/sudoers.d/eggent-node

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/bundled-skills ./bundled-skills
COPY --from=builder /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
COPY --from=builder /app/scripts/ensure-pi-packages.mjs ./scripts/ensure-pi-packages.mjs
COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli

RUN mkdir -p /app/data/tmp /app/data/models/whisper /app/data/ms-playwright /app/data/npm-cache /app/data/.cache \
  && chmod +x /app/scripts/docker-entrypoint.sh /app/scripts/ensure-pi-packages.mjs \
  && chown -R node:node /app/data "${PYTHON_VENV}"

USER node
EXPOSE 3000

CMD ["/app/scripts/docker-entrypoint.sh"]
