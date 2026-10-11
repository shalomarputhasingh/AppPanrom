"""Generates an isolated Android Gradle project for one build from the template + the compiled IR."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from ..lang.spec import REPO_ROOT
from .icon import IconError, validate_png_icon

TEMPLATE_DIR = REPO_ROOT / "android-template"
RUNTIME_JS = REPO_ROOT / "runtime" / "apppanrom-runtime.js"
APP_ID_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
VERSION_RE = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}$")

INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:">
<title>App</title>
<style>html,body{margin:0;height:100%;overflow:hidden}#app{position:relative;height:100%}</style>
</head>
<body>
<div id="app"></div>
<script src="apppanrom-runtime.js"></script>
<script src="app.js"></script>
</body>
</html>
"""

APP_JS = """window.__APPANROM_IR__ = %s;
(function () {
  // Web requests go through the native bridge, which exists only when the program uses api_get / api_post / ...
  var pending = {}, counter = 0;
  window.__apNativeDone = function (id, json) {
    var cb = pending[id]; delete pending[id];
    if (!cb) return;
    var res; try { res = JSON.parse(json); } catch (e) { res = { error: 'The reply could not be read.' }; }
    cb(res);
  };
  var N = window.ApNative;
  function ask(done) { var id = 'r' + (++counter); pending[id] = done; return id; }
  var http = N && N.http ? function (req, done) { N.http(ask(done), req.method, req.url, req.body); } : undefined;
  var location = N && N.location ? function (done) { N.location(ask(done)); } : undefined;
  var notify = N && N.notification ? function (title, text, done) { N.notification(ask(done), title, text); } : undefined;
  var ctrl = AppPanrom.mount(window.__APPANROM_IR__, document.getElementById('app'), {
    http: http,
    location: location,
    notify: notify,
    log: function (level, text) { if (window.console) console[level === 'debug' ? 'log' : (console[level] ? level : 'log')](text); }
  });
  window.__apBack = function () { return ctrl.goBack(); };
})();
"""


class GenerateError(Exception):
    pass


def version_code(version: str) -> int:
    major, minor, patch = (int(p) for p in version.split("."))
    return major * 1_000_000 + minor * 1_000 + patch


def xml_text(value: str) -> str:
    """Escape text for an Android string resource."""
    value = "".join(ch for ch in value if ch >= " " and ch != "\x7f")
    out = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    out = out.replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"')
    if out[:1] in ("@", "?"):
        out = "\\" + out
    return out


PERMISSION_RE = re.compile(r"^android\.permission\.[A-Z_]{3,40}$")


def permissions(ir: dict) -> list[str]:
    """Android permissions the app declares, derived by the compiler from the features the program uses."""
    perms = sorted({p["permission"] for p in ir.get("permissions", [])})
    if not all(PERMISSION_RE.fullmatch(p) for p in perms):
        raise GenerateError("Invalid permission name in IR.")
    return perms


def native_features(ir: dict) -> str:
    """res/values/features.xml: which native bridge features the program uses (the bridge exists only if one is on)."""
    used = {u for p in ir.get("permissions", []) for u in p.get("used_by", [])}
    flags = {
        "ap_net": any(u.startswith("api_") for u in used),
        "ap_location": "location_edu" in used,
        "ap_notify": "notification_kaattu" in used,
    }
    rows = "".join(f'    <bool name="{k}">{"true" if v else "false"}</bool>\n' for k, v in flags.items())
    return f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n{rows}</resources>\n'


def generate_project(ir: dict, dest: Path, icon: Path | None = None) -> None:
    """Writes a complete Gradle project into `dest` (must not exist). Values come from the validated IR only."""
    app = ir["app"]
    if not APP_ID_RE.fullmatch(app["id"]) or not VERSION_RE.fullmatch(app["version"]):
        raise GenerateError("Application id or version failed validation.")
    if dest.exists():
        raise GenerateError("Build directory already exists.")
    shutil.copytree(TEMPLATE_DIR, dest)
    subs = {
        "__APPLICATION_ID__": app["id"],
        "__VERSION_CODE__": str(version_code(app["version"])),
        "__VERSION_NAME__": app["version"],
    }
    gradle = dest / "app" / "build.gradle"
    text = gradle.read_text(encoding="utf-8")
    for k, v in subs.items():
        text = text.replace(k, v)
    gradle.write_text(text, encoding="utf-8")

    manifest = dest / "app" / "src" / "main" / "AndroidManifest.xml"
    names = permissions(ir)
    perms = "\n".join(f'    <uses-permission android:name="{p}" />' for p in names)
    if "android.permission.ACCESS_FINE_LOCATION" in names:
        # fine location would otherwise make Google Play treat a GPS chip as required and hide the app from some devices
        perms += '\n    <uses-feature android:name="android.hardware.location" android:required="false" />'
        perms += '\n    <uses-feature android:name="android.hardware.location.gps" android:required="false" />'
    icon_attr = ""
    if icon is not None:
        try:
            validate_png_icon(icon.read_bytes())
        except (IconError, OSError) as e:
            raise GenerateError(f"App icon rejected: {e}") from None
        target = dest / "app" / "src" / "main" / "res" / "mipmap-xxxhdpi"
        target.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(icon, target / "ic_launcher.png")
        icon_attr = '        android:icon="@mipmap/ic_launcher"\n'
    text = manifest.read_text(encoding="utf-8").replace("__PERMISSIONS__", perms).replace("__ICON_ATTR__", icon_attr)
    manifest.write_text(text, encoding="utf-8")

    res = dest / "app" / "src" / "main" / "res" / "values"
    (res / "features.xml").write_text(native_features(ir), encoding="utf-8")
    (res / "strings.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">'
        + xml_text(app["name"]) + "</string>\n</resources>\n", encoding="utf-8")

    www = dest / "app" / "src" / "main" / "assets" / "www"
    www.mkdir(parents=True)
    (www / "index.html").write_text(INDEX_HTML, encoding="utf-8")
    shutil.copyfile(RUNTIME_JS, www / "apppanrom-runtime.js")
    payload = json.dumps(ir, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    (www / "app.js").write_text(APP_JS % payload, encoding="utf-8")
