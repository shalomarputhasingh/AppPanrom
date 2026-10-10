"""Runtime configuration, read from environment variables (never from project source)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    data_dir: Path
    android_home: Path | None
    gradle_bin: str | None
    java_home: Path | None
    build_timeout_s: int = 900
    max_log_bytes: int = 2_000_000
    keep_artifacts_per_project: int = 10
    keep_build_dirs: bool = False
    cors_origins: list[str] = field(default_factory=list)
    max_projects: int = 200
    max_files_per_project: int = 20
    max_file_bytes: int = 200_000
    max_request_bytes: int = 1_000_000

    @property
    def db_path(self) -> Path:
        return self.data_dir / "apppanrom.db"

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def builds_dir(self) -> Path:
        return self.data_dir / "builds"

    @property
    def artifacts_dir(self) -> Path:
        return self.data_dir / "artifacts"

    @property
    def gradle_home(self) -> Path:
        return self.data_dir / "gradle-home"

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ
        sdk = env.get("ANDROID_HOME") or env.get("ANDROID_SDK_ROOT")
        java_home = env.get("JAVA_HOME")
        origins = env.get("APPANROM_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
        return cls(
            data_dir=Path(env.get("APPANROM_DATA_DIR", "./data")).resolve(),
            android_home=Path(sdk) if sdk else None,
            gradle_bin=env.get("GRADLE_BIN"),
            java_home=Path(java_home) if java_home else None,
            build_timeout_s=_int("APPANROM_BUILD_TIMEOUT", 900),
            keep_build_dirs=env.get("APPANROM_KEEP_BUILD_DIRS") == "1",
            cors_origins=[o.strip() for o in origins.split(",") if o.strip() and o.strip() != "*"],
        )

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.projects_dir, self.builds_dir, self.artifacts_dir, self.gradle_home):
            d.mkdir(parents=True, exist_ok=True)
