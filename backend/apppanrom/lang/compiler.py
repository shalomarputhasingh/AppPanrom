"""Semantic validation and lowering of the AST into the AppPanrom IR."""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

from .diagnostics import Diagnostic, SyntaxProblem
from .parser import parse
from .spec import load_spec

IR_VERSION = 1
APP_ID_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
VERSION_RE = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}$")
HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
JAVA_KEYWORDS = {
    "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue",
    "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "goto", "if",
    "implements", "import", "instanceof", "int", "interface", "long", "native", "new", "package", "private",
    "protected", "public", "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this",
    "throw", "throws", "transient", "try", "void", "volatile", "while", "true", "false", "null",
}
SIZE_RE = re.compile(r"^(\d{1,3}%|fill)$")


@dataclass
class CompileResult:
    ok: bool
    diagnostics: list[Diagnostic]
    ir: dict | None = None

    def to_dict(self) -> dict:
        return {"ok": self.ok, "diagnostics": [d.to_dict() for d in self.diagnostics], "ir": self.ir}


def validate_app_id(value: str) -> str | None:
    if len(value) > 100 or not APP_ID_RE.fullmatch(value):
        return "Use lowercase letters, digits and underscores in dot-separated parts, e.g. com.example.myapp."
    if any(p in JAVA_KEYWORDS for p in value.split(".")):
        return "A part of the application id is a reserved Java keyword."
    return None


def validate_version(value: str) -> str | None:
    return None if VERSION_RE.fullmatch(value) else "Use MAJOR.MINOR.PATCH, e.g. 1.0.0."


def literal_type(node: dict) -> str | None:
    t = node["t"]
    if t in ("num", "str", "bool", "list", "dict", "null"):
        return t
    return None


class Compiler:
    def __init__(self, defaults: dict | None):
        self.spec = load_spec()
        self.defaults = defaults or {}
        self.diags: list[Diagnostic] = []
        self.functions: dict[str, dict] = {}
        self.globals: set[str] = set()
        self.screens: dict[str, dict] = {}
        self.input_names: set[str] = set()
        self.used_input_names: list[tuple[str, list[int]]] = []
        self.nav_targets: list[tuple[str, list[int]]] = []
        self.config: dict[str, str] = {}
        self.used_permission_sources: dict[str, set[str]] = {}

    # ---- diagnostics -----------------------------------------------------
    def error(self, node_or_pos, message: str, code: str, suggestion: str | None = None):
        self._add("error", node_or_pos, message, code, suggestion)

    def warn(self, node_or_pos, message: str, code: str, suggestion: str | None = None):
        self._add("warning", node_or_pos, message, code, suggestion)

    def _add(self, sev, node_or_pos, message, code, suggestion):
        pos = node_or_pos["pos"] if isinstance(node_or_pos, dict) else node_or_pos
        self.diags.append(Diagnostic(sev, code, message, pos[0], pos[1], suggestion=suggestion))

    def suggest(self, name: str, pool) -> str | None:
        close = difflib.get_close_matches(name, list(pool), n=1, cutoff=0.6)
        return f"Did you mean '{close[0]}'?" if close else None

    def _note_use(self, name: str):
        perm = self.spec.get("permissions", {}).get(name)
        if perm:
            self.used_permission_sources.setdefault(perm["android"], set()).add(name)

    def _permissions(self) -> list[dict]:
        reasons = {v["android"]: v["reason"] for v in self.spec.get("permissions", {}).values()}
        return [{"permission": p, "reason": reasons[p], "used_by": sorted(u)} for p, u in sorted(self.used_permission_sources.items())]

    # ---- top level ---------------------------------------------------------
    def compile(self, source: str) -> CompileResult:
        try:
            program = parse(source)
        except SyntaxProblem as e:
            return CompileResult(False, [e.diagnostic])

        for st in program:  # pass 1: declarations
            t = st["t"]
            if t == "function":
                if st["n"] in self.functions:
                    self.error(st, f"Function '{st['n']}' is already defined.", "duplicate_function")
                elif st["n"] in self.spec["functions"] or st["n"] in self.spec["components"]:
                    self.error(st, f"'{st['n']}' is a built-in name and cannot be redefined.", "reserved_name")
                else:
                    self.functions[st["n"]] = st
            elif t == "block_call" and st["f"] == "screen_uruvakku":
                name = self._screen_name(st)
                if name is not None:
                    if name in self.screens:
                        self.error(st, f"Screen '{name}' is declared more than once.", "duplicate_screen")
                    else:
                        self.screens[name] = st

        ir_globals: list[dict] = []
        ir_screens: dict[str, dict] = {}
        for st in program:  # pass 2: bodies
            t = st["t"]
            if t == "call_stmt" and st["f"] in self.spec["config_functions"]:
                self._config(st)
            elif t == "let":
                e = self._expr(st["e"], self.globals, None)
                if st["n"] in self.globals:
                    self.error(st, f"Variable '{st['n']}' is already declared.", "duplicate_variable")
                self.globals.add(st["n"])
                ir_globals.append({"t": "let", "n": st["n"], "e": e, "pos": st["pos"]})
            elif t == "function":
                pass
            elif t == "block_call" and st["f"] == "screen_uruvakku":
                pass
            else:
                self.error(st, "This is not allowed at the top level of a program.", "top_level",
                           "Top level may contain: app_* settings, 'mari' variables, functions and screen_uruvakku(...) blocks.")

        ir_functions = {}
        for name, fn in self.functions.items():
            scope = set(fn["params"])
            if len(scope) != len(fn["params"]):
                self.error(fn, f"Function '{name}' has duplicate parameter names.", "duplicate_param")
            body = self._body(fn["body"], scope, "function")
            ir_functions[name] = {"params": fn["params"], "body": body, "pos": fn["pos"]}
        for name, sc in self.screens.items():
            style = self._screen_style(sc)
            body = self._body(sc["children"], set(), "screen")
            ir_screens[name] = {"style": style, "body": body, "pos": sc["pos"]}

        if not self.screens:
            self.error([1, 1], "The app has no screens.", "no_screens",
                       'Add one: screen_uruvakku("home"):  (then indent the components under it)')
        for target, pos in self.nav_targets:
            if target not in self.screens:
                self.error(pos, f"Navigation target screen '{target}' does not exist.", "unknown_screen",
                           self.suggest(target, self.screens))
        for name, pos in self.used_input_names:
            if name not in self.input_names:
                self.warn(pos, f"No input component named '{name}' is declared.", "unknown_input",
                          self.suggest(name, self.input_names))

        app = self._app_meta()
        errors = [d for d in self.diags if d.severity == "error"]
        self.diags.sort(key=lambda d: (d.line, d.col))
        if errors:
            return CompileResult(False, self.diags)
        ir = {
            "ir_version": IR_VERSION,
            "app": app,
            "style_schema": self.spec["styles"],
            "permissions": self._permissions(),
            "globals": ir_globals,
            "functions": ir_functions,
            "screens": ir_screens,
            "screen_order": list(self.screens),
        }
        return CompileResult(True, self.diags, ir)

    # ---- app config ----------------------------------------------------------
    def _screen_name(self, st: dict) -> str | None:
        if len(st["args"]) != 1 or st["args"][0]["t"] != "str" or set(st["kw"]) - {"style"}:
            self.error(st, "screen_uruvakku needs one text name, e.g. screen_uruvakku(\"home\"):", "bad_screen")
            return None
        name = st["args"][0]["v"]
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,39}", name):
            self.error(st["args"][0], "Screen names use letters, digits and underscores (max 40), starting with a letter.", "bad_screen_name")
            return None
        return name

    def _config(self, st: dict):
        name = st["f"]
        if len(st["args"]) != 1 or st["kw"] or st["args"][0]["t"] != "str":
            self.error(st, f"{name} expects exactly one text value.", "bad_config", self.spec["config_functions"][name]["doc"])
            return
        if name in self.config:
            self.warn(st, f"{name} is set more than once; the last value wins.", "duplicate_config")
        self.config[name] = st["args"][0]["v"]

    def _app_meta(self) -> dict:
        d = self.defaults
        app = {
            "name": self.config.get("app_uruvakku") or d.get("name") or "My App",
            "id": self.config.get("app_id_set") or d.get("app_id") or "com.apppanrom.myapp",
            "version": self.config.get("app_version_set") or d.get("version") or "1.0.0",
            "theme": self.config.get("app_theme_set") or d.get("theme") or "light",
            "start_screen": self.config.get("app_start_screen") or (next(iter(self.screens), None)),
        }
        if not app["name"].strip() or len(app["name"]) > 60:
            self.error([1, 1], "App name must be 1-60 characters.", "bad_app_name")
        msg = validate_app_id(app["id"])
        if msg:
            self.error([1, 1], f"Invalid application id '{app['id']}'. {msg}", "bad_app_id")
        msg = validate_version(app["version"])
        if msg:
            self.error([1, 1], f"Invalid version '{app['version']}'. {msg}", "bad_version")
        if app["theme"] not in self.spec["themes"]:
            self.error([1, 1], f"Unknown theme '{app['theme']}'. Supported: {', '.join(self.spec['themes'])}.", "bad_theme")
        if app["start_screen"] is not None and app["start_screen"] not in self.screens:
            self.error([1, 1], f"Start screen '{app['start_screen']}' does not exist.", "unknown_screen",
                       self.suggest(app["start_screen"], self.screens))
        return app

    # ---- statements --------------------------------------------------------------
    def _body(self, stmts: list[dict], scope: set[str], ctx: str) -> list[dict]:
        return [n for n in (self._stmt(s, scope, ctx) for s in stmts) if n is not None]

    def _stmt(self, st: dict, scope: set[str], ctx: str) -> dict | None:
        t = st["t"]
        if t == "summa":
            return {"t": "summa", "pos": st["pos"]}
        if t == "let":
            e = self._expr(st["e"], scope, ctx)
            if st["n"] in scope:
                self.error(st, f"Variable '{st['n']}' is already declared here.", "duplicate_variable",
                           f"Change its value with: {st['n']} = ...")
            scope.add(st["n"])
            return {"t": "let", "n": st["n"], "e": e, "pos": st["pos"]}
        if t == "assign":
            target = st["target"]
            base = target
            while base["t"] == "index":
                base = base["e"]
            if base["t"] != "name":
                self.error(st, "Cannot assign to this expression.", "bad_assign")
            else:
                if base["n"] not in scope and base["n"] not in self.globals:
                    self.error(base, f"Variable '{base['n']}' is not declared.", "undefined_variable",
                               self.suggest(base["n"], scope | self.globals) or f"Declare it first: mari {base['n']} = ...")
                elif ctx == "screen" and base["n"] not in scope:
                    self.error(base, f"Screens cannot change global '{base['n']}' while drawing; change it inside a button handler function.",
                               "render_mutation")
            return {"t": "assign", "target": self._target(target, scope, ctx), "e": self._expr(st["e"], scope, ctx), "pos": st["pos"]}
        if t == "if":
            branches = [{"cond": self._expr(b["cond"], scope, ctx), "body": self._body(b["body"], scope, ctx)} for b in st["branches"]]
            els = self._body(st["else"], scope, ctx) if st["else"] is not None else None
            return {"t": "if", "branches": branches, "else": els, "pos": st["pos"]}
        if t == "for":
            it = self._expr(st["iter"], scope, ctx)
            scope.add(st["v"])
            return {"t": "for", "v": st["v"], "iter": it, "body": self._body(st["body"], scope, ctx), "pos": st["pos"]}
        if t == "while":
            return {"t": "while", "cond": self._expr(st["cond"], scope, ctx), "body": self._body(st["body"], scope, ctx), "pos": st["pos"]}
        if t == "return":
            if ctx != "function":
                self.error(st, "'return' can only be used inside a function.", "return_outside")
            return {"t": "return", "e": self._expr(st["e"], scope, ctx) if st["e"] else None, "pos": st["pos"]}
        if t == "try":
            body = self._body(st["body"], scope, ctx)
            scope.add(st["var"])
            return {"t": "try", "body": body, "var": st["var"], "handler": self._body(st["handler"], scope, ctx), "pos": st["pos"]}
        if t == "function":
            self.error(st, "Functions can only be defined at the top level.", "nested_function")
            return None
        if t in ("call_stmt", "block_call"):
            return self._call_stmt(st, scope, ctx)
        self.error(st, "Unsupported statement.", "unsupported")
        return None

    def _target(self, target: dict, scope: set[str], ctx: str) -> dict:
        """Lower an assignment target; the base variable was already checked by the caller."""
        if target["t"] == "index":
            return {**target, "e": self._target(target["e"], scope, ctx), "i": self._expr(target["i"], scope, ctx)}
        return target

    def _call_stmt(self, st: dict, scope: set[str], ctx: str) -> dict | None:
        name = st["f"]
        comps = self.spec["components"]
        if name == "screen_uruvakku":
            self.error(st, "Screens can only be declared at the top level.", "nested_screen")
            return None
        if name in self.spec["config_functions"]:
            self.error(st, f"{name} can only be used at the top level.", "config_placement")
            return None
        if name == "screen_title":
            if ctx != "screen":
                self.error(st, "screen_title can only be used inside a screen block.", "component_placement")
                return None
            self._arity(st, 1, 1)
            self._no_kw(st)
            return {"t": "screen_title", "e": self._expr(st["args"][0], scope, ctx) if st["args"] else {"t": "str", "v": ""}, "pos": st["pos"]}
        if name in comps:
            if ctx != "screen":
                self.error(st, f"'{name}' draws UI and can only be used inside a screen block.", "component_placement",
                           "Inside a function, use message_kaattu(...) or toast_kaattu(...) to show feedback." if name == "text_kaattu" else None)
                return None
            return self._component(st, scope, comps[name])
        if st["t"] == "block_call":
            self.error(st, f"'{name}' cannot have an indented block.", "no_block",
                       "Only container components (column_uruvakku, row_uruvakku, card_uruvakku, center_ama) take a block.")
            return None
        node = self._call_expr(st, scope, ctx)
        node["t"] = "call_stmt"
        return node

    # ---- components -----------------------------------------------------------------
    def _component(self, st: dict, scope: set[str], spec: dict) -> dict:
        name = st["f"]
        self._note_use(name)
        if st["t"] == "block_call" and not spec["container"]:
            self.error(st, f"'{name}' cannot contain other components.", "no_block")
        if st["t"] == "call_stmt" and spec["container"]:
            self.error(st, f"'{name}' needs an indented block of children after ':'.", "needs_block",
                       f"Write: {name}(...):  then indent the children.")
        pos_spec = spec["positional"]
        if len(st["args"]) > len(pos_spec):
            self.error(st, f"{name} takes at most {len(pos_spec)} positional argument(s); use name=value for options.", "too_many_args", spec["doc"])
        props: dict[str, dict] = {}
        for i, a in enumerate(st["args"][: len(pos_spec)]):
            props[pos_spec[i]["name"]] = self._typed(a, pos_spec[i]["type"], scope, f"{name} argument '{pos_spec[i]['name']}'")
        for p in pos_spec[len(st["args"]):]:
            if p["required"] and p["name"] not in st["kw"]:
                self.error(st, f"{name} is missing required argument '{p['name']}'.", "missing_arg", spec["doc"])
        events: dict[str, str] = {}
        style = None
        for k, v in st["kw"].items():
            kpos = st["kw_pos"][k]
            if k == "style":
                style = self._style(v, spec["style_groups"], scope, name)
            elif k in spec["events"]:
                events[k] = self._handler(v, k)
            elif k in spec["kwargs"]:
                props[k] = self._typed(v, spec["kwargs"][k], scope, f"{name} option '{k}'")
            elif k in [p["name"] for p in pos_spec]:
                props[k] = self._typed(v, next(p["type"] for p in pos_spec if p["name"] == k), scope, f"{name} argument '{k}'")
            else:
                known = list(spec["kwargs"]) + spec["events"] + ["style"]
                self.error(kpos, f"{name} has no option '{k}'.", "unknown_option", self.suggest(k, known) or f"Options: {', '.join(known)}")
        if "name" in props and spec.get("input"):
            node = props["name"]
            if node["t"] == "str":
                self.input_names.add(node["v"])
            else:
                self.error(node, f"{name} needs a fixed text name (a quoted string).", "bad_input_name")
        children = self._body(st.get("children") or [], scope, "screen") if spec["container"] else None
        out = {"t": "comp", "c": name, "props": props, "events": events, "style": style, "pos": st["pos"]}
        if children is not None:
            out["children"] = children
        return out

    def _handler(self, node: dict, event: str) -> str:
        if node["t"] != "name":
            self.error(node, f"{event} must be the name of a function, e.g. {event}=welcome (no quotes, no parentheses).", "bad_handler")
            return ""
        fn = self.functions.get(node["n"])
        if fn is None:
            self.error(node, f"Handler function '{node['n']}' is not defined.", "undefined_handler",
                       self.suggest(node["n"], self.functions) or f"Define it: function {node['n']}():")
        elif fn["params"]:
            self.error(node, f"Handler '{node['n']}' must take no parameters.", "handler_params")
        return node["n"]

    def _typed(self, node: dict, expected: str, scope: set[str], what: str) -> dict:
        out = self._expr(node, scope, "screen")
        lt = literal_type(node)
        if lt and expected not in ("any", lt) and not (expected == "num" and lt == "num"):
            self.error(node, f"{what} must be {self._tname(expected)}, not {self._tname(lt)}.", "type_mismatch")
        return out

    @staticmethod
    def _tname(t: str) -> str:
        return {"str": "text", "num": "a number", "bool": "true/false", "list": "a list", "dict": "a dictionary",
                "null": "null", "any": "any value"}.get(t, t)

    # ---- styles ------------------------------------------------------------------------
    def _allowed_style_keys(self, groups: list[str]) -> set[str]:
        sg = self.spec["style_groups"]
        return {k for g in groups for k in sg[g]}

    def _screen_style(self, sc: dict) -> dict | None:
        node = sc["kw"].get("style")
        return self._style(node, self.spec["screen_style_groups"], set(), "screen") if node else None

    def _style(self, node: dict, groups: list[str], scope: set[str], comp: str) -> dict | None:
        if node["t"] != "dict":
            self.error(node, 'style must be a dictionary literal, e.g. style={"padding": 16}.', "bad_style")
            return None
        allowed = self._allowed_style_keys(groups)
        defs = self.spec["styles"]
        items = []
        for k, v in node["items"]:
            if k["t"] != "str":
                self.error(k, "Style keys must be quoted text.", "bad_style_key")
                continue
            key = k["v"]
            if key in self.spec["unsupported_styles"]:
                self.error(k, f"Style '{key}' is not supported yet.", "unsupported_style")
            elif key not in defs:
                self.error(k, f"Unknown style '{key}'.", "unknown_style", self.suggest(key, defs))
            elif key not in allowed:
                self.error(k, f"Style '{key}' does not apply to {comp}.", "style_not_applicable")
            else:
                self._style_value(key, defs[key], v)
            items.append([k, self._expr(v, scope, "screen")])
        return {"t": "dict", "items": items, "pos": node["pos"]}

    def _style_value(self, key: str, d: dict, v: dict):
        lt = literal_type(v)
        if lt is None:
            return  # dynamic value: validated again by the runtime
        typ = d["type"]
        ok = True
        if typ == "color":
            ok = lt == "str" and bool(HEX_RE.fullmatch(v["v"]))
            hint = 'Use a hex color like "#2563EB" or "#FFF".'
        elif typ == "number":
            ok = lt == "num" and d["min"] <= v["v"] <= d["max"]
            hint = f"Use a number from {d['min']} to {d['max']}."
        elif typ == "size":
            ok = (lt == "num" and 0 <= v["v"] <= 2000) or (lt == "str" and bool(SIZE_RE.fullmatch(v["v"])))
            hint = 'Use a number, a percentage like "100%", or "fill".'
        elif typ == "enum":
            ok = lt == "str" and v["v"] in d["values"]
            hint = f"Allowed: {', '.join(d['values'])}."
        else:  # bool
            ok = lt == "bool"
            hint = "Use true or false."
        if not ok:
            self.error(v, f"Invalid value for style '{key}'.", "bad_style_value", hint)

    # ---- expressions ------------------------------------------------------------------------
    def _expr(self, e: dict, scope: set[str], ctx: str | None) -> dict:
        t = e["t"]
        if t in ("num", "str", "bool", "null"):
            return e
        if t == "name":
            n = e["n"]
            if n in scope or n in self.globals:
                return e
            if n in self.functions:
                self.error(e, f"'{n}' is a function; call it with {n}(...).", "function_as_value")
            elif n in self.spec["components"] or n in self.spec["functions"]:
                self.error(e, f"'{n}' is a built-in function; call it with {n}(...).", "function_as_value")
            else:
                self.error(e, f"Variable '{n}' is not declared.", "undefined_variable",
                           self.suggest(n, scope | self.globals) or f"Declare it first: mari {n} = ...")
            return e
        if t == "list":
            return {**e, "items": [self._expr(i, scope, ctx) for i in e["items"]]}
        if t == "dict":
            return {**e, "items": [[self._expr(k, scope, ctx), self._expr(v, scope, ctx)] for k, v in e["items"]]}
        if t == "bin":
            lt, rt = literal_type(e["l"]), literal_type(e["r"])
            l, r = self._expr(e["l"], scope, ctx), self._expr(e["r"], scope, ctx)
            if lt and rt and e["op"] in ("+", "-", "*", "/", "%") and lt != rt and "null" not in (lt, rt):
                self.error(e, f"Cannot use '{e['op']}' between {self._tname(lt)} and {self._tname(rt)}.", "type_mismatch",
                           "Convert with str(...) or int(...) first." if "str" in (lt, rt) else None)
            return {**e, "l": l, "r": r}
        if t == "un":
            return {**e, "e": self._expr(e["e"], scope, ctx)}
        if t == "index":
            return {**e, "e": self._expr(e["e"], scope, ctx), "i": self._expr(e["i"], scope, ctx)}
        if t == "call":
            return self._call_expr(e, scope, ctx)
        self.error(e, "Unsupported expression.", "unsupported")
        return e

    def _call_expr(self, e: dict, scope: set[str], ctx: str | None) -> dict:
        name = e["f"]
        args = [self._expr(a, scope, ctx) for a in e["args"]]
        out = {"t": "call", "f": name, "args": args, "pos": e["pos"]}
        if e["kw"]:
            self.error(list(e["kw_pos"].values())[0], f"{name}(...) does not take keyword arguments.", "no_keyword_args")
        if name in self.functions:
            n = len(self.functions[name]["params"])
            if len(args) != n:
                self.error(e, f"Function '{name}' expects {n} argument(s) but got {len(args)}.", "arity")
            return out
        fs = self.spec["functions"].get(name)
        if fs is not None:
            self._note_use(name)
            self._arity(e, fs["min"], fs["max"], fs["doc"])
            for i, (a, want) in enumerate(zip(e["args"], fs.get("arg_types", []))):
                lt = literal_type(a)
                if lt and want != "any" and lt != want:
                    self.error(a, f"{name} argument {i + 1} must be {self._tname(want)}, not {self._tname(lt)}.", "type_mismatch")
            if name == "screen_ku_poo" and args and args[0]["t"] == "str":
                self.nav_targets.append((args[0]["v"], e["pos"]))
            if name in ("input_value", "input_set") and args and args[0]["t"] == "str":
                self.used_input_names.append((args[0]["v"], args[0]["pos"]))
            return out
        if name in self.spec["components"] or name in self.spec["screen_functions"]:
            self.error(e, f"'{name}' draws UI and can only be used as a statement inside a screen block.", "component_placement")
        elif name in self.spec["config_functions"] or name == "screen_uruvakku":
            self.error(e, f"'{name}' can only be used as a top-level statement.", "config_placement")
        elif name in self.spec["not_implemented"]:
            self.error(e, f"'{name}' is planned but not implemented yet.", "not_implemented")
        else:
            pool = list(self.functions) + list(self.spec["functions"]) + list(self.spec["components"])
            self.error(e, f"Unknown function '{name}'.", "unknown_function", self.suggest(name, pool))
        return out

    def _arity(self, e: dict, lo: int, hi: int, doc: str | None = None):
        n = len(e["args"])
        if n < lo or n > hi:
            want = str(lo) if lo == hi else f"{lo}-{hi}"
            self.error(e, f"{e['f']} expects {want} argument(s) but got {n}.", "arity", doc)

    def _no_kw(self, e: dict):
        if e["kw"]:
            self.error(list(e["kw_pos"].values())[0], f"{e['f']}(...) does not take keyword arguments.", "no_keyword_args")


def compile_source(source: str, defaults: dict | None = None) -> CompileResult:
    """Parse + validate + lower to IR. `defaults` supplies project metadata used when the source omits app_* calls."""
    return Compiler(defaults).compile(source)
