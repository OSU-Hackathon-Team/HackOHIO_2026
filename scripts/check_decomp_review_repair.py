"""A missing citation array is repaired by a second review response."""

import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.artifacts import LocalArtifactStore
from engine.validation.review import IndependentReviewer


class Engine:
    def __init__(self, root):
        self.root = root
        self.store = LocalArtifactStore(root / "artifacts")

    def _emit(self, *_args, **_kwargs):
        pass


def main():
    with TemporaryDirectory() as temporary:
        engine = Engine(Path(temporary))
        evidence = {"entry": "00100000", "name": "value",
                    "instructions": [{"address": "00100000"}],
                    "decompilation": "return 1;"}
        evidence_artifact = engine.store.put(json.dumps(evidence).encode())
        draft = {"state": "unreviewed", "campaign": "c" * 64,
                 "subject": "00100000", "evidence_artifact": evidence_artifact,
                 "answer": {"claims": [{"statement": "Returns one.",
                                       "evidence_addresses": ["00100000"],
                                       "assumptions": []}]}}
        draft_artifact = engine.store.put(json.dumps(draft).encode())
        calls = []

        def model(_binary, folder, _prompt, **_kwargs):
            calls.append(folder)
            answer = {"reviews": [{"claim_index": 0, "outcome": "supported_static",
                                   "reason": "The return instruction supplies one.",
                                   "evidence_addresses": None if len(calls) == 1 else ["00100000"]}],
                      "missing_behavior": [], "unresolved": []}
            (folder / "events.jsonl").write_text("{}\n")
            return {"text": json.dumps(answer), "usage": {"input": 1, "output": 1,
                    "reasoning": 0, "cost": 0}, "runtime_version": "test"}

        with patch("engine.validation.review.invoke_opencode", model):
            result = IndependentReviewer(engine, Path("/unused")).run(draft_artifact)
        assert result["state"] == "reviewed", result
        assert len(result["revisions"]) == 2
        assert result["revisions"][0]["errors"] == ["review 0 needs evidence_addresses array"]
        assert result["revisions"][1]["errors"] == []
        print("review repair check passed")


if __name__ == "__main__":
    main()
