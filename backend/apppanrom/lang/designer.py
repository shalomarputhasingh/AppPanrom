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
from .tanglish import detect_style, to_tanglish

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
        "nav_action": 'nav_action("Action", icon="+")',
        "tab_item": 'tab_item("Tab", icon="•")',
    }
    blocks = {
        "navbar_uruvakku": 'navbar_uruvakku(title="Title"):',
        "tabbar_uruvakku": "tabbar_uruvakku():",
        "column_uruvakku": 'column_uruvakku(style={"gap": 8}):',
        "row_uruvakku": 'row_uruvakku(style={"gap": 8}):',
        "center_ama": "center_ama(style={\"gap\": 8}):",
        "card_uruvakku": 'card_uruvakku(style={"padding": 16, "gap": 8}):',
    }
    if ctype in one:
        return [pad + one[ctype]]
    if ctype == "tabbar_uruvakku":  # one tab per screen (up to four), already wired with go=
        names = re.findall(r'^screen_uruvakku\("([A-Za-z0-9_]+)"', source, re.M)[:4] or ["home"]
        return [pad + blocks[ctype]] + [pad + " " * INDENT + f'tab_item("{n.replace("_", " ").title()}", icon="•", go="{n}")' for n in names]
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


CHECKED_KINDS = ("set_prop", "set_style", "set_styles", "set_event", "set_app", "add_global", "set_global", "delete_global", "rename_screen", "delete_screen", "navbar_all", "tabs_all")


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
        "set_prop": _op_set_prop, "set_style": _op_set_style, "set_styles": _op_set_styles, "set_event": _op_set_event,
        "add_screen": _op_add_screen, "create_handler": _op_create_handler,
        "set_app": _op_set_app, "add_global": _op_add_global, "set_global": _op_set_global, "delete_global": _op_delete_global,
        "rename_screen": _op_rename_screen, "delete_screen": _op_delete_screen,
        "navbar_all": _op_navbar_all, "tabs_all": _op_tabs_all,
    }.get(kind)
    if fn is None:
        raise DesignError(f"Unknown operation '{kind}'.", "bad_op")
    before = len(_errors(source)) if kind in CHECKED_KINDS else 0
    new_lines, select = fn(program, lines, source, op)
    new_source = _check(_join(new_lines))
    if kind in CHECKED_KINDS:
        after = _errors(new_source)
        if len(after) > before:
            raise DesignError(after[0].message + (f" {after[0].suggestion}" if after[0].suggestion else ""), "invalid_value")
    if detect_style(source) == "tanglish":  # keep the file in the vocabulary the author chose
        new_source = to_tanglish(new_source)
    return {"source": new_source, "line": select}


def _target(program, op) -> Loc | None:
    line = op.get("target_line")
    if line is None:
        return None
    return _need_component(program, int(line), "target")


BAR_PARENT = {"navbar_uruvakku": "screen", "tabbar_uruvakku": "screen", "nav_action": "navbar_uruvakku", "tab_item": "tabbar_uruvakku"}


def _check_insert_place(ctype: str, program, target, screen, position: str) -> None:
    """Top bar / tab bar pieces only fit in one place; refuse a drop that the compiler would reject."""
    if position == "inside":
        box = (target or screen).node
    else:
        box = target.parent if target is not None else None
    parent = "screen" if box is None or is_screen(box) else box.get("f")
    want = BAR_PARENT.get(ctype)
    names = {"screen": "a screen", "navbar_uruvakku": "the top bar (navbar_uruvakku)", "tabbar_uruvakku": "the tab bar (tabbar_uruvakku)"}
    if want and parent != want:
        raise DesignError(f"{ctype} can only go {'directly in ' if want == 'screen' else 'inside '}{names[want]}.", "bad_target")
    if not want and parent in ("navbar_uruvakku", "tabbar_uruvakku"):
        raise DesignError(f"{names[parent].capitalize()} only holds {'nav_action' if parent == 'navbar_uruvakku' else 'tab_item'} items.", "bad_target")
    if ctype in ("navbar_uruvakku", "tabbar_uruvakku"):
        scr = (screen or (target.ancestors[0] if target and target.ancestors else None))
        scr_node = scr.node if hasattr(scr, "node") else scr
        if scr_node is not None and any(k.get("f") == ctype for k in scr_node.get("children", [])):
            raise DesignError(f"This screen already has a {ctype}.", "duplicate")


def _op_insert(program, lines, source, op):
    edits = Edits()
    screen = None if op.get("target_line") is not None else _first_screen(program, op.get("screen"))
    target = _target(program, op)
    _check_insert_place(op.get("type", ""), program, target, screen, op.get("position", "inside"))
    idx, indent = _insertion_point(program, target, screen, op.get("position", "inside"), edits)
    if op.get("type") == "navbar_uruvakku" and screen is not None:  # the top bar goes first (after screen_title)
        kids = [k for k in screen.node["children"] if k["t"] != "summa"]
        lead = [k for k in kids if k.get("f") == "screen_title"]
        if kids and lead and lead[-1] is not kids[-1]:
            idx = lead[-1]["end"]
        elif kids and not lead:
            idx = kids[0]["pos"][0] - 1
        elif lead:
            idx = lead[-1]["end"]
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


def _style_target(program, op) -> Loc:
    """A component or a screen: both can carry a style dict."""
    return _need_component(program, int(op["line"]))


def _set_style_key(node, key, raw, spec) -> None:
    if key not in spec["styles"]:
        raise DesignError(f"Unknown style '{key}'.", "unknown_style")
    groups = spec["screen_style_groups"] if is_screen(node) else spec["components"][node["f"]]["style_groups"]
    if key not in {k for g in groups for k in spec["style_groups"][g]}:
        raise DesignError(f"Style '{key}' does not apply to {'screens' if is_screen(node) else node['f']}.", "style_not_applicable")
    style = node["kw"].get("style")
    if style is None or style["t"] != "dict":
        if style is not None:
            raise DesignError("This component's style is not a plain {...} dictionary; edit it in the code.", "dynamic_style")
        style = {"t": "dict", "items": [], "pos": [0, 0]}
    items = list(style["items"])
    idx = next((i for i, (k, _) in enumerate(items) if k["t"] == "str" and k["v"] == key), None)
    val = _value_node(raw)
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


def _op_set_style(program, lines, source, op):
    node = _style_target(program, op).node
    _set_style_key(node, op.get("key"), op.get("value"), load_spec())
    return _replace_header(lines, node, header_text(node, _indent_of(node))), node["pos"][0]


def _op_set_styles(program, lines, source, op):
    """Applies several style changes at once ({"styles": {key: value|null}}); one edit, one undo step. null removes a key."""
    styles = op.get("styles")
    if not isinstance(styles, dict) or not styles or len(styles) > 30:
        raise DesignError("'styles' must be a dictionary of 1-30 style keys.", "bad_value")
    node = _style_target(program, op).node
    spec = load_spec()
    for key, raw in styles.items():
        _set_style_key(node, key, raw, spec)
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
        text = str(fn).strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", text):
            node["kw"][ev] = {"t": "name", "n": text, "pos": [0, 0]}
        else:  # a handler call with arguments, e.g. delete_item(i)
            expr = parse_expression(text)
            if expr["t"] != "call" or expr.get("kw"):
                raise DesignError("A handler is a function name or a call like delete_item(i).", "bad_name")
            node["kw"][ev] = expr
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


# --------------------------------------------------------------------------------------------------------------
# App-level edits (settings menu): app name/id/version/theme/start screen, global variables, screens.
# --------------------------------------------------------------------------------------------------------------
APP_KEYS = {"name": "app_uruvakku", "id": "app_id_set", "version": "app_version_set", "theme": "app_theme_set", "start_screen": "app_start_screen"}
_NAME_RE = r"[A-Za-z_][A-Za-z0-9_]*"


def _top(program, t, **match):
    return [n for n in program if n["t"] == t and all(n.get(k) == v for k, v in match.items())]


def _top_insert_index(program, prefer: tuple[str, ...]) -> int:
    """0-based line to insert a new top-level setting/variable: after the last statement of the preferred kinds, else before the first real statement."""
    last = None
    for n in program:
        if (n["t"] == "call_stmt" and "config" in prefer and n["f"] in APP_KEYS.values()) or (n["t"] == "let" and "let" in prefer):
            last = n
    if last is not None:
        return last["end"]
    first = program[0]["pos"][0] - 1 if program else 0
    return first


def _op_set_app(program, lines, source, op):
    key, value = op.get("key"), op.get("value")
    fn = APP_KEYS.get(key)
    if fn is None:
        raise DesignError(f"Unknown app setting '{key}'.", "bad_setting")
    existing = [n for n in program if n["t"] == "call_stmt" and n["f"] == fn]
    if value is None or value == "":
        if key == "name":
            raise DesignError("The app needs a name.", "bad_setting")
        for n in existing:
            del lines[n["pos"][0] - 1 : n["end"]]
        return lines, 1
    text = f"{fn}({unparse(literal_node(str(value)))})"
    if existing:
        n = existing[0]
        lines[n["pos"][0] - 1 : n["end"]] = [text]
        return lines, n["pos"][0]
    idx = _top_insert_index(program, ("config",))
    block = [text]
    if not any(n["t"] == "call_stmt" and n["f"] in APP_KEYS.values() for n in program):
        block.append("")  # first setting: separate it from the code below
    lines[idx:idx] = block
    return lines, idx + 1


def _global_named(program, name):
    found = _top(program, "let", n=name)
    if not found:
        raise DesignError(f"There is no global variable '{name}'.", "unknown_variable")
    return found[0]


def _op_add_global(program, lines, source, op):
    name = str(op.get("name", ""))
    if not re.fullmatch(_NAME_RE, name):
        raise DesignError("Variable names use letters, digits and underscores, starting with a letter.", "bad_name")
    if _top(program, "let", n=name):
        raise DesignError(f"Global '{name}' already exists.", "duplicate")
    expr = unparse(parse_expression(str(op.get("expr", "null")).strip() or "null"))
    idx = _top_insert_index(program, ("let",)) if _top(program, "let") else _top_insert_index(program, ("config",))
    block = [f"mari {name} = {expr}"]
    if not _top(program, "let"):
        block = [""] + block if program and idx > 0 else block + [""]
    lines[idx:idx] = block
    return lines, idx + len(block)


def _op_set_global(program, lines, source, op):
    n = _global_named(program, str(op.get("name", "")))
    expr = unparse(parse_expression(str(op.get("expr", "")).strip() or "null"))
    lines[n["pos"][0] - 1 : n["end"]] = [f"mari {n['n']} = {expr}"]
    return lines, n["pos"][0]


def _op_delete_global(program, lines, source, op):
    n = _global_named(program, str(op.get("name", "")))
    del lines[n["pos"][0] - 1 : n["end"]]
    return lines, 1


def _all_nodes(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from _all_nodes(v)
    elif isinstance(o, list):
        for v in o:
            yield from _all_nodes(v)


def _screen_refs(program, name):
    """String-literal references to a screen name: screen_ku_poo("x") / app_start_screen("x")."""
    return [a for n in _all_nodes(program) if n.get("t") in ("call_stmt", "call") and n.get("f") in ("screen_ku_poo", "app_start_screen")
            for a in n.get("args", [])[:1] if a.get("t") == "str" and a.get("v") == name]


def _screen_named(program, name):
    for n in program:
        if is_screen(n) and n["args"] and n["args"][0].get("v") == name:
            return n
    raise DesignError(f"There is no screen '{name}'.", "unknown_screen")


def _op_rename_screen(program, lines, source, op):
    old, new = str(op.get("name", "")), str(op.get("new_name", ""))
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,39}", new):
        raise DesignError("Screen names use letters, digits and underscores (max 40), starting with a letter.", "bad_name")
    node = _screen_named(program, old)
    if old != new and any(is_screen(n) and n["args"] and n["args"][0].get("v") == new for n in program):
        raise DesignError(f"Screen '{new}' already exists.", "duplicate")
    refs = [node["args"][0]] + _screen_refs(program, old)
    lit = unparse(literal_node(new))
    for a in sorted(refs, key=lambda x: (x["pos"][0], x["pos"][1]), reverse=True):  # right-to-left so columns stay valid
        ln, col = a["pos"][0] - 1, a["pos"][1] - 1
        text = lines[ln]
        q = text[col]
        end = text.index(q, col + 1)
        while text[end - 1] == "\\":
            end = text.index(q, end + 1)
        lines[ln] = text[:col] + lit + text[end + 1 :]
    return lines, node["pos"][0]


def _op_delete_screen(program, lines, source, op):
    name = str(op.get("name", ""))
    node = _screen_named(program, name)
    if sum(1 for n in program if is_screen(n)) == 1:
        raise DesignError("An app needs at least one screen.", "last_screen")
    refs = _screen_refs(program, name)
    if refs:
        raise DesignError(f"Screen '{name}' is still used by screen_ku_poo/app_start_screen on line {refs[0]['pos'][0]}. Change that first.", "screen_in_use")
    start = node["pos"][0] - 1
    end = node["end"]
    while end < len(lines) and not lines[end].strip():
        end += 1  # swallow the blank lines after it
    del lines[start:end]
    return lines, 1


# --------------------------------------------------------------------------------------------------------------
# Top bar / tab bar for the whole app (settings menu)
# --------------------------------------------------------------------------------------------------------------
def _screen_names(program) -> list[str]:
    return [n["args"][0]["v"] for n in program if is_screen(n) and n["args"] and n["args"][0]["t"] == "str"]


def _bar_of(screen: dict, f: str):
    return next((k for k in screen["children"] if k.get("f") == f), None)


def _bare_navbar_index(screen: dict) -> tuple[int, int]:
    """(0-based line, indent) for a new top bar: after screen_title, before everything else."""
    kids = [k for k in screen["children"] if k["t"] != "summa"]
    lead = [k for k in kids if k.get("f") == "screen_title"]
    indent = _indent_of(kids[0]) if kids else _indent_of(screen) + INDENT
    if lead:
        return lead[-1]["end"], indent
    return (kids[0]["pos"][0] - 1 if kids else screen["end"]), indent


def _op_navbar_all(program, lines, source, op):
    """Gives every screen (or `screens`) the same top bar settings. props/style are {key: {"literal": v} | null}; remove=true deletes the bars."""
    props, style = op.get("props") or {}, op.get("style") or {}
    only = op.get("screens")
    cur = source
    for name in _screen_names(program):
        if only and name not in only:
            continue
        prog = parse(cur)
        bar = _bar_of(_screen_named(prog, name), "navbar_uruvakku")
        if op.get("remove"):
            if bar:
                cur = apply_op(cur, {"kind": "delete", "line": bar["pos"][0]})["source"]
            continue
        if bar is None:
            if not any(v is not None for v in list(props.values()) + list(style.values())):
                continue  # nothing to set and no bar to edit
            scr = _screen_named(prog, name)
            idx, indent = _bare_navbar_index(scr)
            ls, _ = _split(cur)
            only_summa = len([k for k in scr["children"] if k["t"] != "summa"]) == 0 and scr["children"]
            if only_summa:  # a lone placeholder: replace it so the file stays tidy
                k = scr["children"][0]
                del ls[k["pos"][0] - 1 : k["end"]]
                idx = k["pos"][0] - 1
            ls[idx:idx] = [" " * indent + "navbar_uruvakku()"]
            cur = _join(ls)
            bar = _bar_of(_screen_named(parse(cur), name), "navbar_uruvakku")
        line = bar["pos"][0]
        for key, val in props.items():
            cur = apply_op(cur, {"kind": "set_prop", "line": line, "name": key, "value": val})["source"]
        if style:
            cur = apply_op(cur, {"kind": "set_styles", "line": line, "styles": style})["source"]
    return _split(cur)[0], 1


def _op_tabs_all(program, lines, source, op):
    """Replaces the bottom tab bar on the chosen screens (default: all) with `tabs` = [{label, icon, go}]. An empty list removes the tab bars."""
    tabs = op.get("tabs")
    if not isinstance(tabs, list) or len(tabs) > 5:
        raise DesignError("'tabs' must be a list of up to 5 tabs.", "bad_value")
    only = op.get("screens")
    cur = source
    for name in _screen_names(program):
        if only and name not in only:
            continue
        old = _bar_of(_screen_named(parse(cur), name), "tabbar_uruvakku")
        if old:
            cur = apply_op(cur, {"kind": "delete", "line": old["pos"][0]})["source"]
        if not tabs:
            continue
        prog = parse(cur)
        scr = _screen_named(prog, name)
        ls, _ = _split(cur)
        edits = Edits()
        idx, indent = _insertion_point(prog, None, Loc(scr, prog, None, []), "inside", edits)
        block = [" " * indent + "tabbar_uruvakku():"]
        for t in tabs:
            args = [unparse(literal_node(str(t.get("label", "Tab"))))]
            if t.get("icon"):
                args.append("icon=" + unparse(literal_node(str(t["icon"]))))
            if t.get("go"):
                args.append("go=" + unparse(literal_node(str(t["go"]))))
            block.append(" " * (indent + INDENT) + f"tab_item({', '.join(args)})")
        edits.insert(idx, block)
        cur = _join(edits.apply(ls))
    return _split(cur)[0], 1


def describe_app(source: str) -> dict:
    """What the settings menu shows: values written in the code (None = not set there) plus globals and screens."""
    try:
        program = parse(source)
    except SyntaxProblem as e:
        raise DesignError(f"Fix the syntax error first (line {e.diagnostic.line}).", "syntax") from None
    code = {}
    for key, fn in APP_KEYS.items():
        found = [n for n in program if n["t"] == "call_stmt" and n["f"] == fn and n["args"] and n["args"][0]["t"] == "str"]
        code[key] = found[0]["args"][0]["v"] if found else None
    return {
        "code": code,
        "globals": [{"name": n["n"], "expr": unparse(n["e"]), "line": n["pos"][0]} for n in program if n["t"] == "let"],
        "screens": [{"name": n["args"][0]["v"], "line": n["pos"][0], "used_by": len(_screen_refs(program, n["args"][0]["v"]))}
                    for n in program if is_screen(n) and n["args"] and n["args"][0]["t"] == "str"],
        "functions": [{"name": n["n"], "params": len(n["params"]), "line": n["pos"][0]} for n in program if n["t"] == "function"],
        "style": detect_style(source),
        "bars": {
            "navbar": [n["args"][0]["v"] for n in program if is_screen(n) and n["args"] and _bar_of(n, "navbar_uruvakku")],
            "tabbar": [n["args"][0]["v"] for n in program if is_screen(n) and n["args"] and _bar_of(n, "tabbar_uruvakku")],
        },
    }


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
