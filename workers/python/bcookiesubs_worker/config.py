
from __future__ import annotations

import os
from dataclasses import dataclass, field


class ConfigError(RuntimeError):
    pass


@dataclass
class WorkerConfig:
    server_url: str
    worker_name: str
    worker_id: int | None
    worker_secret: str | None
    enrollment_token: str | None
    capabilities: list[str]
    max_concurrency: int
    heartbeat_interval: int
    insecure: bool
    data_dir: str
    machine_identifier: str
    worker_version: str = "1.0.0"
    reconnect_max_backoff: float = 30.0

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        server_url = os.environ.get("BCOKIESUBS_SERVER_URL", "").strip()
        if not server_url:
            raise ConfigError("BCOKIESUBS_SERVER_URL is required (e.g. http://worker:5100)")

        data_dir = os.environ.get("WORKER_DATA_DIR", "data").strip() or "data"
        identity = _read_identity(data_dir)

        worker_id = _int_or_none(os.environ.get("WORKER_ID")) or (identity or {}).get("worker_id")
        worker_secret = os.environ.get("WORKER_SECRET") or (identity or {}).get("worker_secret")
        enrollment_token = os.environ.get("WORKER_ENROLLMENT_TOKEN") or None

        if not enrollment_token and (worker_id is None or not worker_secret):
            raise ConfigError(
                "Either WORKER_ENROLLMENT_TOKEN (first run) or WORKER_ID + WORKER_SECRET is required."
            )

        capabilities = [c.strip() for c in os.environ.get("WORKER_CAPABILITIES", "whisper,ocr").split(",") if c.strip()]
        return cls(
            server_url=server_url.rstrip("/"),
            worker_name=os.environ.get("WORKER_NAME", "python-worker").strip() or "python-worker",
            worker_id=worker_id,
            worker_secret=worker_secret,
            enrollment_token=enrollment_token,
            capabilities=capabilities,
            max_concurrency=max(1, _int_or_none(os.environ.get("WORKER_MAX_CONCURRENCY")) or 1),
            heartbeat_interval=max(3, _int_or_none(os.environ.get("WORKER_HEARTBEAT_INTERVAL")) or 10),
            insecure=os.environ.get("WORKER_INSECURE", "").strip().lower() in {"1", "true", "yes"},
            data_dir=data_dir,
            machine_identifier=os.environ.get("WORKER_MACHINE_IDENTIFIER", "").strip() or _machine_identifier(data_dir),
        )


def _int_or_none(raw: str | None) -> int | None:
    try:
        return int(raw) if raw else None
    except ValueError:
        return None


def _machine_identifier(data_dir: str) -> str:
    identity = _read_identity(data_dir) or {}
    machine_id = identity.get("machine_identifier")
    if not machine_id:
        machine_id = uuid4_hex()
        identity.update(machine_identifier=machine_id)
        _write_identity(data_dir, identity)
    return machine_id


def _identity_path(data_dir: str) -> str:
    return os.path.join(data_dir, "identity.json")


def _read_identity(data_dir: str) -> dict | None:
    try:
        import json

        with open(_identity_path(data_dir), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _write_identity(data_dir: str, identity: dict) -> None:
    import json
    import os

    os.makedirs(data_dir, exist_ok=True)
    path = _identity_path(data_dir)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(identity, fh, indent=2)


def save_worker_identity(data_dir: str, worker_id: int, worker_secret: str) -> None:
    identity = _read_identity(data_dir) or {}
    identity["worker_id"] = worker_id
    identity["worker_secret"] = worker_secret
    _write_identity(data_dir, identity)


def uuid4_hex() -> str:
    import uuid

    return uuid.uuid4().hex