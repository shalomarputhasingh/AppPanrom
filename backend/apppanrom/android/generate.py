"""Generates an isolated Android Gradle project for one build from the template + the compiled IR."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from ..lang.spec import REPO_ROOT

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
  var ctrl = AppPanrom.mount(window.__APPANROM_IR__, document.getElementById('app'), {
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


def uses_network(ir: dict) -> bool:
    return '"c": "image_kaattu"' in json.dumps(ir)


def generate_project(ir: dict, dest: Path) -> None:
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
    perms = '    <uses-permission android:name="android.permission.INTERNET" />' if uses_network(ir) else ""
    manifest.write_text(manifest.read_text(encoding="utf-8").replace("__PERMISSIONS__", perms), encoding="utf-8")

    res = dest / "app" / "src" / "main" / "res" / "values"
    (res / "strings.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">'
        + xml_text(app["name"]) + "</string>\n</resources>\n", encoding="utf-8")

    www = dest / "app" / "src" / "main" / "assets" / "www"
    www.mkdir(parents=True)
    (www / "index.html").write_text(INDEX_HTML, encoding="utf-8")
    shutil.copyfile(RUNTIME_JS, www / "apppanrom-runtime.js")
    payload = json.dumps(ir, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    (www / "app.js").write_text(APP_JS % payload, encoding="utf-8")
