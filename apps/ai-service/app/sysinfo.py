"""Systemprobe: VRAM via nvidia-smi och frit RAM via Win32 — utan extra beroenden.

Används av `/health` och av Whisper-device-valet (GPU | CPU). Allt är beste-effort:
saknas `nvidia-smi` eller slår anropet fel returneras `detected_by: "unavailable"`
och inget påstående om GPU. Aldrig gissa (CONVENTIONS: äkthet).
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import platform
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass, field
from typing import Any

_CACHE_TTL_S = 3.0


@dataclass
class GpuInfo:
    name: str = "none"
    total_mb: int = 0
    used_mb: int = 0
    free_mb: int = 0
    detected_by: str = "unavailable"
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class _Cache:
    at: float = 0.0
    gpu: GpuInfo | None = None
    ram_free_mb: int = 0


_cache = _Cache()


def _run_nvidia_smi(args: list[str], timeout: float = 4.0) -> str | None:
    binary = shutil.which("nvidia-smi")
    if binary is None:
        return None
    try:
        proc = subprocess.run([binary, *args], capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    text = proc.stdout.decode("utf-8", "replace").strip()
    return text or None


def probe_gpu(*, force: bool = False) -> GpuInfo:
    """Frågar nvidia-smi; annars ingen GPU. Cacheas i tre sekunder."""
    now = time.monotonic()
    if not force and _cache.gpu is not None and now - _cache.at < _CACHE_TTL_S:
        return _cache.gpu

    info = _probe_nvidia()
    if info is None:
        info = GpuInfo(
            name="none",
            detected_by="unavailable",
            error="nvidia-smi saknas eller svarade inte",
        )
    _cache.gpu = info
    _cache.at = now
    return info


def _probe_nvidia() -> GpuInfo | None:
    csv = _run_nvidia_smi(
        ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"]
    )
    if csv is None:
        return None
    first = csv.splitlines()[0]
    parts = [p.strip() for p in first.split(",")]
    if len(parts) < 4:
        return GpuInfo(detected_by="nvidia-smi", error=f"oväntad output: {first[:80]}")

    def num(value: str) -> int:
        try:
            return int(float(value))
        except ValueError:
            return 0

    return GpuInfo(
        name=parts[0],
        total_mb=num(parts[1]),
        used_mb=num(parts[2]),
        free_mb=num(parts[3]),
        detected_by="nvidia-smi",
    )


def probe_ram_free_mb(*, force: bool = False) -> int:
    """Fria MB RAM. Win32 `GlobalMemoryStatusEx`, annars /proc/meminfo, annars 0."""
    now = time.monotonic()
    if not force and _cache.ram_free_mb and now - _cache.at < _CACHE_TTL_S:
        return _cache.ram_free_mb

    free_mb = 0
    system = platform.system()
    if system == "Windows":
        try:

            class MEMORYSTATUSEX(ctypes.Structure):  # noqa: D106
                _fields_ = [
                    ("dwLength", ctypes.wintypes.DWORD),
                    ("dwMemoryLoad", ctypes.wintypes.DWORD),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):  # type: ignore[attr-defined]
                free_mb = int(status.ullAvailPhys // (1024 * 1024))
        except Exception:  # noqa: BLE001
            free_mb = 0
    else:
        try:
            for line in Path_meminfo():
                if line.startswith("MemAvailable:"):
                    free_mb = int(line.split()[1]) // 1024
                    break
        except Exception:  # noqa: BLE001
            free_mb = 0
    if free_mb:
        _cache.ram_free_mb = free_mb
    return free_mb


def Path_meminfo() -> list[str]:
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            return [line.strip() for line in handle]
    except OSError:
        return []


def reset_cache() -> None:
    global _cache
    _cache = _cache.__class__()
