"""Visual-designer edit engine.

The designer never keeps its own model: the source text is the single source of truth. Every designer action
(drop a component, move, delete, change a property...) is turned into a minimal text edit of `main.apn`, and the
result is re-parsed to prove it is still syntactically valid. Components are addressed by the 1-based source line
where their statement starts, which is exactly what the runtime stamps on every rendered element.
"""
from __future__ import annotations

import re

from .diagnostics import SyntaxProblem
from .compiler import compile_source
from .lexer import tokenize
from .parser import Parser, parse
from .spec import load_spec

INDENT = 4
LINE_WIDTH = 100
MAX_EDIT_SOURCE = 200_000


class DesignError(Exception):
    def __init__(self, message: str, code: str = "design_error"):
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------------------------------------------------
# Unparser (expressions are small; headers of edited components are regenerated from the AST)
# --------------------------------------------------------------------------------------------------------------
_PREC = {"or": 1, "and": 2, "not": 3, "==": 4, "!=": 4, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6}


def quote(value: str) -> str:
    out = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t")
    return '"' + "".join(ch for ch in out if ch >= " ") + '"'


def fmt_number(v) -> str:
    if isinstance(v, bool):
        raise DesignError("Not a number.")
    if isinstance(v, int):
        return str(v)
    text = ("%.10f" % v).rstrip("0").rstrip(".")
    return text if text not in ("", "-") else "0"


def unparse(e: dict, parent_prec: int = 0) -> str:
    t = e["t"]
    if t == "num":
        return fmt_number(e["v"])
    if t == "str":
        return quote(e["v"])
    if t == "bool":
        return "true" if e["v"] else "false"
    if t == "null":
        return "null"
    if t == "name":
        return e["n"]
    if t == "list":
        return "[" + ", ".join(unparse(i) for i in e["items"]) + "]"
    if t == "dict":
        return "{" + ", ".join(f"{unparse(k)}: {unparse(v)}" for k, v in e["items"]) + "}"
    if t == "index":
        return f"{unparse(e['e'], 9)}[{unparse(e['i'])}]"
    if t == "call":
        parts = [unparse(a) for a in e["args"]] + [f"{k}={unparse(v)}" for k, v in e.get("kw", {}).items()]
        return f"{e['f']}({', '.join(parts)})"
    if t == "un":
        prec = _PREC["not"] if e["op"] == "not" else 7
        text = ("not " if e["op"] == "not" else "-") + unparse(e["e"], prec)
        return f"({text})" if prec < parent_prec else text
    if t == "bin":
        prec = _PREC[e["op"]]
        text = f"{unparse(e['l'], prec)} {e['op']} {unparse(e['r'], prec + 1)}"
        return f"({text})" if prec < parent_prec else text
    raise DesignError(f"Cannot write expression of type {t}.")


def literal_node(value) -> dict:
    if isinstance(value, bool):
        return {"t": "bool", "v": value, "pos": [0, 0]}
    if isinstance(value, (int, float)):
        return {"t": "num", "v": value, "pos": [0, 0]}
    if isinstance(value, str):
        return {"t": "str", "v": value, "pos": [0, 0]}
    if value is None:
        return {"t": "null", "pos": [0, 0]}
    raise DesignError("Unsupported literal value.")


def parse_expression(text: str) -> dict:
    """Parses a single AppPanrom expression typed into the inspector."""
    text = text.strip()
    if not text or "\n" in text:
        raise DesignError("Enter a single-line expression.", "bad_expression")
    try:
        p = Parser(tokenize(text))
        e = p.expr()
        if p.cur.kind not in ("NEWLINE", "EOF"):
            raise DesignError("Unexpected text after the expression.", "bad_expression")
        return e
    except SyntaxProblem as ex:
        raise DesignError(f"Invalid expression: {ex.diagnostic.message}", "bad_expression") from None


def header_text(node: dict, indent: int) -> list[str]:
    """Regenerates a component call header ('name(args)' + optional ':') as one or more lines at `indent`."""
    pad = " " * indent
    args = [unparse(a) for a in node["args"]]
    kw = dict(node["kw"])
    style = kw.pop("style", None)
    args += [f"{k}={unparse(v)}" for k, v in kw.items()]
    if style is not None:
        args.append(f"style={unparse(style)}")
    colon = ":" if node["t"] == "block_call" else ""
    one = f"{pad}{node['f']}({', '.join(args)}){colon}"
    if len(one) <= LINE_WIDTH or not args:
        return [one]
    return [f"{pad}{node['f']}("] + [f"{pad}{' ' * INDENT}{a}," for a in args] + [f"{pad}){colon}"]


# --------------------------------------------------------------------------------------------------------------
# Locating statements
# --------------------------------------------------------------------------------------------------------------
class Loc:
    def __init__(self, node, siblings, parent, ancestors):
        self.node, self.siblings, self.parent, self.ancestors = node, siblings, parent, ancestors

    @property
    def index(self) -> int:
        return next(i for i, n in enumerate(self.siblings) if n is self.node)


def _child_lists(node: dict):
    for key in ("body", "children", "handler", "else"):
        v = node.get(key)
        if isinstance(v, list):
            yield v
    for b in node.get("branches", []):
        yield b["body"]


def locate(program: list[dict], line: int) -> Loc | None:
    def walk(stmts, parent, ancestors):
        for n in stmts:
            if n["pos"][0] == line:
                return Loc(n, stmts, parent, ancestors)
            if n["pos"][0] <= line <= n["end"]:
                for sub in _child_lists(n):
                    found = walk(sub, n, ancestors + [n])
                    if found:
                        return found
        return None

    return walk(program, None, [])


def is_component(n: dict) -> bool:
    return n["t"] in ("call_stmt", "block_call") and n["f"] in load_spec()["components"]


def is_screen(n: dict) -> bool:
    return n["t"] == "block_call" and n["f"] == "screen_uruvakku"


def is_container(n: dict) -> bool:
    return is_screen(n) or (n["t"] == "block_call" and load_spec()["components"].get(n["f"], {}).get("container", False))


def _in_screen(loc: Loc) -> bool:
    return any(is_screen(a) for a in loc.ancestors) or is_screen(loc.node)


def _need_component(program, line, what="component") -> Loc:
    loc = locate(program, line)
    if loc is None or not (is_component(loc.node) or is_screen(loc.node)) or not _in_screen(loc):
        raise DesignError(f"Line {line} is not a {what} inside a screen.", "not_a_component")
    return loc


# --------------------------------------------------------------------------------------------------------------
# Line-edit machinery. All edits are expressed in ORIGINAL line coordinates and applied bottom-up.
# --------------------------------------------------------------------------------------------------------------
class Edits:
    def __init__(self):
        self.items: list[tuple[str, int, int, list[str]]] = []  # (kind, start, end, lines); 0-based, end exclusive

    def insert(self, index: int, lines: list[str]):
        self.items.append(("insert", index, index, lines))

    def remove(self, start: int, end: int):
        self.items.append(("remove", start, end, []))

    def apply(self, lines: list[str]) -> list[str]:
        out = list(lines)
        # descending by start; at equal start, removals first so inserted lines land where the removed ones were
        for kind, a, b, new in sorted(self.items, key=lambda it: (it[1], 0 if it[0] == "insert" else 1), reverse=True):
            if kind == "remove":
                del out[a:b]
            else:
                out[a:a] = new
        return out

    def shift_before(self, index: int) -> int:
        """Net line-count change caused by edits located strictly before `index` (original coordinates)."""
        d = 0
        for kind, a, b, new in self.items:
            if a < index:
                d += len(new) if kind == "insert" else -(b - a)
        return d


def _indent_of(node: dict) -> int:
    return node["pos"][1] - 1


def reindent(lines: list[str], delta: int) -> list[str]:
    out = []
    for ln in lines:
        if not ln.strip():
            out.append(ln)
        elif delta >= 0:
            out.append(" " * delta + ln)
        else:
            out.append(ln[min(-delta, len(ln) - len(ln.lstrip(" "))):])
    return out


def _fill_if_empty(edits: Edits, loc: Loc, lines_removed: tuple[int, int]):
    """If removing `loc.node` leaves its block empty, leave a `summa` (no-op) so the file stays valid."""
    if len(loc.siblings) == 1:
        edits.insert(lines_removed[0], [" " * _indent_of(loc.node) + "summa"])


def _insertion_point(program, target: Loc | None, screen: Loc | None, position: str, edits: Edits) -> tuple[int, int]:
    """Returns (0-based index to insert at, indent). May schedule removal of a lone `summa` placeholder."""
    if position == "inside":
        box = target or screen
        if box is None or not is_container(box.node):
            raise DesignError("You can only drop inside a container or a screen.", "not_a_container")
        kids = box.node["children"]
        indent = _indent_of(kids[0]) if kids else _indent_of(box.node) + INDENT
        if len(kids) == 1 and kids[0]["t"] == "summa":
            edits.remove(kids[0]["pos"][0] - 1, kids[0]["end"])
            return kids[0]["pos"][0] - 1, indent
        return box.node["end"], indent
    if target is None:
        raise DesignError("A target component is required.", "bad_target")
    if target.parent is None or not _in_screen(target) or is_screen(target.node):
        raise DesignError("You can only drop next to components inside a screen.", "bad_target")
    if position == "before":
        return target.node["pos"][0] - 1, _indent_of(target.node)
    if position == "after":
        return target.node["end"], _indent_of(target.node)
    raise DesignError("Position must be before, after or inside.", "bad_position")


def _first_screen(program: list[dict], name: str | None) -> Loc:
    for n in program:
        if is_screen(n) and (name is None or (n["args"] and n["args"][0].get("v") == name)):
            return Loc(n, program, None, [])
    raise DesignError("Screen not found.", "no_screen")


# --------------------------------------------------------------------------------------------------------------
# Snippets for newly dropped components
# --------------------------------------------------------------------------------------------------------------
INPUT_BASE = {"input_uruvakku": "input", "password_input": "password", "number_input": "number",
              "checkbox_uruvakku": "check", "toggle_uruvakku": "toggle", "dropdown_uruvakku": "choice"}


def input_names(source: str) -> set[str]:
    return set(re.findall(r'(?:input_uruvakku|password_input|number_input|checkbox_uruvakku|toggle_uruvakku|dropdown_uruvakku)\(\s*"([^"]*)"', source))


def unique_name(source: str, base: str) -> str:
    used = input_names(source)
    i = 1
    while f"{base}{i}" in used:
        i += 1
    return f"{base}{i}"


def snippet(ctype: str, source: str, indent: int) -> list[str]:
    pad = " " * indent
    spec = load_spec()["components"]
    if ctype not in spec:
        raise DesignError(f"Unknown component '{ctype}'.", "unknown_component")
    name = unique_name(source, INPUT_BASE[ctype]) if ctype in INPUT_BASE else None
    one = {
        "title": 'title("Title")',
        "text_kaattu": 'text_kaattu("Text")',
        "button": 'button("Button")',
        "input_uruvakku": f'input_uruvakku("{name}", label="Label", placeholder="Type here")',
        "password_input": f'password_input("{name}", label="Password")',
        "number_input": f'number_input("{name}", label="Number")',
        "checkbox_uruvakku": f'checkbox_uruvakku("{name}", label="Checkbox")',
        "toggle_uruvakku": f'toggle_uruvakku("{name}", label="Toggle")',
        "dropdown_uruvakku": f'dropdown_uruvakku("{name}", options=["One", "Two", "Three"], label="Choose")',
        "image_kaattu": 'image_kaattu("https://placehold.co/300x160/png", alt="Placeholder image")',
        "list_kaattu": 'list_kaattu(["Item 1", "Item 2", "Item 3"])',
        "progress_kaattu": "progress_kaattu(50)",
        "loading_kaattu": "loading_kaattu()",
        "divider_kaattu": "divider_kaattu()",
    }
    blocks = {
        "column_uruvakku": 'column_uruvakku(style={"gap": 8}):',
        "row_uruvakku": 'row_uruvakku(style={"gap": 8}):',
        "center_ama": "center_ama(style={\"gap\": 8}):",
        "card_uruvakku": 'card_uruvakku(style={"padding": 16, "gap": 8}):',
    }
    if ctype in one:
        return [pad + one[ctype]]
    return [pad + blocks[ctype], pad + " " * INDENT + "summa"]


# --------------------------------------------------------------------------------------------------------------
# Public operations
# --------------------------------------------------------------------------------------------------------------
def _split(source: str) -> tuple[list[str], bool]:
    return source.replace("\r\n", "\n").split("\n"), source.endswith("\n")


def _join(lines: list[str]) -> str:
    return "\n".join(lines)


def _check(new_source: str) -> str:
    if len(new_source.encode("utf-8")) > MAX_EDIT_SOURCE:
        raise DesignError("The result would be larger than the maximum source size.", "too_large")
    try:
        parse(new_source)
    except SyntaxProblem as e:
        raise DesignError(f"That edit would make the code invalid ({e.diagnostic.message}).", "invalid_result") from None
    return new_source


def _errors(source: str) -> list:
    r = compile_source(source)
    return [d for d in r.diagnostics if d.severity == "error"]


def apply_op(source: str, op: dict) -> dict:
    """Applies one designer operation. Returns {"source": new_source, "line": line_to_select | None}."""
    kind = op.get("kind")
    try:
        program = parse(source)
    except SyntaxProblem as e:
        raise DesignError(f"Fix the syntax error first (line {e.diagnostic.line}): {e.diagnostic.message}", "syntax") from None
    lines, _ = _split(source)
    fn = {
        "insert": _op_insert, "move": _op_move, "delete": _op_delete, "duplicate": _op_duplicate,
        "set_prop": _op_set_prop, "set_style": _op_set_style, "set_event": _op_set_event,
        "add_screen": _op_add_screen, "create_handler": _op_create_handler,
    }.get(kind)
    if fn is None:
        raise DesignError(f"Unknown operation '{kind}'.", "bad_op")
    before = len(_errors(source)) if kind in ("set_prop", "set_style", "set_event") else 0
    new_lines, select = fn(program, lines, source, op)
    new_source = _check(_join(new_lines))
    if kind in ("set_prop", "set_style", "set_event"):
        after = _errors(new_source)
        if len(after) > before:
            raise DesignError(after[0].message + (f" {after[0].suggestion}" if after[0].suggestion else ""), "invalid_value")
    return {"source": new_source, "line": select}


def _target(program, op) -> Loc | None:
    line = op.get("target_line")
    if line is None:
        return None
    return _need_component(program, int(line), "target")


def _op_insert(program, lines, source, op):
    edits = Edits()
    screen = None if op.get("target_line") is not None else _first_screen(program, op.get("screen"))
    target = _target(program, op)
    idx, indent = _insertion_point(program, target, screen, op.get("position", "inside"), edits)
    new = snippet(op.get("type", ""), source, indent)
    edits.insert(idx, new)
    return edits.apply(lines), idx + edits.shift_before(idx) + 1


def _op_delete(program, lines, source, op):
    loc = _need_component(program, int(op["line"]))
    if is_screen(loc.node):
        raise DesignError("Screens are deleted in the code editor.", "protected")
    edits = Edits()
    a, b = loc.node["pos"][0] - 1, loc.node["end"]
    edits.remove(a, b)
    _fill_if_empty(edits, loc, (a, b))
    return edits.apply(lines), None


def _op_duplicate(program, lines, source, op):
    loc = _need_component(program, int(op["line"]))
    if is_screen(loc.node):
        raise DesignError("Screens cannot be duplicated here.", "protected")
    a, b = loc.node["pos"][0] - 1, loc.node["end"]
    block = list(lines[a:b])
    text = _join(block)
    for name in sorted(input_names(text)):
        text = text.replace(f'"{name}"', f'"{unique_name(source + chr(10) + text, re.sub(r"[0-9]+$", "", name) or "input")}"', 1)
    edits = Edits()
    edits.insert(b, text.split("\n"))
    return edits.apply(lines), b + 1


def _op_move(program, lines, source, op):
    node_loc = _need_component(program, int(op["line"]))
    if is_screen(node_loc.node):
        raise DesignError("Screens cannot be moved here.", "protected")
    a, b = node_loc.node["pos"][0] - 1, node_loc.node["end"]
    screen = None if op.get("target_line") is not None else _first_screen(program, op.get("screen"))
    target = _target(program, op)
    if target is not None and a <= target.node["pos"][0] - 1 < b:
        raise DesignError("A component cannot be moved into itself.", "bad_target")
    edits = Edits()
    idx, indent = _insertion_point(program, target, screen, op.get("position", "inside"), edits)
    if a <= idx < b and idx != a:
        raise DesignError("A component cannot be moved into itself.", "bad_target")
    block = reindent(lines[a:b], indent - _indent_of(node_loc.node))
    edits.remove(a, b)
    _fill_if_empty(edits, node_loc, (a, b))
    edits.insert(idx, block)
    return edits.apply(lines), idx + edits.shift_before(idx) + 1


def _replace_header(lines, node, new_header):
    a, b = node["pos"][0] - 1, node["hend"]
    return lines[:a] + new_header + lines[b:]


def _comp_for_edit(program, op) -> Loc:
    loc = _need_component(program, int(op["line"]))
    if is_screen(loc.node):
        raise DesignError("Select a component, not the screen.", "not_a_component")
    return loc


def _value_node(v) -> dict | None:
    if v is None:
        return None
    if "literal" in v:
        return literal_node(v["literal"])
    if "expr" in v:
        return parse_expression(v["expr"])
    raise DesignError("Value must have 'literal' or 'expr'.", "bad_value")


def _op_set_prop(program, lines, source, op):
    loc = _comp_for_edit(program, op)
    node, name = loc.node, op.get("name")
    cspec = load_spec()["components"][node["f"]]
    positional = [p["name"] for p in cspec["positional"]]
    val = _value_node(op.get("value"))
    if name in positional:
        i = positional.index(name)
        if val is None:
            raise DesignError(f"'{name}' is required.", "required")
        if i < len(node["args"]):
            node["args"][i] = val
        elif i == len(node["args"]):
            node["args"].append(val)
        else:
            raise DesignError("Set the earlier required values first.", "bad_value")
    elif name in cspec["kwargs"]:
        if val is None:
            node["kw"].pop(name, None)
        else:
            node["kw"][name] = val
    else:
        raise DesignError(f"{node['f']} has no property '{name}'.", "unknown_property")
    return _replace_header(lines, node, header_text(node, _indent_of(node))), node["pos"][0]


def _op_set_style(program, lines, source, op):
    loc = _comp_for_edit(program, op)
    node, key = loc.node, op.get("key")
    spec = load_spec()
    if key not in spec["styles"]:
        raise DesignError(f"Unknown style '{key}'.", "unknown_style")
    allowed = {k for g in spec["components"][node["f"]]["style_groups"] for k in spec["style_groups"][g]}
    if key not in allowed:
        raise DesignError(f"Style '{key}' does not apply to {node['f']}.", "style_not_applicable")
    style = node["kw"].get("style")
    if style is None or style["t"] != "dict":
        if style is not None:
            raise DesignError("This component's style is not a plain {...} dictionary; edit it in the code.", "dynamic_style")
        style = {"t": "dict", "items": [], "pos": [0, 0]}
    items = list(style["items"])
    idx = next((i for i, (k, _) in enumerate(items) if k["t"] == "str" and k["v"] == key), None)
    val = _value_node(op.get("value"))
    if val is None:
        if idx is not None:
            del items[idx]
    elif idx is None:
        items.append([literal_node(key), val])
    else:
        items[idx] = [items[idx][0], val]
    style["items"] = items
    if items:
        node["kw"]["style"] = style
    else:
        node["kw"].pop("style", None)
    return _replace_header(lines, node, header_text(node, _indent_of(node))), node["pos"][0]


def _op_set_event(program, lines, source, op):
    loc = _comp_for_edit(program, op)
    node, ev = loc.node, op.get("event")
    if ev not in load_spec()["components"][node["f"]]["events"]:
        raise DesignError(f"{node['f']} has no event '{ev}'.", "unknown_event")
    fn = op.get("function")
    if fn is None:
        node["kw"].pop(ev, None)
    else:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(fn)):
            raise DesignError("Invalid function name.", "bad_name")
        node["kw"][ev] = {"t": "name", "n": fn, "pos": [0, 0]}
    return _replace_header(lines, node, header_text(node, _indent_of(node))), node["pos"][0]


def _op_add_screen(program, lines, source, op):
    name = str(op.get("name", ""))
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,39}", name):
        raise DesignError("Screen names use letters, digits and underscores (max 40), starting with a letter.", "bad_name")
    for n in program:
        if is_screen(n) and n["args"] and n["args"][0].get("v") == name:
            raise DesignError(f"Screen '{name}' already exists.", "duplicate")
    while lines and not lines[-1].strip():
        lines = lines[:-1]
    start = len(lines) + 2
    return lines + ["", f'screen_uruvakku("{name}"):', f'    screen_title("{name}")', "    summa", ""], start


def _op_create_handler(program, lines, source, op):
    name = str(op.get("name", ""))
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", name):
        raise DesignError("Handler names are lowercase letters, digits and underscores.", "bad_name")
    spec = load_spec()
    if name in spec["functions"] or name in spec["components"] or any(n["t"] == "function" and n["n"] == name for n in program):
        raise DesignError(f"'{name}' is already used.", "duplicate")
    first_screen = next((n for n in program if is_screen(n)), None)
    at = first_screen["pos"][0] - 1 if first_screen else len(lines)
    new = [f"function {name}():", f'    toast_kaattu("{name} was called")', ""]
    return lines[:at] + new + lines[at:], at + 1


# --------------------------------------------------------------------------------------------------------------
# Inspector data
# --------------------------------------------------------------------------------------------------------------
def _describe_value(node: dict) -> dict:
    lit = {"str": "str", "num": "num", "bool": "bool"}.get(node["t"])
    out = {"expr": unparse(node)}
    if lit:
        out["literal"] = {"type": lit, "value": node["v"]}
    return out


def _key_text(k: dict) -> str:
    return k["v"] if k["t"] == "str" else unparse(k)


def describe(source: str, line: int) -> dict:
    try:
        program = parse(source)
    except SyntaxProblem as e:
        raise DesignError(f"Fix the syntax error first (line {e.diagnostic.line}).", "syntax") from None
    loc = _need_component(program, line)
    node = loc.node
    spec = load_spec()
    handlers = [n["n"] for n in program if n["t"] == "function" and not n["params"]]
    handler_lines = {n["n"]: n["pos"][0] for n in program if n["t"] == "function"}
    if is_screen(node):
        style = node["kw"].get("style")
        keys = [k for g in spec["screen_style_groups"] for k in spec["style_groups"][g]]
        return {
            "kind": "screen", "component": "screen_uruvakku", "line": line, "container": True,
            "props": {}, "events": {}, "style": {_key_text(k): _describe_value(v) for k, v in style["items"]} if style and style["t"] == "dict" else {},
            "style_dynamic": bool(style and style["t"] != "dict"),
            "allowed": {"props": [], "events": [], "style": keys}, "handlers": handlers, "handler_lines": handler_lines,
            "name": node["args"][0]["v"] if node["args"] else "",
        }
    cspec = spec["components"][node["f"]]
    props = {}
    for p, a in zip(cspec["positional"], node["args"]):
        props[p["name"]] = _describe_value(a)
    events = {}
    for k, v in node["kw"].items():
        if k in cspec["events"]:
            events[k] = v["n"] if v["t"] == "name" else unparse(v)
        elif k != "style":
            props[k] = _describe_value(v)
    style = node["kw"].get("style")
    keys = [k for g in cspec["style_groups"] for k in spec["style_groups"][g]]
    allowed_props = [{"name": p["name"], "type": p["type"], "required": p["required"]} for p in cspec["positional"]] + \
                    [{"name": k, "type": t, "required": False} for k, t in cspec["kwargs"].items()]
    return {
        "kind": "component", "component": node["f"], "line": line, "container": is_container(node),
        "props": props, "events": events,
        "style": {_key_text(k): _describe_value(v) for k, v in style["items"]} if style and style["t"] == "dict" else {},
        "style_dynamic": bool(style and style["t"] != "dict"),
        "allowed": {"props": allowed_props, "events": cspec["events"], "style": keys},
        "handlers": handlers, "handler_lines": handler_lines,
    }
