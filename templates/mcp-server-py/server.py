"""Mall för egna MCP-servrar i Python — FastMCP-stil (heter MCPServer fran mcp 2.x).

Kor:
    python -m venv .venv
    .venv/Scripts/activate              # Windows
    source .venv/bin/activate           # bash/zsh
    pip install -r requirements.txt
    python server.py                    # pratar MCP pa stdio

Se README.md for registreringen i `mcp.json` och for vad som faktiskt ar
verifierat pa denna maskinen.

Designregler (samma som for TypeScript-mallen):
  * stdout ar reserverad for JSON-RPC — logga aldrig dar
  * read-only-verktyg markeras med annotations.readOnlyHint
  * _meta.requiresApproval satts for farliga verktyg sa att NEXUS fragar anvandaren
  * hemliga nycklar kommer fran miljon (os.environ), aldrig fran kallkoden
"""

from __future__ import annotations

import datetime as dt
import inspect
import os
import sys
from typing import Any

# mcp 2.x dojpte om FastMCP -> MCPServer (samma dekorator-yta). Vi stoder bada,
# sa att mallen fungerar bade med kravet i requirements.txt och med en pin for v1.
try:  # pragma: no cover - importvalet beror av installerad version
    from mcp.server.mcpserver import MCPServer as _Server  # mcp >= 2
except ModuleNotFoundError:  # pragma: no cover
    from mcp.server.fastmcp import FastMCP as _Server  # mcp 1.x

SERVER_NAME = os.environ.get("NEXUS_MCP_TEMPLATE_NAME", "nexus-template-py")

_SERVER = _Server(
    name=SERVER_NAME,
    instructions="Demo-MCP-server för NEXUS-IDE (Python). Verktyg svarar med strukturerad JSON.",
)

# `meta` finns bara i mcp 2.x; filtrera bort den pa alden SDK sa att mallen körs båda.
_TOOL_PARAMS = inspect.signature(_SERVER.tool).parameters


def tool_kwargs(**kwargs: Any) -> dict[str, Any]:
    """Filtrera dekorator-argument till det den installerade SDK-versionen stöder."""
    return {key: value for key, value in kwargs.items() if key in _TOOL_PARAMS}


def _stamp() -> str:
    """ISO-8601-stämpel i UTC (annoterad så mypy är nöjd)."""
    return dt.datetime.now(dt.timezone.utc).isoformat()


@_SERVER.tool(
    name="nexus_demo",
    title="Demo tool",
    description="Returnerar en hälsning, tidsstämpel och servernamn. Read-only.",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
    meta={"requiresApproval": False, "example": {"name": "nexus"}},
)
def nexus_demo(name: str = "world", shout: bool = False) -> dict[str, Any]:
    """Ekkar `name` som en hälsning.

    Args:
        name: vem hälsningen gäller.
        shout: sätt True för versaler.
    """
    greeting = f"hej {name} från {SERVER_NAME}"
    if shout:
        greeting = greeting.upper()
    return {"ok": True, "greeting": greeting, "at": _stamp(), "server": SERVER_NAME}


@_SERVER.tool(
    name="add_numbers",
    title="Add numbers",
    description="Adderar två heltal — exempel med obligatoriska argument.",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
)
def add_numbers(a: int, b: int) -> dict[str, Any]:
    """Returnerar summan av a och b.

    Returtypen är `dict[str, Any]` med flit: MCP-SDK:n bygger ett outputSchema av
    annotationen, och `dict[str, int]` tvingar `True` till 1 i structuredContent.
    """
    return {"ok": True, "sum": a + b}


@_SERVER.tool(
    name="server_info",
    title="Server info",
    description="Miljö- och processinformation så NEXUS kan visa den i UI:t. Read-only.",
    annotations={"readOnlyHint": True},
)
def server_info() -> dict[str, Any]:
    """Berättar vad servern kör."""
    return {
        "ok": True,
        "server": SERVER_NAME,
        "python": sys.version.split()[0],
        "pid": os.getpid(),
        "tools": ["nexus_demo", "add_numbers", "server_info"],
    }


@_SERVER.tool(
    name="write_note",
    title="Write note",
    description="Skriver en textfil i NEXUS_NOTES_DIR. Kräver godkännande (destructive).",
    annotations={"readOnlyHint": False, "destructiveHint": True},
    meta={"requiresApproval": True, "riskLevel": "medium"},
)
def write_note(filename: str, content: str) -> dict[str, Any]:
    """Enkel skrivare som visar hur ett godkännandekrävande verktyg markeras."""
    root = os.environ.get("NEXUS_NOTES_DIR")
    if not root:
        return {"ok": False, "error": "NEXUS_NOTES_DIR är inte satt — vägrar skriva"}
    target = os.path.realpath(os.path.join(root, filename))
    if not target.startswith(os.path.realpath(root) + os.sep):
        return {"ok": False, "error": "sökvägen lämnar den tillåtna katalogen"}
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(content)
    return {"ok": True, "path": target, "bytes": len(content.encode("utf-8"))}


def main() -> int:
    """Starta servern på stdio. Returnerar exitkod för `python server.py`."""
    sys.stderr.write(f"[{SERVER_NAME}] redo på stdio\n")
    sys.stderr.flush()
    _SERVER.run(transport="stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
