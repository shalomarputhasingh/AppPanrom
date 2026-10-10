from __future__ import annotations

from dataclasses import asdict, dataclass

# A friendly Tanglish lead-in per diagnostic code (shown by the Studio next to the precise English message).
TANGLISH = {
    "syntax": "Aiyayo, syntax thappa irukku da.",
    "bad_indent": "Machan, indent 4 space-a irukkanum.",
    "tab_indent": "Tab vendam nanba, 4 space podu.",
    "curly_quote": "Kootu-quote (smart quote) vendam; simple \" podu.",
    "unclosed_string": "String-a moodala nanba, kadaisila quote podu.",
    "unclosed_bracket": "Bracket moodala da, onnu miss aayiduchu.",
    "unmatched_bracket": "Bracket jodi illa, extra onnu irukku.",
    "unknown_function": "Indha function enakku theriyaadhu nanba.",
    "undefined_variable": "Indha variable-a nee mari-la solla-ve illa.",
    "duplicate_variable": "Idhe peru-la already variable irukku da.",
    "type_mismatch": "Text-um number-um kalakka koodaadhu, str(...) use pannu.",
    "arity": "Argument ennikkai sariya illa.",
    "too_many_args": "Romba argument kuduthuttey da.",
    "missing_arg": "Oru argument miss aayiduchu.",
    "unknown_screen": "Appadi oru screen illa nanba.",
    "unknown_option": "Indha option-a indha component edukkaadhu.",
    "unknown_style": "Indha style peru theriyala.",
    "bad_style_value": "Style value sariya illa da, range/format paaru.",
    "style_not_applicable": "Indha style indha component-ku set aagaadhu.",
    "undefined_handler": "Indha handler function-a engeyum kaanom.",
    "bad_handler": "Handler function-ku parameter irukka koodaadhu.",
    "render_mutation": "Screen varaiyum bodhu state-a maathaadha, button handler-la maathu.",
    "unsupported": "Idhu innum namma language-la illa nanba.",
    "unsupported_style": "Indha style innum illa.",
    "no_screens": "Oru screen kooda illa, screen_uruvakku podu.",
    "return_outside": "Return function-ukku ulla mattum thaan.",
    "reserved_name": "Idhu reserved peru, vera peru vechuko.",
    "bad_app_id": "App id sariya illa (com.peru.app maadhiri irukkanum).",
    "bad_version": "Version 1.0.0 maadhiri irukkanum.",
    "useless_statement": "Indha line edhuvum seyyaadhu.",
}


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
    ta: str | None = None  # Tanglish lead-in

    def __post_init__(self) -> None:
        if self.ta is None:
            self.ta = TANGLISH.get(self.code)

    def to_dict(self) -> dict:
        return asdict(self)


class SyntaxProblem(Exception):
    """Raised by the lexer/parser at the first unrecoverable syntax error."""

    def __init__(self, message: str, line: int, col: int, code: str = "syntax", suggestion: str | None = None,
                 end_col: int | None = None):
        super().__init__(message)
        self.diagnostic = Diagnostic("error", code, message, line, col, end_col=end_col, suggestion=suggestion)
