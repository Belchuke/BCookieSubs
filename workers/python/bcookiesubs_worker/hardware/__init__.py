
from __future__ import annotations

import os
import platform
import subprocess


def collect() -> dict:
    info = {
        "os": f"{platform.system()} {platform.release()}".strip(),
        "architecture": platform.machine() or "",
        "cpu_model": _cpu_model() or "",
        "cpu_cores": os.cpu_count() or 0,
        "ram_bytes": _ram_bytes() or 0,
        "gpu_vendor": "",
        "gpu_model": "",
        "gpu_vram_bytes": 0,
        "cuda_available": False,
        "python_version": platform.python_version(),
    }

    gpu = _nvidia_gpu()
    if gpu:
        info["gpu_vendor"] = "NVIDIA"
        info["gpu_model"] = gpu[0]
        info["gpu_vram_bytes"] = gpu[1]
        info["cuda_available"] = True

    return info


def _cpu_model() -> str:
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("model name") and ":" in line:
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    if platform.system() == "Darwin":
        return _sysctl("machdep.cpu.brand_string") or ""
    return platform.processor() or ""


def _ram_bytes() -> int:
    try:
        page = os.sysconf("SC_PAGE_SIZE")
        count = os.sysconf("SC_PHYS_PAGES")
        if page > 0 and count > 0:
            return page * count
    except (ValueError, OSError):
        pass
    if platform.system() == "Darwin":
        return int(_sysctl("hw.memsize") or 0)
    return 0


def _nvidia_gpu() -> tuple[str, int] | None:
    try:
        import subprocess

        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            name, vram_mib = result.stdout.strip().splitlines()[0].split(",")
            return name.strip(), int(float(vram_mib.strip())) * 1024 * 1024
    except Exception:
        pass
    return None


def _sysctl(key: str) -> str | None:
    try:
        import subprocess

        result = subprocess.run(["sysctl", "-n", key], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return None