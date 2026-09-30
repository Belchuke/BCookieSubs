
from __future__ import annotations


class JobAborted(Exception):

    def __init__(self, checkpoint: dict | None = None, message: str = "aborted") -> None:
        super().__init__(message)
        self.checkpoint = checkpoint


class EngineError(Exception):

    def __init__(self, message: str, code: str = "engine_error") -> None:
        super().__init__(message)
        self.code = code