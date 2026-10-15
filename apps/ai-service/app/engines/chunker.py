"""Kod-medveten chunking för RAG (FAS 3.5).

Regler:
  * Python: `ast` — topnivå `def`/`class`/`async def` blir egna chunkar med
    faktiska radintervall och symbolnamn (nästed för inuti en klass = samma chunk).
  * JS/TS: radvis spårning av toppnivådeklarationer (`function`, `class`,
    `const arrow = ...`, `export ...`) med barra-djup som hittar slutraden.
  * Övrigt/ogiltig syntax: fönster av N rader, radintervall bevarade.

Chunkarna är det som gör `RagChunk.path/startLine/endLine/symbol` till verkliga
värden i stället för null — och det är det som testerna hävdar.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field

MAX_CHUNK_LINES = 140
FALLBACK_WINDOW = 80

PYTHON_SUFFIXES = {".py", ".pyi"}
TS_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".vue"}

# Topnivå i JS/TS: kolumn 0 (ingen indentering) och export-/async-varianter.
_JS_TOPLEVEL = re.compile(
    r"^(?P<prefix>(?:export\s+)?(?:default\s+)?(?:async\s+)?)"
    r"(?P<kind>function|class|const|let|var)\s+"
    r"(?P<name>[A-Za-z_$][\w$]*)"
    r"(?P<rest>.*)$"
)
_JS_FUNCTION_LIKE = re.compile(r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?function")
_JS_CLASS_LIKE = re.compile(r"^(?:export\s+)?(?:default\s+)?class\b")
_JS_ARROW_DECL = re.compile(r"^(?:export\s+)?(?:const|let|var)\s+(?P<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>")
_JS_METHOD_OBJECT = re.compile(r"^(?P<name>[A-Za-z_$][\w$]*)\s*(?::|=)\s*(?:async\s*)?(?:function|\()")


@dataclass
class SourceChunk:
    path: str
    start_line: int
    end_line: int
    text: str
    symbol: str | None = None
    language: str = "text"
    kind: str = "block"
    notes: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        # radintervall är 1-baserade ochinclusive — samma tolkning som Monaco.
        if self.end_line < self.start_line:
            self.end_line = self.start_line


def language_for(path: str) -> str:
    lowered = path.lower()
    for suffix in PYTHON_SUFFIXES:
        if lowered.endswith(suffix):
            return "python"
    for suffix in TS_SUFFIXES:
        if lowered.endswith(suffix):
            return "typescript"
    if lowered.endswith((".md", ".markdown", ".txt", ".rst")):
        return "markdown"
    if lowered.endswith((".json",)):
        return "json"
    if lowered.endswith((".yaml", ".yml")):
        return "yaml"
    if lowered.endswith((".css", ".scss")):
        return "css"
    if lowered.endswith((".tsx",)):
        return "tsx"
    return "text"


def chunk_source(
    path: str,
    text: str,
    *,
    max_chunk_lines: int = MAX_CHUNK_LINES,
    language: str | None = None,
) -> list[SourceChunk]:
    """Huvudingång: filsökväg + innehåll → chunkar med riktiga radintervall."""
    if not text.strip():
        return []
    lang = language or language_for(path)
    lines = text.splitlines()
    if lang == "python":
        chunks = _chunk_python(path, lines, max_chunk_lines)
        if chunks:
            return chunks
    elif lang == "typescript":
        chunks = _chunk_typescript(path, lines, max_chunk_lines)
        if chunks:
            return chunks
    return _chunk_windowed(path, lines, max_chunk_lines, language=lang)


# --------------------------------------------------------------------- Python
def _chunk_python(path: str, lines: list[str], max_lines: int) -> list[SourceChunk]:
    source = "\n".join(lines)
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        # defek fil: fönster-chunking, men noteringen följer med chunken.
        windowed = _chunk_windowed(path, lines, max_lines, language="python")
        for chunk in windowed[:1]:
            chunk.notes.append(f"ast-syntaxfel på rad {exc.lineno}: {exc.msg}")
        return windowed

    chunks: list[SourceChunk] = []
    covered: set[int] = set()
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        start = int(getattr(node, "lineno", 0))
        end = int(getattr(node, "end_lineno", start) or start)
        # dekoratörer tillhör blocket
        for decorator in getattr(node, "decorator_list", []) or []:
            start = min(start, int(getattr(decorator, "lineno", start)))
        block = _slice(lines, start, end)
        if _line_count(block) > max_lines:
            chunks.extend(_split_large(path, lines, start, end, node.name, "python", max_lines))
        else:
            chunks.append(SourceChunk(path, start, end, block, node.name, "python",
                                      kind="class" if isinstance(node, ast.ClassDef) else "function"))
        covered.update(range(start, end + 1))

    remainder = _window_uncovered(path, lines, covered, max_lines, "python")
    chunks = remainder + chunks
    chunks.sort(key=lambda c: (c.start_line, c.end_line))
    return chunks


def _slice(lines: list[str], start: int, end: int) -> str:
    return "\n".join(lines[max(0, start - 1): end])


def _line_count(text: str) -> int:
    """Antal rader i en chunk (inte tecken!) — used för max_chunk_lines-jämförelsen."""
    if not text:
        return 0
    return text.count("\n") + 1


def _window_uncovered(
    path: str, lines: list[str], covered: set[int], max_lines: int, language: str
) -> list[SourceChunk]:
    """Sammanhåller rader utanför symboler (import, modul-docstring, konstant)."""
    chunks: list[SourceChunk] = []
    run_start: int | None = None
    for index in range(1, len(lines) + 1):
        if index in covered:
            if run_start is not None:
                chunks.append(_text_chunk(path, lines, run_start, index - 1, language))
                run_start = None
            continue
        if not lines[index - 1].strip():
            continue
        if run_start is None:
            run_start = index
    if run_start is not None:
        chunks.append(_text_chunk(path, lines, run_start, len(lines), language))
    out: list[SourceChunk] = []
    for chunk in chunks:
        if chunk.end_line - chunk.start_line + 1 > max_lines:
            out.extend(_split_large(path, lines, chunk.start_line, chunk.end_line, None, language, max_lines))
        else:
            out.append(chunk)
    return out


def _text_chunk(path: str, lines: list[str], start: int, end: int, language: str) -> SourceChunk:
    return SourceChunk(path, start, end, _slice(lines, start, end), None, language, kind="module")


def _split_large(
    path: str, lines: list[str], start: int, end: int, symbol: str | None,
    language: str, max_lines: int,
) -> list[SourceChunk]:
    """Delar ett för stort block i överlappande fönster; radintervall behålls."""
    out: list[SourceChunk] = []
    step = max(20, max_lines - 10)
    cursor = start
    part = 1
    while cursor <= end:
        stop = min(end, cursor + max_lines - 1)
        name = symbol if symbol is None else f"{symbol}#part{part}"
        out.append(SourceChunk(path, cursor, stop, _slice(lines, cursor, stop), name, language, kind="split"))
        if stop >= end:
            break
        cursor = max(stop + 1, cursor + step)
        part += 1
    return out


# --------------------------------------------------------------------- JS/TS
def _chunk_typescript(path: str, lines: list[str], max_lines: int) -> list[SourceChunk]:
    starts: list[tuple[int, str, str]] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line or line[0].isspace():
            index += 1
            continue
        arrow = _JS_ARROW_DECL.match(line)
        plain = _JS_TOPLEVEL.match(line)
        if arrow is not None:
            starts.append((index, arrow.group("name"), "function"))
            index = _find_block_end(lines, index) + 1
            continue
        if plain is not None and (
            _JS_FUNCTION_LIKE.match(line) or _JS_CLASS_LIKE.match(line)
        ):
            kind = "class" if plain.group("kind") == "class" else "function"
            starts.append((index, plain.group("name"), kind))
            index = _find_block_end(lines, index) + 1
            continue
        index += 1

    if not starts:
        return []
    chunks: list[SourceChunk] = []
    covered: set[int] = set()
    for line_index, name, kind in starts:
        start_line = line_index + 1
        end_line = _find_block_end(lines, line_index) + 1
        if end_line < start_line:
            end_line = start_line
        block = _slice(lines, start_line, end_line)
        if _line_count(block) > max_lines:
            chunks.extend(_split_large(path, lines, start_line, end_line, name, "typescript", max_lines))
        else:
            chunks.append(SourceChunk(path, start_line, end_line, block, name, "typescript", kind=kind))
        covered.update(range(start_line, end_line + 1))
    remainder = _window_uncovered(path, lines, covered, max_lines, "typescript")
    chunks = remainder + chunks
    chunks.sort(key=lambda c: (c.start_line, c.end_line))
    return chunks


def _find_block_end(lines: list[str], start_index: int) -> int:
    """Bars/djup-spårning från toppnivåraden till blockets slut (räkna strängar bort)."""
    depth = 0
    seen_body = False
    for index in range(start_index, len(lines)):
        depth += _line_delta(lines[index])
        if depth > 0:
            seen_body = True
        if seen_body and depth <= 0:
            return index
        if not seen_body and index > start_index + 40:
            return index
    return len(lines) - 1


def _line_delta(line: str) -> int:
    delta = 0
    quote: str | None = None
    index = 0
    while index < len(line):
        char = line[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char in {'"', "'", "`"}:
            quote = char
            index += 1
            continue
        if char == "/" and index + 1 < len(line) and line[index + 1] == "/":
            break
        if char in "{[(":
            delta += 1
        elif char in "}])":
            delta -= 1
        index += 1
    return delta


# --------------------------------------------------------------------- fönster
def _chunk_windowed(path: str, lines: list[str], max_lines: int, *, language: str) -> list[SourceChunk]:
    window = min(max_lines, FALLBACK_WINDOW)
    chunks: list[SourceChunk] = []
    start = 1
    part = 1
    while start <= len(lines):
        end = min(len(lines), start + window - 1)
        text = _slice(lines, start, end)
        if text.strip():
            chunks.append(SourceChunk(path, start, end, text, None, language,
                                      kind=f"window{part}" if part > 1 else "window"))
        start = end + 1
        part += 1
    return chunks


def chunk_id(path: str, start_line: int, end_line: int, symbol: str | None) -> str:
    """Stabil id: samma fil + intervall ger samma id (för Chroma-upsert)."""
    return f"{path}:{start_line}-{end_line}:{symbol or '_'}"
