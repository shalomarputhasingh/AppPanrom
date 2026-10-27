"""Detects whether this machine can build an Android APK, and explains what is missing."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from ..config import Settings

MIN_JAVA = 17
MAX_TESTED_JAVA = 23  # Gradle 8.11 runs on Java 17-23; newer JDKs make older Gradle versions fail with obscure errors
COMPILE_SDK = 34
_cache: dict[str, tuple[float, dict]] = {}
_WINDOWS = os.name == "nt"
# Windows programs (Java, Gradle, the Winsock layer) fail without these, so tools started here keep them.
_WINDOWS_ENV = ("SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH",
                "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
                "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE")


def tool_env_names() -> tuple[str, ...]:
    """Environment variables passed through to child tools besides the ones set explicitly."""
    return _WINDOWS_ENV if _WINDOWS else ()


def find_exe(directory: Path, name: str) -> Path | None:
    """`directory/name`, or on Windows `name.exe` / `.bat` / `.cmd`; None if no such file."""
    for suffix in ("", ".exe", ".bat", ".cmd") if _WINDOWS else ("",):
        p = directory / (name + suffix)
        if p.is_file():
            return p
    return None


def _run(cmd: list[str], timeout: int = 60) -> str:
    keep = ("PATH", "HOME", "JAVA_HOME", "JAVA_TOOL_OPTIONS") + tool_env_names()
    env = {k: v for k, v in os.environ.items() if k.upper() in keep}
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    return (p.stdout or "") + (p.stderr or "")


def java_bin(s: Settings) -> str | None:
    if s.java_home:
        exe = find_exe(s.java_home / "bin", "java")
        if exe:
            return str(exe)
    return shutil.which("java")


def gradle_bin(s: Settings) -> str | None:
    if s.gradle_bin:
        return s.gradle_bin if Path(s.gradle_bin).is_file() else shutil.which(s.gradle_bin)
    return shutil.which("gradle")


def check_prerequisites(s: Settings, use_cache: bool = True) -> dict:
    key = f"{s.android_home}|{s.gradle_bin}|{s.java_home}"
    hit = _cache.get(key)
    if use_cache and hit and time.time() - hit[0] < 30:
        return hit[1]
    checks = [_check_java(s), _check_gradle(s), _check_sdk(s)]
    result = {"ok": all(c["ok"] for c in checks), "checks": checks, "supported_output": "debug APK (debug-signed)"}
    _cache[key] = (time.time(), result)
    return result


def _check_java(s: Settings) -> dict:
    exe = java_bin(s)
    c = {"name": "java", "ok": False, "detail": "", "fix": f"Install a JDK {MIN_JAVA}+ and put `java` on PATH or set JAVA_HOME."}
    if not exe:
        c["detail"] = "java not found"
        return c
    try:
        out = _run([exe, "-version"], 20)
    except (OSError, subprocess.SubprocessError) as e:
        c["detail"] = f"could not run java: {e}"
        return c
    m = re.search(r'version "(\d+)(?:\.(\d+))?', out)
    if not m:
        c["detail"] = "could not parse `java -version` output"
        return c
    major = int(m.group(1)) if m.group(1) != "1" else int(m.group(2) or 8)
    c["detail"] = f"Java {major} ({exe})"
    c["ok"] = major >= MIN_JAVA
    if not c["ok"]:
        c["detail"] += f" - Java {MIN_JAVA}+ is required"
    elif major > MAX_TESTED_JAVA:
        c["detail"] += f" - warning: Gradle 8 may not run on Java {major}; point JAVA_HOME at a JDK {MIN_JAVA}-{MAX_TESTED_JAVA} (21 is a good choice)"
    return c


def _check_gradle(s: Settings) -> dict:
    exe = gradle_bin(s)
    c = {"name": "gradle", "ok": False, "detail": "",
         "fix": "Install Gradle 8.7+ and put `gradle` on PATH, or set GRADLE_BIN to its full path."}
    if not exe:
        c["detail"] = "gradle not found" if not s.gradle_bin else f"GRADLE_BIN={s.gradle_bin} does not exist"
        return c
    try:
        out = _run([exe, "--version"], 90)
    except (OSError, subprocess.SubprocessError) as e:
        c["detail"] = f"could not run gradle: {e}"
        return c
    m = re.search(r"Gradle (\d+)\.(\d+)", out)
    if not m:
        c["detail"] = "could not parse `gradle --version` output"
        return c
    ver = (int(m.group(1)), int(m.group(2)))
    c["detail"] = f"Gradle {ver[0]}.{ver[1]} ({exe})"
    c["ok"] = ver >= (8, 7)
    if not c["ok"]:
        c["detail"] += " - Gradle 8.7+ is required by the Android Gradle Plugin used"
    return c


def _check_sdk(s: Settings) -> dict:
    c = {"name": "android_sdk", "ok": False, "detail": "",
         "fix": f"Install the Android SDK (cmdline-tools), run `sdkmanager \"platforms;android-{COMPILE_SDK}\" "
                f"\"build-tools;{COMPILE_SDK}.0.0\"`, accept licenses, then set ANDROID_HOME to the SDK directory."}
    home = s.android_home
    if not home:
        c["detail"] = "ANDROID_HOME (or ANDROID_SDK_ROOT) is not set"
        return c
    if not home.is_dir():
        c["detail"] = f"ANDROID_HOME={home} is not a directory"
        return c
    if not (home / "platforms" / f"android-{COMPILE_SDK}").is_dir():
        c["detail"] = f"SDK platform android-{COMPILE_SDK} is missing in {home}"
        return c
    tools = [p.name for p in (home / "build-tools").glob("*")] if (home / "build-tools").is_dir() else []
    if not any(t.split(".")[0].isdigit() and int(t.split(".")[0]) >= COMPILE_SDK for t in tools):
        c["detail"] = f"SDK build-tools {COMPILE_SDK}+ are missing in {home}"
        return c
    c["ok"] = True
    c["detail"] = f"Android SDK at {home} (platform {COMPILE_SDK}, build-tools {sorted(tools)[-1]})"
    return c


def format_problems(result: dict) -> str:
    lines = ["Cannot build an APK on this machine. Missing prerequisites:"]
    for c in result["checks"]:
        if not c["ok"]:
            lines.append(f"  - {c['name']}: {c['detail']}\n      fix: {c['fix']}")
    return "\n".join(lines)


def check_signing(s: Settings) -> dict:
    """Whether release signing is configured. Reports only booleans and paths, never secrets."""
    problems = []
    if not s.keystore_path:
        problems.append("APPANROM_KEYSTORE is not set")
    elif not s.keystore_path.is_file():
        problems.append("the keystore file does not exist")
    if not s.keystore_password:
        problems.append("APPANROM_KEYSTORE_PASSWORD is not set")
    if not s.key_alias:
        problems.append("APPANROM_KEY_ALIAS is not set")
    return {
        "configured": not problems,
        "detail": "Release signing key configured." if not problems else "Release signing is not configured: " + "; ".join(problems) + ".",
        "fix": "Create a keystore with `python -m apppanrom.cli make-keystore <path> --alias <alias>`, then set APPANROM_KEYSTORE, "
               "APPANROM_KEYSTORE_PASSWORD and APPANROM_KEY_ALIAS (and APPANROM_KEY_PASSWORD if different) before starting the backend. "
               "Keep the keystore and passwords out of git and back them up: losing the key means you cannot update the app.",
    }


def find_apksigner(s: Settings) -> str | None:
    if not s.android_home or not (s.android_home / "build-tools").is_dir():
        return None
    def key(p: Path):
        return tuple(int(x) if x.isdigit() else 0 for x in p.name.split("."))
    for d in sorted((s.android_home / "build-tools").iterdir(), key=key, reverse=True):
        exe = find_exe(d, "apksigner")
        if exe:
            return str(exe)
    return None


def find_jarsigner(s: Settings) -> str | None:
    if s.java_home:
        exe = find_exe(s.java_home / "bin", "jarsigner")
        if exe:
            return str(exe)
    return shutil.which("jarsigner")
