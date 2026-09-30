
from __future__ import annotations

from ..hardware import collect
from ..generated import worker_gateway_pb2 as pb


def hardware_message() -> pb.WorkerHardware:
    return pb.WorkerHardware(**collect())


def capability_list(raw: str | None, default: str = "whisper,ocr") -> list[str]:
    return [c.strip() for c in (raw or default).split(",") if c.strip()]