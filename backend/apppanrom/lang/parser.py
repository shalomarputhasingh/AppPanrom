"""Recursive-descent parser producing a plain-dict AST (see docs/language.md, "AST / IR")."""
from __future__ import annotations

from .diagnostics import SyntaxProblem
from .lexer import Token, tokenize

MAX_DEPTH = 40
COMPARE_OPS = {"==", "!=", "<", ">", "<=", ">="}


class Parser:
    def __init__(self, tokens: list[Token]):
        self.toks = tokens
        self.p = 0
        self.depth = 0

    # ---- helpers -------------------------------------------------------
    @property
    def cur(self) -> Token:
        return self.toks[self.p]

    def advance(self) -> Token:
        t = self.toks[self.p]
        self.p += 1
        return t

    def is_op(self, value: str) -> bool:
        return self.cur.kind == "OP" and self.cur.value == value

    def is_kw(self, value: str) -> bool:
        return self.cur.kind == "KEYWORD" and self.cur.value == value

    def err(self, message: str, tok: Token | None = None, suggestion: str | None = None, code: str = "syntax"):
        t = tok or self.cur
        raise SyntaxProblem(message, t.line, t.col, code, suggestion, end_col=t.end_col or None)

    def expect_op(self, value: str, hint: str | None = None) -> Token:
        if not self.is_op(value):
            self.err(f"Expected '{value}' but found {self.describe(self.cur)}.", suggestion=hint)
        return self.advance()

    def expect_name(self, what: str) -> Token:
        if self.cur.kind != "NAME":
            self.err(f"Expected {what} but found {self.describe(self.cur)}.")
        return self.advance()

    @staticmethod
    def describe(t: Token) -> str:
        if t.kind == "NEWLINE":
            return "end of line"
        if t.kind == "EOF":
            return "end of file"
        if t.kind in ("INDENT", "DEDENT"):
            return "indentation change"
        return repr(t.value)

    def pos(self, t: Token) -> list[int]:
        return [t.line, t.col]

    # ---- program / blocks ----------------------------------------------
    def parse_program(self) -> list[dict]:
        out = []
        while self.cur.kind != "EOF":
            if self.cur.kind == "NEWLINE":
                self.advance()
                continue
            if self.cur.kind == "INDENT":
                self.err("Unexpected indentation.", code="bad_indent")
            out.append(self.statement())
        return out

    def block(self) -> list[dict]:
        if self.cur.kind != "NEWLINE":
            self.err("Expected a new line after ':'.", suggestion="Put the block on the following indented lines.")
        self.advance()
        if self.cur.kind != "INDENT":
            self.err("Expected an indented block.", suggestion="Indent the block body by 4 spaces.", code="bad_indent")
        self.advance()
        body = []
        while self.cur.kind not in ("DEDENT", "EOF"):
            if self.cur.kind == "NEWLINE":
                self.advance()
                continue
            body.append(self.statement())
        if self.cur.kind == "DEDENT":
            self.advance()
        return body

    def end_of_statement(self):
        if self.cur.kind == "NEWLINE":
            self.advance()
        elif self.cur.kind not in ("EOF", "DEDENT"):
            self.err(f"Unexpected {self.describe(self.cur)} after the end of the statement.",
                     suggestion="Put one statement per line.")

    # ---- statements ----------------------------------------------------
    def statement(self) -> dict:
        self.depth += 1
        if self.depth > MAX_DEPTH:
            self.err("Code is nested too deeply.", code="too_deep")
        try:
            return self._statement()
        finally:
            self.depth -= 1

    def _statement(self) -> dict:
        t = self.cur
        pos = self.pos(t)
        if t.kind == "KEYWORD":
            kw = t.value
            if kw == "mari":
                self.advance()
                name = self.expect_name("a variable name after 'mari'")
                self.expect_op("=", "Declare variables like: mari count = 0")
                e = self.expr()
                self.end_of_statement()
                return {"t": "let", "n": name.value, "e": e, "pos": pos}
            if kw == "function":
                return self.function_def()
            if kw == "return":
                self.advance()
                e = None
                if self.cur.kind not in ("NEWLINE", "EOF", "DEDENT"):
                    e = self.expr()
                self.end_of_statement()
                return {"t": "return", "e": e, "pos": pos}
            if kw == "enna_na":
                return self.if_stmt()
            if kw in ("illana", "illana_enna"):
                self.err(f"'{kw}' without a matching 'enna_na'.", suggestion="Start with 'enna_na <condition>:' first.")
            if kw == "ovvoru":
                self.advance()
                var = self.expect_name("a loop variable name")
                if not self.is_kw("in"):
                    self.err("Expected 'in' in loop.", suggestion="Write: ovvoru item in items:")
                self.advance()
                it = self.expr()
                self.expect_op(":", "Loop headers end with ':'")
                return {"t": "for", "v": var.value, "iter": it, "body": self.block(), "pos": pos}
            if kw == "irukkura_varai":
                self.advance()
                cond = self.expr()
                self.expect_op(":", "Loop headers end with ':'")
                return {"t": "while", "cond": cond, "body": self.block(), "pos": pos}
            if kw == "try":
                self.advance()
                self.expect_op(":")
                body = self.block()
                if not self.is_kw("catch"):
                    self.err("'try' needs a matching 'catch'.", suggestion="Add: catch error:")
                self.advance()
                var = self.expect_name("a name for the error, e.g. 'catch error:'")
                self.expect_op(":")
                return {"t": "try", "body": body, "var": var.value, "handler": self.block(), "pos": pos}
            if kw == "catch":
                self.err("'catch' without a matching 'try'.")
        # expression / assignment / component statement
        e = self.expr()
        if self.is_op("="):
            if e["t"] not in ("name", "index"):
                self.err("Cannot assign to this expression.", suggestion="Assign to a variable or list/dict item.")
            self.advance()
            rhs = self.expr()
            self.end_of_statement()
            return {"t": "assign", "target": e, "e": rhs, "pos": pos}
        if self.is_op(":"):
            if e["t"] != "call":
                self.err("Only component calls can be followed by ':' and a block.")
            self.advance()
            e["children"] = self.block()
            e["t"] = "block_call"
            e["pos"] = pos
            return e
        self.end_of_statement()
        if e["t"] != "call":
            self.err("This statement does nothing.", t, "Use a function call, an assignment or 'mari name = value'.",
                     code="useless_statement")
        e["t"] = "call_stmt"
        e["pos"] = pos
        return e

    def function_def(self) -> dict:
        t = self.advance()
        name = self.expect_name("a function name")
        self.expect_op("(")
        params: list[str] = []
        while not self.is_op(")"):
            params.append(self.expect_name("a parameter name").value)
            if self.is_op(","):
                self.advance()
            elif not self.is_op(")"):
                self.err("Expected ',' or ')' in parameter list.")
        self.advance()
        self.expect_op(":", "Function headers end with ':'")
        return {"t": "function", "n": name.value, "params": params, "body": self.block(), "pos": self.pos(t)}

    def if_stmt(self) -> dict:
        t = self.cur
        branches = []
        else_body = None
        self.advance()
        cond = self.expr()
        self.expect_op(":", "Conditions end with ':'")
        branches.append({"cond": cond, "body": self.block()})
        while self.is_kw("illana_enna"):
            self.advance()
            cond = self.expr()
            self.expect_op(":")
            branches.append({"cond": cond, "body": self.block()})
        if self.is_kw("illana"):
            self.advance()
            self.expect_op(":")
            else_body = self.block()
        return {"t": "if", "branches": branches, "else": else_body, "pos": self.pos(t)}

    # ---- expressions ---------------------------------------------------
    def expr(self) -> dict:
        self.depth += 1
        if self.depth > MAX_DEPTH:
            self.err("Expression is nested too deeply.", code="too_deep")
        try:
            return self.or_expr()
        finally:
            self.depth -= 1

    def or_expr(self):
        left = self.and_expr()
        while self.is_kw("or"):
            t = self.advance()
            left = {"t": "bin", "op": "or", "l": left, "r": self.and_expr(), "pos": self.pos(t)}
        return left

    def and_expr(self):
        left = self.not_expr()
        while self.is_kw("and"):
            t = self.advance()
            left = {"t": "bin", "op": "and", "l": left, "r": self.not_expr(), "pos": self.pos(t)}
        return left

    def not_expr(self):
        if self.is_kw("not"):
            t = self.advance()
            return {"t": "un", "op": "not", "e": self.not_expr(), "pos": self.pos(t)}
        return self.compare()

    def compare(self):
        left = self.additive()
        if self.cur.kind == "OP" and self.cur.value in COMPARE_OPS:
            t = self.advance()
            left = {"t": "bin", "op": t.value, "l": left, "r": self.additive(), "pos": self.pos(t)}
            if self.cur.kind == "OP" and self.cur.value in COMPARE_OPS:
                self.err("Chained comparisons are not supported.", suggestion="Use 'and': a < b and b < c")
        return left

    def additive(self):
        left = self.term()
        while self.cur.kind == "OP" and self.cur.value in "+-":
            t = self.advance()
            left = {"t": "bin", "op": t.value, "l": left, "r": self.term(), "pos": self.pos(t)}
        return left

    def term(self):
        left = self.unary()
        while self.cur.kind == "OP" and self.cur.value in ("*", "/", "%"):
            t = self.advance()
            left = {"t": "bin", "op": t.value, "l": left, "r": self.unary(), "pos": self.pos(t)}
        return left

    def unary(self):
        if self.is_op("-"):
            t = self.advance()
            return {"t": "un", "op": "-", "e": self.unary(), "pos": self.pos(t)}
        return self.postfix()

    def postfix(self):
        e = self.atom()
        while True:
            if self.is_op("["):
                t = self.advance()
                idx = self.expr()
                self.expect_op("]")
                e = {"t": "index", "e": e, "i": idx, "pos": self.pos(t)}
            elif self.is_op("("):
                if e["t"] != "name":
                    self.err("Only named functions can be called.")
                e = self.call(e)
            else:
                return e

    def call(self, name_node: dict) -> dict:
        self.expect_op("(")
        args: list[dict] = []
        kw: dict[str, dict] = {}
        kw_pos: dict[str, list[int]] = {}
        while not self.is_op(")"):
            if self.cur.kind == "NAME" and self.toks[self.p + 1].kind == "OP" and self.toks[self.p + 1].value == "=":
                k = self.advance()
                self.advance()
                if k.value in kw:
                    self.err(f"Argument '{k.value}' given twice.", k)
                kw[k.value] = self.expr()
                kw_pos[k.value] = self.pos(k)
            else:
                if kw:
                    self.err("Positional argument after keyword argument.", suggestion="Put keyword arguments last.")
                args.append(self.expr())
            if self.is_op(","):
                self.advance()
            elif not self.is_op(")"):
                self.err(f"Expected ',' or ')' but found {self.describe(self.cur)}.")
        self.advance()
        return {"t": "call", "f": name_node["n"], "args": args, "kw": kw, "kw_pos": kw_pos, "pos": name_node["pos"]}

    def atom(self):
        t = self.cur
        pos = self.pos(t)
        if t.kind == "NUMBER":
            self.advance()
            return {"t": "num", "v": t.value, "pos": pos}
        if t.kind == "STRING":
            self.advance()
            return {"t": "str", "v": t.value, "pos": pos}
        if t.kind == "KEYWORD" and t.value in ("true", "false"):
            self.advance()
            return {"t": "bool", "v": t.value == "true", "pos": pos}
        if t.kind == "KEYWORD" and t.value == "null":
            self.advance()
            return {"t": "null", "pos": pos}
        if t.kind == "NAME":
            self.advance()
            return {"t": "name", "n": t.value, "pos": pos}
        if t.kind == "OP" and t.value == "(":
            self.advance()
            e = self.expr()
            self.expect_op(")")
            return e
        if t.kind == "OP" and t.value == "[":
            self.advance()
            items = []
            while not self.is_op("]"):
                items.append(self.expr())
                if self.is_op(","):
                    self.advance()
                elif not self.is_op("]"):
                    self.err(f"Expected ',' or ']' but found {self.describe(self.cur)}.")
            self.advance()
            return {"t": "list", "items": items, "pos": pos}
        if t.kind == "OP" and t.value == "{":
            self.advance()
            items = []
            while not self.is_op("}"):
                k = self.expr()
                self.expect_op(":", "Dictionary entries look like \"key\": value")
                items.append([k, self.expr()])
                if self.is_op(","):
                    self.advance()
                elif not self.is_op("}"):
                    self.err(f"Expected ',' or '}}' but found {self.describe(self.cur)}.")
            self.advance()
            return {"t": "dict", "items": items, "pos": pos}
        if t.kind == "KEYWORD":
            self.err(f"Unexpected keyword '{t.value}'.", suggestion="Keywords cannot be used as values or names.")
        self.err(f"Unexpected {self.describe(t)}.")


def parse(source: str) -> list[dict]:
    return Parser(tokenize(source)).parse_program()
