"""Background Android builds: generate project -> run Gradle -> verify APK -> record result."""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from ..config import Settings
from ..db import Database
from .generate import GenerateError, generate_project
from .prereqs import check_prerequisites, format_problems, gradle_bin

BUILD_ID_RE = re.compile(r"^b_[0-9a-f]{12}$")
MIN_APK_BYTES = 50_000
APK_REL = Path("app/build/outputs/apk/debug/app-debug.apk")
PASSTHROUGH_ENV = ("PATH", "HOME", "LANG", "JAVA_TOOL_OPTIONS", "http_proxy", "https_proxy", "HTTP_PROXY",
                   "HTTPS_PROXY", "no_proxy", "NO_PROXY", "SSL_CERT_FILE")
TERMINAL = ("succeeded", "failed")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def verify_apk(path: Path) -> str | None:
    """Returns a problem description, or None if the file is a plausible APK."""
    try:
        size = path.stat().st_size
    except OSError:
        return "APK file was not produced."
    if size < MIN_APK_BYTES:
        return f"APK is only {size} bytes, which is too small to be a real app."
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
    except zipfile.BadZipFile:
        return "Output is not a valid APK (zip) file."
    if "AndroidManifest.xml" not in names:
        return "APK has no AndroidManifest.xml."
    if not any(n.endswith("apppanrom-runtime.js") for n in names):
        return "APK does not contain the AppPanrom runtime."
    return None


class BuildManager:
    def __init__(self, settings: Settings, db: Database):
        self.s = settings
        self.db = db
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="apk-build")
        self._procs: dict[str, subprocess.Popen] = {}
        self._lock = threading.Lock()
        # A build can't survive a server restart: don't leave rows stuck in queued/running.
        self.db.execute(
            "UPDATE builds SET status='failed', failure_reason='interrupted', message=?, finished_at=? "
            "WHERE status IN ('queued','running')",
            ("The server restarted while this build was in progress.", _now()),
        )

    # ---- queries
    def get(self, build_id: str) -> dict | None:
        if not BUILD_ID_RE.fullmatch(build_id):
            return None
        row = self.db.one("SELECT * FROM builds WHERE id = ?", (build_id,))
        return self.public(row) if row else None

    def list_for_project(self, project_id: str) -> list[dict]:
        return [self.public(r) for r in self.db.query(
            "SELECT * FROM builds WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50", (project_id,))]

    @staticmethod
    def public(row: dict) -> dict:
        has_artifact = bool(row["artifact_path"]) and not row["artifact_deleted"] and row["status"] == "succeeded"
        return {
            "id": row["id"], "project_id": row["project_id"], "status": row["status"], "kind": row["kind"],
            "signing": "debug keystore (not suitable for Play Store)" if row["kind"] == "debug" else row["kind"],
            "app_id": row["app_id"], "app_name": row["app_name"], "version": row["version"],
            "created_at": row["created_at"], "started_at": row["started_at"], "finished_at": row["finished_at"],
            "duration_s": row["duration_s"], "exit_code": row["exit_code"],
            "failure_reason": row["failure_reason"], "message": row["message"],
            "artifact": {"name": row["artifact_name"], "size": row["artifact_size"], "sha256": row["artifact_sha256"]}
            if has_artifact else None,
        }

    # ---- logs
    def log_path(self, build_id: str) -> Path:
        return self.s.builds_dir / build_id / "build.log"

    def read_log(self, build_id: str, offset: int = 0, limit: int = 262_144) -> tuple[str, int]:
        p = self.log_path(build_id)
        if not p.is_file():
            return "", 0
        with p.open("rb") as f:
            f.seek(max(0, offset))
            data = f.read(limit)
        return data.decode("utf-8", errors="replace"), max(0, offset) + len(data)

    def _log(self, build_id: str, text: str) -> None:
        with self.log_path(build_id).open("a", encoding="utf-8") as f:
            f.write(text if text.endswith("\n") else text + "\n")

    # ---- artifacts
    def artifact_file(self, build_id: str) -> tuple[dict, Path] | None:
        """Returns (build, path) only for a succeeded build whose APK still exists and re-verifies."""
        b = self.get(build_id)
        if not b or not b["artifact"]:
            return None
        row = self.db.one("SELECT artifact_path FROM builds WHERE id = ?", (build_id,))
        path = self.s.artifacts_dir / row["artifact_path"]
        try:
            path.resolve().relative_to(self.s.artifacts_dir.resolve())
        except ValueError:
            return None
        if not path.is_file() or path.stat().st_size != b["artifact"]["size"]:
            return None
        return b, path

    def prune_artifacts(self, project_id: str) -> None:
        rows = self.db.query(
            "SELECT id, artifact_path FROM builds WHERE project_id=? AND artifact_path IS NOT NULL AND artifact_deleted=0 "
            "ORDER BY created_at DESC, rowid DESC", (project_id,))
        for r in rows[self.s.keep_artifacts_per_project:]:
            shutil.rmtree(self.s.artifacts_dir / r["id"], ignore_errors=True)
            self.db.execute("UPDATE builds SET artifact_deleted=1 WHERE id=?", (r["id"],))

    def delete_project_builds(self, project_id: str) -> None:
        for r in self.db.query("SELECT id FROM builds WHERE project_id = ?", (project_id,)):
            shutil.rmtree(self.s.artifacts_dir / r["id"], ignore_errors=True)
            shutil.rmtree(self.s.builds_dir / r["id"], ignore_errors=True)

    # ---- lifecycle
    def submit(self, project_id: str, ir: dict) -> dict:
        build_id = "b_" + uuid.uuid4().hex[:12]
        (self.s.builds_dir / build_id).mkdir(parents=True)
        app = ir["app"]
        self.db.execute(
            "INSERT INTO builds (id, project_id, status, kind, app_id, app_name, version, created_at, log_path) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (build_id, project_id, "queued", "debug", app["id"], app["name"], app["version"], _now(), "build.log"))
        self._log(build_id, f"[apppanrom] build {build_id} queued for {app['id']} {app['version']}")
        self.pool.submit(self._run, build_id, project_id, ir)
        return self.get(build_id)

    def _finish(self, build_id: str, started: float, status: str, **fields) -> None:
        fields.update(status=status, finished_at=_now(), duration_s=round(time.monotonic() - started, 2))
        cols = ", ".join(f"{k}=?" for k in fields)
        self.db.execute(f"UPDATE builds SET {cols} WHERE id=?", (*fields.values(), build_id))

    def _fail(self, build_id: str, started: float, reason: str, message: str, exit_code: int | None = None) -> None:
        self._log(build_id, f"[apppanrom] BUILD FAILED ({reason}): {message}")
        self._finish(build_id, started, "failed", failure_reason=reason, message=message, exit_code=exit_code)

    def _run(self, build_id: str, project_id: str, ir: dict) -> None:
        started = time.monotonic()
        work = self.s.builds_dir / build_id / "work"
        try:
            self.db.execute("UPDATE builds SET status='running', started_at=? WHERE id=?", (_now(), build_id))
            pre = check_prerequisites(self.s, use_cache=False)
            if not pre["ok"]:
                text = format_problems(pre)
                self._log(build_id, text)
                self._fail(build_id, started, "prerequisites_missing", "Android build prerequisites are missing; see the log.")
                return
            self._log(build_id, "[apppanrom] prerequisites OK; generating Android project")
            try:
                generate_project(ir, work)
            except GenerateError as e:
                self._fail(build_id, started, "invalid_project", str(e))
                return
            code, timed_out = self._gradle(build_id, work)
            if timed_out:
                self._fail(build_id, started, "timeout", f"Build exceeded the {self.s.build_timeout_s}s time limit and was stopped.", code)
                return
            if code != 0:
                self._fail(build_id, started, "gradle_failed", f"Gradle exited with code {code}; see the log.", code)
                return
            apk = work / APK_REL
            problem = verify_apk(apk)
            if problem:
                self._fail(build_id, started, "artifact_invalid", problem, code)
                return
            self._store_artifact(build_id, project_id, apk, ir, started, code)
        except Exception as e:  # never leave a build stuck in "running"
            self._fail(build_id, started, "internal_error", f"Unexpected error: {type(e).__name__}")
            self._log(build_id, f"[apppanrom] internal error: {e!r}")
        finally:
            if not self.s.keep_build_dirs:
                shutil.rmtree(work, ignore_errors=True)

    def _store_artifact(self, build_id, project_id, apk: Path, ir: dict, started: float, code: int) -> None:
        safe = re.sub(r"[^A-Za-z0-9._-]+", "-", ir["app"]["name"]).strip("-") or "app"
        name = f"{safe}-{ir['app']['version']}-debug.apk"
        out_dir = self.s.artifacts_dir / build_id
        out_dir.mkdir(parents=True, exist_ok=True)
        dest = out_dir / name
        shutil.copyfile(apk, dest)
        digest = hashlib.sha256(dest.read_bytes()).hexdigest()
        self._log(build_id, f"[apppanrom] BUILD SUCCEEDED: {name} ({dest.stat().st_size} bytes, sha256 {digest[:16]}...) - debug-signed")
        self._finish(build_id, started, "succeeded", exit_code=code, artifact_name=name, artifact_size=dest.stat().st_size,
                     artifact_sha256=digest, artifact_path=f"{build_id}/{name}", message="Debug APK built.")
        self.prune_artifacts(project_id)

    def _gradle(self, build_id: str, work: Path) -> tuple[int, bool]:
        exe = gradle_bin(self.s)
        cmd = [exe, "--no-daemon", "--console=plain", "-p", str(work), "assembleDebug"]
        env = {k: os.environ[k] for k in PASSTHROUGH_ENV if k in os.environ}
        env["GRADLE_USER_HOME"] = str(self.s.gradle_home)
        env["ANDROID_HOME"] = str(self.s.android_home)
        env["ANDROID_SDK_ROOT"] = str(self.s.android_home)
        if self.s.java_home:
            env["JAVA_HOME"] = str(self.s.java_home)
        self._log(build_id, "[apppanrom] running: gradle --no-daemon --console=plain assembleDebug")
        log_path = self.log_path(build_id)
        proc = subprocess.Popen(cmd, cwd=work, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, start_new_session=True)
        with self._lock:
            self._procs[build_id] = proc
        timed_out = threading.Event()

        def killer():
            timed_out.set()
            self._kill(proc)

        timer = threading.Timer(self.s.build_timeout_s, killer)
        timer.start()
        written = 0
        truncated = False
        try:
            with log_path.open("ab") as f:
                for line in iter(proc.stdout.readline, b""):
                    if written < self.s.max_log_bytes:
                        f.write(line)
                        f.flush()
                        written += len(line)
                    elif not truncated:
                        truncated = True
                        f.write(b"\n[apppanrom] log output limit reached; further output discarded\n")
                        f.flush()
            proc.wait()
        finally:
            timer.cancel()
            with self._lock:
                self._procs.pop(build_id, None)
        return proc.returncode, timed_out.is_set()

    @staticmethod
    def _kill(proc: subprocess.Popen) -> None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def shutdown(self) -> None:
        with self._lock:
            for p in self._procs.values():
                self._kill(p)
        self.pool.shutdown(wait=False, cancel_futures=True)
