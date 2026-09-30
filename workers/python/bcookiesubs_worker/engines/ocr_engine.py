
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile

from ..errors import EngineError, JobAborted

logger = logging.getLogger("bcookiesubs.worker.ocr")

JOB_TYPE = "ocr"

FALLBACK_OCR_LANG = "eng"

APP_LANG_TO_TESSERACT = {
    "en": "eng", "da": "dan", "th": "tha", "ja": "jpn", "de": "deu", "fr": "fra",
    "es": "spa", "it": "ita", "pt": "por", "ru": "rus", "ko": "kor",
    "zh": "chi_sim", "ar": "ara", "hi": "hin", "tr": "tur", "nl": "nld",
    "pl": "pol", "sv": "swe", "no": "nor", "fi": "fin", "el": "ell",
    "cs": "ces", "he": "heb", "hu": "hun", "ro": "ron", "vi": "vie",
    "id": "ind", "uk": "ukr", "bg": "bul", "hr": "hrv", "sr": "srp",
    "sk": "slk", "sl": "slv", "et": "est", "lv": "lav", "lt": "lit",
    "fa": "fas", "ca": "cat", "gl": "glg", "bn": "ben", "ta": "tam",
    "te": "tel", "ml": "mal", "pa": "pan",
    "eng": "eng", "dan": "dan", "tha": "tha", "jpn": "jpn", "ger": "deu",
    "deu": "deu", "fre": "fra", "fra": "fra", "spa": "spa", "ita": "ita",
    "por": "por", "rus": "rus", "kor": "kor", "chi": "chi_sim",
    "zho": "chi_sim", "ara": "ara", "hin": "hin", "tur": "tur", "dut": "nld",
    "nld": "nld", "pol": "pol", "swe": "swe", "nor": "nor", "fin": "fin",
    "gre": "ell", "ell": "ell", "cze": "ces", "ces": "ces", "heb": "heb",
    "hun": "hun", "rum": "ron", "ron": "ron", "vie": "vie", "ind": "ind",
    "ukr": "ukr", "bul": "bul", "hrv": "hrv", "srp": "srp", "slo": "slk",
    "slk": "slk", "slv": "slv", "est": "est", "lav": "lav", "lit": "lit",
    "per": "fas", "fas": "fas", "cat": "cat", "glg": "glg", "ben": "ben",
    "tam": "tam", "tel": "tel", "mal": "mal", "pan": "pan",
}

_IDX_TIMESTAMP = re.compile(r"timestamp:\s*(\d+):(\d{2}):(\d{2})[:.](\d{1,3})", re.I)


def run(payload: dict, progress, cancel_event) -> dict:
    image_kind = (payload.get("imageKind") or "").lower()
    image_path = payload.get("imagePath") or ""
    ocr_lang = payload.get("ocrLang") or None
    if not image_path or not os.path.exists(image_path):
        raise EngineError(f"subtitle image not found: {image_path}", code="media_missing")

    lang = _normalize_lang_list(_resolve_lang(ocr_lang))
    _assert_ocr_ready(lang)

    if image_kind == "pgs":
        srt, rows, empty, kind = _ocr_pgs(image_path, lang, progress, cancel_event)
    elif image_kind == "vobsub":
        srt, rows, empty, kind = _ocr_vobsub(image_path, lang, progress, cancel_event)
    else:
        raise EngineError(f"unknown image kind: {image_kind}", code="bad_payload")
    return {"srt": srt, "ocrRows": rows, "emptyRows": empty, "kind": kind}



_SEG_PCS = 0x16
_SEG_END = 0x80
_COMPOSITION_STATE_EPOCH_START = 0x80


def _ocr_pgs(sup_path: str, lang: str, progress, cancel_event) -> tuple[str, int, int, str]:
    width, height, pairs = _parse_pgs_sup(sup_path)
    fps = 10
    duration_sec = -(-(pairs[-1][1] + 1000) // 1000)

    tmp = tempfile.mkdtemp(prefix="bcookiesubs-pgs-ocr-")
    try:
        burned = os.path.join(tmp, "burned.mkv")
        _run_ffmpeg([
            "-y", "-hide_banner", "-loglevel", "error",
            "-copyts", "-fflags", "+genpts",
            "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r={fps}",
            "-i", sup_path,
            "-filter_complex", "[0:v][1:s]overlay=0:0",
            "-t", str(duration_sec),
            "-an",
            "-c:v", "ffv1",
            burned,
        ], 600, "ffmpeg burn PGS")

        frames_dir = os.path.join(tmp, "frames")
        os.makedirs(frames_dir, exist_ok=True)
        return _ocr_events(pairs, fps, burned, frames_dir, lang, progress, cancel_event, "pgs")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _parse_pgs_sup(sup_path: str):
    try:
        raw = open(sup_path, "rb").read()
    except OSError as exc:
        raise EngineError(f"could not read PGS .sup file: {exc}")
    if len(raw) < 13:
        raise EngineError("PGS .sup is too short to contain any PES packets")

    width = height = 0
    pcs: list[tuple[int, int, int]] = []  # (ptsMs, state, objectCount)
    i = 0
    while i + 13 <= len(raw):
        if raw[i] != 0x50 or raw[i + 1] != 0x47:
            i += 1
            continue
        pts_ticks = int.from_bytes(raw[i + 2:i + 6], "big")
        seg_type = raw[i + 10]
        seg_len = int.from_bytes(raw[i + 11:i + 13], "big")
        seg_start = i + 13
        if seg_start + seg_len > len(raw):
            break
        seg = raw[seg_start:seg_start + seg_len]

        if seg_type == _SEG_PCS and len(seg) >= 11:
            w = int.from_bytes(seg[0:2], "big")
            h = int.from_bytes(seg[2:4], "big")
            if w > 0 and h > 0:
                width, height = w, h
            state = seg[7]
            object_count = seg[10]
            pcs.append((pts_ticks // 90, state, object_count))

        i = seg_start + seg_len

    if width == 0 or height == 0:
        raise EngineError("PGS .sup is missing the presentation composition header — file may be malformed or empty")

    events: list[tuple[int, int]] = []
    for k, (pts_ms, state, objects) in enumerate(pcs):
        if state != _COMPOSITION_STATE_EPOCH_START or objects == 0:
            continue
        start = pts_ms
        end = start + 2000
        for next_pts, _, _ in pcs[k + 1:]:
            if next_pts > start:
                end = next_pts
                break
        if end <= start:
            end = start + 1000
        events.append((start, end))

    if not events:
        raise EngineError("PGS .sup contains no subtitle display events — file may be malformed or empty")
    return width, height, events



def _ocr_vobsub(sub_path: str, lang: str, progress, cancel_event) -> tuple[str, int, int, str]:
    idx_path = os.path.splitext(sub_path)[0] + ".idx"
    if not os.path.exists(idx_path):
        raise EngineError(f"VobSub .idx file not found: {idx_path}")
    width, height, starts = _parse_vobsub_idx(idx_path)
    pairs = _build_start_end_pairs(starts)

    fps = 2
    duration_sec = -(-(pairs[-1][1] + 1000) // 1000)
    burn_timeout = max(300, duration_sec * 3)

    tmp = tempfile.mkdtemp(prefix="bcookiesubs-vobsub-ocr-")
    try:
        frames_dir = os.path.join(tmp, "frames")
        os.makedirs(frames_dir, exist_ok=True)
        _run_ffmpeg([
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r={fps}",
            "-i", idx_path,
            "-filter_complex", "[0:v][1:s]overlay=0:0",
            "-t", str(duration_sec),
            "-an",
            os.path.join(frames_dir, "f_%06d.png"),
        ], burn_timeout, "ffmpeg burn VobSub")

        frames = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
        if not frames:
            raise EngineError("ffmpeg produced no rendered frames — the .idx/.sub pair may be invalid")

        entries: list[tuple[int, int, str]] = []
        empty_rows = 0
        for i, (start_ms, end_ms) in enumerate(pairs):
            if cancel_event.is_set():
                _abort_partial(entries, empty_rows)
            mid_sec = (start_ms + end_ms) / 2 / 1000
            fi = min(len(frames) - 1, max(0, int(mid_sec * fps)))
            frame_path = os.path.join(frames_dir, frames[fi])
            text = _ocr_frame(frame_path, lang)
            if not text:
                empty_rows += 1
            else:
                entries.append((start_ms, end_ms, text))
            _report(progress, len(entries) + empty_rows, len(pairs))
        if not entries:
            raise EngineError(
                f"VobSub OCR produced no text rows (0/{len(pairs)} events recognised). "
                f"Check the Tesseract language pack ({lang}) and the subtitle image quality.")
        return _serialize_srt(entries), len(entries), empty_rows, "vobsub"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _parse_vobsub_idx(idx_path: str):
    try:
        raw = open(idx_path, encoding="utf-8", errors="replace").read()
    except OSError as exc:
        raise EngineError(f"could not read VobSub .idx file: {exc}")

    width, height = 720, 480
    size_match = re.search(r"size:\s*(\d+)x(\d+)", raw, re.I)
    if size_match:
        width, height = int(size_match.group(1)), int(size_match.group(2))

    starts: list[int] = []
    for line in raw.splitlines():
        m = _IDX_TIMESTAMP.search(line)
        if m:
            h, mm, s, ms = m.groups()
            starts.append((int(h) * 3_600_000 + int(mm) * 60_000 + int(s) * 1000
                           + int(ms.ljust(3, "0"))))
    if not starts:
        raise EngineError("VobSub .idx contains no subtitle timestamps — file may be malformed or empty")
    return width, height, starts


def _build_start_end_pairs(starts: list[int]) -> list[tuple[int, int]]:
    pairs: list[tuple[int, int]] = []
    for i, start in enumerate(starts):
        nxt = starts[i + 1] if i + 1 < len(starts) else None
        end = nxt if nxt is not None and nxt > start else start + 2000
        if end <= start:
            end = start + 1000
        pairs.append((start, end))
    return pairs



def _ocr_events(pairs, fps, burned, frames_dir, lang, progress, cancel_event, kind):
    entries: list[tuple[int, int, str]] = []
    empty_rows = 0
    for i, (start_ms, end_ms) in enumerate(pairs):
        if cancel_event.is_set():
            _abort_partial(entries, empty_rows)
        mid_sec = (start_ms + end_ms) / 2 / 1000
        frame_path = os.path.join(frames_dir, f"f_{i:06d}.png")
        result = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-ss", f"{mid_sec:.3f}", "-i", burned,
             "-frames:v", "1", "-q:v", "2", frame_path],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0 or not os.path.exists(frame_path):
            empty_rows += 1
            continue
        text = _ocr_frame(frame_path, lang)
        if not text:
            empty_rows += 1
        else:
            entries.append((start_ms, end_ms, text))
        _report(progress, len(entries) + empty_rows, len(pairs))
    if not entries:
        raise EngineError(
            f"PGS OCR produced no text rows (0/{len(pairs)} events recognised). "
            f"Check the Tesseract language pack ({lang}) and the subtitle image quality.")
    return _serialize_srt(entries), len(entries), empty_rows, kind


def _abort_partial(entries, empty_rows: int) -> None:
    raise JobAborted(
        checkpoint=None,
        message=f"aborted after {len(entries)} rows ({empty_rows} empty)",
    )


def _ocr_frame(frame_path: str, lang: str) -> str:
    try:
        result = subprocess.run(
            ["tesseract", frame_path, "stdout", "-l", lang, "--psm", "6"],
            capture_output=True, text=True, timeout=30,
        )
    except (subprocess.SubprocessError, OSError):
        return ""
    if result.returncode != 0:
        return ""
    return (result.stdout or "").replace("\r", "").replace("|", "I").strip()


def _report(progress, done: int, total: int) -> None:
    if total <= 0:
        return
    pct = int(min(100, done * 100 / total))
    progress(pct, "")


def _run_ffmpeg(args: list[str], timeout_sec: int, label: str) -> None:
    try:
        result = subprocess.run(["ffmpeg"] + args, capture_output=True, text=True,
                                timeout=timeout_sec)
    except subprocess.SubprocessError as exc:
        raise EngineError(f"{label}: {str(exc)[:160]}")
    except OSError as exc:
        raise EngineError(f"{label}: ffmpeg not available: {exc}", code="ffmpeg_missing")
    if result.returncode != 0:
        reason = (result.stderr or "").strip().splitlines()[:1]
        raise EngineError(f"{label}: {reason[0][:200] if reason else 'ffmpeg exited non-zero'}")


def _resolve_lang(hint: str | None) -> str:
    if not hint:
        return FALLBACK_OCR_LANG
    return APP_LANG_TO_TESSERACT.get(hint.lower(), FALLBACK_OCR_LANG)


def _normalize_lang_list(lang: str) -> str:
    parts = [p.strip().lower() for p in lang.split("+") if p.strip()]
    mapped = [APP_LANG_TO_TESSERACT.get(p, p) for p in parts]
    return "+".join(mapped) if mapped else FALLBACK_OCR_LANG


def _assert_ocr_ready(lang: str) -> None:
    if shutil.which("tesseract") is None:
        raise EngineError(
            "Tesseract OCR is not installed or not on PATH. Install `tesseract-ocr` "
            "and the needed language packs.", code="tesseract_missing")
    result = subprocess.run(["tesseract", "--list-langs"], capture_output=True,
                            text=True, timeout=30)
    available = set()
    if result.returncode == 0:
        for line in (result.stdout or "").splitlines():
            t = line.strip().lower()
            if t and not t.startswith("list of available") and t != "osd":
                available.add(t)
    missing = [p for p in lang.split("+") if p and p not in available]
    if missing:
        raise EngineError(
            f'Tesseract language data for "{", ".join(missing)}" is not installed. '
            f"Install the matching tesseract-ocr language pack(s) (requested OCR language: {lang}).",
            code="tesseract_lang_missing")



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