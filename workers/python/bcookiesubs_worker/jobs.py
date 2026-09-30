
from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field

from .engines import ocr_engine, whisper_engine
from .errors import EngineError, JobAborted

logger = logging.getLogger("bcookiesubs.worker.jobs")


@dataclass
class RunningJob:
    job_id: int
    job_type: str
    cancel_event: threading.Event
    thread: threading.Thread | None = None
    started_at: float = field(default_factory=time.time)


class JobRunner:
    def __init__(self, max_concurrency: int = 1) -> None:
        self._max_concurrency = max(1, max_concurrency)
        self._jobs: dict[int, RunningJob] = {}
        self._lock = threading.Lock()
        self._send_progress = lambda job_id, progress, status: None
        self._send_result = lambda **kwargs: None

    def bind(self, send_progress, send_result) -> None:
        self._send_progress = send_progress
        self._send_result = send_result

    def active_count(self) -> int:
        with self._lock:
            return len(self._jobs)

    def submit(self, job_id: int, job_type: str, payload_json: str) -> None:
        with self._lock:
            existing = self._jobs.get(job_id)
            if existing is not None:
                logger.warning("job %s already running; ignoring duplicate assignment", job_id)
                return
            job = RunningJob(job_id=job_id, job_type=job_type, cancel_event=threading.Event())
            thread = threading.Thread(
                target=self._run, args=(job_id, job_type, payload_json, job), daemon=True
            )
            job.thread = thread
            self._jobs[job_id] = job
        thread.start()

    def cancel(self, job_id: int, reason: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            logger.info("cancel for unknown job %s (%s)", job_id, reason)
            return
        job.cancel_event.set()
        logger.info("cancel signalled for job %s (%s)", job_id, reason)


    def _run(self, job_id: int, job_type: str, payload_json: str, job: RunningJob) -> None:
        try:
            payload = json.loads(payload_json or "{}")
        except ValueError as exc:
            self._finish(job_id, success=False, error_code="bad_payload", error_message=f"bad payload: {exc}")
            return

        def progress(pct: int, status: str = "") -> None:
            self._send_progress(job_id, max(0, min(100, int(pct))), status)

        try:
            if job_type == whisper_engine.JOB_TYPE:
                result = whisper_engine.run(payload, progress, job.cancel_event)
            elif job_type == ocr_engine.JOB_TYPE:
                result = ocr_engine.run(payload, progress, job.cancel_event)
            else:
                self._finish(job_id, success=False, error_code="unknown_job_type",
                             error_message=f"no engine for job type {job_type}")
                return
            self._finish(job_id, success=True, result=json.dumps(result))
        except JobAborted as abort:
            checkpoint = json.dumps(abort.checkpoint) if abort.checkpoint else ""
            self._finish(job_id, success=False, error_code="aborted",
                         error_message=str(abort), result=checkpoint)
        except EngineError as exc:
            logger.warning("job %s failed: %s", job_id, exc)
            self._finish(job_id, success=False, error_code=exc.code, error_message=str(exc))
        except Exception as exc:  # noqa: BLE001 - a crash must not kill the stream
            logger.exception("job %s crashed", job_id)
            self._finish(job_id, success=False, error_code="engine_error", error_message=str(exc)[:500])
        finally:
            with self._lock:
                self._jobs.pop(job_id, None)

    def _finish(self, job_id: int, success: bool, error_code: str = "",
                error_message: str = "", result: str = "") -> None:
        self._send_result(
            job_id=job_id, success=success, result=result,
            error_code=error_code, error_message=error_message,
        )