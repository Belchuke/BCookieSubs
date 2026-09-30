
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time

from ..errors import EngineError, JobAborted

logger = logging.getLogger("bcookiesubs.worker.whisper")

JOB_TYPE = "whisper.transcribe"

PROGRESS_INTERVAL_SECONDS = 2.0
SRT_LINE = re.compile(r"^(\d+)\s*\n(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*\n", re.M)

_model_cache: dict[str, object] = {}
_model_lock = threading.Lock()


def run(payload: dict, progress, cancel_event) -> dict:
    subtitle_id = payload.get("subtitleId")
    media_path = payload.get("mediaPath") or ""
    model_name = payload.get("model") or "large-v3-turbo"
    use_cuda = bool(payload.get("useCuda"))
    resume_srt = payload.get("resumeSrt") or ""
    resume_ms = int(payload.get("resumeMs") or 0)
    model_root = payload.get("modelRootPath") or os.environ.get("WHISPER_MODEL_ROOT", "/models/whisper")

    if not media_path or not os.path.exists(media_path):
        raise EngineError(f"media file not found: {media_path}", code="media_missing")

    duration_ms = _probe_duration_ms(media_path)
    if duration_ms <= 0:
        raise EngineError(f"could not probe media duration: {media_path}")

    model = _load_model(model_name, use_cuda, model_root)

    tmp = tempfile.mkdtemp(prefix="bcookiesubs-whisper-")
    try:
        wav_path = os.path.join(tmp, "audio.wav")
        _extract_wav(media_path, wav_path, resume_ms)
        if cancel_event.is_set():
            _abort(resume_srt, resume_ms, 0)

        resume_entries = _parse_srt(resume_srt) if resume_ms > 0 else []
        entries: list[tuple[int, int, str]] = list(resume_entries)
        last_send = 0.0
        last_end_ms = resume_ms

        offset = resume_ms
        segments, info = model.transcribe(wav_path, task="transcribe", beam_size=5)
        for segment in segments:
            if cancel_event.is_set():
                _abort(_serialize_srt(entries), resume_ms + last_end_ms, len(entries))
            start_ms = offset + int(segment.start * 1000)
            end_ms = offset + int(segment.end * 1000)
            text = (segment.text or "").strip()
            if text:
                entries.append((start_ms, end_ms, text))
            last_end_ms = max(last_end_ms, end_ms)

            now = time.monotonic()
            if now - last_send >= PROGRESS_INTERVAL_SECONDS:
                last_send = now
                pct = int(min(100, last_end_ms * 100 / duration_ms)) if duration_ms else 0
                status = json.dumps({
                    "positionMs": last_end_ms,
                    "durationMs": duration_ms,
                })
                progress(pct, status)

        full_srt = _serialize_srt(entries)
        return {"srt": full_srt, "lineCount": len(entries), "model": model_name}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _abort(resume_srt: str, checkpoint_ms: int, segments: int) -> None:
    raise JobAborted(
        checkpoint={"srt": resume_srt, "ms": checkpoint_ms, "segments": segments},
        message=f"paused at {checkpoint_ms}ms; will resume from there",
    )


def _load_model(model_name: str, use_cuda: bool, model_root: str):
    from faster_whisper import WhisperModel

    device = "cuda" if use_cuda else "cpu"
    key = f"{model_name}:{device}:{model_root}"
    with _model_lock:
        cached = _model_cache.get(key)
        if cached is not None:
            return cached
    os.makedirs(model_root, exist_ok=True)
    try:
        model = WhisperModel(model_name, device=device, download_root=model_root,
                             compute_type="float16" if device == "cuda" else "int8")
    except Exception as exc:
        if device == "cuda":
            logger.warning("CUDA load failed (%s); falling back to CPU", exc)
            device = "cpu"
            model = WhisperModel(model_name, device=device, download_root=model_root,
                                 compute_type="int8")
        else:
            raise EngineError(f"could not load whisper model {model_name}: {exc}")
    with _model_lock:
        _model_cache[key] = model
    return model


def _extract_wav(media_path: str, wav_path: str, resume_ms: int) -> None:
    args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    if resume_ms > 0:
        args += ["-ss", f"{resume_ms / 1000:.3f}"]
    args += ["-i", media_path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav_path]
    result = subprocess.run(args, capture_output=True, text=True, timeout=1800)
    if result.returncode != 0 or not os.path.exists(wav_path):
        reason = (result.stderr or "").strip().splitlines()[:1]
        raise EngineError(f"audio extraction failed: {reason[0][:200] if reason else 'unknown error'}")


def _probe_duration_ms(path: str) -> int:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return int(float(result.stdout.strip()) * 1000)
    except (ValueError, subprocess.SubprocessError):
        return 0


def _parse_srt(text: str) -> list[tuple[int, int, str]]:
    entries: list[tuple[int, int, str]] = []
    matches = list(SRT_LINE.finditer(text))
    for i, m in enumerate(matches):
        start_ms = _srt_time_to_ms(m.group(2))
        end_ms = _srt_time_to_ms(m.group(3))
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[body_start:body_end].strip()
        if body:
            entries.append((start_ms, end_ms, body))
    return entries


def _srt_time_to_ms(raw: str) -> int:
    h, m, rest = raw.split(":")
    s, ms = re.split(r"[,.]", rest)
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(ms)


def _srt_time(ms: int) -> str:
    ms = max(0, int(ms))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{milli:03d}"


def _serialize_srt(entries: list[tuple[int, int, str]]) -> str:
    parts = []
    for i, (start_ms, end_ms, text) in enumerate(entries):
        parts.append(f"{i + 1}\n{_srt_time(start_ms)} --> {_srt_time(end_ms)}\n{text}\n")
    return "\n".join(parts)