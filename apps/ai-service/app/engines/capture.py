"""Skärmbild (FAS 6.1) via mss — stöd för hel skärm och fönster, utan extrapaket.

`/screenshot` ger PNG base64 som Node-laget stoppar i `CaptureResult`.
Fönsterlistelesning görs med Win32 `EnumWindows` direkt via ctypes (ingen
pygetwindow-beroende). På andra plattformar blir fönsterlistan tom och
motorn rapporterar det ärligt.
"""

from __future__ import annotations

import base64
import ctypes
import platform
import time
from ctypes import wintypes
from typing import Any

from ..config import Settings, get_settings
from ..logging_setup import get_logger
from ..schemas import ScreenshotResult, WindowInfo, WindowListResult
from . import Availability, EngineUnavailable

log = get_logger("ai.capture")

_state = Availability(slot="capture", engine="mss")
_dpi_aware = False


def availability(settings: Settings | None = None) -> Availability:
    return _state


def _ensure_importable() -> Any:
    try:
        import mss  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        global _state
        _state = Availability(
            slot="capture", engine="unavailable", ready=False, probed=True,
            detail=f"mss-import: {type(exc).__name__}: {exc}", degraded=True,
        )
        raise EngineUnavailable("capture-unavailable", f"{type(exc).__name__}: {exc}") from exc
    return mss


def _set_dpi_aware() -> None:
    """Windows ska rapportera fysiska pixlar, annars blir fångsten skala 125 %."""
    global _dpi_aware
    if _dpi_aware or platform.system() != "Windows":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - äldre Windows utan shcore
        try:
            ctypes.windll.user32.SetProcessDPIAware()  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
    _dpi_aware = True


def _png_bytes(image: Any) -> bytes:
    import mss

    return mss.tools.to_png(image.rgb, image.size)


def capture(
    *,
    monitor: int = 0,
    window_title: str = "",
    target: str = "screen",
    settings: Settings | None = None,
) -> ScreenshotResult:
    """Full skärm (monitor 0 = union, 1 = primär) eller fönster med delnamn."""
    mss = _ensure_importable()
    _set_dpi_aware()
    cfg = settings or get_settings()
    ts = int(time.time() * 1000)

    try:
        with mss.mss() as sct:
            if window_title:
                rect = _find_window_rect(window_title)
                if rect is None:
                    raise EngineUnavailable(
                        "window-not-found", f"no fönster som matchar '{window_title}'"
                    )
                box = {
                    "left": rect["left"], "top": rect["top"],
                    "width": rect["right"] - rect["left"], "height": rect["bottom"] - rect["top"],
                }
                if box["width"] <= 0 or box["height"] <= 0:
                    raise EngineUnavailable("window-not-visible", f"minimerat fönster: {window_title}")
                image = sct.grab(box)
                used_target = "window"
            else:
                index = monitor if 0 < monitor < len(sct.monitors) else (monitor if monitor == 0 else 1)
                image = sct.grab(sct.monitors[index])
                used_target = target if target in ("screen", "window") else "screen"
            png = _png_bytes(image)
    except EngineUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - R5
        global _state
        _state = Availability(
            slot="capture", engine="unavailable", ready=False, probed=True,
            detail=f"{type(exc).__name__}: {exc}", degraded=True,
        )
        raise EngineUnavailable("capture-failed", f"{type(exc).__name__}: {exc}") from exc

    _state = Availability(
        slot="capture", engine="mss", ready=True, probed=True,
        model=f"{image.width}x{image.height}", detail=f"target={used_target}",
    )
    log.info("Skärmbild %dx%d (%d KB) target=%s", image.width, image.height, len(png) // 1024, used_target)
    return ScreenshotResult(
        png_base64=base64.b64encode(png).decode("ascii"),
        width=int(image.width),
        height=int(image.height),
        ts=ts,
        target=used_target,
        bytes=len(png),
        display_id=f"monitor-{monitor}",
    )


# ------------------------------------------------------------------ fönster (Win32)
def _find_window_rect(title: str) -> dict[str, int] | None:
    for window in list_windows():
        if title.lower() in window.title.lower():
            return {"left": window.left, "top": window.top, "right": window.right, "bottom": window.bottom}
    return None


def list_windows(*, title_contains: str = "") -> list[WindowInfo]:
    """Only on Windows: EnumWindows + GetWindowText + GetWindowRect."""
    if platform.system() != "Windows":
        return []
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        return []

    found: list[WindowInfo] = []
    EnumWindowsProc = ctypes.WINFUNCTYPE(  # noqa: N806
        ctypes.c_bool, wintypes.HWND, wintypes.LPARAM
    )

    def _callback(hwnd: Any, _lparam: Any) -> bool:
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length == 0:
                return True
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buffer, length + 1)
            title = buffer.value or ""
            if title_contains and title_contains.lower() not in title.lower():
                return True
            rect = wintypes.RECT()
            if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                return True
            if rect.right - rect.left < 40 or rect.bottom - rect.top < 40:
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            found.append(
                WindowInfo(
                    title=title, left=rect.left, top=rect.top,
                    right=rect.right, bottom=rect.bottom, pid=int(pid.value),
                )
            )
        except Exception:  # noqa: BLE001 - ett fönster får inte avbryta uppräkningen
            return True
        return True

    try:
        user32.EnumWindows(EnumWindowsProc(_callback), 0)
    except Exception as exc:  # noqa: BLE001
        log.warning("EnumWindows felade: %s", exc)
    return found


def monitor_count() -> int:
    try:
        mss = _ensure_importable()
        with mss.mss() as sct:
            return len(sct.monitors)
    except Exception:  # noqa: BLE001
        return 0
