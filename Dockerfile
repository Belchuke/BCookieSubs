# syntax=docker/dockerfile:1.7

# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Build deps for native modules (better-sqlite3, bcrypt) and whisper.cpp
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ cmake ca-certificates wget curl git \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --include=dev --no-audit --no-fund

# Pre-build whisper.cpp inside nodejs-whisper so the runtime container doesn't
# have to compile it. On Apple Silicon / ARM64 Docker we disable ARM ISA
# extensions that cause "target specific option mismatch" in the slim image.
RUN if [ -d node_modules/nodejs-whisper/cpp/whisper.cpp ]; then \
      cd node_modules/nodejs-whisper/cpp/whisper.cpp && \
      rm -rf build && \
      cmake -B build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DGGML_NATIVE=OFF \
        -DGGML_DOTPROD=OFF \
        -DGGML_I8MM=OFF \
        -DGGML_SVE=OFF \
        -DGGML_SME=OFF \
        -DWHISPER_NO_CUDA=ON \
        -DWHISPER_NO_OPENCL=ON \
        -DWHISPER_NO_METAL=ON \
        -DWHISPER_BUILD_SERVER=OFF \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_EXAMPLES=ON \
        ${CMAKE_TARGET_ARCH:+"-DCMAKE_SYSTEM_PROCESSOR=${CMAKE_TARGET_ARCH}"} && \
      cmake --build build --config Release -j$(nproc); \
    fi

# Pre-download the default Whisper model so the first transcription doesn't stall
# on a multi-GB HuggingFace download. It is baked into the image (inside
# node_modules) and seeded into the model dir at container startup (see entrypoint).
ARG WHISPER_PRELOAD_MODEL=large-v3-turbo
RUN if [ -d node_modules/nodejs-whisper/cpp/whisper.cpp/models ]; then \
      wget -q -O "node_modules/nodejs-whisper/cpp/whisper.cpp/models/ggml-${WHISPER_PRELOAD_MODEL}.bin" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_PRELOAD_MODEL}.bin" ; \
    fi

COPY tsconfig.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc

# Drop devDependencies for the runtime image.
RUN npm prune --omit=dev


# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# System dependencies needed by the scanner/extractor and Whisper at runtime:
#   - mkvtoolnix : mkvmerge / mkvextract (MKV subtitle probing + extraction)
#   - ffmpeg     : ffprobe / ffmpeg (non-MKV containers + Whisper audio prep)
#   - build tools: whisper.cpp native compilation for current platform
#   - wget/curl  : nodejs-whisper auto-downloads models from HuggingFace
#   - git        : whisper.cpp CMake configure requires git for build info
#   - ca-certs   : outbound HTTPS (TheMovieDB, Ollama Cloud, OpenAI, Anthropic)
#   - tini       : PID 1 init so SIGTERM is forwarded to Node cleanly
RUN apt-get update && apt-get install -y --no-install-recommends \
      mkvtoolnix \
      ffmpeg \
      build-essential \
      cmake \
      wget \
      curl \
      git \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Sensible defaults for a containerised deploy. Override via docker-compose.
ENV PORT=4850
ENV DBPATH=/data/subtitles.db
ENV DISABLE_OLLAMA_SPAWN=1
ENV WHISPER_MODEL_ROOT_PATH=/data/whisper-models
ENV WHISPER_PRELOAD_MODEL=large-v3-turbo

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY views ./views
COPY locales ./locales

# Persistent data + media mount points. Whisper models live in /data/whisper-models.
RUN mkdir -p /data /data/whisper-models /media
VOLUME ["/data"]

# Entrypoint: seed the pre-downloaded Whisper model (baked inside node_modules)
# into the persistent model dir on first start, so the first transcription is
# fast even though /data is a volume that the image's content can't pre-populate.
RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'MODEL_DIR="${WHISPER_MODEL_ROOT_PATH:-/data/whisper-models}"' \
  'MODEL_FILE="ggml-${WHISPER_PRELOAD_MODEL:-large-v3-turbo}.bin"' \
  'SRC="/app/node_modules/nodejs-whisper/cpp/whisper.cpp/models/${MODEL_FILE}"' \
  'mkdir -p "$MODEL_DIR"' \
  'if [ -f "$SRC" ] && [ ! -f "$MODEL_DIR/$MODEL_FILE" ]; then' \
  '  echo "[entrypoint] Seeding Whisper model ${MODEL_FILE} into ${MODEL_DIR}"' \
  '  cp "$SRC" "$MODEL_DIR/$MODEL_FILE"' \
  'fi' \
  'exec "$@"' \
  > /usr/local/bin/docker-entrypoint.sh \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4850

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
