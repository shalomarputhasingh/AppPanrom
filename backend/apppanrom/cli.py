"""Tiny CLI.

  python -m apppanrom.cli compile <file.apn | ->        print the compile result (diagnostics + IR) as JSON
  python -m apppanrom.cli android-project <file.apn> <dest-dir>
                                                         write the generated Android Gradle project (open it in
                                                         Android Studio, or run `gradle assembleDebug` in it)
"""
from __future__ import annotations

import json
import sys

from .lang import compile_source


def main(argv: list[str]) -> int:
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
