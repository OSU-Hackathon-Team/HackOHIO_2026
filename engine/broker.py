"""Cleanroom broker: the only behavioral channel from the implementer sandbox.

The broker sits beside private evidence. It accepts bounded natural-language
questions, answers caller-visible behavior, and applies a deterministic
disclosure filter before anything reaches the sandbox. Every exchange is
audited outside the sandbox. Broker answers are not evidence: they can focus
an implementation attempt but cannot change a spec, claim, probe, or readiness.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import socketserver
import threading
import time
from typing import Callable, Iterable

MAX_QUESTION_CHARS = 1200
MAX_CONTEXT_CHARS = 4000
MAX_ANSWER_CHARS = 1800
MAX_REQUEST_BYTES = 32768
DEFAULT_QUOTA = 48

# A request may ask what behavior occurs. It may not ask to see the material
# the broker is protecting, nor ask for implementation mechanics.
_DISCLOSURE_REQUEST = re.compile(
    r"\b(?:show|send|give|print|paste|quote|share|dump|reveal|provide|read|open|"
    r"inspect|fetch|return|expose|leak)\b[^\n]{0,80}?"
    r"\b(?:source|code|decompil\w*|disassembl\w*|assembly|pseudo-?code|bytes?|"
    r"address(?:es)?|symbol(?:s)?|opcodes?|vtable(?:s)?|struct(?:ure)?\s+layout|"
    r"object\s+layout|implementation|internals?|binary)\b",
    re.I,
)
_SOURCE_REQUEST = re.compile(
    r"\b(?:source\s*code|decompil\w*|disassembl\w*|pseudo-?code|machine\s+code|"
    r"object\s+layout|vtable|implementation\s+detail|internal\s+code)\b",
    re.I,
)
_BINARY_IDENTIFIER = re.compile(
    r"\b(?:FUN|DAT|LAB)_[0-9a-fA-F]+|\bparam_\d+\b|\b0x[0-9a-fA-F]+\b"
)
_CODE_FENCE = re.compile(r"```")

# Responses must read as prose behavior. Anything that looks like source,
# assembly, a path, or a copied implementation line fails closed.
_RESPONSE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("fenced code", re.compile(r"```")),
    ("preprocessor directive", re.compile(r"(?m)^\s*#\s*(?:include|define|ifdef|endif)\b")),
    ("braces", re.compile(r"[{}]")),
    ("C++ scope or pointer member", re.compile(r"::|->")),
    ("operator expression", re.compile(r"==|!=|<=|>=|\+=|-=|\+\+|&&|\|\||=(?!=)")),
    ("binary identifier", _BINARY_IDENTIFIER),
    ("hex constant", re.compile(r"\b0x[0-9a-fA-F]{4,}\b|\b[0-9a-fA-F]{8,}\b")),
    ("source path or file", re.compile(
        r"(?:^|\s)(?:\./|\.\./|/)[\w.-]+(?:/[\w.-]+)+|"
        r"\b[\w-]+\.(?:c|h|so|bin|o|py|json|txt)\b"
    )),
    ("assembly register or mnemonic", re.compile(
        r"\b(?:rax|rbx|rcx|rdx|rsi|rdi|rsp|rbp|eax|ebx|ecx|edx|esi|edi|esp|ebp|"
        r"xmm\d+|ymm\d+|movaps|movups|movsd|pxor|xorps|lea|jmp|jne|je|jg|jl|"
        r"callq|retq|pushq|popq)\b",
        re.I,
    )),
    ("indented code block", re.compile(r"(?m)^(?: {4}|\t)\S")),
)


class BrokerError(RuntimeError):
    """Base class for broker failures."""


class QuestionRejected(BrokerError):
    """The question asks for protected material or implementation mechanics."""


class DisclosureError(BrokerError):
    """An answer failed the deterministic disclosure filter."""


def _normalize(text: str) -> str:
    return " ".join(text.split()).strip()


def _protected_lines(texts: Iterable[str]) -> set[str]:
    """Lines from private source-like material that must never be quoted."""
    lines: set[str] = set()
    for text in texts:
        for line in str(text).splitlines():
            normalized = _normalize(line).lower()
            if len(normalized) < 24:
                continue
            if not re.search(r"[{};=#]|0x|->|::|\)\s*;", line):
                continue
            lines.add(normalized)
    return lines


def validate_question(question: object) -> str:
    if not isinstance(question, str) or not question.strip():
        raise QuestionRejected("question must be a nonempty string")
    cleaned = question.strip()
    if len(cleaned) > MAX_QUESTION_CHARS:
        raise QuestionRejected(
            f"question exceeds {MAX_QUESTION_CHARS} characters; ask one behavior at a time"
        )
    if _CODE_FENCE.search(cleaned):
        raise QuestionRejected("questions may not contain code blocks")
    disclosure = _DISCLOSURE_REQUEST.search(cleaned) or _SOURCE_REQUEST.search(cleaned)
    if disclosure:
        raise QuestionRejected(
            "the broker does not disclose source, decompilation, disassembly, "
            "addresses, bytes, symbols, or implementation mechanics; ask about "
            "caller-visible behavior instead"
        )
    if _BINARY_IDENTIFIER.search(cleaned):
        raise QuestionRejected(
            "questions may not contain binary identifiers or addresses; use the "
            "public operation and value names"
        )
    return cleaned


def _context_text(context: object) -> str:
    if context is None:
        return ""
    if isinstance(context, str):
        text = context
    elif isinstance(context, (dict, list)):
        text = json.dumps(context, sort_keys=True)
    else:
        raise QuestionRejected("context must be a string, object, array, or null")
    if len(text) > MAX_CONTEXT_CHARS:
        raise QuestionRejected(
            f"context exceeds {MAX_CONTEXT_CHARS} characters; include only the failing case"
        )
    return text


def check_answer(answer: object, protected: set[str],
                 allowed_calls: Iterable[str] = ()) -> str:
    """Return the answer if it is prose behavior, otherwise raise DisclosureError."""
    if not isinstance(answer, str) or not answer.strip():
        raise DisclosureError("broker produced no answer")
    cleaned = answer.strip()
    if len(cleaned) > MAX_ANSWER_CHARS:
        raise DisclosureError(
            f"answer exceeds {MAX_ANSWER_CHARS} characters; a behavior answer must be concise"
        )
    for label, pattern in _RESPONSE_PATTERNS:
        match = pattern.search(cleaned)
        if match:
            raise DisclosureError(f"answer contains {label}: {match.group(0)[:80]!r}")
    for span in re.findall(r"`([^`\n]+)`", cleaned):
        if not re.fullmatch(r"[A-Za-z_][\w .:@#-]{0,40}", span):
            raise DisclosureError(f"answer contains code-like inline span: {span[:80]!r}")
    allowed = {name.lower() for name in allowed_calls}
    for match in re.finditer(r"\b([A-Za-z_]\w*)\(", cleaned):
        if match.group(1).lower() not in allowed:
            raise DisclosureError(
                f"answer contains function call syntax: {match.group(0)[:80]!r}")
    normalized = _normalize(cleaned).lower()
    for line in protected:
        if line and line in normalized:
            raise DisclosureError("answer copies a protected source line")
    return cleaned


def model_responder(*, opencode: Path, env_file: Path, model: str,
                    folder: Path, timeout: int = 120,
                    agent_name: str = "cleanroom-broker") -> Callable[..., dict]:
    """Build a broker responder backed by a model with no tools.

    The model may read private evidence, but its output still passes the same
    deterministic filter. The broker therefore does not trust the model to
    enforce containment.
    """
    from engine.model_runtime import invoke_opencode

    def respond(question: str, context: str, public: str, private: str) -> dict:
        prompt = (
            "You are the cleanroom broker between an independent implementer and a "
            "reverse-engineering team. Answer ONLY the caller-visible behavior asked "
            "about, in plain prose. Never provide source code, decompilation, "
            "disassembly, pseudocode, hexadecimal addresses, offsets, symbol names, "
            "file paths, object layout, implementation mechanics, or verbatim lines "
            "from the analyst material. Use decimal for opcodes and values; never "
            "hexadecimal addresses or pointers. Never mention or reveal held-out test cases. "
            "If the reviewed evidence does not answer the question, say that the "
            "evidence is silent and name the unknown; do not guess. Keep the answer "
            "under 1200 characters.\n"
            f"Public specification and examples:\n{public[:8000]}\n"
            f"Private analyst notes (behavioral claims, original observations, and source):\n"
            f"{private[:16000]}\n"
            f"Public failure context supplied by the implementer:\n{context[:2000]}\n"
            f"Question: {question}"
        )
        reply = invoke_opencode(
            opencode, folder, prompt, model=model, timeout=timeout,
            env_file=env_file, agent_name=agent_name,
            agent_instruction="Answer with caller-visible behavior only. Return no code.",
        )
        return {"answer": reply["text"].strip(),
                "sources": ["public_spec", "reviewed_private_evidence"]}

    return respond


class Broker:
    """Answer, filter, deduplicate, and audit cleanroom questions."""

    def __init__(self, responder: Callable[..., object], *,
                 public_context: str = "", private_context: str = "",
                 protected_texts: Iterable[str] = (), quota: int = DEFAULT_QUOTA,
                 audit_path: Path | None = None, store=None, session_id: str = "cleanroom",
                 allowed_calls: Iterable[str] = ()):
        if quota < 0:
            raise ValueError("quota must not be negative")
        self.responder = responder
        self.public_context = public_context
        self.private_context = private_context
        self.protected = _protected_lines(protected_texts)
        self.quota = quota
        self.audit_path = Path(audit_path) if audit_path else None
        self.store = store
        self.session_id = session_id
        self.allowed_calls = frozenset(allowed_calls)
        self._answers: dict[str, str] = {}
        self._records: list[dict] = []
        self._lock = threading.RLock()

    @property
    def records(self) -> list[dict]:
        with self._lock:
            return list(self._records)

    def _audit(self, record: dict) -> dict:
        if self.store is not None:
            record["artifact"] = self.store.put(
                json.dumps(record, sort_keys=True).encode()
            )
        if self.audit_path is not None:
            self.audit_path.parent.mkdir(parents=True, exist_ok=True)
            line = json.dumps(record, sort_keys=True) + "\n"
            with self.audit_path.open("a", encoding="utf-8") as handle:
                handle.write(line)
                handle.flush()
                os.fsync(handle.fileno())
        return record

    def _refuse(self, question: str, context: str, reason: str,
                status: str = "refused") -> dict:
        record = {
            "schema": 1, "session": self.session_id, "time": round(time.time(), 3),
            "question": question, "context_chars": len(context),
            "status": status, "reason": reason, "answer": None, "sources": [],
        }
        with self._lock:
            self._records.append(self._audit(record))
        return {"schema": 1, "status": status, "answer": None, "reason": reason}

    def ask(self, request: object) -> dict:
        if not isinstance(request, dict):
            return self._refuse("", "", "request must be a JSON object", "invalid")
        extra = set(request) - {"question", "context"}
        if extra:
            return self._refuse("", "", f"unsupported request fields: {sorted(extra)}",
                                "invalid")
        raw_question = request.get("question")
        raw_context = request.get("context")
        try:
            question = validate_question(raw_question)
            context = _context_text(raw_context)
        except QuestionRejected as exc:
            question = raw_question if isinstance(raw_question, str) else ""
            return self._refuse(question, "", str(exc))
        key = hashlib.sha256(
            json.dumps({"question": question, "context": context}, sort_keys=True).encode()
        ).hexdigest()
        with self._lock:
            if key in self._answers:
                answer = self._answers[key]
                record = {
                    "schema": 1, "session": self.session_id,
                    "time": round(time.time(), 3), "question": question,
                    "context_chars": len(context), "status": "answered",
                    "reason": "deduplicated", "answer": answer,
                    "sources": ["cached"], "cached": True,
                }
                self._records.append(self._audit(record))
                return {"schema": 1, "status": "answered", "answer": answer,
                        "reason": "deduplicated", "cached": True}
            if len(self._records) >= self.quota:
                return self._refuse(
                    question, context,
                    f"broker quota of {self.quota} questions is exhausted",
                    "quota_exhausted",
                )
        try:
            reply = self.responder(question, context, self.public_context,
                                   self.private_context)
        except Exception as exc:  # The broker must fail closed, not leak a traceback.
            return self._refuse(question, context,
                                f"broker responder unavailable: {type(exc).__name__}",
                                "unavailable")
        if isinstance(reply, dict):
            answer = reply.get("answer")
            sources = reply.get("sources") or []
        else:
            answer = reply
            sources = ["broker"]
        try:
            cleaned = check_answer(answer, self.protected, self.allowed_calls)
        except DisclosureError as exc:
            return self._refuse(question, context, str(exc), "disclosure_blocked")
        record = {
            "schema": 1, "session": self.session_id, "time": round(time.time(), 3),
            "question": question, "context_chars": len(context), "status": "answered",
            "reason": None, "answer": cleaned,
            "answer_sha256": hashlib.sha256(cleaned.encode()).hexdigest(),
            "sources": sorted(set(str(item) for item in sources)),
        }
        with self._lock:
            self._answers[key] = cleaned
            self._records.append(self._audit(record))
        return {"schema": 1, "status": "answered", "answer": cleaned,
                "reason": None, "cached": False}


class _BrokerHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        payload = self.rfile.readline(MAX_REQUEST_BYTES)
        try:
            request = json.loads(payload)
            response = self.server.broker.ask(request)
        except Exception as exc:
            response = {"schema": 1, "status": "invalid", "answer": None,
                        "reason": f"invalid request: {type(exc).__name__}"}
        try:
            self.wfile.write(json.dumps(response, sort_keys=True).encode() + b"\n")
            self.wfile.flush()
        except OSError:
            pass


class _BrokerServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, socket_path: str, broker: Broker):
        self.broker = broker
        super().__init__(socket_path, _BrokerHandler)

    def server_bind(self) -> None:
        super().server_bind()
        os.chmod(self.server_address, 0o666)

    def handle_error(self, request, client_address) -> None:
        # A malformed sandbox request must not print private material or crash the run.
        return


class BrokerHost:
    """Serve a Broker on a Unix socket while the implementation container runs."""

    def __init__(self, broker: Broker, socket_path: Path):
        self.broker = broker
        self.socket_path = Path(socket_path)
        if len(str(self.socket_path)) >= 100:
            raise ValueError("broker socket path is too long for a Unix socket")
        self._server: _BrokerServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> BrokerHost:
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        self.socket_path.unlink(missing_ok=True)
        self._server = _BrokerServer(str(self.socket_path), self.broker)
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        name="cleanroom-broker", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        self.socket_path.unlink(missing_ok=True)

    def __enter__(self) -> BrokerHost:
        return self.start()

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.stop()
