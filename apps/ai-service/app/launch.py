"""Startpunkt som skriver sin EGEN Windows-PID till pid-filen före uvicorn.

Varför detta behövs: i Git Bash är `$!` en MSYS-pid som inte nödvändigtvis
motsvarar Windows-processtid som `taskkill` förväntar sig. Genom att låta
själva serverprocessen skriva `os.getpid()` blir pid-filen provbar, och
`scripts/stop_ai_service.sh` kan bevisa att den faktiska processen är död.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .config import get_settings
from .logging_setup import configure, get_logger
from .main import app


def write_pid_file() -> Path:
    settings = get_settings()
    pid_path = Path(os.environ.get("NEXUS_AI_PID_FILE", str(settings.nexus_dir / "ai-service.pid")))
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(str(os.getpid()), encoding="utf-8")
    return pid_path


def main() -> int:
    settings = get_settings()
    log_path = configure(settings.log_level, settings.log_path)
    log = get_logger("ai.launch")
    pid_path = write_pid_file()
    log.info(
        "ai-service pid=%d på %s (logg=%s, pidfil=%s)",
        os.getpid(), settings.base_url, settings.log_path, pid_path,
    )
    try:
        import uvicorn

        uvicorn.run(
            app,
            host=settings.host,
            port=settings.port,
            log_level=settings.log_level,
            access_log=False,
        )
    finally:
        with __import__("contextlib").suppress(OSError):
            if pid_path.is_file() and pid_path.read_text(encoding="utf-8").strip() == str(os.getpid()):
                pid_path.unlink()
    return 0


if __name__ == "__main__":
    sys.exit(main())
