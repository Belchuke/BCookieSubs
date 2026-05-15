# syntax=docker/dockerfile:1.7

# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Build deps for native modules (better-sqlite3, bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --include=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc

# Drop devDependencies for the runtime image.
RUN npm prune --omit=dev


# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# System dependencies needed by the scanner/extractor at runtime:
#   - mkvtoolnix : mkvmerge / mkvextract (MKV subtitle probing + extraction)
#   - ffmpeg     : ffprobe / ffmpeg (non-MKV containers)
#   - ca-certs   : outbound HTTPS (TheMovieDB, Ollama Cloud, OpenAI, Anthropic)
#   - tini       : PID 1 init so SIGTERM is forwarded to Node cleanly
RUN apt-get update && apt-get install -y --no-install-recommends \
      mkvtoolnix \
      ffmpeg \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Sensible defaults for a containerised deploy. Override via docker-compose.
ENV PORT=4850
ENV DBPATH=/data/subtitles.db
ENV DISABLE_OLLAMA_SPAWN=1

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY views ./views

# Persistent data + media mount points.
RUN mkdir -p /data /media
VOLUME ["/data"]

EXPOSE 4850

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
