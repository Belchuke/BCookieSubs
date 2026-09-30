
from __future__ import annotations

import logging
import queue
import random
import threading
import time
import urllib.parse

import grpc

from .config import WorkerConfig, save_worker_identity
from .hardware import collect
from .generated import worker_gateway_pb2 as pb
from .generated import worker_gateway_pb2_grpc as pb_grpc

logger = logging.getLogger("bcookiesubs.worker")


class WorkerClient:
    def __init__(self, config: WorkerConfig, runner=None) -> None:
        self._config = config
        self._runner = runner
        self._stop = threading.Event()
        self._draining = threading.Event()
        self._heartbeat_interval = config.heartbeat_interval
        self._active_outgoing: queue.Queue | None = None
        self._fatal_error: str | None = None

    def stop(self, reason: str = "shutdown") -> None:
        self._stop.set()
        if self._active_outgoing is not None:
            self._active_outgoing.put(pb.ClientMessage(disconnect=pb.Disconnect(reason=reason)))

    @property
    def fatal_error(self) -> str | None:
        return self._fatal_error

    def run_forever(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                self._run_session()
                backoff = 1.0
            except grpc.RpcError as exc:
                logger.warning("gateway stream failed: %s", exc)
            except Exception:  # noqa: BLE001 - never crash the reconnect loop
                logger.exception("unexpected error in gateway session")

            if self._stop.is_set():
                break

            sleep_for = min(backoff, self._config.reconnect_max_backoff) + random.uniform(0, 0.5)
            logger.info("reconnecting in %.1fs", sleep_for)
            if self._stop.wait(sleep_for):
                break
            backoff = min(backoff * 2, self._config.reconnect_max_backoff)


    def _run_session(self) -> None:
        with self._make_channel() as channel:
            stub = pb_grpc.WorkerGatewayStub(channel)
            outgoing: queue.Queue = queue.Queue()
            session_stop = threading.Event()

            response_iter = stub.Connect(self._outgoing_messages(outgoing, session_stop))
            self._active_outgoing = outgoing

            heartbeat = threading.Thread(
                target=self._heartbeat_loop, args=(outgoing, session_stop), daemon=True
            )
            heartbeat.start()

            try:
                for message in response_iter:
                    if not self._handle_server_message(message):
                        return
            except grpc.RpcError:
                raise
            finally:
                session_stop.set()
                outgoing.put(None)  # unblock the outgoing iterator
                heartbeat.join(timeout=5)
                self._active_outgoing = None

    def _make_channel(self) -> grpc.Channel:
        options = [("grpc.keepalive_time_ms", 20000), ("grpc.keepalive_timeout_ms", 10000)]
        target, secure = self._channel_target()
        if self._config.insecure:
            secure = False
        if secure:
            return grpc.secure_channel(target, grpc.ssl_channel_credentials(), options)
        return grpc.insecure_channel(target, options)

    def _channel_target(self) -> tuple[str, bool]:
        raw = self._config.server_url
        if "://" not in raw:
            return raw, False
        parts = urllib.parse.urlsplit(raw)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        return f"{parts.hostname}:{port}", parts.scheme == "https"

    def _outgoing_messages(self, outgoing: queue.Queue, session_stop: threading.Event):
        yield self._first_message()
        while not session_stop.is_set():
            try:
                message = outgoing.get(timeout=0.5)
            except queue.Empty:
                continue
            if message is None:
                break
            yield message

    def _first_message(self):
        config = self._config
        capabilities = config.capabilities
        hardware = collect()
        if config.enrollment_token and (config.worker_id is None or not config.worker_secret):
            return pb.ClientMessage(
                enroll=pb.EnrollRequest(
                    enrollment_token=config.enrollment_token,
                    worker_name=config.worker_name,
                    machine_identifier=config.machine_identifier,
                    worker_version=config.worker_version,
                    capabilities=capabilities,
                    max_concurrency=config.max_concurrency,
                    hardware=pb.WorkerHardware(**hardware),
                )
            )
        return pb.ClientMessage(
            auth=pb.AuthRequest(
                worker_id=config.worker_id or 0,
                worker_secret=config.worker_secret or "",
                machine_identifier=config.machine_identifier,
                worker_version=config.worker_version,
                capabilities=capabilities,
                max_concurrency=config.max_concurrency,
                hardware=pb.WorkerHardware(**hardware),
            )
        )

    def _heartbeat_loop(self, outgoing: queue.Queue, session_stop: threading.Event) -> None:
        while not session_stop.is_set():
            active = self._runner.active_count() if self._runner is not None else 0
            outgoing.put(
                pb.ClientMessage(
                    heartbeat=pb.Heartbeat(
                        ready=not self._draining.is_set(),
                        active_jobs=active,
                        sent_at_unix=int(time.time()),
                    )
                )
            )
            if session_stop.wait(self._heartbeat_interval):
                break

    def _handle_server_message(self, message) -> bool:
        kind = message.WhichOneof("payload")

        if kind == "enroll_result":
            result = message.enroll_result
            if result.success:
                logger.info("enrolled as %s (id=%s)", result.assigned_name, result.worker_id)
                save_worker_identity(self._config.data_dir, result.worker_id, result.worker_secret)
                self._config.worker_id = result.worker_id
                self._config.worker_secret = result.worker_secret
                self._config.enrollment_token = None
            else:
                logger.error("enrollment rejected: %s", result.message)
                self._fatal_error = result.message
                self._stop.set()
                return False

        elif kind == "auth_result":
            result = message.auth_result
            if not result.success:
                logger.error("authentication rejected: %s", result.message)
                self._fatal_error = result.message
                self._stop.set()
                return False
            logger.info("authenticated")

        elif kind == "config_update":
            if message.config_update.heartbeat_interval_seconds > 0:
                self._heartbeat_interval = message.config_update.heartbeat_interval_seconds
            if message.config_update.draining and not self._draining.is_set():
                self._draining.set()
                logger.info("server requested drain; reporting not-ready")
            elif not message.config_update.draining and self._draining.is_set():
                self._draining.clear()
                logger.info("server resumed; reporting ready")

        elif kind == "drain":
            self._draining.set()
            logger.info("drain command received")

        elif kind == "resume":
            self._draining.clear()
            logger.info("resume command received")

        elif kind == "job":
            assignment = message.job
            if self._runner is None:
                logger.error("job assignment received but no runner is wired up")
                self._send_job_result(job_id=assignment.job_id, success=False,
                                      error_code="no_runner", error_message="runner not configured")
            else:
                logger.info("job %s assigned (%s)", assignment.job_id, assignment.job_type)
                self._runner.submit(assignment.job_id, assignment.job_type, assignment.payload)

        elif kind == "job_cancel":
            cancel = message.job_cancel
            if self._runner is not None:
                self._runner.cancel(cancel.job_id, cancel.reason)

        elif kind == "disconnect":
            logger.info("server disconnect: %s", message.disconnect.reason)
            return False

        return True


    def _send_job_progress(self, job_id: int, progress: int, status: str) -> None:
        if self._active_outgoing is not None:
            self._active_outgoing.put(pb.ClientMessage(
                job_progress=pb.JobProgress(job_id=job_id, progress=progress, status=status)
            ))

    def _send_job_result(self, job_id: int, success: bool, result: str = "",
                         error_code: str = "", error_message: str = "") -> None:
        if self._active_outgoing is not None:
            self._active_outgoing.put(pb.ClientMessage(
                job_result=pb.JobResult(
                    job_id=job_id, success=success, result=result,
                    error_code=error_code, error_message=error_message,
                )
            ))