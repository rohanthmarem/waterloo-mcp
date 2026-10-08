# Stage 1 compiles the vendored Brightspace client. TypeScript, vitest, prettier
# and the other development packages stay here and never reach the image that runs.
FROM mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY upstream/package.json upstream/tsconfig.json ./upstream/
COPY upstream/src ./upstream/src
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund
# Every launch is headless, which Playwright serves from the headless shell. The full
# Chromium, Firefox, WebKit and the screen-recording ffmpeg are never started.
RUN find /ms-playwright -mindepth 1 -maxdepth 1 ! -name 'chromium_headless_shell-*' -exec rm -rf {} +

# Stage 2 is the runtime: the Ubuntu release, Node binary and headless shell the
# Playwright image ships, without its other browsers, their libraries, npm or Xvfb.
FROM ubuntu:noble@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
LABEL org.waterloo-mcp.component="gateway"
# Chromium libraries and fonts follow Playwright 1.58.2's Ubuntu 24.04 list
# (playwright-core/lib/server/registry/nativeDeps.js); update both together.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates procps poppler-utils ffmpeg python3-venv \
    libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    fontconfig libfontconfig1 libfreetype6 fonts-liberation fonts-noto-color-emoji fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f \
  && groupadd --gid 1001 pwuser \
  && useradd --create-home --uid 1001 --gid 1001 --groups users pwuser
COPY requirements-transcription.lock /tmp/requirements-transcription.lock
RUN python3 -m venv /opt/transcription && /opt/transcription/bin/pip install --no-cache-dir -r /tmp/requirements-transcription.lock
COPY --from=build /usr/bin/node /usr/bin/node
COPY --from=build /ms-playwright /ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY upstream/package.json ./upstream/package.json
COPY --from=build /app/upstream/build ./upstream/build
COPY web ./web
COPY src ./src
COPY scripts ./scripts
COPY gateway.mjs authorization.mjs outlines.mjs libcal.mjs piazza.mjs outlook.mjs renew.mjs transcribe.py ./
# A 4 MiB young generation keeps the long-lived worker near 195 MiB instead of 290 MiB
# after sustained reads, at about 3% more GC CPU and no measurable latency change.
ENV NODE_OPTIONS=--max-semi-space-size=4
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_ENV=production WATERLOO_SERVICE=1 WATERLOO_BIND=0.0.0.0 WATERLOO_STATE_DIR=/state WATERLOO_SECRETS_DIR=/run/secrets D2L_BASE_URL=https://learn.uwaterloo.ca D2L_SESSION_DIR=/state/sessions
USER pwuser
EXPOSE 8000
# Bash's /dev/tcp costs about 2 ms per check; starting Node for it cost about 55 ms every 30 s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8000 && printf 'GET /health HTTP/1.0\\r\\n\\r\\n' >&3 && head -n 1 <&3 | grep -q ' 200 '"]
CMD ["node", "gateway.mjs"]
