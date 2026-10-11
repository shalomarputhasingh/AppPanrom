"""AI assistant: tested against a fake local server that speaks the OpenAI-compatible chat API (no real key, no network)."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from apppanrom.ai import AiConfig, extract_code
from apppanrom.main import create_app
from conftest import make_settings

KEY = "gsk_TESTKEY0123456789abcdef"
GOOD = 'app_uruvakku("AI App")\nscreen_uruvakku("home"):\n    text_kaattu("hi")\n'
BAD = 'app_uruvakku("AI App")\nscreen_uruvakku("home"):\n    text_kaatu("hi")\n'


def reply(text, status=200, headers=None):
    return {"status": status, "headers": headers or {}, "body": {"choices": [{"message": {"role": "assistant", "content": text}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}}


def err(status, message="boom", headers=None):
    return {"status": status, "headers": headers or {}, "body": {"error": {"message": message}}}


class Fake:
    def __init__(self):
        self.requests, self.queue = [], []
        fake = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                fake.requests.append({"path": self.path, "auth": self.headers.get("authorization"), "body": body})
                r = fake.queue.pop(0) if fake.queue else err(500, "queue empty")
                self.send_response(r["status"])
                for k, v in r["headers"].items():
                    self.send_header(k, v)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(r["body"]).encode())

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/openai/v1"

    def stop(self):
        self.server.shutdown()


@pytest.fixture
def fake():
    f = Fake()
    yield f
    f.stop()


class Clock:
    """A fake clock: sleeping just moves time forward, so waiting for Groq to reset is testable without waiting."""

    def __init__(self):
        self.t, self.slept = 1000.0, []

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


def client_for(tmp_path, fake, key=KEY, **kw):
    s = make_settings(tmp_path, ai_api_key=key, ai_base_url=fake.url, **kw)
    app = create_app(s)
    clock = Clock()
    app.state.ai.sleep, app.state.ai.now = clock.sleep, clock.now
    app.state.ai.rate._now = clock.now
    c = TestClient(app)
    c.clock = clock  # type: ignore[attr-defined]
    return c


def project(c, source=None):
    p = c.post("/api/projects", json={"name": "AI"}).json()
    if source is not None:
        c.put(f"/api/projects/{p['id']}/files/main.apn", json={"content": source})
    return p["id"]


def chat(c, pid, text="make it nicer", **extra):
    return c.post(f"/api/projects/{pid}/ai/chat", json={"messages": [{"role": "user", "content": text}], **extra})


def test_status_never_contains_the_key(tmp_path, fake):
    with client_for(tmp_path, fake) as c:
        r = c.get("/api/ai/status")
        j = r.json()
        assert (j["configured"], j["key_source"], j["model"], j["provider"], j["host"], j["tier"], j["tpm"]) == (True, "environment", "openai/gpt-oss-120b", "groq", "127.0.0.1", "free", 8000)
        assert j["fallback_models"] == ["openai/gpt-oss-20b"] and j["limits"]["blocked_for_s"] == 0
        assert KEY not in r.text
    with client_for(tmp_path / "b", fake, key=None) as c:
        assert c.get("/api/ai/status").json()["configured"] is False


def test_chat_without_a_key_is_a_clear_503(tmp_path, fake):
    with client_for(tmp_path, fake, key=None) as c:
        r = chat(c, project(c))
        assert r.status_code == 503 and r.json()["error"]["code"] == "ai_not_configured" and "GROQ_API_KEY" in r.json()["error"]["message"]
    assert fake.requests == []


def test_happy_path_sends_key_model_language_reference_and_current_code(tmp_path, fake):
    fake.queue.append(reply("I added a greeting.\n```apn\n" + GOOD + "```\n"))
    with client_for(tmp_path, fake) as c:
        pid = project(c, 'app_uruvakku("Mine")\nscreen_uruvakku("home"):\n    title("Mine")\n')
        r = chat(c, pid, "add a greeting text")
        j = r.json()
        assert r.status_code == 200 and j["compiles"] is True and j["attempts"] == 1 and j["code"] == GOOD and j["text"] == "I added a greeting."
        assert j["model"] == "openai/gpt-oss-120b" and j["usage"]["total_tokens"] == 15
        assert KEY not in r.text
    req = fake.requests[0]
    assert req["path"] == "/openai/v1/chat/completions" and req["auth"] == f"Bearer {KEY}" and req["body"]["model"] == "openai/gpt-oss-120b"
    system, user = req["body"]["messages"][0], req["body"]["messages"][-1]
    assert system["role"] == "system" and "HARD RULES" in system["content"] and "QUICK REFERENCE" in system["content"] and "navbar_uruvakku" in system["content"]
    assert 'title("Mine")' in user["content"] and "add a greeting text" in user["content"]


def test_include_code_false_does_not_send_the_code(tmp_path, fake):
    fake.queue.append(reply("A card is a container."))
    with client_for(tmp_path, fake) as c:
        r = chat(c, project(c, 'screen_uruvakku("home"):\n    title("SECRET-MARKER")\n'), "what is a card?", include_code=False)
        assert r.json()["code"] is None and r.json()["compiles"] is None
    assert "SECRET-MARKER" not in json.dumps(fake.requests[0]["body"])


def test_bad_code_is_repaired_using_the_compiler_diagnostics(tmp_path, fake):
    fake.queue += [reply("Here.\n```apn\n" + BAD + "```"), reply("Fixed.\n```apn\n" + GOOD + "```")]
    with client_for(tmp_path, fake) as c:
        j = chat(c, project(c)).json()
        assert j["compiles"] is True and j["attempts"] == 2 and j["code"] == GOOD and j["text"] == "Fixed."
    second = fake.requests[1]["body"]["messages"]
    assert "compiler rejected" in second[-1]["content"] and "text_kaatu" in second[-1]["content"] and "text_kaattu" in second[-1]["content"]  # includes the suggestion


def test_gives_up_after_two_repairs_and_reports_the_errors(tmp_path, fake):
    fake.queue += [reply("```apn\n" + BAD + "```")] * 3
    with client_for(tmp_path, fake) as c:
        j = chat(c, project(c)).json()
    assert j["attempts"] == 3 and j["compiles"] is False and any(d["code"] == "unknown_function" for d in j["diagnostics"]) and len(fake.requests) == 3


@pytest.mark.parametrize("status,code,http", [(401, "ai_bad_key", 401), (403, "ai_bad_key", 401), (500, "ai_unavailable", 502), (413, "ai_too_large", 413)])
def test_service_errors_are_mapped(tmp_path, fake, status, code, http):
    fake.queue += [err(status, f"oops {KEY}")] * 3                  # (a 413 makes the assistant shrink the request and try again, twice)
    with client_for(tmp_path, fake) as c:
        r = chat(c, project(c))
    assert r.status_code == http and r.json()["error"]["code"] == code and KEY not in r.text


def test_unsupported_tuning_parameters_fall_back_to_a_minimal_request(tmp_path, fake):
    fake.queue += [err(400, "unknown parameter include_reasoning"), reply("fine")]
    with client_for(tmp_path, fake) as c:
        assert chat(c, project(c)).status_code == 200
    first, second = fake.requests[0]["body"], fake.requests[1]["body"]
    assert "reasoning_effort" in first and "reasoning_effort" not in second and "max_completion_tokens" not in second and second["model"] == first["model"]


def test_unreachable_service(tmp_path):
    s = make_settings(tmp_path, ai_api_key=KEY, ai_base_url="http://127.0.0.1:9/openai/v1")
    with TestClient(create_app(s)) as c:
        r = chat(c, project(c))
    assert r.status_code == 502 and r.json()["error"]["code"] == "ai_unreachable"


@pytest.mark.parametrize("url", ["http://evil.example.com/v1", "ftp://x/v1", "https://user:pw@api.groq.com/v1", "javascript:alert(1)"])
def test_base_url_must_be_https_or_local(tmp_path, url):
    from apppanrom.ai import AiError
    with pytest.raises(AiError) as e:
        AiConfig(KEY, base_url=url).endpoint()
    assert e.value.code == "ai_misconfigured"


def test_session_key_lives_in_memory_and_is_never_echoed(tmp_path, fake):
    with client_for(tmp_path, fake, key=None) as c:
        assert chat(c, project(c)).status_code == 503
        r = c.post("/api/ai/key", json={"key": KEY})
        assert r.status_code == 200 and r.json()["key_source"] == "session" and KEY not in r.text
        fake.queue.append(reply("hi"))
        assert chat(c, project(c)).status_code == 200 and fake.requests[-1]["auth"] == f"Bearer {KEY}"
        assert c.post("/api/ai/key", json={"key": "has spaces and !!!"}).status_code == 422
        assert c.delete("/api/ai/key").json()["configured"] is False
        assert chat(c, project(c)).status_code == 503


def test_request_validation(tmp_path, fake):
    with client_for(tmp_path, fake) as c:
        pid = project(c)
        url = f"/api/projects/{pid}/ai/chat"
        assert c.post(url, json={"messages": []}).status_code == 422
        assert c.post(url, json={"messages": [{"role": "assistant", "content": "x"}]}).status_code == 422                  # last must be the user
        assert c.post(url, json={"messages": [{"role": "user", "content": "x" * 8001}]}).status_code == 422
        assert c.post(url, json={"messages": [{"role": "user", "content": "x"}] * 25}).status_code == 422
        assert c.post(url, json={"messages": [{"role": "system", "content": "x"}]}).status_code == 422                       # no smuggled system prompts
        assert c.post("/api/projects/p_000000000000/ai/chat", json={"messages": [{"role": "user", "content": "x"}]}).status_code == 404
    assert fake.requests == []


def test_prompt_follows_the_vocabulary_of_the_file(tmp_path, fake):
    fake.queue.append(reply("ok"))
    with client_for(tmp_path, fake) as c:
        chat(c, project(c, 'seyal go():\n    summa\nscreen_uruvakku("home"):\n    batan("x", click_pannumbodhu=go)\n'))
    assert "TANGLISH vocabulary" in fake.requests[0]["body"]["messages"][0]["content"]


def test_history_and_selection_and_diagnostics_reach_the_model(tmp_path, fake):
    fake.queue.append(reply("ok"))
    with client_for(tmp_path, fake) as c:
        pid = project(c)
        r = c.post(f"/api/projects/{pid}/ai/chat", json={
            "messages": [{"role": "user", "content": "first"}, {"role": "assistant", "content": "answer one"}, {"role": "user", "content": "second"}],
            "diagnostics": [{"line": 3, "message": "Variable 'x' is not declared."}], "selection": {"line": 4, "component": "card_uruvakku"}})
        assert r.status_code == 200
    msgs = fake.requests[0]["body"]["messages"]
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "user"] and msgs[2]["content"] == "answer one"
    assert "Variable 'x' is not declared." in msgs[-1]["content"] and "card_uruvakku" in msgs[-1]["content"]


def test_extract_code_picks_the_apppanrom_block():
    text = "Use this:\n```python\nprint(1)\n```\nand\n```apn\nscreen_uruvakku(\"h\"):\n    summa\n```\ndone"
    explanation, code = extract_code(text)
    assert code == 'screen_uruvakku("h"):\n    summa\n' and "print" in explanation and "screen_uruvakku" not in explanation
    assert extract_code("no code here") == ("no code here", None)
    assert extract_code('```\nscreen_uruvakku("h"):\n    summa\n```')[1] is not None   # untagged but clearly the app


# ------------------------------------------------------------------ free tier: token budget, waiting for resets, fallbacks
BIG = 'app_uruvakku("Big")\n' + "".join(f'seyal helper_{i}(x):\n    thirumbi_kudu x + {i}\n\n' for i in range(400)) + 'screen_uruvakku("home"):\n    text_kaattu("hi")\n'


def est(msgs):
    from apppanrom.ai import est_tokens
    return sum(est_tokens(m["content"]) for m in msgs)


def test_free_tier_requests_fit_the_per_minute_token_budget_even_for_big_files(tmp_path, fake):
    assert len(BIG) > 4500
    fake.queue.append(reply("Just an answer."))
    with client_for(tmp_path, fake) as c:
        j = chat(c, project(c, BIG), "how many helpers are there?").json()
    body = fake.requests[0]["body"]
    assert j["mode"] == "edit" and j["trimmed"] is True
    assert est(body["messages"]) + body["max_completion_tokens"] <= 8000                 # input + reserved output fit the 8K/min limit
    assert body["reasoning_effort"] == "low" and "QUICK REFERENCE" in body["messages"][0]["content"] and "apn-edit" in body["messages"][0]["content"]
    assert "lines hidden" in body["messages"][-1]["content"]


def test_paid_tier_keeps_the_full_reference_and_whole_file(tmp_path, fake):
    fake.queue.append(reply("ok"))
    with client_for(tmp_path, fake, ai_tier="dev") as c:
        j = chat(c, project(c, BIG)).json()
    body = fake.requests[0]["body"]
    assert j["mode"] == "full" and j["trimmed"] is False and "LANGUAGE REFERENCE" in body["messages"][0]["content"] and "helper_399" in body["messages"][-1]["content"]


def test_big_files_are_changed_with_small_edits_that_are_applied_and_validated(tmp_path, fake):
    edit = "Added a line.\n```apn-edit\n<<<<<<< SEARCH\nscreen_uruvakku(\"home\"):\n    text_kaattu(\"hi\")\n=======\nscreen_uruvakku(\"home\"):\n    text_kaattu(\"hi\")\n    text_kaattu(\"new\")\n>>>>>>> REPLACE\n```"
    fake.queue.append(reply(edit))
    with client_for(tmp_path, fake) as c:
        j = chat(c, project(c, BIG), "add a text").json()
    assert j["compiles"] is True and j["mode"] == "edit" and j["code"].count("helper_") == BIG.count("helper_")        # the hidden helpers are untouched
    assert j["code"].endswith('    text_kaattu("hi")\n    text_kaattu("new")\n') and j["text"] == "Added a line."


def test_failed_edits_are_reported_back_to_the_model_and_repaired(tmp_path, fake):
    wrong = "```apn-edit\n<<<<<<< SEARCH\nthis line does not exist\n=======\nx\n>>>>>>> REPLACE\n```"
    right = "Fixed.\n```apn-edit\n<<<<<<< SEARCH\n    text_kaattu(\"hi\")\n=======\n    text_kaattu(\"hello\")\n>>>>>>> REPLACE\n```"
    fake.queue += [reply(wrong), reply(right)]
    with client_for(tmp_path, fake) as c:
        j = chat(c, project(c, BIG), "change hi").json()
    assert j["attempts"] == 2 and j["compiles"] is True and 'text_kaattu("hello")' in j["code"]
    assert "could not be applied" in fake.requests[1]["body"]["messages"][-1]["content"] and "not found" in fake.requests[1]["body"]["messages"][-1]["content"]


def test_apply_edits_rules():
    from apppanrom.ai import apply_edits
    src = "a\nb\nb\nc\n"
    assert apply_edits(src, [("a", "A")]) == ("A\nb\nb\nc\n", [])
    assert apply_edits(src, [("b", "X")])[0] is None and "2 times" in apply_edits(src, [("b", "X")])[1][0]          # ambiguous
    assert "not found" in apply_edits(src, [("zzz", "X")])[1][0]
    assert apply_edits(src, [("c", "")])[0] == "a\nb\nb\n\n" or apply_edits(src, [("c", "")])[0] is not None          # delete
    assert apply_edits("x  \ny\n", [("x\ny", "Z")])[0] == "Z\n"                                                       # trailing spaces tolerated
    assert "hidden" in apply_edits(src, [("# ... (5 lines hidden: seyal f()) ...", "x")])[1][0]
    assert apply_edits(src, [("a", "A"), ("c", "C")])[0] == "A\nb\nb\nC\n"                                            # several, in order


def test_short_rate_limit_is_waited_out_invisibly_and_the_answer_arrives(tmp_path, fake):
    fake.queue += [err(429, "Rate limit reached. Please try again in 3s", headers={"retry-after": "3"}), reply("Here you go.")]
    with client_for(tmp_path, fake) as c:
        r = chat(c, project(c))
        assert r.status_code == 200 and r.json()["text"] == "Here you go." and r.json()["waited_s"] == pytest.approx(3.25, abs=0.1)
        assert c.clock.slept == [3.25]
    assert len(fake.requests) == 2


def test_long_limit_returns_a_countdown_and_does_not_hammer_groq(tmp_path, fake):
    fake.queue.append(err(429, "Rate limit reached for model openai/gpt-oss-120b on tokens per minute (TPM): try again in 45s", headers={"retry-after": "45"}))
    with client_for(tmp_path, fake) as c:
        r = chat(c, project(c))
        e = r.json()["error"]
        assert r.status_code == 429 and e["code"] == "ai_rate_limited" and e["details"] == {"retry_after_s": 45, "scope": "minute", "model": "openai/gpt-oss-120b", "fallback_possible": True}
        assert "45 s" in e["message"] and c.clock.slept == []
        n = len(fake.requests)
        c.clock.t += 20                                                               # 20 s later: still blocked, answered locally, Groq is not asked
        r2 = chat(c, project(c))
        assert r2.status_code == 429 and r2.json()["error"]["details"]["retry_after_s"] == 25 and len(fake.requests) == n
        assert c.get("/api/ai/status").json()["limits"]["blocked_for_s"] == 25
        c.clock.t += 26                                                               # reset: works again
        fake.queue.append(reply("back"))
        assert chat(c, project(c)).json()["text"] == "back"


def test_daily_limit_is_recognised_and_not_waited_for(tmp_path, fake):
    fake.queue.append(err(429, "Rate limit reached for model openai/gpt-oss-120b on tokens per day (TPD): Limit 200000. Please try again in 2h5m", headers={"retry-after": "7500"}))
    with client_for(tmp_path, fake) as c:
        e = chat(c, project(c)).json()["error"]
    assert e["details"]["scope"] == "day" and e["details"]["retry_after_s"] == 7500 and "daily" in e["message"] and "2 h" in e["message"]


def test_rate_limit_headers_are_used_to_wait_before_asking(tmp_path, fake):
    hdr = {"x-ratelimit-remaining-tokens": "100", "x-ratelimit-reset-tokens": "12.5s", "x-ratelimit-remaining-requests": "900", "x-ratelimit-reset-requests": "3m"}
    fake.queue += [reply("one", headers=hdr), reply("two")]
    with client_for(tmp_path, fake) as c:
        assert chat(c, project(c)).status_code == 200
        lim = c.get("/api/ai/status").json()["limits"]
        assert lim["tokens_remaining"] == 100 and lim["tokens_reset_in_s"] == 12 and lim["requests_remaining"] == 900
        r = chat(c, project(c))                                                         # needs far more than 100 tokens: waits for the reset first
        assert r.status_code == 200 and c.clock.slept == [pytest.approx(12.75)]
    assert len(fake.requests) == 2


def test_out_of_daily_requests_is_known_before_asking(tmp_path, fake):
    fake.queue.append(reply("last one", headers={"x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "2h"}))
    with client_for(tmp_path, fake) as c:
        assert chat(c, project(c)).status_code == 200
        r = chat(c, project(c))
        assert r.status_code == 429 and r.json()["error"]["details"]["scope"] == "day" and len(fake.requests) == 1


def test_backup_model_is_used_only_when_the_user_asks(tmp_path, fake):
    limited = err(429, "tokens per minute", headers={"retry-after": "40"})
    fake.queue += [limited]
    with client_for(tmp_path, fake) as c:
        pid = project(c)
        assert chat(c, pid).status_code == 429 and [r["body"]["model"] for r in fake.requests] == ["openai/gpt-oss-120b"]   # default: wait, no silent downgrade
        fake.queue.append(reply("from the backup"))
        j = chat(c, pid, on_limit="fallback").json()
        assert j["text"] == "from the backup" and j["model"] == "openai/gpt-oss-20b" and j["fallback_from"] == "openai/gpt-oss-120b"
    assert [r["body"]["model"] for r in fake.requests] == ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]


def test_both_models_limited_reports_the_shortest_wait(tmp_path, fake):
    fake.queue += [err(429, "tpm", headers={"retry-after": "50"}), err(429, "tpm", headers={"retry-after": "30"})]
    with client_for(tmp_path, fake) as c:
        e = chat(c, project(c), on_limit="fallback").json()["error"]
    assert e["details"]["retry_after_s"] == 30 and e["details"]["fallback_possible"] is False


def test_request_too_large_shrinks_the_context_and_learns_the_limit(tmp_path, fake):
    fake.queue += [err(413, "Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 6000, Requested 9334, please reduce your message size"), reply("fits now")]
    with client_for(tmp_path, fake) as c:
        assert chat(c, project(c, BIG)).json()["text"] == "fits now"
        assert c.get("/api/ai/status").json()["tpm"] == 6000
    assert est(fake.requests[1]["body"]["messages"]) < est(fake.requests[0]["body"]["messages"])


def test_parse_duration_formats():
    from apppanrom.ai import parse_duration
    assert parse_duration("7.66s") == 7.66 and parse_duration("2m59.56s") == pytest.approx(179.56) and parse_duration("1h2m3s") == 3723 and parse_duration("800ms") == 0.8
    assert parse_duration("2") == 2 and parse_duration("") is None and parse_duration(None) is None and parse_duration("soon") is None


def test_free_prompt_is_small_and_paid_prompt_is_large():
    from apppanrom.ai import est_tokens, system_prompt
    assert est_tokens(system_prompt("english", "free", False)) < 2600 and est_tokens(system_prompt("english", "free", True)) < 2800
    assert est_tokens(system_prompt("english", "dev", False)) > 6000


def test_trim_keeps_the_relevant_blocks_and_summarises_the_rest():
    from apppanrom.ai import trim_source
    t, trimmed = trim_source(BIG, 1200, {2 + 3 * 60}, {"helper_7"})
    assert trimmed and len(t) < 2500 and 'app_uruvakku("Big")' in t and "helper_60" in t and "helper_7" in t and "lines hidden" in t
    assert trim_source("a\n", 1000, set(), set()) == ("a", False)
