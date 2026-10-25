"""Versioned internal records for native scope discovery."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class ScopeRequest:
    mode: str
    query: str
    seeds: tuple[str, ...]
    max_functions: int = 32
    max_depth: int = 2
    include_callers: bool = False
    include_shared_data: bool = True
    inclusions: tuple[str, ...] = ()
    exclusions: tuple[str, ...] = ()
    boundary_contracts: dict[str, str] = field(default_factory=dict)
    expected_observables: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, value: dict) -> "ScopeRequest":
        if not isinstance(value, dict):
            raise ValueError("scope request must be an object")
        allowed = set(cls.__dataclass_fields__)
        unknown = set(value) - allowed
        if unknown:
            raise ValueError(f"unknown scope fields: {sorted(unknown)}")
        data = dict(value)
        for key in ("seeds", "inclusions", "exclusions", "expected_observables"):
            raw = data.get(key, ())
            if not isinstance(raw, (list, tuple)):
                raise ValueError(f"{key} must be an array")
            data[key] = tuple(raw)
            if not all(isinstance(item, str) and item for item in data[key]):
                raise ValueError(f"{key} must contain nonempty strings")
        request = cls(**data)
        if request.mode not in {"subsystem", "project"}:
            raise ValueError("mode must be subsystem or project")
        if not request.query or not isinstance(request.query, str):
            raise ValueError("query must be a nonempty string")
        if request.mode == "subsystem" and not request.seeds and not request.inclusions:
            raise ValueError("subsystem scope requires a seed or explicit inclusion")
        if not isinstance(request.max_functions, int) or isinstance(request.max_functions, bool):
            raise ValueError("max_functions must be an integer")
        if not isinstance(request.max_depth, int) or isinstance(request.max_depth, bool):
            raise ValueError("max_depth must be an integer")
        if not 1 <= request.max_functions <= 10000 or not 0 <= request.max_depth <= 100:
            raise ValueError("scope limits are out of range")
        if not isinstance(request.boundary_contracts, dict) or not all(
            isinstance(k, str) and isinstance(v, str) and k and v
            for k, v in request.boundary_contracts.items()
        ):
            raise ValueError("boundary_contracts must map names or addresses to descriptions")
        return request

    def as_dict(self) -> dict:
        return asdict(self)
