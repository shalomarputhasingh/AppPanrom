import json
import sqlite3

from fastapi.testclient import TestClient

from apppanrom.main import create_app
from conftest import make_settings


def mk(client, name="Demo App", **kw):
    r = client.post("/api/projects", json={"name": name, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_health(client):
    assert client.get("/health").json()["status"] == "ok"


def test_project_crud(client):
    p = mk(client, "Mass App")
    assert p["id"].startswith("p_") and p["files"] == ["main.apn"] and p["app_id"] == "com.apppanrom.massapp"
    assert [x["id"] for x in client.get("/api/projects").json()["projects"]] == [p["id"]]
    r = client.patch(f"/api/projects/{p['id']}", json={"name": "Renamed", "version": "2.0.1", "theme": "dark"})
    assert r.status_code == 200 and r.json()["name"] == "Renamed" and r.json()["version"] == "2.0.1"
    assert client.delete(f"/api/projects/{p['id']}").status_code == 204
    assert client.get(f"/api/projects/{p['id']}").status_code == 404


def test_validation_and_consistent_errors(client):
    r = client.post("/api/projects", json={"name": ""})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    r = client.post("/api/projects", json={"name": "x", "app_id": "Bad Id"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "bad_app_id"
    r = client.post("/api/projects", json={"name": "x", "version": "1.0"})
    assert r.json()["error"]["code"] == "bad_version"
    r = client.post("/api/projects", json={"name": "x", "theme": "neon"})
    assert r.json()["error"]["code"] == "bad_theme"
    for r in (client.get("/api/projects/p_000000000000"), client.get("/api/builds/b_000000000000"), client.get("/nope")):
        assert r.status_code == 404 and set(r.json()) == {"error"}


def test_files_roundtrip_and_limits(client):
    p = mk(client)
    url = f"/api/projects/{p['id']}/files"
    assert client.put(f"{url}/notes.md", json={"content": "hello"}).status_code == 200
    assert client.get(f"{url}/notes.md").json()["content"] == "hello"
    names = [f["name"] for f in client.get(url).json()["files"]]
    assert names == ["main.apn", "notes.md"]
    assert client.delete(f"{url}/notes.md").status_code == 204
    assert client.delete(f"{url}/main.apn").status_code == 422
    r = client.put(f"{url}/main.apn", json={"content": "x" * 200_001})
    assert r.status_code == 422
    big = client.post("/api/projects", content=b"x" * 1_100_000, headers={"content-type": "application/json"})
    assert big.status_code == 413 and big.json()["error"]["code"] == "request_too_large"


def test_paths_cannot_escape_the_project(client, settings):
    p = mk(client)
    secret = settings.data_dir / "secret.txt"
    secret.write_text("TOP SECRET")
    base = f"/api/projects/{p['id']}/files"
    for bad in ["../../secret.txt", "..%2F..%2Fsecret.txt", "%2e%2e%2fsecret.txt", "a/b.apn", "main.apn%00.txt",
                ".hidden.apn", "x.py", "C:%5Cx.apn", "main.APN"]:
        r = client.get(f"{base}/{bad}")
        assert r.status_code in (404, 422), (bad, r.status_code)
        assert "TOP SECRET" not in r.text
        r = client.put(f"{base}/{bad}", json={"content": "x"})
        assert r.status_code in (404, 405, 422), (bad, r.status_code)
    assert (settings.data_dir / "secret.txt").read_text() == "TOP SECRET"
    for bad_id in ["../x", "p_zzzzzzzzzzzz", "p_1", "..%2F"]:
        assert client.get(f"/api/projects/{bad_id}").status_code == 404


def test_validate_and_preview(client):
    p = mk(client)
    r = client.post(f"/api/projects/{p['id']}/validate").json()
    assert r["ok"] and r["diagnostics"] == []
    r = client.post(f"/api/projects/{p['id']}/validate", json={"source": 'button("x"'}).json()
    assert not r["ok"] and r["diagnostics"][0]["line"] == 1
    r = client.post(f"/api/projects/{p['id']}/preview").json()
    assert r["ok"] and r["ir"]["app"]["id"] == "com.apppanrom.demoapp" and "home" in r["ir"]["screens"]
    r = client.post(f"/api/projects/{p['id']}/preview", json={"source": 'screen_uruvakku("a"):\n    titel("x")\n'}).json()
    assert not r["ok"] and r["ir"] is None and r["diagnostics"][0]["code"] == "unknown_function"


def test_project_metadata_feeds_compile_defaults(client):
    p = mk(client, app_id="com.me.app", version="3.2.1", theme="dark")
    ir = client.post(f"/api/projects/{p['id']}/preview").json()["ir"]
    assert ir["app"]["id"] == "com.me.app" and ir["app"]["version"] == "3.2.1" and ir["app"]["theme"] == "dark"


def test_persistence_across_restart(settings):
    with TestClient(create_app(settings)) as c1:
        p = mk(c1, "Persist Me")
        c1.put(f"/api/projects/{p['id']}/files/main.apn", json={"content": 'screen_uruvakku("z"):\n    title("saved")\n'})
    with TestClient(create_app(settings)) as c2:
        got = c2.get("/api/projects").json()["projects"]
        assert [x["name"] for x in got] == ["Persist Me"]
        assert "saved" in c2.get(f"/api/projects/{p['id']}/files/main.apn").json()["content"]


def test_cors_is_restricted(tmp_path):
    s = make_settings(tmp_path, cors_origins=["http://localhost:5173"])
    with TestClient(create_app(s)) as c:
        ok = c.get("/health", headers={"Origin": "http://localhost:5173"})
        assert ok.headers["access-control-allow-origin"] == "http://localhost:5173"
        bad = c.get("/health", headers={"Origin": "http://evil.example"})
        assert "access-control-allow-origin" not in bad.headers


def test_sql_injection_in_ids_is_inert(client, settings):
    client.get("/api/projects/p_000000000000'; DROP TABLE projects;--")
    p = mk(client, "Still works'; DROP TABLE projects;--")
    assert client.get("/api/projects").json()["projects"][0]["id"] == p["id"]


def test_language_spec_endpoint(client):
    spec = client.get("/api/language/spec").json()
    assert "button" in spec["components"] and "text_upper" in spec["functions"]


def test_design_endpoints(client):
    p = mk(client)
    src = client.get(f"/api/projects/{p['id']}/files/main.apn").json()["content"]
    r = client.post(f"/api/projects/{p['id']}/design/edit", json={"source": src, "op": {"kind": "insert", "type": "button", "screen": "home"}})
    assert r.status_code == 200 and 'button("Button")' in r.json()["source"] and r.json()["line"] > 1
    new = r.json()
    n = client.post(f"/api/projects/{p['id']}/design/node", json={"source": new["source"], "line": new["line"]}).json()
    assert n["component"] == "button" and n["props"]["label"]["literal"]["value"] == "Button"
    bad = client.post(f"/api/projects/{p['id']}/design/edit", json={"source": src, "op": {"kind": "delete", "line": 1}})
    assert bad.status_code == 422 and set(bad.json()["error"]) >= {"code", "message"}
    assert client.post("/api/projects/p_000000000000/design/edit", json={"source": src, "op": {}}).status_code == 404
    assert client.post(f"/api/projects/{p['id']}/design/edit", json={"source": src}).status_code == 422
