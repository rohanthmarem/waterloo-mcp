# Stage 1 compiles the vendored Brightspace client. TypeScript, vitest, prettier
# and the other development packages stay here and never reach the image that runs.
FROM mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY upstream/package.json upstream/tsconfig.json ./upstream/
COPY upstream/src ./upstream/src
RUN npm run build

# Stage 2 is the runtime: production dependencies only, plus the compiled output.
FROM mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils ffmpeg python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY requirements-transcription.lock /tmp/requirements-transcription.lock
RUN python3 -m venv /opt/transcription && /opt/transcription/bin/pip install --no-cache-dir -r /tmp/requirements-transcription.lock
COPY upstream/package.json ./upstream/package.json
COPY --from=build /app/upstream/build ./upstream/build
COPY src ./src
COPY scripts ./scripts
COPY gateway.mjs authorization.mjs outlines.mjs libcal.mjs piazza.mjs renew.mjs transcribe.py ./
ENV NODE_ENV=production WATERLOO_SERVICE=1 WATERLOO_BIND=0.0.0.0 WATERLOO_STATE_DIR=/state WATERLOO_SECRETS_DIR=/run/secrets D2L_BASE_URL=https://learn.uwaterloo.ca D2L_SESSION_DIR=/state/sessions
USER pwuser
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8000/status').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"
CMD ["node", "gateway.mjs"]
