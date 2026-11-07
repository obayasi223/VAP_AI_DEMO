"""TS の zod から生成した JSON Schema で JSON メッセージを検証する。

スキーマの正本は packages/contracts/src。ここで手書きしない。
`npm run gen:schemas` で packages/contracts/schemas が更新される。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import best_match

SCHEMA_DIR = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "schemas"
_SUFFIX = ".schema.json"

SCHEMA_NAMES = tuple(sorted(p.name[: -len(_SUFFIX)] for p in SCHEMA_DIR.glob(f"*{_SUFFIX}")))


class ContractViolation(ValueError):
    """契約に合わないメッセージ。"""

    def __init__(self, schema: str, message: str, path: str) -> None:
        super().__init__(f"{schema}: {message} (at {path or '<root>'})")
        self.schema = schema
        self.path = path


@lru_cache(maxsize=None)
def _validator(name: str) -> Draft202012Validator:
    path = SCHEMA_DIR / f"{name}{_SUFFIX}"
    if not path.exists():
        raise KeyError(f"unknown schema {name!r}; known: {SCHEMA_NAMES}")
    schema = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def is_valid(name: str, message: Any) -> bool:
    return _validator(name).is_valid(message)


def validate(name: str, message: Any) -> None:
    """不合格なら ContractViolation。"""
    error = best_match(_validator(name).iter_errors(message))
    if error is not None:
        path = "/".join(str(p) for p in error.absolute_path)
        raise ContractViolation(name, error.message, path)
