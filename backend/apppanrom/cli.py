"""Tiny CLI.

  python -m apppanrom.cli compile <file.apn | ->        print the compile result (diagnostics + IR) as JSON
  python -m apppanrom.cli android-project <file.apn> <dest-dir>
                                                         write the generated Android Gradle project (open it in
                                                         Android Studio, or run `gradle assembleDebug` in it)
  python -m apppanrom.cli make-keystore <path> --alias <alias> [--name "CN=My Company"]
                                                         create a release keystore (password is prompted, never printed or stored)
"""
from __future__ import annotations

import json
import sys

from .lang import compile_source


def make_keystore(path: str, alias: str, dname: str = "CN=AppPanrom Release", password: str | None = None) -> int:
    """Creates an RSA-2048 release keystore with keytool. The password is handed to keytool through its environment."""
    import getpass
    import os
    import re
    import shutil
    import subprocess
    from pathlib import Path

    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", alias):
        print("Alias may only contain letters, digits, '.', '_' and '-'.", file=sys.stderr)
        return 2
    target = Path(path)
    if target.exists():
        print(f"Refusing to overwrite existing {target}.", file=sys.stderr)
        return 1
    keytool = shutil.which("keytool")
    if not keytool:
        print("keytool not found: install a JDK (17+) and make sure it is on PATH.", file=sys.stderr)
        return 1
    if password is None:
        password = getpass.getpass("New keystore/key password (min 6 chars): ")
        if password != getpass.getpass("Repeat password: "):
            print("Passwords do not match.", file=sys.stderr)
            return 1
    if len(password) < 6:
        print("Password must be at least 6 characters.", file=sys.stderr)
        return 1
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "JAVA_TOOL_OPTIONS")}
    env["APPANROM_KS_PW"] = password
    cmd = [keytool, "-genkeypair", "-keystore", str(target), "-alias", alias, "-keyalg", "RSA", "-keysize", "2048",
           "-validity", "10000", "-dname", dname, "-storepass:env", "APPANROM_KS_PW", "-keypass:env", "APPANROM_KS_PW"]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        print("keytool failed:", (r.stderr or r.stdout).strip()[:500], file=sys.stderr)
        return 1
    target.chmod(0o600)
    print(f"Keystore written to {target}\n\nBack it up and keep it OUT of git. Then start the backend with:\n"
          f"  export APPANROM_KEYSTORE={target}\n  export APPANROM_KEY_ALIAS={alias}\n  export APPANROM_KEYSTORE_PASSWORD=...   # the password you just chose")
    return 0


def main(argv: list[str]) -> int:
    if argv and argv[0] == "make-keystore":
        import argparse

        ap = argparse.ArgumentParser(prog="make-keystore")
        ap.add_argument("path")
        ap.add_argument("--alias", required=True)
        ap.add_argument("--name", default="CN=AppPanrom Release")
        a = ap.parse_args(argv[1:])
        return make_keystore(a.path, a.alias, a.name)
    if len(argv) == 3 and argv[0] == "android-project":
        from pathlib import Path

        from .android.generate import generate_project

        result = compile_source(open(argv[1], encoding="utf-8").read())
        for d in result.diagnostics:
            print(f"{d.file}:{d.line}:{d.col}: {d.severity}: {d.message}", file=sys.stderr)
        if not result.ok:
            return 1
        generate_project(result.ir, Path(argv[2]))
        print(f"Android project written to {argv[2]}")
        return 0
    if len(argv) < 2 or argv[0] != "compile":
        print(__doc__, file=sys.stderr)
        return 2
    src = sys.stdin.read() if argv[1] == "-" else open(argv[1], encoding="utf-8").read()
    result = compile_source(src)
    print(json.dumps(result.to_dict()))
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
