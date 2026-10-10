"""Small SQLite wrapper. Everything goes through parameterised queries."""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  theme TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'debug',
  app_id TEXT,
  app_name TEXT,
  version TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  duration_s REAL,
  exit_code INTEGER,
  failure_reason TEXT,
  message TEXT,
  artifact_name TEXT,
  artifact_size INTEGER,
  artifact_sha256 TEXT,
  artifact_path TEXT,
  artifact_deleted INTEGER NOT NULL DEFAULT 0,
  log_path TEXT
);
CREATE INDEX IF NOT EXISTS builds_project ON builds(project_id, created_at);
"""


class Database:
    def __init__(self, path: Path):
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(SCHEMA)

    def query(self, sql: str, params: tuple = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def one(self, sql: str, params: tuple = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: tuple = ()) -> None:
        with self._lock:
            self._conn.execute(sql, params)

    def close(self) -> None:
        with self._lock:
            self._conn.close()
