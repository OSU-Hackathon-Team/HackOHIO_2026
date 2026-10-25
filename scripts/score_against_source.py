"""Analyst-only: score a dossier's claims against the public LibreOffice source.

    python3 scripts/score_against_source.py --state decomp-state --dossier-artifact <sha> \
        --source ~/src/libreoffice-core [--out decomp-state/lo_score.md]

LibreOffice is MPL-2.0 and its source is public, so it is ground truth for "is the
decompile junk?". This script must never feed the source to any model or into the spec;
it only measures. For each claim it finds the C++ definition of the claimed function and
reports mechanical signals:
  * located      the function's definition was found in the source tree
  * constants    numbers the claim states that also appear in the function body
  * unsupported  numbers the claim states that do not appear (likely invented or derived)
and writes a side-by-side sheet with an empty "grade" column for a human to fill in.
Precision is the human grade, not these signals.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402

SOURCE_GLOBS = ("sc/source/core/tool/*.cxx", "sc/source/core/data/*.cxx",
                "formula/source/core/api/*.cxx")
NUMBER = re.compile(r"(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?![\w.])")
TRIVIAL = {"0", "1", "-1", "2"}


def short_name(name: str) -> str:
    """'ScInterpreter::ScMul' or 'ScMul' or a mangled name -> 'ScMul'."""
    if name.startswith("_Z"):
        match = re.search(r"\d+([A-Za-z_]\w*)E", name)
        return match.group(1) if match else name
    return name.split("::")[-1].split("(")[0]


def find_definition(source: Path, name: str) -> tuple[str, str] | None:
    """(relative path, body) of the first `Class::name(` definition with a braced body."""
    short = short_name(name)
    pattern = re.compile(r"^[^\n;]*\b\w+::" + re.escape(short) + r"\s*\([^;{]*\)[^;{]*\{", re.M)
    for glob in SOURCE_GLOBS:
        for path in sorted(source.glob(glob)):
            text = path.read_text(errors="replace")
            match = pattern.search(text)
            if not match:
                continue
            depth, index = 0, match.end() - 1
            for index in range(match.end() - 1, len(text)):
                depth += {"{": 1, "}": -1}.get(text[index], 0)
                if depth == 0:
                    break
            return str(path.relative_to(source)), text[match.start():index + 1]
    return None


def score_claim(claim: dict, names: dict[str, str], source: Path) -> dict:
    name = names.get(claim["subject"], claim["subject"])
    found = find_definition(source, name)
    stated = sorted(set(NUMBER.findall(claim["statement"])) - TRIVIAL)
    body = found[1] if found else ""
    in_body = set(NUMBER.findall(body))
    return {"subject": claim["subject"], "function": name, "statement": claim["statement"],
            "review_state": claim.get("review_state"), "located": found is not None,
            "source_file": found[0] if found else None,
            "constants": [n for n in stated if n in in_body],
            "unsupported": [n for n in stated if n not in in_body] if found else stated,
            "excerpt": body[:1500]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--state", type=Path, default=ROOT / "decomp-state")
    parser.add_argument("--dossier-artifact", required=True)
    parser.add_argument("--source", type=Path, required=True, help="LibreOffice core checkout")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    store = LocalArtifactStore(args.state / "artifacts")
    dossier = json.loads(store.get(args.dossier_artifact))
    names = {item["entry"]: item["name"] for item in dossier["scope"]["included"]}
    rows = [score_claim(claim, names, args.source) for claim in dossier["claims"]]
    located = sum(r["located"] for r in rows)
    with_numbers = [r for r in rows if r["constants"] or r["unsupported"]]
    supported = sum(not r["unsupported"] for r in with_numbers)
    summary = {"claims": len(rows), "located": located,
               "claims_with_constants": len(with_numbers),
               "claims_all_constants_in_source": supported}
    out = args.out or args.state / "lo_score.md"
    lines = [f"# Claim score for dossier {args.dossier_artifact[:12]}", "",
             f"{summary}", "", "Fill in grade: correct / partly / wrong / not checkable.", ""]
    for r in rows:
        lines += [f"## {r['function']} ({r['subject']}) — review: {r['review_state']}", "",
                  f"> {r['statement']}", "",
                  f"source: {r['source_file'] or 'NOT FOUND'}  constants in body: {r['constants']}  "
                  f"not in body: {r['unsupported']}", "", "grade: ", "",
                  "```cpp", r["excerpt"], "```", ""]
    out.write_text("\n".join(lines))
    (out.with_suffix(".json")).write_text(json.dumps({"summary": summary, "claims": rows}, indent=2))
    print(json.dumps(summary))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
