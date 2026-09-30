
from __future__ import annotations


class EngineNotAvailable(RuntimeError):
    pass


ENGINES: dict[str, object] = {}


def engine_for(capability: str) -> object:
    if capability in ENGINES and ENGINES[capability] is not None:
        return ENGINES[capability]
    raise EngineNotAvailable(f"no engine available for capability '{capability}' in this version")