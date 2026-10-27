import os
import shutil
import stat
import sys
import textwrap
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from apppanrom.config import Settings
from apppanrom.main import create_app


def make_settings(tmp_path: Path, **kw) -> Settings:
    base = dict(data_dir=tmp_path / "data", android_home=None, gradle_bin=None, java_home=None, cors_origins=[])
    base.update(kw)
    return Settings(**base)


@pytest.fixture
def settings(tmp_path):
    return make_settings(tmp_path)


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c


def fake_sdk(tmp_path: Path) -> Path:
    sdk = tmp_path / "sdk"
    (sdk / "platforms" / "android-34").mkdir(parents=True)
    (sdk / "build-tools" / "34.0.0").mkdir(parents=True)
    return sdk


FAKE_GRADLE = '''#!{python}
# TEST DOUBLE for Gradle. It only exists to exercise the build manager (status, logs, timeouts,
# artifact verification). It does NOT compile Android code.
import sys, os, zipfile
args = sys.argv[1:]
if args == ["--version"]:
    print("Gradle 8.14.3"); sys.exit(0)
work = args[args.index("-p") + 1]
{body}
'''

OK_BODY = '''
print("> Task :app:assembleDebug (fake)")
out = os.path.join(work, "app/build/outputs/apk/debug"); os.makedirs(out)
with zipfile.ZipFile(os.path.join(out, "app-debug.apk"), "w", zipfile.ZIP_STORED) as z:
    z.writestr("AndroidManifest.xml", "x" * 100)
    z.writestr("assets/www/apppanrom-runtime.js", open(os.path.join(work, "app/src/main/assets/www/apppanrom-runtime.js"), "rb").read())
    z.writestr("classes.dex", os.urandom(60000))
print("BUILD SUCCESSFUL")
'''


def fake_gradle(tmp_path: Path, body: str = OK_BODY, name: str = "gradle") -> str:
    script = FAKE_GRADLE.format(python=sys.executable, body=textwrap.dedent(body))
    if os.name == "nt":  # no shebangs on Windows: a .cmd launcher runs the Python script
        impl = tmp_path / f"{name}_impl.py"
        impl.write_text(script, encoding="utf-8")
        p = tmp_path / f"{name}.cmd"
        p.write_text(f'@"{sys.executable}" "{impl}" %*\r\n', encoding="utf-8")
        return str(p)
    p = tmp_path / name
    p.write_text(script, encoding="utf-8")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


def wait_build(client, build_id, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        b = client.get(f"/api/builds/{build_id}").json()
        if b["status"] in ("succeeded", "failed"):
            return b
        time.sleep(0.1)
    raise AssertionError("build did not finish")


needs_java = pytest.mark.skipif(shutil.which("java") is None, reason="java not installed (needed by the prerequisite check)")
