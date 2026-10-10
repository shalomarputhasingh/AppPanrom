"""Indentation-aware lexer for AppPanrom source."""
from __future__ import annotations

from dataclasses import dataclass

from .diagnostics import SyntaxProblem

KEYWORDS = {
    "mari", "function", "return", "enna_na", "illana_enna", "illana",
    "ovvoru", "in", "irukkura_varai", "try", "catch", "and", "or", "not", "summa",
    "true", "false", "null",
}

TWO_CHAR_OPS = {"==", "!=", "<=", ">="}
ONE_CHAR_OPS = set("+-*/%<>=()[]{},:.")
ESCAPES = {"n": "\n", "t": "\t", '"': '"', "'": "'", "\\": "\\"}
CURLY = {"“": '"', "”": '"', "‘": "'", "’": "'"}
MAX_SOURCE_BYTES = 200_000
INDENT_WIDTH = 4


@dataclass
class Token:
    kind: str  # NAME KEYWORD NUMBER STRING OP NEWLINE INDENT DEDENT EOF
    value: object
    line: int
    col: int
    end_col: int = 0


def tokenize(source: str) -> list[Token]:
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise SyntaxProblem(f"Source is larger than {MAX_SOURCE_BYTES} bytes.", 1, 1, "source_too_large")
    tokens: list[Token] = []
    indents = [0]
    depth = 0  # open brackets: newlines are ignored inside them
    lines = source.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for lineno, raw in enumerate(lines, start=1):
        i = 0
        n = len(raw)
        if depth == 0:
            stripped = raw.lstrip(" ")
            if "\t" in raw[: n - len(raw.lstrip())]:
                raise SyntaxProblem("Tabs are not allowed for indentation.", lineno, 1, "tab_indent",
                                    "Use 4 spaces per indentation level.")
            if stripped == "" or stripped.startswith("#"):
                continue
            width = n - len(stripped)
            if width % INDENT_WIDTH:
                raise SyntaxProblem(f"Indentation must be a multiple of {INDENT_WIDTH} spaces (found {width}).",
                                    lineno, 1, "bad_indent", f"Use {INDENT_WIDTH} spaces per level.")
            if width > indents[-1]:
                if width != indents[-1] + INDENT_WIDTH:
                    raise SyntaxProblem("Indented too far; indent one level (4 spaces) at a time.", lineno, 1, "bad_indent")
                indents.append(width)
                tokens.append(Token("INDENT", None, lineno, 1))
            else:
                while width < indents[-1]:
                    indents.pop()
                    tokens.append(Token("DEDENT", None, lineno, 1))
                if width != indents[-1]:
                    raise SyntaxProblem("Unindent does not match any outer indentation level.", lineno, 1, "bad_indent")
            i = width
        while i < n:
            ch = raw[i]
            col = i + 1
            if ch in " \t":
                i += 1
            elif ch == "#":
                break
            elif ch in CURLY:
                raise SyntaxProblem("Curly (smart) quote found.", lineno, col, "curly_quote",
                                    'Use straight quotes: " or \'. (Pasting from a word processor often converts them.)')
            elif ch in "\"'":
                value, i = _read_string(raw, i, lineno)
                tokens.append(Token("STRING", value, lineno, col, i + 1))
            elif ch.isdigit() or (ch == "." and i + 1 < n and raw[i + 1].isdigit()):
                j = i
                seen_dot = False
                while j < n and (raw[j].isdigit() or (raw[j] == "." and not seen_dot)):
                    seen_dot = seen_dot or raw[j] == "."
                    j += 1
                text = raw[i:j]
                tokens.append(Token("NUMBER", float(text) if seen_dot else int(text), lineno, col, j + 1))
                i = j
            elif ch.isalpha() or ch == "_":
                j = i
                while j < n and (raw[j].isalnum() or raw[j] == "_"):
                    j += 1
                word = raw[i:j]
                tokens.append(Token("KEYWORD" if word in KEYWORDS else "NAME", word, lineno, col, j + 1))
                i = j
            elif raw[i : i + 2] in TWO_CHAR_OPS:
                tokens.append(Token("OP", raw[i : i + 2], lineno, col, col + 2))
                i += 2
            elif ch in ONE_CHAR_OPS:
                if ch in "([{":
                    depth += 1
                elif ch in ")]}":
                    depth -= 1
                    if depth < 0:
                        raise SyntaxProblem(f"Unmatched '{ch}'.", lineno, col, "unmatched_bracket")
                tokens.append(Token("OP", ch, lineno, col, col + 1))
                i += 1
            else:
                raise SyntaxProblem(f"Unexpected character {ch!r}.", lineno, col, "bad_char")
        if depth == 0:
            tokens.append(Token("NEWLINE", None, lineno, n + 1))
    if depth > 0:
        raise SyntaxProblem("Unclosed bracket at end of file.", len(lines), 1, "unclosed_bracket")
    last = len(lines)
    while len(indents) > 1:
        indents.pop()
        tokens.append(Token("DEDENT", None, last, 1))
    tokens.append(Token("EOF", None, last, 1))
    return tokens


def _read_string(raw: str, start: int, lineno: int) -> tuple[str, int]:
    quote = raw[start]
    out: list[str] = []
    i = start + 1
    while i < len(raw):
        ch = raw[i]
        if ch == quote:
            return "".join(out), i + 1
        if ch == "\\":
            i += 1
            if i >= len(raw) or raw[i] not in ESCAPES:
                raise SyntaxProblem("Unknown escape sequence in string.", lineno, i, "bad_escape",
                                    "Supported escapes: \\n \\t \\\" \\' \\\\")
            out.append(ESCAPES[raw[i]])
        else:
            out.append(ch)
        i += 1
    raise SyntaxProblem("String is not closed.", lineno, start + 1, "unclosed_string",
                        f"Add a closing {quote} at the end of the string.")
