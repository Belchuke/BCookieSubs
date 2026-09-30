FROM python:3.12-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        tesseract-ocr \
        tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install --no-cache-dir grpcio protobuf faster-whisper

COPY bcookiesubs_worker ./bcookiesubs_worker

ENV PYTHONUNBUFFERED=1 \
    WORKER_DATA_DIR=/data \
    WORKER_INSECURE=1 \
    WHISPER_MODEL_ROOT=/models/whisper

VOLUME ["/data", "/media", "/work", "/models"]

ENTRYPOINT ["python", "-m", "bcookiesubs_worker"]