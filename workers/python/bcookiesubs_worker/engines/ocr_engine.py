
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
import time

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



_SEG_PDS = 0x14
_SEG_ODS = 0x15
_SEG_PCS = 0x16
_SEG_END = 0x80
_COMPOSITION_STATE_EPOCH_START = 0x80
_OBJ_CROPPED = 0x80

_UNSET_PIXEL = 255  # palette key treated as "no pixel drawn"


def _ocr_pgs(sup_path: str, lang: str, progress, cancel_event) -> tuple[str, int, int, str]:
    events = _parse_pgs_sup(sup_path)
    entries: list[tuple[int, int, str]] = []
    empty_rows = 0
    tmp = tempfile.mkdtemp(prefix="bcookiesubs-pgs-ocr-")
    try:
        frame_path = os.path.join(tmp, "f.ppm")
        total = len(events)
        for start_ms, end_ms, width, height, rgb in events:
            if cancel_event.is_set():
                _abort_partial(entries, empty_rows)
            # One PPM per event straight into tesseract — no full-movie video
            # burn, so progress (and the server lease) stays alive throughout.
            with open(frame_path, "wb") as fh:
                # Tesseract wants dark text on a light page: compose the
                # bitmap on black, then invert.
                fh.write(f"P6\n{width} {height}\n255\n".encode("ascii"))
                fh.write(bytes(255 - v for v in rgb))
            text = _ocr_frame(frame_path, lang)
            if not text:
                empty_rows += 1
            else:
                entries.append((start_ms, end_ms, text))
            _report(progress, len(entries) + empty_rows, total)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not entries:
        raise EngineError(
            f"PGS OCR produced no text rows (0/{len(events)} events recognised). "
            f"Check the Tesseract language pack ({lang}) and the subtitle image quality.")
    return _serialize_srt(entries), len(entries), empty_rows, "pgs"


def _parse_pgs_sup(sup_path: str):
    try:
        raw = open(sup_path, "rb").read()
    except OSError as exc:
        raise EngineError(f"could not read PGS .sup file: {exc}")
    if len(raw) < 13:
        raise EngineError("PGS .sup is too short to contain any PES packets")

    segs: list[tuple[int, int, bytes]] = []
    width = height = 0
    i = 0
    while i + 13 <= len(raw):
        if raw[i] != 0x50 or raw[i + 1] != 0x47:
            i += 1
            continue
        pts_ms = int.from_bytes(raw[i + 2:i + 6], "big") // 90
        seg_type = raw[i + 10]
        seg_len = int.from_bytes(raw[i + 11:i + 13], "big")
        seg_start = i + 13
        if seg_start + seg_len > len(raw):
            break
        body = raw[seg_start:seg_start + seg_len]
        if seg_type == _SEG_PCS and len(body) >= 4 and width == 0:
            w = int.from_bytes(body[0:2], "big")
            h = int.from_bytes(body[2:4], "big")
            if w > 0 and h > 0:
                width, height = w, h
        segs.append((pts_ms, seg_type, body))
        i = seg_start + seg_len

    if width == 0 or height == 0:
        raise EngineError("PGS .sup is missing the presentation composition header — file may be malformed or empty")
    return _compose_pgs_events(segs, width, height)


def _compose_pgs_events(segs, video_w: int, video_h: int):
    """Rasterize each epoch into (start, end, w, h, rgb) events."""
    palettes: dict[int, bytearray] = {}
    objects: dict[int, tuple[int, int, bytes]] = {}
    epoch_pts: list[int] = []
    pending: dict | None = None
    skipped_epochs = 0
    events: list[tuple[int, int, int, int, bytes]] = []

    def flush() -> tuple[int, int, int, int, bytes] | None:
        if pending is None:
            return None
        placement: list[tuple[int, int, int, int, bytes]] = []
        for oid, x, y in pending["objects"]:
            meta = objects.get(oid)
            if meta is None:
                return None  # referenced object never arrived — incomplete epoch
            w, h, rle = meta
            placement.append((x, y, w, h, rle))
        if not placement:
            return None
        pal = palettes.get(pending["palette"]) if pending["palette"] is not None else None
        if pal is None:
            return None
        x0 = min(x for x, _, _, _, _ in placement)
        y0 = min(y for _, y, _, _, _ in placement)
        x1 = max(x + w for x, _, w, _, _ in placement)
        y1 = max(y + h for _, y, _, h, _ in placement)
        cw, ch = x1 - x0, y1 - y0
        if cw <= 0 or ch <= 0 or cw > video_w * 2 or ch > video_h * 2:
            return None
        rgb = bytearray(cw * ch * 3)
        for x, y, w, h, rle in placement:
            _rle_to_rgb(rle, w, h, x - x0, y - y0, cw, ch, pal, rgb)
        return (pending["start"], pending["end"], cw, ch, bytes(rgb))

    def _append_objects(pending, body):
        off = 11
        for _ in range(body[10]):
            if off + 8 > len(body):
                break
            oid = int.from_bytes(body[off:off + 2], "big")
            flag = body[off + 3]
            x = int.from_bytes(body[off + 4:off + 6], "big")
            y = int.from_bytes(body[off + 6:off + 8], "big")
            off += 8
            if flag & _OBJ_CROPPED:
                off += 8  # crop rectangle
            entry = (oid, x, y)
            if entry not in pending["objects"]:
                pending["objects"].append(entry)

    for pts_ms, seg_type, body in segs:
        if seg_type == _SEG_PCS and len(body) >= 11 and body[7] == _COMPOSITION_STATE_EPOCH_START:
            if pending is not None:
                if pending["end"] <= pending["start"]:
                    pending["end"] = pts_ms
                ev = flush()
                if ev is None and pending["objects"]:
                    skipped_epochs += 1
                elif ev is not None:
                    events.append(ev)
            objects = {}
            palettes = {}
            epoch_pts.append(pts_ms)
            pending = {"start": pts_ms, "end": -1, "objects": [], "palette": None}
            _append_objects(pending, body)
        elif seg_type == _SEG_PCS and len(body) >= 11 and pending is not None:
            # Normal/acquisition PCS re-lists the same composition objects.
            _append_objects(pending, body)
        elif seg_type == _SEG_PDS and len(body) >= 7 and pending is not None:
            palette_key = body[0]
            if pending["palette"] is None:
                pending["palette"] = palette_key
            table = palettes.setdefault(palette_key, bytearray(768))
            for off in range(2, len(body) - 4, 5):
                key, yy, cb, cr, a = body[off], body[off + 1], body[off + 2], body[off + 3], body[off + 4]
                if key < 256:
                    if a == 0:
                        continue  # fully transparent — leave the pixel black
                    _palette_ycc_to_rgb(table, key, yy, cb, cr)
        elif seg_type == _SEG_ODS and len(body) >= 8:
            oid = int.from_bytes(body[0:2], "big")
            seq = body[3]
            meta = objects.get(oid)
            if seq & 0x80 and pending is not None:
                # First (or re-sent) fragment: start the object over.
                # mkvextract prefixes a 3-byte object length and stores
                # width/height at offsets 7/9; fall back to the classic
                # w/h-at-4/6 layout when that does not check out.
                declared = (body[4] << 16) | (body[5] << 8) | body[6]
                w = int.from_bytes(body[7:9], "big")
                h = int.from_bytes(body[9:11], "big")
                if not (0 < w <= video_w and 0 < h <= video_h * 2 and declared == len(body) - 7):
                    w = int.from_bytes(body[4:6], "big")
                    h = int.from_bytes(body[6:8], "big")
                    rle = body[8:]
                else:
                    rle = body[11:]
                if w > 0 and h > 0:
                    objects[oid] = (w, h, bytes(rle))
            elif meta is not None:
                objects[oid] = (meta[0], meta[1], meta[2] + body[4:])
        elif seg_type == _SEG_END and pending is not None:
            pending["end"] = pts_ms

    if pending is not None:
        ev = flush()
        if ev is None and pending["objects"]:
            skipped_epochs += 1
        elif ev is not None:
            events.append(ev)

    fixed: list[tuple[int, int, int, int, bytes]] = []
    for k, ev in enumerate(events):
        start, end, w, h, rgb = ev
        if end <= start:
            end = start + 2000
        if end <= start:
            end = start + 1000
        fixed.append((start, end, w, h, rgb))
    if not fixed:
        if skipped_epochs:
            raise EngineError(
                "PGS display sets could not be rasterized — referenced objects or palettes are missing")
        raise EngineError("PGS .sup contains no subtitle display events — file may be malformed or empty")
    return fixed


def _palette_ycc_to_rgb(table: bytearray, key: int, yy: int, cb: int, cr: int) -> None:
    cy = yy - 16
    cbd = cb - 128
    crd = cr - 128
    r = (298 * cy + 409 * crd + 128) >> 8
    g = (298 * cy - 100 * cbd - 208 * crd + 128) >> 8
    b = (298 * cy + 516 * cbd + 128) >> 8
    base = key * 3
    table[base] = max(0, min(255, r))
    table[base + 1] = max(0, min(255, g))
    table[base + 2] = max(0, min(255, b))


def _rle_to_rgb(rle: bytes, width: int, height: int, dst_x: int, dst_y: int,
                canvas_w: int, canvas_h: int, palette: bytearray, rgb: bytearray) -> None:
    """Decode PGS RLE runs into an RGB canvas row by row.

    Run encoding (verified against real .sup files):
      00 00   end of line · 01-3F run of zeros · 40-BF 6-bit run + color byte
      C0-FF   14-bit run + color byte
    """
    pos = 0
    x = 0
    y = 0
    n = len(rle)
    # The run at the end of a line often reaches exactly `width`; such a line
    # also ends with an explicit EOL marker. Avoid advancing rows twice.
    x_just_wrapped = False
    while pos < n and y < height:
        b = rle[pos]
        pos += 1
        if b != 0:
            count = 1
            key = b
        else:
            if pos >= n:
                break
            b2 = rle[pos]
            pos += 1
            if b2 == 0:
                if not x_just_wrapped:
                    y += 1
                x_just_wrapped = False
                x = 0
                continue
            x_just_wrapped = False
            if b2 <= 0x3F:
                count = b2 & 0x3F
                key = 0
            elif b2 <= 0xBF:
                if pos >= n:
                    break
                count = b2 & 0x3F
                key = rle[pos]
                pos += 1
            else:
                if pos + 1 >= n:
                    break
                count = ((b2 & 0x3F) << 8) | rle[pos]
                key = rle[pos + 1]
                pos += 2

        if count <= 0 or key == _UNSET_PIXEL or key >= 256:
            # nothing drawn, still advance (key 255 is the palette's
            # background color here — the canvas is black already)
            pass
        else:
            row = y + dst_y
            if 0 <= row < canvas_h:
                col = x + dst_x
                if col < canvas_w:
                    count = min(count, canvas_w - col)
                    start = (row * canvas_w + col) * 3
                    end = start + count * 3
                    base = key * 3
                    rgb[start:end] = bytes(palette[base:base + 3]) * count

        x += count
        if x >= width:
            x = 0
            y += 1
            x_just_wrapped = True



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
        _run_ffmpeg_progress(
            [
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r={fps}",
                "-i", idx_path,
                "-filter_complex", "[0:v][1:s]overlay=0:0",
                "-t", str(duration_sec),
                "-an",
                os.path.join(frames_dir, "f_%06d.png"),
            ],
            burn_timeout, "ffmpeg burn VobSub", fps, duration_sec * fps,
            progress, cancel_event)

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


def _run_ffmpeg_progress(args: list[str], timeout_sec: int, label: str, fps: int,
                         total_frames: int, progress, cancel_event) -> None:
    """Run a burn ffmpeg, streaming -progress output as job progress.

    The streamed progress doubles as the server-side heartbeat, keeping the
    job lease renewed while ffmpeg works.
    """
    args = args[:-1] + ["-progress", "pipe:1", args[-1]]
    deadline = time.monotonic() + timeout_sec
    err_file = tempfile.TemporaryFile()
    proc = None
    try:
        try:
            proc = subprocess.Popen(["ffmpeg"] + args, stdout=subprocess.PIPE,
                                    stderr=err_file, text=True)
        except OSError as exc:
            raise EngineError(f"{label}: ffmpeg not available: {exc}", code="ffmpeg_missing")

        for line in proc.stdout:
            if cancel_event.is_set():
                proc.terminate()
                _abort_partial([], 0)
            if line.startswith(("out_time_us=", "out_time_ms=")):
                try:
                    micros = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                if total_frames > 0:
                    done = min(total_frames, int(micros / 1_000_000 * fps))
                    _report(progress, done, total_frames)
            if time.monotonic() > deadline:
                proc.kill()
                raise EngineError(f"{label}: timed out after {timeout_sec}s")
        proc.stdout.close()
        code = proc.wait(timeout=max(1.0, deadline - time.monotonic()))
        if code != 0:
            err_file.seek(0)
            text = err_file.read().decode("utf-8", "replace")
            reason = text.strip().splitlines()[:1]
            raise EngineError(f"{label}: {reason[0][:200] if reason else 'ffmpeg exited non-zero'}")
    except subprocess.SubprocessError as exc:
        if proc is not None:
            proc.kill()
        raise EngineError(f"{label}: {str(exc)[:160]}")
    finally:
        err_file.close()
        if proc is not None and proc.poll() is None:
            proc.kill()


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
