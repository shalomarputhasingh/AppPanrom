import os
import shutil
import struct
import zlib

import pytest
from fastapi.testclient import TestClient

from apppanrom.android.builder import verify_aab
from apppanrom.android.generate import GenerateError, generate_project
from apppanrom.android.icon import IconError, validate_png_icon
from apppanrom.cli import make_keystore
from apppanrom.main import create_app
from conftest import fake_gradle, fake_sdk, make_settings, needs_java, wait_build

PASSWORD = "s3cret-pw-123"
needs_jdk_tools = pytest.mark.skipif(not (shutil.which("keytool") and shutil.which("jarsigner") and shutil.which("java")),
                                     reason="keytool/jarsigner not installed")


def png(size=192, corrupt=False) -> bytes:
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x10\x20\x30\xff" * size for _ in range(size))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return data[:-8] if corrupt else data


def mk(c, **kw):
    return c.post("/api/projects", json={"name": "Sign Me", **kw}).json()


# ------------------------------------------------------------------ icon
def test_icon_validation():
    assert validate_png_icon(png(192)) == (192, 192)
    assert validate_png_icon(png(512)) == (512, 512)
    for bad, msg in [(b"GIF89a" + b"0" * 100, "PNG"), (png(100), "between"), (png(2000), "larger|between"), (png(192, corrupt=True), "truncated"),
                     (b"", "PNG"), (b"\x89PNG\r\n\x1a\n" + b"0" * 40, "header")]:
        with pytest.raises(IconError, match=msg):
            validate_png_icon(bad)
    # non-square
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", 256, 192, 8, 6, 0, 0, 0)
    wide = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00")) + chunk(b"IEND", b"")
    with pytest.raises(IconError, match="square"):
        validate_png_icon(wide)


def test_icon_api_roundtrip(client):
    p = mk(client)
    url = f"/api/projects/{p['id']}/icon"
    assert not p["has_icon"] and client.get(url).status_code == 404
    r = client.put(url, content=png(256), headers={"content-type": "image/png"})
    assert r.status_code == 200 and r.json()["width"] == 256
    assert client.get(url).content == png(256)
    assert client.get(f"/api/projects/{p['id']}").json()["has_icon"] is True
    assert "icon.png" not in client.get(f"/api/projects/{p['id']}").json()["files"]
    assert client.put(url, content=b"nope", headers={"content-type": "image/png"}).status_code == 422
    assert client.put(url, content=png(256), headers={"content-type": "text/plain"}).status_code == 415
    assert client.delete(url).status_code == 204 and client.get(url).status_code == 404


def test_generator_adds_icon_only_when_given(tmp_path):
    from apppanrom.lang import compile_source
    ir = compile_source('screen_uruvakku("h"):\n    title("x")\n').ir
    generate_project(ir, tmp_path / "a")
    assert "android:icon" not in (tmp_path / "a/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
    icon = tmp_path / "i.png"
    icon.write_bytes(png(192))
    generate_project(ir, tmp_path / "b", icon)
    assert 'android:icon="@mipmap/ic_launcher"' in (tmp_path / "b/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
    assert (tmp_path / "b/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png").read_bytes() == png(192)
    icon.write_bytes(b"not a png")
    with pytest.raises(GenerateError):
        generate_project(ir, tmp_path / "c", icon)


@needs_java
def test_icon_reaches_the_generated_project_during_a_build(tmp_path):
    body = '''
if not os.path.isfile(os.path.join(work, "app/src/main/res/mipmap-xxxhdpi/ic_launcher.png")):
    print("icon missing"); sys.exit(1)
''' + __import__("conftest").OK_BODY
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path, body))
    with TestClient(create_app(s)) as c:
        p = mk(c)
        c.put(f"/api/projects/{p['id']}/icon", content=png(192), headers={"content-type": "image/png"})
        assert wait_build(c, c.post(f"/api/projects/{p['id']}/builds").json()["id"])["status"] == "succeeded"


# ------------------------------------------------------------------ signing config
def test_signing_status_reports_booleans_only(tmp_path):
    ks = tmp_path / "k.jks"
    ks.write_bytes(b"x")
    s = make_settings(tmp_path, keystore_path=ks, keystore_password=PASSWORD, key_alias="rel")
    assert PASSWORD not in repr(s)
    with TestClient(create_app(s)) as c:
        st = c.get("/api/system/status")
        assert st.json()["signing"]["configured"] is True and PASSWORD not in st.text and str(ks) not in st.text
    with TestClient(create_app(make_settings(tmp_path / "other"))) as c:
        sg = c.get("/api/system/status").json()["signing"]
        assert sg["configured"] is False and "APPANROM_KEYSTORE" in sg["detail"] and "make-keystore" in sg["fix"]


@needs_java
def test_release_without_signing_fails_and_produces_nothing(tmp_path):
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path))
    with TestClient(create_app(s)) as c:
        p = mk(c)
        for kind in ("release_apk", "release_aab"):
            b = wait_build(c, c.post(f"/api/projects/{p['id']}/builds", json={"kind": kind}).json()["id"])
            assert b["status"] == "failed" and b["failure_reason"] == "signing_not_configured" and b["artifact"] is None
        assert c.post(f"/api/projects/{p['id']}/builds", json={"kind": "debug_apk; rm -rf /"}).status_code == 422


@needs_jdk_tools
def test_make_keystore_cli(tmp_path, capsys):
    ks = tmp_path / "release.jks"
    assert make_keystore(str(ks), "rel", password=PASSWORD) == 0
    assert ks.is_file()
    if os.name != "nt":  # Windows has no POSIX permission bits
        assert oct(ks.stat().st_mode)[-3:] == "600"
    out = capsys.readouterr().out
    assert PASSWORD not in out and "APPANROM_KEYSTORE" in out
    assert make_keystore(str(ks), "rel", password=PASSWORD) == 1  # never overwrites
    assert make_keystore(str(tmp_path / "x.jks"), "bad alias!", password=PASSWORD) == 2
    assert make_keystore(str(tmp_path / "y.jks"), "rel", password="123") == 1


AAB_BODY = '''
if os.environ.get("APPANROM_SIGN_STORE_FILE") is None:
    print("signing env missing"); sys.exit(1)
out = os.path.join(work, "app/build/outputs/bundle/release"); os.makedirs(out)
aab = os.path.join(out, "app-release.aab")
with zipfile.ZipFile(aab, "w", zipfile.ZIP_STORED) as z:
    z.writestr("BundleConfig.pb", b"x"); z.writestr("base/manifest/AndroidManifest.xml", b"x" * 100)
    z.writestr("base/assets/www/apppanrom-runtime.js", open(os.path.join(work, "app/src/main/assets/www/apppanrom-runtime.js"), "rb").read())
    z.writestr("base/dex/classes.dex", os.urandom(60000))
@@SIGN@@
print("BUNDLE SUCCESSFUL")
'''
SIGN_CMD = '''
import subprocess
r = subprocess.run(["jarsigner", "-keystore", os.environ["APPANROM_SIGN_STORE_FILE"], "-storepass:env", "APPANROM_SIGN_STORE_PASSWORD",
                    "-keypass:env", "APPANROM_SIGN_KEY_PASSWORD", aab, os.environ["APPANROM_SIGN_KEY_ALIAS"]], capture_output=True, text=True)
if r.returncode != 0:
    print(r.stdout, r.stderr); sys.exit(r.returncode)
'''


@pytest.fixture
def keystore(tmp_path):
    ks = tmp_path / "release.jks"
    assert make_keystore(str(ks), "rel", password=PASSWORD) == 0
    return ks


@needs_java
@needs_jdk_tools
def test_release_aab_is_built_signed_and_verified_with_real_jarsigner(tmp_path, keystore):
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path, AAB_BODY.replace("@@SIGN@@", SIGN_CMD)),
                      keystore_path=keystore, keystore_password=PASSWORD, key_alias="rel")
    with TestClient(create_app(s)) as c:
        p = mk(c)
        b = wait_build(c, c.post(f"/api/projects/{p['id']}/builds", json={"kind": "release_aab"}).json()["id"])
        assert b["status"] == "succeeded", b
        assert b["artifact"]["name"] == "Sign-Me-1.0.0-release.aab" and b["kind"] == "release_aab"
        assert b["signing"] == "release key (verified with jarsigner)"
        r = c.get(f"/api/builds/{b['id']}/artifact")
        assert r.status_code == 200 and r.headers["content-type"] == "application/octet-stream"
        assert verify_aab(next(s.artifacts_dir.rglob("*.aab"))) is None
        # secrets never leak into logs, API output or the database
        log = c.get(f"/api/builds/{b['id']}/logs").json()["text"]
        assert "BUNDLE SUCCESSFUL" in log and "jar verified" in log
        everything = log + c.get(f"/api/builds/{b['id']}").text + c.get("/api/system/status").text
        assert PASSWORD not in everything
        assert PASSWORD.encode() not in (s.db_path).read_bytes()
        for f in s.data_dir.rglob("*"):
            if f.is_file() and f.suffix in (".log", ".gradle", ".properties", ".xml", ".js", ".json"):
                assert PASSWORD.encode() not in f.read_bytes(), f


@needs_java
@needs_jdk_tools
def test_unsigned_release_bundle_is_rejected(tmp_path, keystore):
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path, AAB_BODY.replace("@@SIGN@@", "")),
                      keystore_path=keystore, keystore_password=PASSWORD, key_alias="rel")
    with TestClient(create_app(s)) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds", json={"kind": "release_aab"}).json()["id"])
        assert b["status"] == "failed" and b["failure_reason"] == "artifact_invalid" and "unsigned" in b["message"]
        assert b["artifact"] is None


APK_BODY = '''
out = os.path.join(work, "app/build/outputs/apk/release"); os.makedirs(out)
with zipfile.ZipFile(os.path.join(out, "app-release.apk"), "w", zipfile.ZIP_STORED) as z:
    z.writestr("AndroidManifest.xml", "x" * 100)
    z.writestr("assets/www/apppanrom-runtime.js", open(os.path.join(work, "app/src/main/assets/www/apppanrom-runtime.js"), "rb").read())
    z.writestr("classes.dex", os.urandom(60000))
print("BUILD SUCCESSFUL")
'''


def fake_apksigner(sdk, output: str, code: int = 0):
    tools = sdk / "build-tools" / "34.0.0"
    if os.name == "nt":  # find_apksigner looks for apksigner.bat on Windows
        (tools / "apksigner.out").write_text(output + "\n", encoding="utf-8")
        (tools / "apksigner.bat").write_text(f'@type "%~dp0apksigner.out"\r\n@exit /b {code}\r\n', encoding="utf-8")
        return
    p = tools / "apksigner"
    p.write_text(f"#!/bin/sh\ncat <<'EOF'\n{output}\nEOF\nexit {code}\n")
    p.chmod(0o755)


@needs_java
def test_release_apk_signature_checks(tmp_path):
    sdk = fake_sdk(tmp_path)
    ks = tmp_path / "k.jks"
    ks.write_bytes(b"placeholder")
    kw = dict(android_home=sdk, gradle_bin=fake_gradle(tmp_path, APK_BODY), keystore_path=ks, keystore_password=PASSWORD, key_alias="rel")
    # 1. no apksigner available: succeeds but says it could not verify (honest)
    with TestClient(create_app(make_settings(tmp_path / "a", **kw))) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds", json={"kind": "release_apk"}).json()["id"])
        assert b["status"] == "succeeded" and "not independently verified" in b["signing"] and b["artifact"]["name"].endswith("-release.apk")
    # 2. apksigner verifies with a release certificate
    fake_apksigner(sdk, "Signer #1 certificate DN: CN=Acme Release\nVerified using v2 scheme: true")
    with TestClient(create_app(make_settings(tmp_path / "b", **kw))) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds", json={"kind": "release_apk"}).json()["id"])
        assert b["status"] == "succeeded" and b["signing"] == "release key (verified with apksigner)"
    # 3. debug certificate on a "release" build is rejected
    fake_apksigner(sdk, "Signer #1 certificate DN: CN=Android Debug, O=Android")
    with TestClient(create_app(make_settings(tmp_path / "c", **kw))) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds", json={"kind": "release_apk"}).json()["id"])
        assert b["status"] == "failed" and "debug key" in b["message"] and b["artifact"] is None
    # 4. apksigner failure rejects
    fake_apksigner(sdk, "DOES NOT VERIFY", code=1)
    with TestClient(create_app(make_settings(tmp_path / "d", **kw))) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds", json={"kind": "release_apk"}).json()["id"])
        assert b["status"] == "failed" and b["artifact"] is None


@needs_java
def test_debug_builds_never_receive_signing_secrets(tmp_path):
    body = '''
leaked = [k for k in os.environ if k.startswith("APPANROM_SIGN")]
if leaked:
    print("LEAK", leaked); sys.exit(1)
''' + __import__("conftest").OK_BODY
    ks = tmp_path / "k.jks"
    ks.write_bytes(b"x")
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path, body),
                      keystore_path=ks, keystore_password=PASSWORD, key_alias="rel")
    with TestClient(create_app(s)) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds").json()["id"])
        assert b["status"] == "succeeded" and b["kind"] == "debug_apk"


def test_template_reads_signing_from_environment_only():
    from pathlib import Path
    g = (Path(__file__).resolve().parents[2] / "android-template/app/build.gradle").read_text(encoding="utf-8")
    assert 'System.getenv("APPANROM_SIGN_STORE_PASSWORD")' in g and "storePassword \"" not in g
