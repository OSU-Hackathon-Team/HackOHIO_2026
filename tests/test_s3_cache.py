"""S3 cache bootstrap and corruption boundaries without AWS or model calls."""

import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from botocore.exceptions import ClientError

from engine.s3_cache import S3ArtifactStore, S3StageCache
from engine.analysis.ghidra import GhidraAnalysis
from engine.lo_pipeline import _materialize_cached_result, _restore_cached_analysis


def error(code):
    return ClientError({"Error": {"Code": code, "Message": code}}, "GetObject")


class FakeS3:
    def __init__(self):
        self.objects = {}

    def put_object(self, *, Bucket, Key, Body, IfNoneMatch, **unused):
        if Key in self.objects:
            raise error("PreconditionFailed")
        self.objects[Key] = bytes(Body)

    def get_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise error("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[Key])}

    def list_objects_v2(self, *, Bucket, Prefix, MaxKeys):
        return {"Contents": [{"Key": key} for key in self.objects if key.startswith(Prefix)][:MaxKeys]}


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.s3 = FakeS3()
        self.store = S3ArtifactStore(Path(self.temp.name) / "first", "private", self.s3)
        self.cache = S3StageCache(self.store)

    def test_new_worker_rehydrates_verified_artifact_and_stage(self):
        identity = {"binary": "a" * 64, "model": "pinned-model", "scope": "x"}
        artifact = self.cache.put("semantic_review", identity, {"answer": "checked"})
        other = S3StageCache(S3ArtifactStore(Path(self.temp.name) / "second", "private", self.s3))
        self.assertEqual(other.get("semantic_review", identity), {"answer": "checked"})
        self.assertEqual(other.store.get(artifact), b'{"answer":"checked"}')
        self.assertIsNone(other.get("semantic_review", {**identity, "model": "changed"}))
        self.assertIsNone(other.get("semantic_review", {**identity, "binary": "b" * 64}))

    def test_corrupt_artifact_and_pointer_are_rejected(self):
        identity = {"campaign": "one"}
        artifact = self.cache.put("function", identity, {"entry": "0010"})
        artifact_key = self.store._key(artifact)
        self.s3.objects[artifact_key] = b'tampered'
        fresh = S3StageCache(S3ArtifactStore(Path(self.temp.name) / "fresh", "private", self.s3))
        with self.assertRaisesRegex(RuntimeError, "remote artifact corruption"):
            fresh.get("function", identity)
        self.s3.objects[artifact_key] = b'{"entry":"0010"}'
        key, _ = fresh._key("function", identity)
        self.s3.objects[key] = b'{"schema":1,"identity_sha256":"wrong","artifact":"bad"}'
        with self.assertRaisesRegex(RuntimeError, "invalid S3 cache pointer"):
            fresh.get("function", identity)

    def test_access_denied_for_absent_key_is_a_miss_only_after_scoped_listing(self):
        class OpaqueMiss(FakeS3):
            def get_object(self, *, Bucket, Key):
                if Key not in self.objects:
                    raise error("AccessDenied")
                return super().get_object(Bucket=Bucket, Key=Key)
        s3 = OpaqueMiss()
        cache = S3StageCache(S3ArtifactStore(Path(self.temp.name) / "opaque", "private", s3))
        self.assertIsNone(cache.get("function", {"campaign": "new"}))

    def test_conflicting_pointer_cannot_replace_completed_result(self):
        identity = {"campaign": "same"}
        self.cache.put("function", identity, {"entry": "one"})
        with self.assertRaisesRegex(RuntimeError, "pointer conflict"):
            self.cache.put("function", identity, {"entry": "two"})

    def test_artifact_upload_failure_never_publishes_stage_pointer(self):
        class Broken(FakeS3):
            def put_object(self, *, Key, **kwargs):
                if "/artifacts/" in Key:
                    raise error("AccessDenied")
                return super().put_object(Key=Key, **kwargs)
        broken = Broken()
        cache = S3StageCache(S3ArtifactStore(Path(self.temp.name) / "broken", "private", broken))
        with self.assertRaises(ClientError):
            cache.put("function", {"campaign": "x"}, {"entry": "one"})
        self.assertFalse(any("/entries/" in key for key in broken.objects))

    def test_next_campaign_worker_reads_function_without_ghidra_export(self):
        index = {"functions": [{"entry": "00100010", "name": "f"}]}
        index_artifact = self.store.put(json.dumps(index).encode())
        def engine(root, store, warm):
            item = GhidraAnalysis.__new__(GhidraAnalysis)
            item.root, item.store, item.cache, item.warm = root, store, S3StageCache(store), warm
            item._emit = lambda *args, **kwargs: None
            item._run = lambda *args, **kwargs: self.fail("Ghidra export ran on a cache hit")
            return item
        class Warm:
            def export(self, manifest, address):
                return json.dumps({"entry": address, "status": "ok", "decompilation": "int f()"}).encode()
        first_root = Path(self.temp.name) / "project-one"
        first_root.mkdir()
        first = engine(first_root, self.store, Warm())
        manifest = {"project": str(first_root), "campaign": "campaign-one",
                    "index_artifact": index_artifact, "analysis_options": {},
                    "program_name": "fixture.so"}
        self.assertEqual(first.function(manifest, "00100010")["status"], "ok")
        second_root = Path(self.temp.name) / "project-two"
        second_root.mkdir()
        remote = S3ArtifactStore(Path(self.temp.name) / "remote-artifacts", "private", self.s3)
        second = engine(second_root, remote, None)
        reused = second.function({**manifest, "project": str(second_root)}, "00100010")
        self.assertEqual(reused["decompilation"], "int f()")
        self.assertTrue((second_root / "functions" / "00100010.json").exists())
        changed_root = Path(self.temp.name) / "project-changed"
        changed_root.mkdir()
        changed = engine(changed_root, remote, None)
        with self.assertRaises(AssertionError):
            changed.function({**manifest, "project": str(changed_root),
                              "campaign": "different-campaign"}, "00100010")

    def test_reused_model_record_keeps_output_but_zeroes_new_run_usage(self):
        response = self.store.put(b'{"answer":"reviewed"}')
        root = Path(self.temp.name) / "run"
        record = {"attempt_id": "a" * 32, "artifact": "b" * 64,
                  "response_artifact": response, "state": "unreviewed",
                  "answer": {"claims": []},
                  "usage": {"input": 100, "output": 20, "cost": 0.1}}
        fresh = S3ArtifactStore(root / "artifacts", "private", self.s3)
        _materialize_cached_result(root, fresh, "attempts", record)
        saved = json.loads((root / "attempts" / ("a" * 32) / "result.json").read_text())
        self.assertEqual(saved["answer"], record["answer"])
        self.assertEqual(saved["usage"]["input"], 0)
        self.assertEqual(fresh.get(response), b'{"answer":"reviewed"}')
        with self.assertRaisesRegex(RuntimeError, "identity"):
            _materialize_cached_result(root, fresh, "attempts",
                                       {**record, "attempt_id": "../../outside"})

    def test_reviewed_analysis_restores_without_model_calls(self):
        root = Path(self.temp.name) / "reviewed-run"
        remote = S3ArtifactStore(root / "artifacts", "private", self.s3)
        cache = S3StageCache(remote)
        evidence = {"entry": "00100010", "instructions": []}
        evidence_artifact = remote.put(json.dumps(evidence).encode())
        prompt_artifact = remote.put(b"prompt")
        identity = {"campaign": "campaign", "scope_artifact": remote.put(b"scope"),
                    "evidence_artifact": evidence_artifact,
                    "semantic_model": "drafter", "review_model": "reviewer"}
        draft = {"attempt_id": "1" * 32, "campaign": "campaign",
                 "scope_artifact": identity["scope_artifact"], "subject": "00100010",
                 "evidence_artifact": evidence_artifact, "model": "drafter",
                 "state": "unreviewed", "structural_errors": [],
                 "answer": {**{key: "known" for key in
                              ("inputs", "outputs", "state", "side_effects", "errors", "pseudocode")},
                            **{key: [] for key in
                               ("claims", "dependencies", "unknowns", "evidence_requests")}},
                 "prompt_artifact": prompt_artifact,
                 "usage": {"input": 10, "output": 5, "reasoning": 0, "cost": 0.01}}
        draft_artifact = remote.put(json.dumps(draft).encode())
        review = {"review_id": "2" * 32, "campaign": "campaign",
                  "draft_artifact": draft_artifact, "subject": "00100010",
                  "evidence_artifact": evidence_artifact, "model": "reviewer",
                  "state": "reviewed", "structural_errors": [],
                  "answer": {"reviews": [], "missing_behavior": [], "unresolved": []},
                  "prompt_artifact": prompt_artifact,
                  "usage": {"input": 8, "output": 3, "reasoning": 0, "cost": 0.01}}
        review_artifact = remote.put(json.dumps(review).encode())
        cache.put("semantic_review", identity,
                  {"draft_artifact": draft_artifact, "review_artifact": review_artifact})
        class Engine:
            def __init__(self, root, store):
                self.root, self.store, self.events = root, store, []
            def _emit(self, *args, **kwargs):
                self.events.append(args[1])
        fresh_store = S3ArtifactStore(Path(self.temp.name) / "fresh-artifacts", "private", self.s3)
        fresh = Engine(Path(self.temp.name) / "fresh-run", fresh_store)
        restored = _restore_cached_analysis(fresh, S3StageCache(fresh_store),
                                            identity, "00100010", evidence)
        self.assertEqual(restored["draft"]["artifact"], draft_artifact)
        self.assertEqual(restored["review"]["artifact"], review_artifact)
        self.assertEqual(fresh.events, ["semantic_cache_hit", "review_cache_hit"])
        self.assertEqual(json.loads((fresh.root / "attempts" / ("1" * 32) /
                                     "result.json").read_text())["usage"]["input"], 0)
        self.assertEqual(fresh_store.get(prompt_artifact), b"prompt")
        review["campaign"] = "wrong"
        bad_review = remote.put(json.dumps(review).encode())
        bad_identity = {**identity, "revision": 2}
        cache.put("semantic_review", bad_identity,
                  {"draft_artifact": draft_artifact, "review_artifact": bad_review})
        with self.assertRaisesRegex(RuntimeError, "failed validation"):
            _restore_cached_analysis(fresh, S3StageCache(fresh_store),
                                     bad_identity, "00100010", evidence)

    def test_scoped_index_bootstraps_after_local_baseline_preparation(self):
        scope = {"functions": [{"entry": "00100010"}], "frontier": []}
        def make(root, store, allow_export):
            root.mkdir()
            engine = GhidraAnalysis.__new__(GhidraAnalysis)
            engine.root, engine.store, engine.cache = root, store, S3StageCache(store)
            engine.headless = root / "headless"
            engine._emit = lambda *args, **kwargs: None
            def run(args, *unused):
                if not allow_export:
                    self.fail("scoped index export ran on a cache hit")
                Path(args[-2]).write_text(json.dumps({"status": "ok", "functions": [
                    {"entry": "00100010"}, {"entry": "00100020"}]}))
            engine._run = run
            return engine
        first_root = Path(self.temp.name) / "index-one"
        second_root = Path(self.temp.name) / "index-two"
        first = make(first_root, self.store, True)
        second_store = S3ArtifactStore(Path(self.temp.name) / "index-artifacts", "private", self.s3)
        second = make(second_root, second_store, False)
        def prepared(root):
            return {"project": str(root), "campaign": "exact-campaign",
                    "scope_sha256": "a" * 64, "scope": scope,
                    "program_name": "fixture.so"}
        with patch("engine.analysis.scoped.prepare_scoped", side_effect=[prepared(first_root),
                                                                        prepared(second_root)]), \
             patch("engine.analysis.ghidra.tool_version", return_value="version"):
            one = first.analyze_scoped(Path("fixture.so"), ["seed"], max_functions=1, max_depth=0)
            two = second.analyze_scoped(Path("fixture.so"), ["seed"], max_functions=1, max_depth=0)
        self.assertEqual(one["index_artifact"], two["index_artifact"])
        self.assertEqual(two["function_count"], 1)


if __name__ == "__main__":
    unittest.main()
