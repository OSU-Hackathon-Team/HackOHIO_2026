"""Read just enough of an ELF64 file to tell whether Ghidra will have real symbol names.

A stripped distribution library (e.g. LibreOffice's libsclo.so) has no .symtab; its
names come from a separate debug file found by GNU build-id under /usr/lib/debug.
"""

from __future__ import annotations

from pathlib import Path
import struct

DEBUG_ROOTS = (Path("/usr/lib/debug"),)


def _sections(data: bytes) -> dict[str, tuple[int, int, int]]:
    """Section name -> (type, offset, size). Empty for non-ELF64-LE input."""
    if len(data) < 64 or data[:4] != b"\x7fELF" or data[4] != 2 or data[5] != 1:
        return {}
    shoff, = struct.unpack_from("<Q", data, 0x28)
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 0x3A)
    if not shoff or shentsize < 64 or shoff + shnum * shentsize > len(data):
        return {}
    headers = []
    for index in range(shnum):
        name, kind, _flags, _addr, offset, size = struct.unpack_from(
            "<IIQQQQ", data, shoff + index * shentsize)
        headers.append((name, kind, offset, size))
    if shstrndx >= len(headers):
        return {}
    _, _, names_offset, names_size = headers[shstrndx]
    names = data[names_offset:names_offset + names_size]
    result = {}
    for name, kind, offset, size in headers:
        end = names.find(b"\0", name)
        result[names[name:end if end >= 0 else None].decode(errors="replace")] = (kind, offset, size)
    return result


def build_id(data: bytes) -> str | None:
    section = _sections(data).get(".note.gnu.build-id")
    if section is None:
        return None
    _, offset, size = section
    note = data[offset:offset + size]
    if len(note) < 12:
        return None
    namesz, descsz, kind = struct.unpack_from("<III", note, 0)
    start = 12 + ((namesz + 3) & ~3)
    if kind != 3 or note[12:12 + namesz].rstrip(b"\0") != b"GNU" or start + descsz > len(note):
        return None
    return note[start:start + descsz].hex()


def debug_file_for(build: str | None, roots: tuple[Path, ...] = DEBUG_ROOTS) -> Path | None:
    if not build or len(build) < 3:
        return None
    for root in roots:
        candidate = root / ".build-id" / build[:2] / f"{build[2:]}.debug"
        if candidate.is_file():
            return candidate
    return None


def symbol_state(path: Path, roots: tuple[Path, ...] = DEBUG_ROOTS) -> dict:
    data = Path(path).read_bytes()
    sections = _sections(data)
    build = build_id(data)
    debug = debug_file_for(build, roots)
    return {"elf": bool(sections), "symtab": ".symtab" in sections,
            "dwarf": ".debug_info" in sections, "build_id": build,
            "debug_file": str(debug) if debug else None,
            "named": ".symtab" in sections or debug is not None}
