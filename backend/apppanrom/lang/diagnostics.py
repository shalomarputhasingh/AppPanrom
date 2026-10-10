from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class Diagnostic:
    severity: str  # "error" | "warning"
    code: str
    message: str
    line: int
    col: int
    file: str = "main.apn"
    end_col: int | None = None
    suggestion: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


class SyntaxProblem(Exception):
    """Raised by the lexer/parser at the first unrecoverable syntax error."""

    def __init__(self, message: str, line: int, col: int, code: str = "syntax", suggestion: str | None = None,
                 end_col: int | None = None):
        super().__init__(message)
        self.diagnostic = Diagnostic("error", code, message, line, col, end_col=end_col, suggestion=suggestion)
