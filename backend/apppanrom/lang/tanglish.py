"""Tanglish vocabulary: spoken-Tamil names for the language's English words (keywords, a few components, options and standard-library functions).

The English names stay valid. The lexer maps every Tanglish name to its canonical name, so the parser, compiler, runtime and IR never see
the difference. `to_tanglish` / `to_english` rewrite source text between the two vocabularies (strings and comments are never touched).
The vocabulary lives in spec/schema.json ("tanglish") so every tool shares it.
"""
from __future__ import annotations

import re

from .spec import load_spec

_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _tables() -> tuple[dict[str, str], dict[str, str]]:
    to_en: dict[str, str] = {}
    for group in load_spec()["tanglish"].values():
        for en, ta in group.items():
            to_en[ta] = en
    return to_en, {en: ta for ta, en in to_en.items()}


def canonical(word: str) -> str:
    """Canonical (English) name of a Tanglish word; any other word is returned unchanged."""
    return _tables()[0].get(word, word)


def all_aliases() -> set[str]:
    return set(_tables()[0])


def _rewrite(source: str, table: dict[str, str]) -> str:
    out: list[str] = []
    for line in source.replace("\r\n", "\n").split("\n"):
        i, n, buf = 0, len(line), []
        while i < n:
            ch = line[i]
            if ch == "#":
                buf.append(line[i:])
                break
            if ch in "\"'":
                j = i + 1
                while j < n and line[j] != ch:
                    j += 2 if line[j] == "\\" else 1
                buf.append(line[i : j + 1])
                i = j + 1
            elif ch.isalpha() or ch == "_":
                m = _WORD.match(line, i)
                word = m.group(0) if m else ch
                # a word glued to digits (e.g. 12abc) is not an identifier we own
                buf.append(table.get(word, word))
                i += len(word)
            else:
                buf.append(ch)
                i += 1
        out.append("".join(buf))
    return "\n".join(out)


def to_tanglish(source: str) -> str:
    return _rewrite(source, _tables()[1])


def to_english(source: str) -> str:
    return _rewrite(source, _tables()[0])


def detect_style(source: str) -> str:
    """'tanglish' when the file uses more Tanglish vocabulary words than English ones, else 'english'."""
    to_en, to_ta = _tables()
    ta = en = 0
    for line in source.split("\n"):
        code = re.sub(r"\"(\\.|[^\"\\])*\"|'(\\.|[^'\\])*'|#.*", "", line)
        for w in _WORD.findall(code):
            if w in to_en:
                ta += 1
            elif w in to_ta:
                en += 1
    return "tanglish" if ta > en else "english"
