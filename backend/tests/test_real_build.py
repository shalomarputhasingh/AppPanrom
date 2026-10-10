"""Real Android builds (real Gradle, real SDK). Skipped unless ANDROID_HOME / ANDROID_SDK_ROOT points at an SDK.

Needs JDK 17+, Gradle 8.7+, platforms;android-34, build-tools;34.0.0 and network access to Google Maven / Maven Central.
Run with:  ANDROID_HOME=~/android-sdk python3 -m pytest tests/test_real_build.py -v
"""
import os
import shutil
import subprocess
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from apppanrom.cli import make_keystore
from apppanrom.main import create_app
from conftest import make_settings, wait_build
from test_signing_icon import png

SDK = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
pytestmark = pytest.mark.skipif(not SDK, reason="ANDROID_HOME not set: real Android builds are skipped")

PASSWORD = "real-build-test-pw"
SOURCE = '''app_uruvakku("Real Build")
app_id_set("com.apppanrom.realbuild")
function buzz():
    vibrate_pannu(100)
screen_uruvakku("home"):
    column_uruvakku(style={"padding": 24}):
        title("Hi")
        image_kaattu("https://example.com/a.png", alt="x")
        button("Buzz", click_pannumbodhu=buzz)
'''
BUILD_TIMEOUT = 1200


def build_tool(name: str) -> str | None:
    found = sorted(Path(SDK, "build-tools").glob(f"*/{name}"))
    return str(found[-1]) if found else shutil.which(name)


def permissions(apk: Path) -> set[str]:
    aapt2 = build_tool("aapt2")
    if not aapt2:
        pytest.skip("aapt2 not available")
    out = subprocess.run([aapt2, "dump", "permissions", str(apk)], capture_output=True, text=True, check=True).stdout
    return {line.split("name='")[1].rstrip("'") for line in out.splitlines() if "name='" in line}


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    root = tmp_path_factory.mktemp("realbuild")
    ks = root / "test.jks"
    signing = {}
    if shutil.which("keytool"):
        assert make_keystore(str(ks), "release", password=PASSWORD) == 0
        signing = dict(keystore_path=ks, keystore_password=PASSWORD, key_alias="release")
    settings = make_settings(root, android_home=Path(SDK), **signing)
    with TestClient(create_app(settings)) as client:
        yield client, root, bool(signing)


@pytest.fixture(scope="module")
def project(env):
    client = env[0]
    p = client.post("/api/projects", json={"name": "Real Build"}).json()
    assert client.put(f"/api/projects/{p['id']}/files/main.apn", json={"content": SOURCE}).status_code == 200
    assert client.put(f"/api/projects/{p['id']}/icon", content=png(256), headers={"content-type": "image/png"}).status_code == 200
    return p["id"]


def build(client, pid, kind, attempts=4):
    """Runs a build. Only dependency-download errors (e.g. HTTP 429 from Maven Central) are retried; Gradle keeps what it
    already downloaded, so retries converge. Real compile/packaging failures fail immediately."""
    for attempt in range(1, attempts + 1):
        r = client.post(f"/api/projects/{pid}/builds", json={"kind": kind})
        assert r.status_code == 202, r.text
        b = wait_build(client, r.json()["id"], timeout=BUILD_TIMEOUT)
        if b["status"] == "succeeded":
            return b
        log = client.get(f"/api/builds/{b['id']}/logs?offset=0").json().get("text", "")
        transient = b.get("failure_reason") == "gradle_failed" and ("Could not GET" in log or "Could not resolve" in log or "Could not download" in log)
        if not transient or attempt == attempts:
            pytest.fail(f"{kind} failed (attempt {attempt}): {b.get('failure_reason')}: {b.get('message')}\n--- log tail ---\n{log[-3000:]}")
        time.sleep(20)


def artifact(client, root, b, suffix):
    r = client.get(f"/api/builds/{b['id']}/artifact")
    assert r.status_code == 200
    path = root / f"{b['id']}{suffix}"
    path.write_bytes(r.content)
    assert zipfile.is_zipfile(path)
    return path


def test_debug_apk_builds_and_contains_what_it_should(env, project):
    client, root, _ = env
    b = build(client, project, "debug_apk")
    assert b["status"] == "succeeded", b
    apk = artifact(client, root, b, ".apk")
    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        assert "AndroidManifest.xml" in names and "assets/www/apppanrom-runtime.js" in names
        assert any("ic_launcher" in n for n in names)  # the uploaded icon
        runtime = Path(__file__).resolve().parents[2] / "runtime" / "apppanrom-runtime.js"
        assert z.read("assets/www/apppanrom-runtime.js") == runtime.read_bytes()
    assert permissions(apk) == {"android.permission.INTERNET", "android.permission.VIBRATE"}
    apksigner = build_tool("apksigner")
    if apksigner:
        assert subprocess.run([apksigner, "verify", str(apk)], capture_output=True).returncode == 0


def test_release_without_signing_is_refused(tmp_path, project):
    # A separate server without signing configured; the project is recreated there.
    settings = make_settings(tmp_path, android_home=Path(SDK))
    with TestClient(create_app(settings)) as client:
        pid = client.post("/api/projects", json={"name": "Unsigned"}).json()["id"]
        r = client.post(f"/api/projects/{pid}/builds", json={"kind": "release_apk"})
        b = wait_build(client, r.json()["id"])
        assert b["status"] == "failed" and b["failure_reason"] == "signing_not_configured"
        assert client.get(f"/api/builds/{b['id']}/artifact").status_code == 404


def test_release_apk_and_aab_are_signed_and_verified(env, project):
    client, root, has_signing = env
    if not has_signing:
        pytest.skip("keytool not available")
    apk_build = build(client, project, "release_apk")
    assert apk_build["status"] == "succeeded", apk_build
    assert "verified with" in apk_build["signing"]
    apk = artifact(client, root, apk_build, ".apk")
    assert permissions(apk) == {"android.permission.INTERNET", "android.permission.VIBRATE"}
    apksigner = build_tool("apksigner")
    if apksigner:
        assert subprocess.run([apksigner, "verify", str(apk)], capture_output=True).returncode == 0
    aab_build = build(client, project, "release_aab")
    assert aab_build["status"] == "succeeded", aab_build
    aab = artifact(client, root, aab_build, ".aab")
    if shutil.which("jarsigner"):
        out = subprocess.run(["jarsigner", "-verify", str(aab)], capture_output=True, text=True).stdout
        assert "jar verified" in out
