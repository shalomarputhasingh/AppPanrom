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
    # Release signing. Secrets come only from the environment, are hidden from repr(), and are never stored or returned.
    keystore_path: Path | None = None
    keystore_password: str | None = field(default=None, repr=False)
    key_alias: str | None = None
    key_password: str | None = field(default=None, repr=False)
    # AI assistant (Groq). The key is read from the environment only, hidden from repr(), and never stored or returned.
    ai_api_key: str | None = field(default=None, repr=False)
    ai_model: str | None = None
    ai_base_url: str | None = None
    ai_tier: str | None = None                  # "free" (default: plan around Groq's small per-minute token limit) or "dev" (paid plan)
    ai_tpm: int | None = None                   # tokens per minute to plan around (default 8000 on the free tier)
    ai_fallback_models: list[str] | None = None  # backup models used only when the user chooses "use backup when limited"
    ai_max_wait_s: float = 20.0                  # waits up to this long happen invisibly on the server; longer ones become a countdown in the Studio
    proxy_allow_private: bool = False            # UNSAFE, for local tests only: lets the web-request proxy reach private/loopback addresses
    proxy_ca_file: str | None = None             # extra trusted CA bundle for the web-request proxy (corporate CA or a test server)
    max_projects: int = 200
    max_files_per_project: int = 20
    max_file_bytes: int = 200_000
    max_request_bytes: int = 1_000_000

    @property
    def effective_key_password(self) -> str:
        """The key password, defaulting to the keystore password (the common keytool setup)."""
        return self.key_password or self.keystore_password or ""

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
            keystore_path=Path(env["APPANROM_KEYSTORE"]) if env.get("APPANROM_KEYSTORE") else None,
            keystore_password=env.get("APPANROM_KEYSTORE_PASSWORD"),
            key_alias=env.get("APPANROM_KEY_ALIAS"),
            key_password=env.get("APPANROM_KEY_PASSWORD") or env.get("APPANROM_KEYSTORE_PASSWORD"),
            ai_api_key=env.get("GROQ_API_KEY"),
            ai_model=env.get("APPANROM_AI_MODEL"),
            ai_base_url=env.get("APPANROM_AI_BASE_URL"),
            ai_tier=env.get("APPANROM_AI_TIER"),
            ai_tpm=_int("APPANROM_AI_TPM", 0) or None,
            ai_fallback_models=([m.strip() for m in env["APPANROM_AI_FALLBACK_MODELS"].split(",") if m.strip()] if "APPANROM_AI_FALLBACK_MODELS" in env else None),
            ai_max_wait_s=float(_int("APPANROM_AI_MAX_WAIT", 20)),
            proxy_allow_private=env.get("APPANROM_PROXY_ALLOW_PRIVATE") == "1",
            proxy_ca_file=env.get("APPANROM_PROXY_CA_FILE") or None,
            cors_origins=[o.strip() for o in origins.split(",") if o.strip() and o.strip() != "*"],
        )

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.projects_dir, self.builds_dir, self.artifacts_dir, self.gradle_home):
            d.mkdir(parents=True, exist_ok=True)
