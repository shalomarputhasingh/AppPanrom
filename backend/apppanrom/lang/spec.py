"""Loads the shared language/component/style spec (spec/schema.json)."""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


@lru_cache(maxsize=1)
def load_spec() -> dict:
    path = Path(os.environ.get("APPANROM_SPEC", REPO_ROOT / "spec" / "schema.json"))
    return json.loads(path.read_text(encoding="utf-8"))
