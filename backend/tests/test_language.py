from pathlib import Path

import pytest

from apppanrom.lang import compile_source, validate_app_id, validate_version

SAMPLE = Path(__file__).resolve().parents[2] / "examples" / "vanakkam.apn"

BASE = 'screen_uruvakku("home"):\n    title("Hi")\n'


def codes(src: str, **kw):
    r = compile_source(src, **kw)
    return r, [d.code for d in r.diagnostics]


def test_sample_compiles_to_ir():
    r = compile_source(SAMPLE.read_text(encoding="utf-8"))
    assert r.ok, r.diagnostics
    ir = r.ir
    assert ir["app"]["id"] == "com.apppanrom.vanakkam"
    assert ir["app"]["start_screen"] == "home"
    assert set(ir["screens"]) == {"home", "about"}
    assert "welcome" in ir["functions"]
    button = next(n for n in ir["screens"]["home"]["body"][1]["children"] if n.get("c") == "button")
    assert button["events"]["click_pannumbodhu"] == "welcome"


def test_defaults_from_project_metadata():
    r = compile_source(BASE, defaults={"name": "Proj", "app_id": "com.x.proj", "version": "2.1.0", "theme": "dark"})
    assert r.ok
    assert r.ir["app"] == {"name": "Proj", "id": "com.x.proj", "version": "2.1.0", "theme": "dark", "start_screen": "home"}


def test_source_overrides_defaults():
    r = compile_source('app_id_set("com.src.app")\n' + BASE, defaults={"app_id": "com.x.proj"})
    assert r.ir["app"]["id"] == "com.src.app"


@pytest.mark.parametrize("src,line,col,code", [
    ('screen_uruvakku("home"):\n\ttitle("x")\n', 2, 1, "tab_indent"),
    ('screen_uruvakku("home"):\n  title("x")\n', 2, 1, "bad_indent"),
    ('screen_uruvakku("home"):\ntitle("x")\n', 2, 1, "bad_indent"),
    ('mari a = "oops\n', 1, 10, "unclosed_string"),
    ('mari a = “hi”\n', 1, 10, "curly_quote"),
    ('mari = 3\n', 1, 6, "syntax"),
    ('mari a = (1 + \n', 2, 1, "unclosed_bracket"),
    ('mari a = 1 2\n', 1, 12, "syntax"),
    ('mari a = 1 $\n', 1, 12, "bad_char"),
])
def test_syntax_errors_have_positions(src, line, col, code):
    r = compile_source(src)
    assert not r.ok and r.ir is None
    d = r.diagnostics[0]
    assert (d.line, d.col, d.code) == (line, col, code)


def test_enna_na_without_colon_has_suggestion():
    r = compile_source('function f():\n    enna_na 1 > 0\n        return 1\n')
    assert r.diagnostics[0].suggestion


def test_unknown_function_suggests_closest():
    r, c = codes(BASE.replace('title("Hi")', 'text_kaatu("Hi")'))
    assert c == ["unknown_function"]
    assert "text_kaattu" in r.diagnostics[0].suggestion


def test_raw_python_and_shell_are_not_executable():
    for src in ['__import__("os").system("id")\n', 'exec("1")\n', 'eval("1")\n', 'import os\n', 'open("/etc/passwd")\n']:
        r = compile_source(src)
        assert not r.ok
    r, c = codes('function f():\n    system("rm -rf /")\n' + BASE)
    assert "unknown_function" in c


def test_not_implemented_features_are_reported_honestly():
    r, c = codes('function f():\n    api_json("https://x.com")\n' + BASE)
    assert c == ["not_implemented"]


def test_web_request_calls_are_checked_at_compile_time():
    ok = 'function got(r):\n    debug_log(r["status"])\nfunction f():\n    api_get("https://x.com/a", "got")\n    api_post("https://x.com/a", {"a": 1}, "got")\n    api_put("https://x.com/a", [1], "got")\n    api_delete("https://x.com/a", "got")\n'
    r, c = codes(ok + BASE)
    assert r.ok and c == [], c
    assert [p["permission"] for p in r.ir["permissions"]] == ["android.permission.INTERNET"]
    assert r.ir["permissions"][0]["used_by"] == ["api_delete", "api_get", "api_post", "api_put"]
    assert r.ir["permissions"][0]["runtime"] is False
    # Tanglish names are the same functions
    r2, c2 = codes('seyal got(r):\n    pathivu_pannu(r["status"])\nseyal f():\n    api_vaangu("https://x.com/a", "got")\n    api_anuppu("https://x.com/a", {}, "got")\n' + BASE)
    assert r2.ok, c2
    bad = lambda body: codes('function got(r):\n    debug_log(r["status"])\nfunction two(a, b):\n    debug_log(a)\nfunction f():\n    ' + body + '\n' + BASE)[1]
    assert bad('api_get("http://x.com/a", "got")') == ["api_needs_https"]
    assert bad('api_get("ftp://x.com/a", "got")') == ["api_needs_https"]
    assert bad('api_get("https://x.com/a", "nope")') == ["undefined_handler"]
    assert bad('api_get("https://x.com/a", "two")') == ["handler_params"]
    assert bad('api_get("https://x.com/a")') == ["arity"]
    assert bad('api_post("https://x.com/a", {}, got)') == ["function_as_value"]       # the handler goes in quotes
    assert bad('mari h = "got"\n    api_get("https://x.com/a", h)') == ["bad_handler"]
    assert bad('api_get(5, "got")') == ["type_mismatch"]


def test_runtime_permission_calls_are_checked_and_marked_as_runtime_permissions():
    src = 'function here(r):\n    debug_log(r["ok"])\nfunction f():\n    location_edu("here")\n    notification_kaattu("t", "x")\n'
    r, c = codes(src + BASE)
    assert r.ok and c == [], c
    runtime = {p["permission"]: p["runtime"] for p in r.ir["permissions"]}
    assert runtime == {"android.permission.ACCESS_COARSE_LOCATION": True, "android.permission.ACCESS_FINE_LOCATION": True, "android.permission.POST_NOTIFICATIONS": True}
    assert codes('function f():\n    location_edu("nope")\n' + BASE)[1] == ["undefined_handler"]
    assert codes('function f():\n    notification_kaattu("only title")\n' + BASE)[1] == ["arity"]
    # an app that uses neither has no permissions at all
    assert codes('function f():\n    debug_log(1)\n' + BASE)[0].ir["permissions"] == []


def test_undefined_variable_and_assignment():
    _, c = codes('function f():\n    x = 1\n' + BASE)
    assert c == ["undefined_variable"]
    _, c = codes('function f():\n    return y\n' + BASE)
    assert c == ["undefined_variable"]


def test_function_scoping_and_globals():
    r, _ = codes('mari n = 0\nfunction inc(by):\n    mari t = by\n    n = n + t\n' + BASE)
    assert r.ok
    _, c = codes('function a():\n    mari t = 1\nfunction b():\n    return t\n' + BASE)
    assert c == ["undefined_variable"]


def test_duplicate_declarations():
    assert "duplicate_function" in codes('function a():\n    return 1\nfunction a():\n    return 2\n' + BASE)[1]
    assert "duplicate_screen" in codes(BASE + BASE)[1]
    assert "duplicate_variable" in codes('mari a = 1\nmari a = 2\n' + BASE)[1]


def test_screen_rules():
    assert "no_screens" in codes('mari a = 1\n')[1]
    assert "unknown_screen" in codes('function go():\n    screen_ku_poo("nope")\n' + BASE)[1]
    assert "unknown_screen" in codes('app_start_screen("nope")\n' + BASE)[1]
    assert "nested_screen" in codes('screen_uruvakku("a"):\n    screen_uruvakku("b"):\n        title("x")\n')[1]


def test_components_only_in_screens():
    _, c = codes('function f():\n    text_kaattu("x")\n' + BASE)
    assert c == ["component_placement"]
    _, c = codes('text_kaattu("x")\n' + BASE)
    assert "top_level" in c


def test_handler_validation():
    s = lambda b: 'screen_uruvakku("home"):\n    ' + b + '\n'
    assert "undefined_handler" in codes(s('button("a", click_pannumbodhu=nope)'))[1]
    assert "bad_handler" in codes(s('button("a", click_pannumbodhu="nope")'))[1]
    assert "handler_params" in codes('function h(x):\n    return x\n' + s('button("a", click_pannumbodhu=h)'))[1]
    assert "unknown_option" in codes(s('button("a", click_pannumbod=h)'))[1]


def test_component_argument_validation():
    s = lambda b: 'screen_uruvakku("home"):\n    ' + b + '\n'
    assert "missing_arg" in codes(s('button()'))[1]
    assert "type_mismatch" in codes(s('input_uruvakku(5)'))[1]
    assert "needs_block" in codes(s('column_uruvakku()'))[1]
    assert "no_block" in codes(s('title("x"):\n        title("y")'))[1]
    assert "unknown_input" in codes('function f():\n    mari a = input_value("zzz")\n' + s('input_uruvakku("name")'))[1]


def test_style_validation():
    s = lambda st: 'screen_uruvakku("home"):\n    title("x", style=' + st + ')\n'
    assert compile_source(s('{"text_color": "#FFF", "font_size": 20, "text_align": "center"}')).ok
    assert "bad_style_value" in codes(s('{"text_color": "blue"}'))[1]
    assert "bad_style_value" in codes(s('{"font_size": 4}'))[1]
    assert "bad_style_value" in codes(s('{"text_align": "middle"}'))[1]
    assert "unknown_style" in codes(s('{"colour": "#fff"}'))[1]
    assert "unsupported_style" in codes(s('{"gradient": "#fff"}'))[1]
    assert compile_source(s('{"shadow": "soft", "clay": true, "background": "#A78BFA"}')).ok
    assert "bad_style_value" in codes(s('{"shadow": 4}'))[1]
    assert "bad_style_value" in codes(s('{"shadow": "huge"}'))[1]
    assert "bad_style_value" in codes(s('{"clay": "yes"}'))[1]
    for good in ['{"glass": true}', '{"neumorphic": true, "background": "#E5E7EB"}', '{"brutal": true}', '{"background": "#FFF", "background_to": "#000", "gradient_angle": 90}',
                 '{"animate": "pop", "animate_duration": 0.5, "animate_delay": 1}']:
        assert compile_source(s(good)).ok, good
    for bad in ['{"animate": "wobble"}', '{"animate_duration": 0}', '{"animate_duration": 99}', '{"gradient_angle": 361}', '{"background_to": "red"}', '{"glass": 1}']:
        assert "bad_style_value" in codes(s(bad))[1], bad
    assert "style_not_applicable" in codes(s('{"gap": 4}'))[1]
    assert "bad_style" in codes(s('5'))[1]


def test_style_is_scoped_to_component():
    r = compile_source('screen_uruvakku("home"):\n    button("a", click_pannumbodhu=f, style={"background": "#111111"})\n    button("b", click_pannumbodhu=f)\nfunction f():\n    return 1\n')
    assert r.ok
    a, b = r.ir["screens"]["home"]["body"]
    assert a["style"] is not None and b["style"] is None


def test_render_cannot_mutate_globals():
    _, c = codes('mari n = 0\nscreen_uruvakku("home"):\n    n = n + 1\n    title("x")\n')
    assert "render_mutation" in c


def test_type_mismatch_literals():
    _, c = codes('mari a = "x" + 1\n' + BASE)
    assert "type_mismatch" in c


def test_function_as_value_and_arity():
    assert "function_as_value" in codes('function f():\n    return 1\nmari a = f\n' + BASE)[1]
    assert "arity" in codes('function f(a):\n    return a\nmari b = f()\n' + BASE)[1]
    assert "arity" in codes('mari b = text_upper()\n' + BASE)[1]


def test_return_outside_function():
    assert "return_outside" in codes('screen_uruvakku("h"):\n    return 1\n')[1]


def test_app_metadata_validation():
    assert "bad_app_id" in codes('app_id_set("Bad Id")\n' + BASE)[1]
    assert "bad_app_id" in codes('app_id_set("com.example.class")\n' + BASE)[1]
    assert "bad_version" in codes('app_version_set("1.0")\n' + BASE)[1]
    assert "bad_theme" in codes('app_theme_set("neon")\n' + BASE)[1]
    assert validate_app_id("com.apppanrom.vanakkam") is None
    assert validate_version("1.2.3") is None


def test_control_flow_parses():
    src = '''function f(items):
    mari total = 0
    ovvoru x in items:
        enna_na x > 10:
            total = total + 10
        illana_enna x > 5:
            total = total + 5
        illana:
            total = total + 1
    irukkura_varai total < 100:
        total = total * 2
    try:
        data_save_pannu("t", total)
    catch error:
        error_kaattu(error)
    return total
''' + BASE
    assert compile_source(src).ok


def test_source_size_limit():
    r = compile_source("# " + "x" * 300_000)
    assert r.diagnostics[0].code == "source_too_large"


def test_deep_nesting_is_rejected_not_crashing():
    r = compile_source("mari a = " + "(" * 500 + "1" + ")" * 500 + "\n")
    assert not r.ok


def test_trailing_newline_cannot_sneak_past_identifier_checks():
    assert validate_app_id("com.x.app\n") is not None
    assert validate_version("1.0.0\n") is not None
    _, c = codes('screen_uruvakku("home"):\n    title("x", style={"text_color": "#FFF\\n"})\n')
    assert "bad_style_value" in c


@pytest.mark.parametrize("path", sorted((SAMPLE.parent).glob("*.apn")), ids=lambda p: p.name)
def test_all_shipped_examples_compile_cleanly(path):
    r = compile_source(path.read_text(encoding="utf-8"))
    assert r.ok and not r.diagnostics, [d.to_dict() for d in r.diagnostics]


def test_language_doc_mentions_every_spec_item():
    """Drift guard: docs/language.md must document every function, component and style in spec/schema.json."""
    import json
    spec = json.loads((SAMPLE.parents[1] / "spec" / "schema.json").read_text(encoding="utf-8"))
    doc = (SAMPLE.parents[1] / "docs" / "language.md").read_text(encoding="utf-8")
    missing = [n for group in ("functions", "components", "styles", "config_functions") for n in spec[group] if f"`{n}" not in doc]
    assert not missing, missing


# ------------------------------------------------------------------ Tanglish vocabulary
def test_tanglish_vocabulary_compiles_to_the_same_program():
    import json
    from apppanrom.lang.tanglish import detect_style, to_english, to_tanglish

    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if k not in ("pos", "kw_pos")}
        return [strip(x) for x in o] if isinstance(o, list) else o

    for name in ("vanakkam", "counter", "notes", "calculator", "showcase"):
        en = (SAMPLE.parents[1] / "examples" / f"{name}.apn").read_text(encoding="utf-8")
        ta = to_tanglish(en)
        assert detect_style(en) == "english" and detect_style(ta) == "tanglish" and ta != en
        assert to_english(ta) == en  # lossless round trip, comments and strings untouched
        a, b = compile_source(en), compile_source(ta)
        assert a.ok and b.ok
        assert json.dumps(strip(a.ir), sort_keys=True) == json.dumps(strip(b.ir), sort_keys=True)


def test_tanglish_conversion_never_touches_strings_or_comments():
    from apppanrom.lang.tanglish import to_tanglish
    src = 'mari s = "function return true"  # function in a comment\nfunction f():\n    return not true\n'
    out = to_tanglish(src)
    assert '"function return true"' in out and "# function in a comment" in out
    assert "seyal f():" in out and "thirumbi_kudu illaadha sari" in out


def test_tanglish_diagnostics_have_a_friendly_lead_in():
    r = compile_source('screen_uruvakku("home"):\n    text_kaattu(naan)\n')
    d = [x for x in r.diagnostics if x.code == "undefined_variable"][0]
    assert d.ta and "variable" in d.ta
    assert "ta" in d.to_dict()


def test_convert_endpoint(client):
    r = client.post("/api/language/convert", json={"source": "function f():\n    return true\n", "to": "tanglish"}).json()
    assert r["source"] == "seyal f():\n    thirumbi_kudu sari\n" and r["style"] == "tanglish"
    assert client.post("/api/language/convert", json={"source": r["source"], "to": "english"}).json()["source"] == "function f():\n    return true\n"


def test_designer_keeps_a_tanglish_file_in_tanglish():
    from apppanrom.lang.designer import apply_op
    src = 'app_uruvakku("x")\nseyal go():\n    summa\nscreen_uruvakku("home"):\n    thalaippu("a")\n    batan("b", click_pannumbodhu=go)\n    thalaippu("c")\n'
    out = apply_op(src, {"kind": "insert", "type": "button", "target_line": 5, "position": "after"})["source"]
    assert "batan(" in out and "button(" not in out
    assert compile_source(out).ok


def test_handlers_with_arguments_are_checked():
    base = 'mari items = ["a"]\nfunction del_item(i):\n    remove(items, i)\nfunction plain():\n    summa\nscreen_uruvakku("home"):\n    ovvoru i in range(length(items)):\n        button("x", click_pannumbodhu=%s)\n'
    assert compile_source(base % "del_item(i)").ok
    assert compile_source(base % "plain").ok
    for bad, code in [("del_item", "handler_params"), ("del_item(i, 1)", "handler_params"), ("plain(i)", "handler_params"), ("nope(i)", "undefined_handler"), ("del_item(k)", "undefined_variable")]:
        assert code in [d.code for d in compile_source(base % bad).diagnostics], bad


def test_flagship_machan_app_is_tanglish_and_equivalent_in_english():
    import json
    from apppanrom.lang.tanglish import detect_style, to_english

    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if k not in ("pos", "kw_pos")}
        return [strip(x) for x in o] if isinstance(o, list) else o

    ta = (SAMPLE.parents[1] / "examples" / "machan.apn").read_text(encoding="utf-8")
    assert detect_style(ta) == "tanglish" and "seyal " in ta and "thirumbi_kudu" in ta and "batan(" in ta
    en = to_english(ta)
    a, b = compile_source(ta), compile_source(en)
    assert a.ok and b.ok and not a.diagnostics
    assert json.dumps(strip(a.ir), sort_keys=True) == json.dumps(strip(b.ir), sort_keys=True)
    assert sorted(a.ir["permissions"]) == sorted(["VIBRATE"]) or a.ir["permissions"]


def test_navbar_and_tabbar_rules():
    ok = ('app_uruvakku("t")\nfunction go():\n    screen_maathu("two")\nscreen_uruvakku("one"):\n'
          '    navbar_uruvakku(title="Hi", subtitle="s", align="center", back=false, style={"background": "#4F46E5"}):\n        nav_action("Go", icon="+", click_pannumbodhu=go)\n'
          '    text_kaattu("x")\n    tabbar_uruvakku():\n        tab_item("One", icon="1", go="one")\n        tab_item("Two", go="two")\nscreen_uruvakku("two"):\n    navbar_uruvakku(visible=false)\n    text_kaattu("y")\n')
    assert compile_source(ok).ok
    cases = {
        "nav_action outside a navbar": ok.replace('    text_kaattu("x")', '    nav_action("x")'),
        "navbar nested in a column": ok.replace('    text_kaattu("x")', '    column_uruvakku():\n        navbar_uruvakku()'),
        "second navbar": ok.replace('    text_kaattu("x")', '    navbar_uruvakku():\n        summa'),
        "bad align": ok.replace('align="center"', 'align="middle"'),
        "unknown tab target": ok.replace('go="two")', 'go="nope")'),
        "non-action in navbar": ok.replace('        nav_action("Go", icon="+", click_pannumbodhu=go)', '        text_kaattu("no")'),
        "unknown screen_maathu target": ok.replace('screen_maathu("two")', 'screen_maathu("zzz")'),
    }
    for what, src in cases.items():
        assert not compile_source(src).ok, what
