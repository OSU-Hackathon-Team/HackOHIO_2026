"""Private, content-addressed S3 cache for native analysis workers."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from botocore.exceptions import ClientError

from engine.artifacts import LocalArtifactStore


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _missing(error: ClientError) -> bool:
    return error.response.get("Error", {}).get("Code") in ("NoSuchKey", "404", "NotFound")


class S3ArtifactStore(LocalArtifactStore):
    def __init__(self, root: Path, bucket: str, client, prefix: str = "cache/v1"):
        super().__init__(root)
        self.bucket, self.client, self.prefix = bucket, client, prefix.rstrip("/")

    def _key(self, digest: str) -> str:
        return f"{self.prefix}/artifacts/{digest[:2]}/{digest}"

    def put(self, data: bytes) -> str:
        digest = super().put(data)
        try:
            self.client.put_object(Bucket=self.bucket, Key=self._key(digest), Body=data,
                                   IfNoneMatch="*", ServerSideEncryption="AES256")
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") not in ("PreconditionFailed", "412"):
                raise
            if self._remote(digest) != data:
                raise RuntimeError(f"remote artifact digest collision: {digest}") from error
        return digest

    def _remote(self, digest: str) -> bytes:
        data = self.client.get_object(Bucket=self.bucket, Key=self._key(digest))["Body"].read()
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError(f"remote artifact corruption: {digest}")
        return data

    def get(self, digest: str) -> bytes:
        try:
            return super().get(digest)
        except FileNotFoundError:
            if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                raise ValueError("invalid artifact digest") from None
            data = self._remote(digest)
            LocalArtifactStore.put(self, data)
            return data


class S3StageCache:
    def __init__(self, store: S3ArtifactStore):
        self.store = store

    def _key(self, stage: str, identity: dict) -> tuple[str, str]:
        if not stage.replace("_", "").isalnum():
            raise ValueError("invalid cache stage")
        digest = hashlib.sha256(canonical(identity)).hexdigest()
        return f"{self.store.prefix}/entries/{stage}/{digest}.json", digest

    def get(self, stage: str, identity: dict) -> dict | None:
        key, digest = self._key(stage, identity)
        try:
            data = self.store.client.get_object(Bucket=self.store.bucket, Key=key)["Body"].read()
        except ClientError as error:
            if _missing(error):
                return None
            if error.response.get("Error", {}).get("Code") in ("AccessDenied", "403"):
                listed = self.store.client.list_objects_v2(Bucket=self.store.bucket,
                                                           Prefix=key, MaxKeys=1)
                if not any(item.get("Key") == key for item in listed.get("Contents", [])):
                    return None
            raise
        pointer = json.loads(data)
        if (pointer.get("schema") != 1 or pointer.get("identity_sha256") != digest or
                not isinstance(pointer.get("artifact"), str)):
            raise RuntimeError(f"invalid S3 cache pointer: {key}")
        value = json.loads(self.store.get(pointer["artifact"]))
        if not isinstance(value, dict):
            raise RuntimeError(f"invalid S3 cache value: {key}")
        return value

    def put(self, stage: str, identity: dict, value: dict) -> str:
        key, digest = self._key(stage, identity)
        artifact = self.store.put(canonical(value))
        pointer = {"schema": 1, "identity_sha256": digest, "artifact": artifact}
        try:
            self.store.client.put_object(Bucket=self.store.bucket, Key=key,
                                         Body=canonical(pointer), ContentType="application/json",
                                         IfNoneMatch="*", ServerSideEncryption="AES256")
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") not in ("PreconditionFailed", "412"):
                raise
            existing = self.get(stage, identity)
            if existing != value:
                raise RuntimeError(f"S3 cache pointer conflict: {key}") from error
        return artifact
