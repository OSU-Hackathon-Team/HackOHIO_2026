"""Shared loader for the global role -> model config (models.json).

Resolution order for get_model(role):
  1. explicit argument (CLI --model / per-assignment "model")
  2. env MODEL_<ROLE_UPPER>  (e.g. MODEL_DECOMP_WORKER)
  3. models.json roles[role]
  4. env OPENCODE_MODEL (legacy override for the default role)
  5. models.json "default"
  6. hardcoded fallback "amazon-bedrock/deepseek.v3.2"
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

FALLBACK_MODEL = "amazon-bedrock/deepseek.v3.2"


def config_path(explicit: str | os.PathLike | None = None) -> Path:
    if explicit is not None:
        return Path(explicit)
    env_path = os.environ.get("MODELS_JSON") or os.environ.get("MODEL_CONFIG")
    if env_path:
        return Path(env_path)
    return Path(__file__).resolve().parent / "models.json"


@lru_cache(maxsize=8)
def _load_cached(path_str: str) -> dict:
    path = Path(path_str)
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def load_config(path: str | os.PathLike | None = None) -> dict:
    """Return {'default': str, 'roles': {role: model}} merged with built-ins."""
    resolved = config_path(path)
    data = _load_cached(str(resolved))
    roles = data.get("roles")
    if not isinstance(roles, dict):
        roles = {}
    default = data.get("default") or FALLBACK_MODEL
    return {"default": default, "roles": dict(roles), "path": str(resolved)}


def role_env_var(role: str) -> str:
    return "MODEL_" + role.upper().replace("-", "_")


def available_roles(path: str | os.PathLike | None = None) -> list[str]:
    return sorted(load_config(path)["roles"].keys())


def get_model(role: str = "decomp_worker",
              explicit: str | None = None,
              path: str | os.PathLike | None = None) -> str:
    if explicit:
        return explicit
    cfg = load_config(path)
    roles = cfg["roles"]
    env_hit = os.environ.get(role_env_var(role))
    if env_hit:
        return env_hit
    if role in roles and roles[role]:
        return str(roles[role])
    if role == "default":
        return str(os.environ.get("OPENCODE_MODEL") or cfg["default"])
    # Unknown role (or empty entry): fall back to default chain.
    return str(os.environ.get("OPENCODE_MODEL") or cfg["default"])


def resolved_table(path: str | os.PathLike | None = None) -> dict[str, str]:
    cfg = load_config(path)
    table = {"default": get_model("default", path=path)}
    for role in cfg["roles"]:
        table[role] = get_model(role, path=path)
    return table
