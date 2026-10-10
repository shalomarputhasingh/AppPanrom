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
COMPILE_SDK = 34
_cache: dict[str, tuple[float, dict]] = {}


def _run(cmd: list[str], timeout: int = 60) -> str:
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "JAVA_HOME", "JAVA_TOOL_OPTIONS")}
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    return (p.stdout or "") + (p.stderr or "")


def java_bin(s: Settings) -> str | None:
    if s.java_home and (s.java_home / "bin" / "java").is_file():
        return str(s.java_home / "bin" / "java")
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
