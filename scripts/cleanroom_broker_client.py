#!/usr/bin/env python3
"""Ask the cleanroom broker one behavioral question.

Runs inside the implementation sandbox. The broker socket is mounted at
/broker/broker.sock by default; nothing else from the analysis environment is
reachable. The broker answers caller-visible behavior only and may refuse.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys


def ask(socket_path: str, question: str, context: str, timeout: float) -> dict:
    request = json.dumps({"question": question, "context": context}).encode() + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(socket_path)
        client.sendall(request)
        response = b""
        while b"\n" not in response:
            chunk = client.recv(8192)
            if not chunk:
                break
            response += chunk
    if not response:
        raise RuntimeError("broker returned no response")
    return json.loads(response.split(b"\n", 1)[0])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("question", help="behavior question, for example 'what does finalize do?'")
    parser.add_argument("--context", default="",
                        help="failing case or test output; keep it short")
    parser.add_argument("--socket", default="/broker/broker.sock")
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()
    try:
        response = ask(args.socket, args.question, args.context, args.timeout)
    except Exception as exc:
        print(f"broker error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    if response.get("status") == "answered":
        print(response["answer"])
        return 0
    print(f"broker refused ({response.get('status')}): {response.get('reason')}",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
