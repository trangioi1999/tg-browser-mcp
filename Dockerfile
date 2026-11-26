# syntax=docker/dockerfile:1.7
# TG Browser MCP — Streamable HTTP server with headless Chromium.
# Build:  docker build -t tg-browser-mcp .
# Run:    docker run --rm -p 8931:8931 -e TG_BROWSER_TOKEN=<≥24 chars> tg-browser-mcp

ARG NODE_VERSION=24-bookworm-slim

FROM node:${NODE_VERSION} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/copy-ui.mjs ./scripts/
RUN npm run build

FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    TG_LOG_LEVEL=info
WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies only; then the Chromium headless shell and its OS libraries.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npx --no-install playwright install --with-deps --only-shell chromium \
 && apt-get purge -y --auto-remove \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*
COPY --from=build /src/dist ./dist
COPY deploy/cloudflare/tg-browser.cloud.json ./tg-browser.cloud.json
# Unprivileged runtime user. /app stays root-owned (read-only for the server);
# only the data directory is writable.
RUN groupadd --system --gid 10001 tg \
 && useradd --system --uid 10001 --gid tg --home /home/tg --create-home --shell /usr/sbin/nologin tg \
 && mkdir -p /home/tg/.tg-browser && chown -R tg:tg /home/tg && chmod 700 /home/tg/.tg-browser \
 && chmod -R a-w /app
USER tg
EXPOSE 8931
STOPSIGNAL SIGTERM
CMD ["node", "/app/dist/index.js", "start", "--transport", "http", "--config", "/app/tg-browser.cloud.json"]
