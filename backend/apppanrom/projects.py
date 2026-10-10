"""Project metadata (SQLite) and source files (a controlled directory per project)."""
from __future__ import annotations

import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .config import Settings
from .db import Database
from .lang import validate_app_id, validate_version

PROJECT_ID_RE = re.compile(r"^p_[0-9a-f]{12}$")
FILE_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_\-]{0,63}\.(apn|md|txt)$")
MAIN_FILE = "main.apn"
THEMES = ("light", "dark")

STARTER = '''# Welcome to AppPanrom! Edit this file, then press Run.
app_uruvakku("{name}")

mari clicks = 0

function welcome():
    mari username = text_trim(input_value("name"))
    clicks = clicks + 1
    enna_na username == "":
        toast_kaattu("Un peru ennanu sollu!")
    illana:
        message_kaattu("Vanakkam " + username + "!")

screen_uruvakku("home"):
    screen_title("{name}")
    column_uruvakku(style={{"padding": 24, "gap": 16}}):
        title("Vanakkam Nanba!", style={{"text_align": "center"}})
        text_kaattu("AppPanrom-la un first app!")
        input_uruvakku("name", label="Un peru", placeholder="Un peru enna?")
        button("Click Pannu", click_pannumbodhu=welcome)
        enna_na clicks > 0:
            text_kaattu("Clicks: " + str(clicks))
'''


class NotFound(Exception):
    pass


class Invalid(Exception):
    def __init__(self, message: str, code: str = "invalid"):
        super().__init__(message)
        self.code = code


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slug_app_id(name: str) -> str:
    part = re.sub(r"[^a-z0-9]", "", name.lower()) or "app"
    if not part[0].isalpha():
        part = "app" + part
    return f"com.apppanrom.{part[:30]}"


class ProjectStore:
    def __init__(self, settings: Settings, db: Database):
        self.s = settings
        self.db = db

    # ---- helpers
    def _dir(self, project_id: str) -> Path:
        if not PROJECT_ID_RE.fullmatch(project_id):
            raise NotFound("project")
        return self.s.projects_dir / project_id

    @staticmethod
    def _check_meta(name=None, app_id=None, version=None, theme=None):
        if name is not None and not (1 <= len(name.strip()) <= 60):
            raise Invalid("Project name must be 1-60 characters.", "bad_name")
        if app_id is not None:
            msg = validate_app_id(app_id)
            if msg:
                raise Invalid(f"Invalid application id. {msg}", "bad_app_id")
        if version is not None:
            msg = validate_version(version)
            if msg:
                raise Invalid(f"Invalid version. {msg}", "bad_version")
        if theme is not None and theme not in THEMES:
            raise Invalid(f"Theme must be one of: {', '.join(THEMES)}.", "bad_theme")

    # ---- projects
    def list(self) -> list[dict]:
        return [self._public(r) for r in self.db.query("SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC")]

    def get(self, project_id: str) -> dict:
        self._dir(project_id)
        row = self.db.one("SELECT * FROM projects WHERE id = ?", (project_id,))
        if not row:
            raise NotFound("project")
        return self._public(row)

    def _public(self, row: dict) -> dict:
        d = self._dir(row["id"])
        files = sorted(p.name for p in d.glob("*") if p.is_file() and FILE_NAME_RE.fullmatch(p.name)) if d.exists() else []
        return {
            "id": row["id"], "name": row["name"], "app_id": row["app_id"], "version": row["version"],
            "theme": row["theme"], "created_at": row["created_at"], "updated_at": row["updated_at"], "files": files,
        }

    def create(self, name: str, app_id: str | None = None, version: str = "1.0.0", theme: str = "light",
               source: str | None = None) -> dict:
        name = name.strip()
        app_id = app_id or slug_app_id(name)
        self._check_meta(name, app_id, version, theme)
        if len(self.db.query("SELECT id FROM projects")) >= self.s.max_projects:
            raise Invalid(f"Project limit reached ({self.s.max_projects}).", "limit")
        pid = "p_" + uuid.uuid4().hex[:12]
        d = self._dir(pid)
        d.mkdir(parents=True)
        text = source if source is not None else STARTER.format(name=name.replace('"', "'").replace("\\", ""))
        (d / MAIN_FILE).write_text(text, encoding="utf-8")
        ts = now()
        self.db.execute("INSERT INTO projects VALUES (?,?,?,?,?,?,?)", (pid, name, app_id, version, theme, ts, ts))
        return self.get(pid)

    def update(self, project_id: str, **fields) -> dict:
        cur = self.get(project_id)
        new = {k: v for k, v in fields.items() if v is not None}
        self._check_meta(new.get("name"), new.get("app_id"), new.get("version"), new.get("theme"))
        if "name" in new:
            new["name"] = new["name"].strip()
        merged = {**cur, **new}
        self.db.execute(
            "UPDATE projects SET name=?, app_id=?, version=?, theme=?, updated_at=? WHERE id=?",
            (merged["name"], merged["app_id"], merged["version"], merged["theme"], now(), project_id),
        )
        return self.get(project_id)

    def delete(self, project_id: str, artifact_cleanup=None) -> None:
        self.get(project_id)
        if artifact_cleanup:
            artifact_cleanup(project_id)
        shutil.rmtree(self._dir(project_id), ignore_errors=True)
        self.db.execute("DELETE FROM builds WHERE project_id = ?", (project_id,))
        self.db.execute("DELETE FROM projects WHERE id = ?", (project_id,))

    # ---- files (flat directory; names are validated, never joined from user paths)
    def _file(self, project_id: str, name: str) -> Path:
        if not FILE_NAME_RE.fullmatch(name):
            raise Invalid("File names use letters, digits, '_' or '-' and end with .apn, .md or .txt.", "bad_file_name")
        return self._dir(project_id) / name

    def read_file(self, project_id: str, name: str) -> str:
        self.get(project_id)
        p = self._file(project_id, name)
        if not p.is_file():
            raise NotFound("file")
        return p.read_text(encoding="utf-8")

    def write_file(self, project_id: str, name: str, content: str) -> dict:
        proj = self.get(project_id)
        p = self._file(project_id, name)
        if len(content.encode("utf-8")) > self.s.max_file_bytes:
            raise Invalid(f"File is larger than {self.s.max_file_bytes} bytes.", "file_too_large")
        if not p.exists() and len(proj["files"]) >= self.s.max_files_per_project:
            raise Invalid(f"A project can have at most {self.s.max_files_per_project} files.", "limit")
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(p)
        self.db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now(), project_id))
        return {"name": name, "size": len(content.encode("utf-8"))}

    def delete_file(self, project_id: str, name: str) -> None:
        self.get(project_id)
        if name == MAIN_FILE:
            raise Invalid("main.apn is the app's entry file and cannot be deleted.", "protected_file")
        p = self._file(project_id, name)
        if not p.is_file():
            raise NotFound("file")
        p.unlink()

    def compile_defaults(self, project: dict) -> dict:
        return {"name": project["name"], "app_id": project["app_id"], "version": project["version"], "theme": project["theme"]}
