"""Check watchdog decisions, cache, and reviewer independence without a model call."""

import hashlib
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.watchdog import Watchdog
from model_config import get_model


class Store:
    def __init__(self):
        self.items = {}

    def put(self, content):
        key = hashlib.sha256(content).hexdigest()
        self.items[key] = content
        return key

    def get(self, key):
        return self.items[key]


class Engine:
    def __init__(self, root):
        self.root = root
        self.store = Store()


with tempfile.TemporaryDirectory() as directory:
    engine = Engine(Path(directory))
    watchdog = Watchdog(engine, Path("/unused"))
    calls = []

    def invoke(*args, **kwargs):
        calls.append(kwargs["model"])
        (args[1] / "events.jsonl").write_text("{}\n")
        return {"text": json.dumps({"diagnosis": "The prior answer confused object layout with behavior.",
                                     "guidance": "Derive the visible add and clear transitions.",
                                     "model_role": "decomp_watchdog",
                                     "evidence_bytes": 90000})}

    inputs = {"campaign": "campaign", "scope_artifact": "scope", "subject": "entry",
              "stage": "semantic", "snapshot": {"last_failure": "layout"}}
    with patch("engine.watchdog.invoke_opencode", side_effect=invoke):
        first = watchdog.inspect(**inputs)
        assert first["state"] == "ready"
        assert first["intervention"]["evidence_bytes"] == 90000
        assert first["model"] == get_model("decomp_watchdog")
        cached = watchdog.inspect(**inputs, previous_artifact=first["artifact"])
        assert cached["artifact"] == first["artifact"] and len(calls) == 1
        revised = watchdog.inspect(**{**inputs, "snapshot": {"last_failure": "missing rule"}},
                                   previous_artifact=first["artifact"])
        assert revised["artifact"] != first["artifact"] and len(calls) == 2
        rejected = watchdog.inspect(**{**inputs, "stage": "review"},
                                    occupied_models={get_model("decomp_watchdog")})
        assert rejected["state"] == "failed"
        assert rejected["intervention"]["guidance"] == ""

    def review_reply(*args, **kwargs):
        return {"text": json.dumps({"diagnosis": "The draft has an unsupported transition.",
                                     "guidance": "Check both empty and populated state.",
                                     "model_role": "decomp_reviewer", "evidence_bytes": None})}

    with patch("engine.watchdog.invoke_opencode", side_effect=review_reply):
        review = watchdog.inspect(**{**inputs, "stage": "review"},
                                  occupied_models={get_model("decomp_worker")})
        assert review["state"] == "ready"
        assert review["intervention"]["model_role"] == "decomp_reviewer"

    def implementation_reply(*args, **kwargs):
        return {"text": json.dumps({"diagnosis": "Public transitions disagree.",
                                     "guidance": "Infer predicate categories from observed transitions.",
                                     "model_role": "decomp_watchdog", "evidence_bytes": 48000})}

    with patch("engine.watchdog.invoke_opencode", side_effect=implementation_reply):
        implementation = watchdog.inspect(**{**inputs, "stage": "implementation"})
        assert implementation["state"] == "ready"
        assert implementation["intervention"]["model_role"] == "decomp_watchdog"
        assert implementation["intervention"]["evidence_bytes"] is None

    def line_broken_reply(*args, **kwargs):
        return {"text": ("{\"diagnosis\": \"Public transitions disagree\n"
                         "for copy.\", \"guidance\": \"Derive copy from the "
                         "observed rows.\", \"model_role\": null, "
                         "\"evidence_bytes\": null}")}

    with patch("engine.watchdog.invoke_opencode", side_effect=line_broken_reply):
        recovered = watchdog.inspect(**{**inputs, "stage": "implementation"})
        assert recovered["state"] == "ready"
        assert recovered["intervention"]["guidance"] == \
            "Derive copy from the observed rows."

print("watchdog checks passed")
