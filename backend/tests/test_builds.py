from pathlib import Path
import zipfile

from fastapi.testclient import TestClient

from apppanrom.android.builder import verify_apk
from apppanrom.android.generate import GenerateError, generate_project, version_code, xml_text
from apppanrom.main import create_app
from conftest import fake_gradle, fake_sdk, make_settings, needs_java, wait_build


def mk(client, **kw):
    return client.post("/api/projects", json={"name": "Build Me", **kw}).json()


def test_prerequisites_reported_when_missing(client):
    st = client.get("/api/system/status").json()["android"]
    sdk = next(c for c in st["checks"] if c["name"] == "android_sdk")
    assert not st["ok"] and not sdk["ok"] and "ANDROID_HOME" in sdk["detail"] and "sdkmanager" in sdk["fix"]


def test_build_without_prerequisites_fails_honestly(client):
    p = mk(client)
    b = client.post(f"/api/projects/{p['id']}/builds")
    assert b.status_code == 202
    done = wait_build(client, b.json()["id"])
    assert done["status"] == "failed" and done["failure_reason"] == "prerequisites_missing"
    assert done["artifact"] is None
    log = client.get(f"/api/builds/{done['id']}/logs").json()
    assert log["done"] and "android_sdk" in log["text"] and "fix:" in log["text"]
    r = client.get(f"/api/builds/{done['id']}/artifact")
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_artifact"


def test_invalid_source_is_rejected_before_building(client):
    p = mk(client)
    client.put(f"/api/projects/{p['id']}/files/main.apn", json={"content": "button("})
    r = client.post(f"/api/projects/{p['id']}/builds")
    assert r.status_code == 422 and r.json()["error"]["code"] == "source_invalid"
    assert client.get(f"/api/projects/{p['id']}/builds").json()["builds"] == []


@needs_java
def test_successful_build_flow_with_fake_gradle(tmp_path):
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path))
    with TestClient(create_app(s)) as c:
        p = mk(c, app_id="com.me.buildme", version="1.2.3")
        b = wait_build(c, c.post(f"/api/projects/{p['id']}/builds").json()["id"])
        assert b["status"] == "succeeded", b
        assert b["exit_code"] == 0 and b["duration_s"] is not None and "debug" in b["signing"]
        assert b["artifact"]["name"] == "Build-Me-1.2.3-debug.apk" and b["artifact"]["size"] > 50_000
        r = c.get(f"/api/builds/{b['id']}/artifact")
        assert r.status_code == 200 and r.headers["content-type"] == "application/vnd.android.package-archive"
        assert len(r.content) == b["artifact"]["size"]
        assert "BUILD SUCCESSFUL" in c.get(f"/api/builds/{b['id']}/logs").json()["text"]
        assert not (s.builds_dir / b["id"] / "work").exists(), "temporary build dir is cleaned"
        assert c.get(f"/api/projects/{p['id']}/builds").json()["builds"][0]["id"] == b["id"]
    with TestClient(create_app(s)) as c2:  # history survives restart
        assert c2.get(f"/api/builds/{b['id']}").json()["status"] == "succeeded"
        assert c2.get(f"/api/builds/{b['id']}/artifact").status_code == 200


@needs_java
def test_gradle_failure_is_captured(tmp_path):
    body = 'print("e: Unresolved reference: Foo"); sys.exit(1)'
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path, body))
    with TestClient(create_app(s)) as c:
        p = mk(c)
        b = wait_build(c, c.post(f"/api/projects/{p['id']}/builds").json()["id"])
        assert b["status"] == "failed" and b["failure_reason"] == "gradle_failed" and b["exit_code"] == 1
        assert "Unresolved reference: Foo" in c.get(f"/api/builds/{b['id']}/logs").json()["text"]
        assert c.get(f"/api/builds/{b['id']}/artifact").status_code == 404


@needs_java
def test_exit_zero_without_apk_is_not_success(tmp_path):
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path, 'print("BUILD SUCCESSFUL")'))
    with TestClient(create_app(s)) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds").json()["id"])
        assert b["status"] == "failed" and b["failure_reason"] == "artifact_invalid" and b["artifact"] is None


@needs_java
def test_tiny_or_corrupt_apk_is_rejected(tmp_path):
    body = '''
out = os.path.join(work, "app/build/outputs/apk/debug"); os.makedirs(out)
open(os.path.join(out, "app-debug.apk"), "wb").write(b"not an apk" * 10000)
'''
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path, body))
    with TestClient(create_app(s)) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds").json()["id"])
        assert b["status"] == "failed" and b["failure_reason"] == "artifact_invalid"
        assert "valid APK" in b["message"]


@needs_java
def test_build_timeout_kills_process(tmp_path):
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path, "import time; time.sleep(60)"),
                      build_timeout_s=1)
    with TestClient(create_app(s)) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds").json()["id"], timeout=20)
        assert b["status"] == "failed" and b["failure_reason"] == "timeout"


@needs_java
def test_log_output_is_capped(tmp_path):
    body = 'for i in range(20000): print("x" * 100)'
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path, body), max_log_bytes=50_000)
    with TestClient(create_app(s)) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds").json()["id"])
        assert (s.builds_dir / b["id"] / "build.log").stat().st_size < 70_000
        assert "output limit reached" in (s.builds_dir / b["id"] / "build.log").read_text()


@needs_java
def test_artifact_download_requires_existing_file(tmp_path):
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path))
    with TestClient(create_app(s)) as c:
        b = wait_build(c, c.post(f"/api/projects/{mk(c)['id']}/builds").json()["id"])
        for f in s.artifacts_dir.rglob("*.apk"):
            f.unlink()
        assert c.get(f"/api/builds/{b['id']}/artifact").status_code == 404


@needs_java
def test_old_artifacts_are_pruned_but_records_kept(tmp_path):
    s = make_settings(tmp_path, android_home=fake_sdk(tmp_path), gradle_bin=fake_gradle(tmp_path), keep_artifacts_per_project=1)
    with TestClient(create_app(s)) as c:
        p = mk(c)
        first = wait_build(c, c.post(f"/api/projects/{p['id']}/builds").json()["id"])
        second = wait_build(c, c.post(f"/api/projects/{p['id']}/builds").json()["id"])
        assert c.get(f"/api/builds/{first['id']}").json()["artifact"] is None
        assert c.get(f"/api/builds/{first['id']}/artifact").status_code == 404
        assert c.get(f"/api/builds/{second['id']}/artifact").status_code == 200
        assert (s.projects_dir / p["id"] / "main.apn").is_file(), "source is never touched by cleanup"


def test_restart_marks_stuck_builds_failed(tmp_path):
    s = make_settings(tmp_path)
    with TestClient(create_app(s)) as c:
        p = mk(c)
        c.app.state.builds.db.execute(
            "INSERT INTO builds (id, project_id, status, created_at) VALUES ('b_aaaaaaaaaaaa', ?, 'running', 'now')", (p["id"],))
    with TestClient(create_app(s)) as c2:
        b = c2.get("/api/builds/b_aaaaaaaaaaaa").json()
        assert b["status"] == "failed" and b["failure_reason"] == "interrupted"


def test_deleting_project_removes_builds_and_artifacts(tmp_path):
    s = make_settings(tmp_path)
    with TestClient(create_app(s)) as c:
        p = mk(c)
        b = wait_build(c, c.post(f"/api/projects/{p['id']}/builds").json()["id"])
        c.delete(f"/api/projects/{p['id']}")
        assert c.get(f"/api/builds/{b['id']}").status_code == 404
        assert not (s.builds_dir / b["id"]).exists()


# ---- generator / verifier unit tests (no Gradle needed)
IR = {"app": {"name": "My <App> & 'Co'", "id": "com.x.app", "version": "1.2.3", "theme": "light", "start_screen": "home"},
      "screens": {}, "functions": {}, "globals": []}


def test_generated_project_contents(tmp_path):
    dest = tmp_path / "proj"
    generate_project(IR, dest)
    g = (dest / "app/build.gradle").read_text()
    assert 'applicationId "com.x.app"' in g and "versionCode 1002003" in g and 'versionName "1.2.3"' in g
    assert "__" not in g
    s = (dest / "app/src/main/res/values/strings.xml").read_text()
    assert "My &lt;App&gt; &amp; \\'Co\\'" in s
    assert "INTERNET" not in (dest / "app/src/main/AndroidManifest.xml").read_text()
    assert "__PERMISSIONS__" not in (dest / "app/src/main/AndroidManifest.xml").read_text()
    www = dest / "app/src/main/assets/www"
    assert (www / "apppanrom-runtime.js").is_file() and "__APPANROM_IR__" in (www / "app.js").read_text()


def test_permissions_are_declared_only_for_features_used(tmp_path):
    from apppanrom.lang import compile_source

    plain = compile_source('screen_uruvakku("h"):\n    title("x")\n')
    assert plain.ir["permissions"] == []
    generate_project(plain.ir, tmp_path / "a")
    assert "uses-permission" not in (tmp_path / "a/app/src/main/AndroidManifest.xml").read_text()
    src = 'function f():\n    vibrate_pannu(50)\nscreen_uruvakku("h"):\n    image_kaattu("https://x.com/a.png")\n    button("b", click_pannumbodhu=f)\n'
    r = compile_source(src)
    assert [p["permission"] for p in r.ir["permissions"]] == ["android.permission.INTERNET", "android.permission.VIBRATE"]
    assert r.ir["permissions"][1]["used_by"] == ["vibrate_pannu"]
    generate_project(r.ir, tmp_path / "b")
    manifest = (tmp_path / "b/app/src/main/AndroidManifest.xml").read_text()
    assert "android.permission.INTERNET" in manifest and "android.permission.VIBRATE" in manifest


def test_generator_rejects_bad_permission_names(tmp_path):
    try:
        generate_project({**IR, "permissions": [{"permission": 'x"/><evil', "reason": "", "used_by": []}]}, tmp_path / "bad")
        raise AssertionError("should have failed")
    except GenerateError:
        pass


def test_generator_rejects_unsafe_identifiers(tmp_path):
    for bad in ({"id": 'com.x";rm -rf /;"'}, {"id": "com.x.app\n"}, {"version": "1.0.0\"; evil"}):
        try:
            generate_project({**IR, "app": {**IR["app"], **bad}}, tmp_path / "bad")
            raise AssertionError("should have failed")
        except GenerateError:
            pass


def test_helpers():
    assert version_code("1.0.0") == 1_000_000 and version_code("999.999.999") < 2**31
    assert xml_text("@x") == "\\@x" and "\n" not in xml_text("a\nb")


def test_verify_apk(tmp_path):
    p = tmp_path / "a.apk"
    assert verify_apk(p) == "APK file was not produced."
    p.write_bytes(b"PK" + b"0" * 100)
    assert "too small" in verify_apk(p)
    p.write_bytes(b"0" * 60000)
    assert "not a valid APK" in verify_apk(p)
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("classes.dex", b"0" * 60000)
    assert "AndroidManifest" in verify_apk(p)


def test_native_web_bridge_is_enabled_only_for_programs_that_make_web_requests(tmp_path):
    from apppanrom.lang import compile_source

    def features(ir, name):
        generate_project(ir, tmp_path / name)
        return (tmp_path / name / "app/src/main/res/values/features.xml").read_text()

    # an image alone needs INTERNET but not the native bridge
    img = compile_source('screen_uruvakku("h"):\n    image_kaattu("https://x.com/a.png")\n')
    assert '"ap_net">false<' in features(img.ir, "img")
    api = compile_source('function got(r):\n    debug_log(r["status"])\nfunction go():\n    api_get("https://x.com/a", "got")\n'
                         'screen_uruvakku("h"):\n    button("b", click_pannumbodhu=go)\n')
    assert api.ok, api.diagnostics
    assert [p["permission"] for p in api.ir["permissions"]] == ["android.permission.INTERNET"]
    assert '"ap_net">true<' in features(api.ir, "api")
    js = (tmp_path / "api/app/src/main/assets/www/app.js").read_text()
    assert "window.ApNative" in js and "__apNativeDone" in js
    assert (tmp_path / "api/app/src/main/java/com/apppanrom/shell/NativeBridge.java").is_file()


def test_runtime_permission_features_declare_permissions_flags_and_gps_not_required(tmp_path):
    from apppanrom.lang import compile_source

    src = (Path(__file__).resolve().parents[2] / "examples" / "idam.apn").read_text(encoding="utf-8")
    r = compile_source(src)
    assert r.ok, r.diagnostics
    perms = {p["permission"]: p for p in r.ir["permissions"]}
    assert set(perms) == {"android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION", "android.permission.POST_NOTIFICATIONS"}
    assert all(p["runtime"] for p in perms.values())                       # all three are asked for while the app runs
    assert perms["android.permission.POST_NOTIFICATIONS"]["used_by"] == ["notification_kaattu"]
    generate_project(r.ir, tmp_path / "idam")
    manifest = (tmp_path / "idam/app/src/main/AndroidManifest.xml").read_text()
    assert 'android.hardware.location.gps" android:required="false"' in manifest
    feats = (tmp_path / "idam/app/src/main/res/values/features.xml").read_text()
    assert '"ap_location">true<' in feats and '"ap_notify">true<' in feats and '"ap_net">false<' in feats
    js = (tmp_path / "idam/app/src/main/assets/www/app.js").read_text()
    assert "N.location" in js and "N.notification" in js
    # a program with only web requests gets neither location nor notification flags and no GPS feature lines
    api = compile_source('function got(r):\n    debug_log(r["status"])\nfunction go():\n    api_get("https://x.com/a", "got")\nscreen_uruvakku("h"):\n    button("b", click_pannumbodhu=go)\n')
    generate_project(api.ir, tmp_path / "api2")
    f2 = (tmp_path / "api2/app/src/main/res/values/features.xml").read_text()
    assert '"ap_net">true<' in f2 and '"ap_location">false<' in f2 and '"ap_notify">false<' in f2
    assert "uses-feature" not in (tmp_path / "api2/app/src/main/AndroidManifest.xml").read_text()
