"""Immutable, content-addressed artifacts stored on local disk."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import tempfile


class LocalArtifactStore:
    def __init__(self, root: Path):
        self.root = Path(root)

    def put(self, data: bytes) -> str:
        digest = hashlib.sha256(data).hexdigest()
        destination = self.root / digest[:2] / digest
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if destination.read_bytes() != data:
                raise RuntimeError(f"artifact digest collision: {digest}")
            return digest
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as tmp:
            tmp.write(data)
            tmp.flush()
            os.fsync(tmp.fileno())
            temporary = Path(tmp.name)
        try:
            # Another process may have published the same hash; replacing it is harmless
            # because the bytes are content-addressed.
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        return digest

    def get(self, digest: str) -> bytes:
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("invalid artifact digest")
        data = (self.root / digest[:2] / digest).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError(f"artifact corruption: {digest}")
        return data
