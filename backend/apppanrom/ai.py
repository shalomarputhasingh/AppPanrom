"""AI coding assistant for the Studio, backed by Groq's OpenAI-compatible API (default model: openai/gpt-oss-120b).

Design rules
* The API key comes from the environment (GROQ_API_KEY) or is pasted into the Studio for the lifetime of the server process.
  It is never written to disk or the database, never returned by any endpoint, and scrubbed from every error message.
* The host is fixed (api.groq.com). A different base URL can be configured with APPANROM_AI_BASE_URL, but only https, or http to
  the local machine (used by the tests); user text can never choose where requests go.
* The model is taught the real language. Whatever code it returns is compiled by *our* compiler; if there are errors they are fed
  back to the model for up to two repair rounds, so the user sees validated code.

Free-tier survival (Groq free plan: ~30 requests/min, ~8,000 tokens/min, daily caps)
* Requests are sized to fit the per-minute token budget: a compact language cheat-sheet, history trimmed, and the user's code
  trimmed to the parts that matter. Big files are changed with small SEARCH/REPLACE edits instead of whole-file rewrites.
* Groq's rate-limit headers are tracked per model. Before a request we know if it would be rejected; short waits (a few seconds)
  happen invisibly on the server, longer ones are reported to the Studio as a countdown so it can wait and retry by itself.
* A daily limit is recognised and reported with the time it resets (the Studio never sits and waits for hours).
* Optionally, when a model is limited the request can go to a backup model (limits are per model) - only if the user asks for it.
"""
from __future__ import annotations

import json
import math
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlparse

from .lang.spec import REPO_ROOT, load_spec
from .lang.tanglish import detect_style

DEFAULT_MODEL = "openai/gpt-oss-120b"
DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_FALLBACKS = ("openai/gpt-oss-20b",)
MAX_REPAIRS = 2
KEY_RE = re.compile(r"[A-Za-z0-9_\-]{16,256}")
CHARS_PER_TOKEN = 3.0          # AppPanrom code is symbol-heavy; be conservative so we never under-estimate


def est_tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN)


# ------------------------------------------------------------------------------------------------ errors

class AiError(Exception):
    def __init__(self, code: str, message: str, status: int = 502, details: dict | None = None):
        super().__init__(message)
        self.code, self.message, self.status, self.details = code, message, status, details


class AiRateLimited(AiError):
    """The model's limit is used up. `retry_after_s` says how long until it is worth asking again; `scope` is "minute" or "day"."""

    def __init__(self, model: str, retry_after_s: float, scope: str, fallback_possible: bool = False):
        secs = max(1, math.ceil(retry_after_s))
        when = _human(secs)
        msg = (f"Groq's {'daily' if scope == 'day' else 'per-minute'} limit for {model.split('/')[-1]} is used up. It resets in about {when}."
               + (" You can switch to the backup model in the AI panel." if fallback_possible else ""))
        super().__init__("ai_rate_limited", msg, 429, {"retry_after_s": secs, "scope": scope, "model": model, "fallback_possible": fallback_possible})
        self.retry_after_s, self.scope, self.model = secs, scope, model


def _human(seconds: int) -> str:
    if seconds < 90:
        return f"{seconds} s"
    if seconds < 5400:
        return f"{round(seconds / 60)} min"
    return f"{seconds // 3600} h {round((seconds % 3600) / 60)} min"


_DUR = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)")


def parse_duration(text: str | None) -> float | None:
    """Groq style durations: '7.66s', '2m59.56s', '1h2m3s', '800ms', or plain seconds '2'."""
    if text is None:
        return None
    text = str(text).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        pass
    parts = _DUR.findall(text)
    if not parts:
        return None
    unit = {"h": 3600.0, "m": 60.0, "s": 1.0, "ms": 0.001}
    return sum(float(n) * unit[u] for n, u in parts)


# ------------------------------------------------------------------------------------------------ rate-limit tracking

@dataclass
class _ModelLimits:
    tokens_remaining: int | None = None
    tokens_reset_at: float = 0.0
    requests_remaining: int | None = None
    requests_reset_at: float = 0.0
    blocked_until: float = 0.0
    blocked_scope: str = "minute"


class RateState:
    """What we know about each model's limits, learned from Groq's response headers. Thread-safe."""

    def __init__(self, now: Callable[[], float]):
        self._now, self._m, self._lock = now, {}, threading.Lock()

    def _get(self, model: str) -> _ModelLimits:
        return self._m.setdefault(model, _ModelLimits())

    def observe(self, model: str, headers) -> None:
        now = self._now()
        with self._lock:
            m = self._get(model)
            def num(name):
                try:
                    return int(float(headers.get(name)))
                except (TypeError, ValueError):
                    return None
            tr, rr = num("x-ratelimit-remaining-tokens"), num("x-ratelimit-remaining-requests")
            if tr is not None:
                m.tokens_remaining = tr
                m.tokens_reset_at = now + (parse_duration(headers.get("x-ratelimit-reset-tokens")) or 0.0)
            if rr is not None:
                m.requests_remaining = rr
                m.requests_reset_at = now + (parse_duration(headers.get("x-ratelimit-reset-requests")) or 0.0)

    def note_limited(self, model: str, retry_after: float, scope: str) -> None:
        with self._lock:
            m = self._get(model)
            m.blocked_until = max(m.blocked_until, self._now() + max(0.0, retry_after))
            m.blocked_scope = scope

    def wait_for(self, model: str, tokens_needed: int) -> tuple[float, str]:
        """Seconds to wait before a request of about `tokens_needed` tokens can succeed, and which limit it is."""
        now = self._now()
        with self._lock:
            m = self._get(model)
            if m.blocked_until > now:
                return m.blocked_until - now, m.blocked_scope
            if m.requests_remaining is not None and m.requests_remaining <= 0 and m.requests_reset_at > now:
                return m.requests_reset_at - now, "day"
            if m.tokens_remaining is not None and tokens_needed > m.tokens_remaining and m.tokens_reset_at > now:
                return m.tokens_reset_at - now, "minute"
        return 0.0, "minute"

    def snapshot(self, model: str) -> dict:
        now = self._now()
        with self._lock:
            m = self._get(model)
            return {
                "tokens_remaining": m.tokens_remaining, "tokens_reset_in_s": max(0, round(m.tokens_reset_at - now)) if m.tokens_remaining is not None else None,
                "requests_remaining": m.requests_remaining, "requests_reset_in_s": max(0, round(m.requests_reset_at - now)) if m.requests_remaining is not None else None,
                "blocked_for_s": max(0, round(m.blocked_until - now)), "blocked_scope": m.blocked_scope if m.blocked_until > now else None,
            }


# ------------------------------------------------------------------------------------------------ configuration

class AiConfig:
    """Where the key and model come from, plus the limits we plan around. Thread-safe; the session key lives only in memory."""

    def __init__(self, env_key: str | None, model: str | None = None, base_url: str | None = None, timeout: float = 90.0,
                 tier: str | None = None, tpm: int | None = None, fallback_models: tuple[str, ...] | list[str] | None = None,
                 max_inline_wait: float = 20.0, sleep: Callable[[float], None] = time.sleep, now: Callable[[], float] = time.monotonic):
        self._env_key = (env_key or "").strip() or None
        self._session_key: str | None = None
        self._lock = threading.Lock()
        self.call_lock = threading.RLock()                 # one AI request at a time: two at once would double the token spend
        self.model = (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
        self.base_url = (base_url or DEFAULT_BASE_URL).strip().rstrip("/")
        self.timeout = timeout
        self.tier = "dev" if (tier or "").strip().lower() in ("dev", "developer", "paid") else "free"
        self.tpm = tpm if tpm and tpm > 0 else (8000 if self.tier == "free" else 0)   # 0 = do not plan around a token limit
        self.fallback_models = [m for m in (fallback_models if fallback_models is not None else DEFAULT_FALLBACKS) if m and m != self.model]
        self.max_inline_wait = max_inline_wait
        self.sleep, self.now = sleep, now
        self.rate = RateState(now)

    @property
    def key(self) -> str | None:
        with self._lock:
            return self._session_key or self._env_key

    @property
    def key_source(self) -> str | None:
        with self._lock:
            return "session" if self._session_key else "environment" if self._env_key else None

    def set_session_key(self, key: str | None) -> None:
        if key is not None and not KEY_RE.fullmatch(key.strip()):
            raise AiError("ai_bad_key_format", "That does not look like an API key (letters, digits, - and _ only).", 422)
        with self._lock:
            self._session_key = key.strip() if key else None

    def status(self) -> dict:
        host = urlparse(self.base_url).hostname or ""
        return {"configured": self.key is not None, "key_source": self.key_source, "model": self.model, "provider": "groq", "host": host,
                "tier": self.tier, "tpm": self.tpm, "fallback_models": self.fallback_models, "limits": self.rate.snapshot(self.model)}

    def scrub(self, text: str) -> str:
        for k in (self.key, self._env_key, self._session_key):
            if k:
                text = text.replace(k, "[key]")
        return text

    def endpoint(self) -> str:
        u = urlparse(self.base_url)
        local = u.hostname in ("127.0.0.1", "localhost", "::1")
        if u.scheme not in ("https", "http") or (u.scheme == "http" and not local) or u.username or u.password or not u.hostname:
            raise AiError("ai_misconfigured", "APPANROM_AI_BASE_URL must be an https URL (or http to localhost).", 500)
        return self.base_url + "/chat/completions"

    # budgets (tokens). Groq counts input + the completion we reserve against the per-minute limit.
    def max_completion(self, edit_mode: bool) -> int:
        return (2400 if edit_mode else 3200) if self.tier == "free" else 8192

    def input_budget(self, max_out: int) -> int | None:
        return None if not self.tpm else max(1200, self.tpm - 400 - max_out)


# ------------------------------------------------------------------------------------------------ HTTP

_TOO_LARGE = re.compile(r"Limit (\d+), Requested (\d+)", re.I)


def _post(cfg: AiConfig, model: str, body: dict) -> tuple[dict, dict]:
    key = cfg.key
    if not key:
        raise AiError("ai_not_configured", "No API key. Set GROQ_API_KEY before starting the backend, or paste a key in the AI panel.", 503)
    body = {**body, "model": model}
    req = urllib.request.Request(
        cfg.endpoint(), data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "AppPanrom-Studio/0.1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=cfg.timeout) as resp:  # noqa: S310 - scheme/host validated in endpoint()
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return json.loads(resp.read(4_000_000).decode("utf-8")), headers
    except urllib.error.HTTPError as e:
        raw = e.read(8000).decode("utf-8", "replace")
        headers = {k.lower(): v for k, v in e.headers.items()}
        try:
            detail = json.loads(raw).get("error", {}).get("message") or raw
        except ValueError:
            detail = raw
        detail = cfg.scrub(str(detail))[:600]
        cfg.rate.observe(model, headers)
        if e.code in (401, 403):
            raise AiError("ai_bad_key", "The API key was rejected. Check it and try again.", 401) from None
        low = detail.lower()
        if e.code == 413 or (e.code in (400, 429) and "request too large" in low):
            m = _TOO_LARGE.search(detail)
            err = AiError("ai_too_large", "That request is bigger than the model's per-minute token limit.", 413)
            err.limit = int(m.group(1)) if m else None  # type: ignore[attr-defined]
            raise err from None
        if e.code == 429:
            retry = parse_duration(headers.get("retry-after"))
            if retry is None:
                m2 = re.search(r"try again in ([0-9hms.]+)", detail, re.I)
                retry = parse_duration(m2.group(1)) if m2 else None
            scope = "day" if re.search(r"per day|\(tpd\)|\(rpd\)", low) else "minute"
            if retry is None:
                retry = (parse_duration(headers.get("x-ratelimit-reset-requests")) if scope == "day" else parse_duration(headers.get("x-ratelimit-reset-tokens"))) or 5.0
            cfg.rate.note_limited(model, retry, scope)
            raise AiRateLimited(model, retry, scope, bool(cfg.fallback_models)) from None
        if e.code == 400:
            err = AiError("ai_bad_request", f"The AI service refused the request: {detail}", 502)
            err.detail = detail  # type: ignore[attr-defined]
            raise err from None
        raise AiError("ai_unavailable", f"The AI service returned an error ({e.code}). {detail}", 502) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise AiError("ai_unreachable", f"Cannot reach the AI service: {cfg.scrub(str(getattr(e, 'reason', e)))[:200]}", 502) from None
    except ValueError:
        raise AiError("ai_bad_response", "The AI service sent a reply that could not be read.", 502) from None


def _complete(cfg: AiConfig, model: str, messages: list[dict], max_out: int, waited: list[float]) -> tuple[str, dict]:
    """One model call that waits for rate limits to reset. Short waits are invisible; a long wait raises AiRateLimited (the Studio shows a countdown)."""
    need = sum(est_tokens(m["content"]) for m in messages) + max_out
    effort = "low" if cfg.tier == "free" else "medium"
    full = {"messages": messages, "temperature": 0.2, "max_completion_tokens": max_out, "reasoning_effort": effort, "include_reasoning": False}
    minimal = {"messages": messages, "temperature": 0.2}
    body, tried_minimal, limited_tries = full, False, 0
    while True:
        wait, scope = cfg.rate.wait_for(model, need)
        if wait > 0:
            if wait > cfg.max_inline_wait or limited_tries >= 3:
                raise AiRateLimited(model, wait, scope, bool(cfg.fallback_models))
            cfg.sleep(wait + 0.25)
            waited.append(wait + 0.25)
        try:
            data, headers = _post(cfg, model, body)
            cfg.rate.observe(model, headers)
            break
        except AiRateLimited as e:
            limited_tries += 1
            if e.retry_after_s > cfg.max_inline_wait or limited_tries >= 3:
                raise
            cfg.sleep(e.retry_after_s + 0.25)       # a short limit: wait it out and try again, invisibly
            waited.append(e.retry_after_s + 0.25)
        except AiError as e:
            if e.code == "ai_bad_request" and not tried_minimal:
                tried_minimal, body = True, minimal   # the service rejected an optional tuning parameter: ask plainly
                continue
            raise
    try:
        text = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise AiError("ai_bad_response", "The AI service sent an empty reply.", 502) from None
    return text, data.get("usage") or {}


# ------------------------------------------------------------------------------------------------ prompts

_PITFALLS = """\
HARD RULES (the compiler rejects violations):
- AppPanrom is NOT Python or JavaScript. Use ONLY the constructs listed. Indentation is exactly 4 spaces, never tabs.
- No if/else/elif, def, for-in without `ovvoru`, while, True/False/None, print, +=, import, classes, lambdas, f-strings, comprehensions,
  slicing, negative indexes, break/continue, or the ternary `a if c else b` (write a small helper function returning one of two values).
- Text and numbers never mix implicitly: "n=" + str(n).
- Event handlers: a zero-parameter function name (click_pannumbodhu=go) or a call with arguments (click_pannumbodhu=delete_item(i)).
- Components only inside screen blocks. Drawing code must not assign variables or call functions that change state.
- Input names are fixed quoted strings, unique across the app. Colours are "#RGB"/"#RRGGBB".
- navbar_uruvakku / tabbar_uruvakku go directly inside a screen (one each); nav_action only in a navbar; tab_item only in a tabbar.
- Do not invent functions, style keys, options or components. Not implemented: network/api calls, camera/location, dialogs, custom fonts.
"""

_COMMON_OUTPUT = """\
Reply in the language the user writes in (English, or friendly Tanglish if they write Tanglish). Start with 1-5 short lines saying what you did
(or the answer to a question; then NO code block). Keep the file's vocabulary: if it uses Tanglish words (seyal, thirumbi_kudu, batan, sari/thappu)
write new code in Tanglish, if English words (function, return, button, true/false) stay English; never mix inside new code.
"""

_OUTPUT_FULL = """\
HOW TO ANSWER: after the short explanation give the COMPLETE new main.apn in ONE fenced block:
```apn
...whole file...
```
Always the whole file, never a fragment. Keep everything the user did not ask you to change.
"""

_OUTPUT_EDIT = """\
HOW TO ANSWER (this file is large, so change it with EDITS, not a rewrite). After the short explanation give one block:
```apn-edit
<<<<<<< SEARCH
exact lines that exist now (copied character for character, including indentation)
=======
the lines that replace them
>>>>>>> REPLACE
```
You may give several SEARCH/REPLACE pairs in the one block, in file order. Each SEARCH must match exactly one place in the file: include enough
neighbouring lines to make it unique. To INSERT, SEARCH a nearby existing line and REPLACE with that line plus the new lines. To DELETE, leave the
REPLACE part empty. Lines like `# ... (N lines hidden: names) ...` are NOT in the file: never put them in a SEARCH. Only edit what you can see; to touch
hidden code, say so briefly instead. Do not repeat unchanged code.
"""

COMPACT_REFERENCE = """\
=== AppPanrom QUICK REFERENCE ===
app_uruvakku("Name")  app_id_set("com.x.y")  app_version_set("1.0.0")  app_theme_set("light"|"dark")  app_start_screen("home")   (top level)
mari x = 1                      global variable (inside a function `mari` makes a local); assign with x = x + 1, items[0] = v, d["k"] = v
function f(a, b):               top-level only; `return v`
enna_na c:  /  illana_enna c:  /  illana:        if / else-if / else
ovvoru i in range(5):  /  ovvoru x in items:  /  irukkura_varai c:      for-each / while
try: ... catch err:             err is the message text.   summa = empty statement (an empty block must contain it)
Values: numbers, text "..", true/false, null, lists [..], dicts {"k": v}. Operators + - * / % == != < > <= >= and or not.
screen_uruvakku("home", style={...}):   screen_title("Title")   then components, indented 4 spaces. Screens redraw after every event.

COMPONENTS: title(text)  text_kaattu(text)  button(label, click_pannumbodhu=fn, enabled=true)
input_uruvakku("name", label="", placeholder="", initial="", change_aagumbodhu=fn, submit_pannumbodhu=fn)  password_input(..)  number_input(..)
checkbox_uruvakku("n", label=, initial=)  toggle_uruvakku(..)  dropdown_uruvakku("n", options=[..], label=, initial=, change_aagumbodhu=fn)
image_kaattu("https://..", alt="")  list_kaattu([..])  progress_kaattu(0..100, label="")  loading_kaattu(label="")  divider_kaattu()
Containers (end with `:` + indented children): card_uruvakku(style={})  column_uruvakku(..)  row_uruvakku(..)  center_ama(..)
Top bar: navbar_uruvakku(title="", subtitle="", align="left|center|right", back=true, visible=true, style={}):  nav_action(label, icon="", click_pannumbodhu=fn)
   (directly in a screen, one per screen; visible=false removes the bar; a navbar without actions needs no block)
Tabs: tabbar_uruvakku(style={}):  tab_item(label, icon="", go="screen")   (one per screen; go switches screen without back history)
Event value: handler name, or a call with arguments evaluated at draw time: click_pannumbodhu=delete_item(i)

STYLE KEYS (in a dict; colours "#RRGGBB"): background text_color border_color | padding margin gap corner_radius border_width(0-20) font_size(8-96)
opacity(0-1) | width height (number, "50%" or "fill") | font_weight(normal|medium|bold) text_align(left|center|right) align(start|center|end|stretch)
justify(start|center|end|space_between|space_around) wrap scroll visible(bool) | shadow(none|soft|medium|strong) | looks (bool): clay glass neumorphic brutal |
background_to + gradient_angle(0-360) | animate(fade_in|slide_up|slide_down|slide_left|slide_right|zoom_in|pop|bounce|shake|pulse|float|spin)
animate_duration animate_delay.   style may also be a call returning a dict: style=card_style("#FDE68A")

FUNCTIONS: message_kaattu(v) toast_kaattu(v) debug_log(v) int float str bool type_of text_length text_upper text_lower text_trim text_replace(t,a,b)
text_split(t,sep) text_join(list,sep) text_contains(t,part) length append(list,v) remove(list,i) sort(list) range(n) dict_get(d,k,default) dict_keys
min max sum round(v,digits) abs json_encode json_decode now_iso random_number(lo,hi) random_choice(list) input_value("n") input_set("n",v)
data_save_pannu(key,v) data_edu(key,default) data_delete_pannu(key) data_clear_pannu() screen_ku_poo("s") screen_back_poo() screen_maathu("s")
screen_data_set(k,v) screen_data_get(k,default) clipboard_copy(t) vibrate_pannu(ms)

TANGLISH WORDS (identical program): function=seyal return=thirumbi_kudu try/catch=muyarchi/pidi in=ulle and/or/not=matrum/allathu/illaadha
true/false/null=sari/thappu/onnum_illa title=thalaippu button=batan password_input=ragasiya_input number_input=ennai_input label/placeholder/
initial/enabled/options/alt=peyar/kurippu/modhal/iyakkam/thervugal/vilakkam str/int/float/bool=text_aakku/muzhu_ennai/thasama_ennai/unmai_ah
length/append/remove/sort/range=neelam/serthu/neekku/varisai_paduthu/ellai min/max/sum/round/abs=kuraivu/athigam/kootu/suththam_pannu/nermai
text_length/text_trim/text_split/text_join=text_neelam/text_suththam/text_pirichu/text_serthu dict_get/dict_keys=dict_edu/dict_saavigal
json_encode/json_decode=json_aakku/json_padi now_iso=ippo random_number/random_choice=random_ennai/random_edu
"""

_prompt_cache: dict[tuple[str, str, str], str] = {}


def _full_reference() -> str:
    try:
        return (REPO_ROOT / "docs" / "language.md").read_text(encoding="utf-8")
    except OSError:
        return COMPACT_REFERENCE


def system_prompt(style: str, tier: str = "free", edit_mode: bool = False) -> str:
    key = (style, tier, "edit" if edit_mode else "full")
    if key in _prompt_cache:
        return _prompt_cache[key]
    head = ("You are the coding assistant inside AppPanrom Studio, a visual IDE for the AppPanrom language: a small Tanglish (Tamil + English) "
            "language that builds Android apps. You write and fix AppPanrom code. You are precise, brief and practical.\n\n")
    if tier == "free":
        ref = COMPACT_REFERENCE
    else:
        spec = load_spec()
        ref = ("=== COMPONENTS ===\n" + "\n".join(f"- {c['doc']}" for c in spec["components"].values()) + "\n\n=== STANDARD LIBRARY ===\n"
               + "\n".join(f"- {f['doc']}" for f in spec["functions"].values()) + "\n\n=== LANGUAGE REFERENCE (authoritative) ===\n" + _full_reference())
    text = (head + _PITFALLS + "\n" + _COMMON_OUTPUT + "\n" + (_OUTPUT_EDIT if edit_mode else _OUTPUT_FULL) +
            f"\nThe current file uses the {style.upper()} vocabulary.\n\n" + ref)
    _prompt_cache[key] = text
    return text


# ------------------------------------------------------------------------------------------------ reply parsing

FENCE = re.compile(r"```[ \t]*([A-Za-z0-9_+.\-]*)[ \t]*\r?\n(.*?)```", re.S)
EDIT_BLOCK = re.compile(r"<<<<<<<[ \t]*SEARCH[ \t]*\r?\n(.*?)\r?\n=======[ \t]*\r?\n(.*?)(?:\r?\n)?>>>>>>>[ \t]*REPLACE", re.S)
HIDDEN = re.compile(r"^\s*# \.\.\. \(\d+ lines? hidden.*\) \.\.\.\s*$")


def extract_code(text: str) -> tuple[str, str | None]:
    """Splits a model reply into (explanation, code). Code is the last fenced block that looks like a whole AppPanrom program."""
    pick = None
    for m in FENCE.finditer(text):
        lang, body = m.group(1).lower(), m.group(2)
        if lang in ("apn", "apppanrom") or (lang != "apn-edit" and re.search(r"^\s*screen_uruvakku\(", body, re.M)):
            pick = m
    if pick is None:
        return text.strip(), None
    code = pick.group(2).replace("\r\n", "\n").strip("\n") + "\n"
    explanation = (text[: pick.start()] + text[pick.end():]).strip()
    return re.sub(r"\n{3,}", "\n\n", explanation), code


def extract_edits(text: str) -> tuple[str, list[tuple[str, str]] | None]:
    """(explanation, [(search, replace), ...]) from an ```apn-edit block, or (text, None) if there is none."""
    blocks: list[tuple[str, str]] = []
    explanation, found = text, False
    for m in FENCE.finditer(text):
        if m.group(1).lower() != "apn-edit":
            continue
        found = True
        explanation = explanation.replace(m.group(0), "")
        for b in EDIT_BLOCK.finditer(m.group(2)):
            blocks.append((b.group(1).replace("\r\n", "\n"), b.group(2).replace("\r\n", "\n")))
    if not found:
        return text.strip(), None
    return re.sub(r"\n{3,}", "\n\n", explanation).strip(), blocks


def apply_edits(source: str, edits: list[tuple[str, str]]) -> tuple[str | None, list[str]]:
    """Applies SEARCH/REPLACE pairs to the real source. Returns (new_source, []) or (None, [what went wrong...])."""
    errors: list[str] = []
    cur = source if source.endswith("\n") or not source else source + "\n"
    if not edits:
        return None, ["The edit block contained no SEARCH/REPLACE pair."]
    for i, (search, replace) in enumerate(edits, 1):
        s = search.strip("\n")
        r = replace.strip("\n")
        if not s.strip():
            errors.append(f"Edit {i}: the SEARCH part is empty.")
            continue
        if any(HIDDEN.match(line) for line in s.split("\n")):
            errors.append(f"Edit {i}: the SEARCH part contains a '# ... lines hidden ...' marker, which is not in the file.")
            continue
        n = cur.count(s)
        if n == 1:
            cur = cur.replace(s, r, 1)
            continue
        if n > 1:
            errors.append(f"Edit {i}: the SEARCH text appears {n} times; add more neighbouring lines so it matches exactly one place.")
            continue
        # tolerate trailing-whitespace differences line by line
        lines, want = cur.split("\n"), [x.rstrip() for x in s.split("\n")]
        hits = [k for k in range(len(lines) - len(want) + 1) if [x.rstrip() for x in lines[k:k + len(want)]] == want]
        if len(hits) == 1:
            k = hits[0]
            cur = "\n".join(lines[:k] + r.split("\n") + lines[k + len(want):])
        elif len(hits) > 1:
            errors.append(f"Edit {i}: the SEARCH text appears {len(hits)} times; add more neighbouring lines.")
        else:
            first = s.split("\n")[0].strip()[:70]
            errors.append(f"Edit {i}: the SEARCH text was not found in the file (starts with `{first}`). Copy the lines exactly as they appear in the code you were shown.")
    if errors:
        return None, errors
    return cur if cur.endswith("\n") else cur + "\n", []


# ------------------------------------------------------------------------------------------------ context building

_BLOCK_START = re.compile(r"^\S")


def split_blocks(source: str) -> list[list[str]]:
    """Top-level blocks: a non-indented, non-comment line plus everything indented / blank / commented below it."""
    blocks: list[list[str]] = []
    for line in source.rstrip("\n").split("\n"):
        starts = bool(_BLOCK_START.match(line)) and not line.startswith("#")
        if starts or not blocks:
            blocks.append([line])
        else:
            blocks[-1].append(line)
    return blocks


def trim_source(source: str, budget_chars: int, focus_lines: set[int], words: set[str]) -> tuple[str, bool]:
    """Keeps the parts of the file most relevant to the request within `budget_chars`; hides the rest behind marker lines."""
    if len(source) <= budget_chars:
        return source.rstrip("\n"), False
    blocks = split_blocks(source)
    pos, spans = 0, []
    for b in blocks:                                  # source line range of each block (1-based)
        spans.append((pos + 1, pos + len(b)))
        pos += len(b)
    def score(i: int) -> int:
        b, (a, z) = blocks[i], spans[i]
        head = b[0]
        s = 0
        if any(a <= ln <= z for ln in focus_lines):
            s += 1000
        if head.startswith(("app_", "mari ")):
            s += 500                                   # settings and globals are small and set the context
        name = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", head)
        s += 60 * len({w.lower() for w in name} & words)
        if head.startswith("screen_uruvakku"):
            s += 20
        return s
    order = sorted(range(len(blocks)), key=lambda i: (-score(i), i))
    keep: set[int] = set()
    used = 0
    for i in order:
        cost = sum(len(x) + 1 for x in blocks[i])
        if used + cost <= budget_chars:
            keep.add(i)
            used += cost
    out: list[str] = []
    run: list[int] = []

    def flush() -> None:
        if not run:
            return
        lines = sum(len([x for x in blocks[i] if x.strip()]) for i in run)
        names = ", ".join(re.sub(r"\s+", " ", blocks[i][0]).strip().rstrip(":")[:40] for i in run[:8])
        out.append(f"# ... ({lines} lines hidden: {names}{', ...' if len(run) > 8 else ''}) ...")
        run.clear()

    for i, b in enumerate(blocks):
        if i in keep:
            flush()
            out.extend(b)
        else:
            run.append(i)
    flush()
    return "\n".join(out), True


def _context_block(code: str | None, trimmed: bool, diagnostics: list[dict], selection: dict | None) -> str:
    parts: list[str] = []
    if code is not None:
        parts.append(("CURRENT main.apn (parts hidden to save space; lines marked `# ... hidden ...` are not editable here):" if trimmed else "CURRENT main.apn:")
                     + "\n```apn\n" + code + "\n```")
    if diagnostics:
        parts.append("COMPILER PROBLEMS IN IT RIGHT NOW:\n" + "\n".join(f"- line {d.get('line')}: {d.get('message')}" for d in diagnostics[:12]))
    if selection and selection.get("component"):
        parts.append(f"The user has selected a {selection['component']} (line {selection.get('line')}) in the visual designer.")
    return "\n\n".join(parts)


@dataclass
class ChatMessage:
    role: str
    content: str


FULL_MODE_MAX_CHARS_FREE = 4500          # small files are rewritten whole; bigger ones are changed with edits


def assist(cfg: AiConfig, compile_fn: Callable[[str], tuple[bool, list[dict]]], messages: list[ChatMessage], source: str | None,
           include_code: bool = True, diagnostics: list[dict] | None = None, selection: dict | None = None, on_limit: str = "wait") -> dict:
    """Runs one assistant turn: ask, validate the returned code with the real compiler, repair up to MAX_REPAIRS times."""
    if not messages or messages[-1].role != "user":
        raise AiError("bad_request", "The last message must be from the user.", 422)
    with cfg.call_lock:
        return _assist(cfg, compile_fn, messages, source, include_code, diagnostics or [], selection, on_limit)


def _assist(cfg, compile_fn, messages, source, include_code, diagnostics, selection, on_limit):
    style = detect_style(source or "")
    real = (source or "")
    free = cfg.tier == "free"
    edit_mode = bool(include_code and real and len(real) > (FULL_MODE_MAX_CHARS_FREE if free else 30_000))
    max_out = cfg.max_completion(edit_mode)
    last = messages[-1].content
    words = {w.lower() for w in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", last)}
    focus = {int(d["line"]) for d in diagnostics if d.get("line")} | ({int(selection["line"])} if selection and selection.get("line") else set())
    # history: recent turns only, text only (the code is sent once, in the last message)
    keep_hist = 4 if free else 12
    hist_cap = 700 if free else 8000
    history = [{"role": m.role, "content": m.content[:hist_cap]} for m in messages[:-1]][-keep_hist:]
    scale = 1.0
    shrinks = 0
    while True:
        sys_text = system_prompt(style, cfg.tier, edit_mode)
        budget_tokens = cfg.input_budget(max_out)
        code_text, trimmed = (None, False)
        if include_code:
            if budget_tokens is None:
                code_text, trimmed = real.rstrip("\n"), False
            else:
                fixed = est_tokens(sys_text) + sum(est_tokens(h["content"]) for h in history) + est_tokens(last) + 250
                avail = max(400, int((budget_tokens - fixed) * scale))
                code_text, trimmed = trim_source(real, int(avail * CHARS_PER_TOKEN), focus, words)
        ctx = _context_block(code_text, trimmed, diagnostics[:12], selection) if (include_code or diagnostics or selection) else ""
        convo = [{"role": "system", "content": sys_text}, *history, {"role": "user", "content": (ctx + "\n\nUSER REQUEST:\n" if ctx else "") + last}]
        try:
            return _run_turns(cfg, compile_fn, convo, real, edit_mode, max_out, on_limit, trimmed)
        except AiError as e:
            if e.code == "ai_too_large" and shrinks < 2:
                shrinks += 1
                scale *= 0.55
                lim = getattr(e, "limit", None)
                if lim and (not cfg.tpm or lim < cfg.tpm):
                    cfg.tpm = lim                      # learn the real limit from the service's own message
                history = history[-2:]
                continue
            raise


def _run_turns(cfg, compile_fn, convo, real, edit_mode, max_out, on_limit, trimmed) -> dict:
    usage_total: dict[str, int] = {}
    waited: list[float] = []
    used_model, fallback_from = cfg.model, None
    attempts, ok, diags, code, explanation = 0, None, [], None, ""
    while True:
        attempts += 1
        text, usage, used_model, fb = _ask(cfg, convo, max_out, waited, on_limit)
        fallback_from = fallback_from or fb
        for k, v in usage.items():
            if isinstance(v, int):
                usage_total[k] = usage_total.get(k, 0) + v
        problems: list[str] = []
        explanation, edits = extract_edits(text)
        if edits is not None:
            code, errs = apply_edits(real, edits)
            problems = errs
        else:
            explanation, code = extract_code(text)
        if code is not None and not problems:
            ok, diags = compile_fn(code)
            if not ok:
                problems = [f"line {d['line']}: {d['message']}" + (f" ({d['suggestion']})" if d.get("suggestion") else "") for d in diags[:12]]
        elif problems:
            ok, diags, code = False, [], None
        else:
            ok, diags = None, []
        if not problems or attempts > MAX_REPAIRS:
            break
        # a repair round re-sends the whole conversation: make sure that still fits the minute budget, otherwise stop here
        if cfg.tpm and sum(est_tokens(m["content"]) for m in convo) + est_tokens(text) + max_out + 400 > cfg.tpm:
            break
        what = "The edits could not be applied" if (edits is not None and code is None) else "The compiler rejected that code"
        redo = ("Fix every problem and give the corrected ```apn-edit block (SEARCH text copied exactly from the file; edits are applied to the ORIGINAL file again)."
                if edit_mode else "Fix every problem and return the COMPLETE corrected main.apn in one ```apn block (short explanation first).")
        convo += [{"role": "assistant", "content": text}, {"role": "user", "content": f"{what}:\n" + "\n".join(f"- {p}" for p in problems) + "\n" + redo}]
    if code is None and edits is not None:
        explanation = (explanation + "\n\n" if explanation else "") + "(The suggested edits could not be applied to your file.)"
    return {"text": explanation, "code": code, "compiles": ok, "diagnostics": diags, "attempts": attempts, "model": used_model,
            "fallback_from": fallback_from, "mode": "edit" if edit_mode else "full", "trimmed": trimmed, "waited_s": round(sum(waited), 1), "usage": usage_total}


def _ask(cfg, convo, max_out, waited, on_limit):
    """Asks the main model; if it is rate-limited for longer than we wait inline and the user chose a backup model, asks that instead."""
    tried: list[AiRateLimited] = []
    for model in [cfg.model] + (cfg.fallback_models if on_limit == "fallback" else []):
        try:
            text, usage = _complete(cfg, model, convo, max_out, waited)
            return text, usage, model, (cfg.model if model != cfg.model else None)
        except AiRateLimited as e:
            tried.append(e)
    first = min(tried, key=lambda e: e.retry_after_s)
    if len(tried) > 1:
        raise AiRateLimited(cfg.model, first.retry_after_s, first.scope, False)
    raise tried[0]
