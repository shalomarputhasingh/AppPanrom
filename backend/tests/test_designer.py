import pytest

from apppanrom.lang import compile_source
from apppanrom.lang.designer import DesignError, apply_op, describe, parse_expression, unparse

BASE = '''app_uruvakku("D")
function go():
    toast_kaattu("hi")

screen_uruvakku("home"):
    column_uruvakku(style={"gap": 8}):
        title("Hello")
        button("Go", click_pannumbodhu=go)
    text_kaattu("Footer")
'''


def ok(src):
    r = compile_source(src)
    assert r.ok, [d.to_dict() for d in r.diagnostics]
    return r


def op(src, **kw):
    out = apply_op(src, kw)
    ok(out["source"])
    return out


def test_summa_is_a_valid_noop_statement():
    ok('screen_uruvakku("a"):\n    column_uruvakku():\n        summa\n')


def test_insert_inside_container_appends_at_container_indent():
    out = op(BASE, kind="insert", type="text_kaattu", target_line=6, position="inside")
    lines = out["source"].split("\n")
    assert lines[out["line"] - 1] == '        text_kaattu("Text")'
    assert lines[out["line"] - 2].strip().startswith("button(")


def test_insert_before_and_after_use_target_indent():
    out = op(BASE, kind="insert", type="divider_kaattu", target_line=8, position="before")
    assert out["source"].split("\n")[7] == "        divider_kaattu()"
    out = op(BASE, kind="insert", type="divider_kaattu", target_line=6, position="after")  # after the whole column block
    assert out["source"].split("\n")[out["line"] - 1] == "    divider_kaattu()"
    assert out["line"] == 9


def test_insert_into_screen_end():
    out = op(BASE, kind="insert", type="title", screen="home")
    assert out["source"].rstrip().endswith('    title("Title")')


def test_new_container_gets_summa_placeholder_and_accepts_drops():
    out = op(BASE, kind="insert", type="card_uruvakku", screen="home")
    assert "    card_uruvakku(" in out["source"] and out["source"].rstrip().endswith("summa")
    line = out["line"]
    out2 = op(out["source"], kind="insert", type="button", target_line=line, position="inside")
    assert "summa" not in out2["source"].split("card_uruvakku")[1]  # placeholder replaced
    assert 'button("Button")' in out2["source"]


def test_input_names_are_unique():
    s = BASE
    for _ in range(3):
        s = op(s, kind="insert", type="input_uruvakku", screen="home")["source"]
    assert all(f'"input{i}"' in s for i in (1, 2, 3))


def test_delete_removes_whole_block_and_fills_empty_parent():
    out = op(BASE, kind="delete", line=6)
    assert "column_uruvakku" not in out["source"] and "Hello" not in out["source"]
    s = op(BASE, kind="delete", line=8)["source"]
    s = op(s, kind="delete", line=7)["source"]
    assert "column_uruvakku" in s and "summa" in s


def test_delete_last_child_of_screen_leaves_summa():
    s = 'screen_uruvakku("a"):\n    title("x")\n'
    out = op(s, kind="delete", line=2)
    assert out["source"].strip().endswith("summa")


def test_move_reorders_within_container():
    out = op(BASE, kind="move", line=8, target_line=7, position="before")
    lines = out["source"].split("\n")
    assert lines[6].strip().startswith("button(") and lines[7].strip().startswith("title(")


def test_move_out_of_container_reindents():
    out = op(BASE, kind="move", line=7, target_line=9, position="after")
    lines = out["source"].split("\n")
    assert lines[-2] == '    title("Hello")' and lines[out["line"] - 1] == '    title("Hello")'


def test_move_into_container_reindents_deeper():
    out = op(BASE, kind="move", line=9, target_line=6, position="inside")
    assert out["source"].split("\n")[-2] == '        text_kaattu("Footer")'


def test_move_whole_container_with_children():
    out = op(BASE, kind="move", line=6, target_line=9, position="after")
    src = out["source"]
    assert src.index("Footer") < src.index("column_uruvakku")
    assert src.count("button(") == 1


def test_move_into_itself_is_rejected():
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "move", "line": 6, "target_line": 7, "position": "inside"})
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "move", "line": 6, "target_line": 6, "position": "after"})


def test_moving_only_child_out_leaves_summa_behind():
    s = 'screen_uruvakku("a"):\n    column_uruvakku():\n        title("x")\n    text_kaattu("y")\n'
    out = op(s, kind="move", line=3, target_line=4, position="after")
    assert "summa" in out["source"]


def test_duplicate_renames_inputs():
    s = op(BASE, kind="insert", type="input_uruvakku", screen="home")["source"]
    line = [i + 1 for i, l in enumerate(s.split("\n")) if "input_uruvakku" in l][0]
    out = op(s, kind="duplicate", line=line)
    assert '"input1"' in out["source"] and '"input2"' in out["source"]
    out = op(BASE, kind="duplicate", line=6)  # container with children
    assert out["source"].count("column_uruvakku") == 2


def test_set_prop_literal_and_expression():
    out = op(BASE, kind="set_prop", line=7, name="text", value={"literal": 'He said "hi"\n'})
    assert 'title("He said \\"hi\\"\\n")' in out["source"]
    out = op(BASE, kind="set_prop", line=8, name="label", value={"expr": 'str(1 + 2) + "x"'})
    assert 'button(str(1 + 2) + "x", click_pannumbodhu=go)' in out["source"]
    out = op(BASE, kind="set_prop", line=8, name="enabled", value={"literal": False})
    assert "enabled=false" in out["source"]
    out2 = op(out["source"], kind="set_prop", line=8, name="enabled", value=None)
    assert "enabled" not in out2["source"]


def test_set_style_add_change_remove_and_cleanup():
    out = op(BASE, kind="set_style", line=7, key="font_size", value={"literal": 30})
    assert 'title("Hello", style={"font_size": 30})' in out["source"]
    out = op(out["source"], kind="set_style", line=7, key="text_color", value={"literal": "#FF0000"})
    out = op(out["source"], kind="set_style", line=7, key="font_size", value={"literal": 12})
    assert '{"font_size": 12, "text_color": "#FF0000"}' in out["source"]
    out = op(out["source"], kind="set_style", line=7, key="font_size", value=None)
    out = op(out["source"], kind="set_style", line=7, key="text_color", value=None)
    assert 'title("Hello")' in out["source"] and "style" not in out["source"].split("title(")[1].split("\n")[0]


def test_set_style_on_container_preserves_block():
    out = op(BASE, kind="set_style", line=6, key="padding", value={"literal": 24})
    assert 'column_uruvakku(style={"gap": 8, "padding": 24}):' in out["source"]
    assert 'title("Hello")' in out["source"]


def test_invalid_values_are_rejected_not_written():
    with pytest.raises(DesignError, match="Invalid value for style"):
        apply_op(BASE, {"kind": "set_style", "line": 7, "key": "font_size", "value": {"literal": 4}})
    with pytest.raises(DesignError, match="Invalid value for style"):
        apply_op(BASE, {"kind": "set_style", "line": 7, "key": "text_color", "value": {"literal": "red"}})
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "set_style", "line": 8, "key": "gap", "value": {"literal": 4}})  # not applicable to button
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "set_prop", "line": 7, "name": "text", "value": {"expr": "1 +"}})
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "set_prop", "line": 7, "name": "nope", "value": {"literal": 1}})
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "set_prop", "line": 7, "name": "text", "value": {"expr": "undefined_var"}})


def test_set_event_and_create_handler():
    out = op(BASE, kind="set_event", line=8, event="click_pannumbodhu", function=None)
    assert 'button("Go")' in out["source"]
    out = op(out["source"], kind="create_handler", name="save_it")
    assert "function save_it():" in out["source"]
    ln = [i + 1 for i, l in enumerate(out["source"].split("\n")) if "button(" in l][0]
    out = op(out["source"], kind="set_event", line=ln, event="click_pannumbodhu", function="save_it")
    assert 'button("Go", click_pannumbodhu=save_it)' in out["source"]
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "set_event", "line": 8, "event": "click_pannumbodhu", "function": "nope"})


def test_add_screen():
    out = op(BASE, kind="add_screen", name="details")
    assert 'screen_uruvakku("details"):' in out["source"]
    with pytest.raises(DesignError):
        apply_op(out["source"], {"kind": "add_screen", "name": "details"})
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "add_screen", "name": "bad name"})


def test_long_header_is_wrapped_and_still_valid():
    out = op(BASE, kind="set_prop", line=8, name="label", value={"literal": "x" * 120})
    assert "button(\n" in out["source"]
    ok(out["source"])


def test_describe_for_inspector():
    d = describe(BASE, 8)
    assert d["component"] == "button" and d["events"] == {"click_pannumbodhu": "go"}
    assert d["props"]["label"]["literal"] == {"type": "str", "value": "Go"}
    assert "go" in d["handlers"] and "background" in d["allowed"]["style"] and "gap" not in d["allowed"]["style"]
    d = describe(BASE, 6)
    assert d["container"] and d["style"]["gap"]["literal"]["value"] == 8 and "gap" in d["allowed"]["style"]
    s = describe(BASE, 5)
    assert s["kind"] == "screen" and s["name"] == "home"


def test_edits_refuse_non_components_and_broken_source():
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "delete", "line": 2})  # a function
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "delete", "line": 5})  # a screen
    with pytest.raises(DesignError, match="syntax"):
        apply_op("button(", {"kind": "delete", "line": 1})
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "bogus"})
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "insert", "type": "nope", "screen": "home"})
    with pytest.raises(DesignError):
        apply_op(BASE, {"kind": "insert", "type": "title", "target_line": 8, "position": "inside"})  # leaf


@pytest.mark.parametrize("src", ["1 + 2 * 3", "(1 + 2) * 3", "not (a and b)", "a - (b - c)", "-(1 + 2)", 'f(x, "y")[0]', '{"a": [1, 2]}', "a < b and not c"])
def test_unparse_roundtrips_semantically(src):
    e1 = parse_expression(src)
    e2 = parse_expression(unparse(e1))
    strip = lambda n: __import__("json").dumps(n, default=str, sort_keys=True)
    import re
    clean = lambda n: re.sub(r'"pos": \[\d+, \d+\],? ?', "", strip(n))
    assert clean(e1) == clean(e2)


def test_many_random_edits_keep_source_compilable():
    import random
    rnd = random.Random(7)
    s = BASE
    types = ["title", "text_kaattu", "button", "input_uruvakku", "card_uruvakku", "row_uruvakku", "column_uruvakku", "list_kaattu", "divider_kaattu"]
    for _ in range(150):
        from apppanrom.lang.parser import parse
        prog = parse(s)
        comps = []
        def walk(stmts):
            for n in stmts:
                if n["t"] in ("call_stmt", "block_call") and n["f"] != "screen_title":
                    comps.append(n)
                for key in ("children", "body", "handler", "else"):
                    if isinstance(n.get(key), list) and n["t"] != "function":
                        walk(n[key])
        walk(prog)
        movable = [n for n in comps if n["f"] != "screen_uruvakku"]
        choice = rnd.choice(["insert", "move", "delete", "duplicate"])
        try:
            if choice == "insert" or not movable:
                t = rnd.choice(comps)
                pos = rnd.choice(["before", "after", "inside"])
                out = apply_op(s, {"kind": "insert", "type": rnd.choice(types), "target_line": t["pos"][0], "position": pos})
            elif choice == "move":
                a, t = rnd.choice(movable), rnd.choice(comps)
                out = apply_op(s, {"kind": "move", "line": a["pos"][0], "target_line": t["pos"][0], "position": rnd.choice(["before", "after", "inside"])})
            elif choice == "delete":
                out = apply_op(s, {"kind": "delete", "line": rnd.choice(movable)["pos"][0]})
            else:
                out = apply_op(s, {"kind": "duplicate", "line": rnd.choice(movable)["pos"][0]})
        except DesignError:
            continue  # rejected edits must leave the source untouched
        r = compile_source(out["source"])
        assert not [d for d in r.diagnostics if d.severity == "error" and d.code in ("syntax", "bad_indent", "needs_block", "undefined_handler")], out["source"]
        s = out["source"]


def test_set_styles_is_one_atomic_edit_and_works_on_screens():
    src = 'app_uruvakku("x")\nscreen_uruvakku("home"):\n    title("a")\n'
    r = apply_op(src, {"kind": "set_styles", "line": 3, "styles": {"background": {"literal": "#C4B5FD"}, "clay": {"literal": True}, "corner_radius": {"literal": 28}}})
    assert 'title("a", style={"background": "#C4B5FD", "clay": true, "corner_radius": 28})' in r["source"]
    r2 = apply_op(r["source"], {"kind": "set_styles", "line": 3, "styles": {"clay": None, "background": None, "corner_radius": None}})
    assert 'title("a")' in r2["source"] and "style" not in r2["source"].split("\n")[2]
    # screens can be styled too
    r3 = apply_op(src, {"kind": "set_styles", "line": 2, "styles": {"background": {"literal": "#E9E4FF"}}})
    assert 'screen_uruvakku("home", style={"background": "#E9E4FF"}):' in r3["source"]


def test_set_styles_rejects_bad_batches_without_partial_changes():
    src = 'app_uruvakku("x")\nscreen_uruvakku("home"):\n    title("a")\n'
    for styles in [{}, {"nope": {"literal": 1}}, {"clay": {"literal": "yes"}}, {"padding": {"literal": 5}, "gradient": {"literal": "#fff"}}, "x"]:
        with pytest.raises(DesignError):
            apply_op(src, {"kind": "set_styles", "line": 3, "styles": styles})
    with pytest.raises(DesignError):  # 'gap' is a flow style; a title does not take it
        apply_op(src, {"kind": "set_styles", "line": 3, "styles": {"gap": {"literal": 4}}})


# ------------------------------------------------------------------ settings menu: app-level edits
APP_SRC = '# my app\napp_uruvakku("Old")\n\nmari count = 0\n\nfunction bump():\n    count = count + 1\n\nscreen_uruvakku("home"):\n    button("go", click_pannumbodhu=bump)\n    button("next", click_pannumbodhu=go_next)\n\nfunction go_next():\n    screen_ku_poo("second")\n\nscreen_uruvakku("second"):\n    text_kaattu("hi")\n'


def test_set_app_settings_edit_or_insert_lines():
    from apppanrom.lang.designer import describe_app
    s = apply_op(APP_SRC, {"kind": "set_app", "key": "name", "value": "New Name"})["source"]
    assert 'app_uruvakku("New Name")' in s and "Old" not in s
    s = apply_op(s, {"kind": "set_app", "key": "id", "value": "com.me.app"})["source"]
    s = apply_op(s, {"kind": "set_app", "key": "version", "value": "2.3.4"})["source"]
    s = apply_op(s, {"kind": "set_app", "key": "theme", "value": "dark"})["source"]
    s = apply_op(s, {"kind": "set_app", "key": "start_screen", "value": "second"})["source"]
    d = describe_app(s)
    assert d["code"] == {"name": "New Name", "id": "com.me.app", "version": "2.3.4", "theme": "dark", "start_screen": "second"}
    assert s.startswith("# my app\n") and compile_source(s).ok
    s2 = apply_op(s, {"kind": "set_app", "key": "theme", "value": None})["source"]
    assert describe_app(s2)["code"]["theme"] is None
    for bad in [{"key": "id", "value": "Not An Id"}, {"key": "version", "value": "x"}, {"key": "theme", "value": "pink"}, {"key": "start_screen", "value": "nope"}, {"key": "name", "value": ""}, {"key": "zzz", "value": "a"}]:
        with pytest.raises(DesignError):
            apply_op(APP_SRC, {"kind": "set_app", **bad})


def test_globals_add_edit_delete():
    from apppanrom.lang.designer import describe_app
    s = apply_op(APP_SRC, {"kind": "add_global", "name": "total", "expr": "1 + 2"})["source"]
    assert "mari total = 1 + 2" in s and [g["name"] for g in describe_app(s)["globals"]] == ["count", "total"]
    s = apply_op(s, {"kind": "set_global", "name": "total", "expr": '"hello"'})["source"]
    assert 'mari total = "hello"' in s
    s = apply_op(s, {"kind": "delete_global", "name": "total"})["source"]
    assert "total" not in s
    with pytest.raises(DesignError):
        apply_op(s, {"kind": "delete_global", "name": "count"})  # still used by bump()
    with pytest.raises(DesignError):
        apply_op(s, {"kind": "add_global", "name": "count", "expr": "1"})
    with pytest.raises(DesignError):
        apply_op(s, {"kind": "add_global", "name": "bad name", "expr": "1"})
    with pytest.raises(DesignError):
        apply_op(s, {"kind": "add_global", "name": "x", "expr": "1 +"})
    # first global in a file without any
    t = apply_op('screen_uruvakku("home"):\n    text_kaattu("a")\n', {"kind": "add_global", "name": "n", "expr": "5"})["source"]
    assert t.startswith("mari n = 5") and compile_source(t).ok


def test_rename_and_delete_screen_update_references():
    s = apply_op(APP_SRC, {"kind": "rename_screen", "name": "second", "new_name": "settings"})["source"]
    assert 'screen_uruvakku("settings")' in s and 'screen_ku_poo("settings")' in s and "second" not in s
    assert compile_source(s).ok
    with pytest.raises(DesignError):
        apply_op(s, {"kind": "rename_screen", "name": "settings", "new_name": "home"})
    with pytest.raises(DesignError):
        apply_op(s, {"kind": "delete_screen", "name": "settings"})  # still navigated to
    t = apply_op(s, {"kind": "set_app", "key": "start_screen", "value": "home"})["source"]
    t = t.replace('    screen_ku_poo("settings")', "    summa")
    t = apply_op(t, {"kind": "delete_screen", "name": "settings"})["source"]
    assert "settings" not in t and compile_source(t).ok
    with pytest.raises(DesignError):
        apply_op(t, {"kind": "delete_screen", "name": "home"})  # last screen


def test_design_app_endpoint_and_edit_roundtrip(client):
    p = client.post("/api/projects", json={"name": "Settings App"}).json()
    d = client.post(f"/api/projects/{p['id']}/design/app", json={}).json()
    assert [s["name"] for s in d["screens"]] and "code" in d and d["style"] == "english"
    src = client.get(f"/api/projects/{p['id']}/files/main.apn").json()["content"]
    r = client.post(f"/api/projects/{p['id']}/design/edit", json={"source": src, "op": {"kind": "set_app", "key": "version", "value": "9.9.9"}})
    assert r.status_code == 200 and 'app_version_set("9.9.9")' in r.json()["source"]
    bad = client.post(f"/api/projects/{p['id']}/design/edit", json={"source": src, "op": {"kind": "set_app", "key": "version", "value": "banana"}})
    assert bad.status_code == 422
    assert client.post(f"/api/projects/{p['id']}/design/app", json={"source": "mari ="}).status_code == 422


# ------------------------------------------------------------------ top bar / tab bar
BARS_SRC = 'app_uruvakku("x")\nscreen_uruvakku("home"):\n    screen_title("Home")\n    text_kaattu("hi")\nscreen_uruvakku("other"):\n    summa\n'


def test_navbar_all_creates_updates_hides_and_removes():
    from apppanrom.lang.designer import describe_app
    s = apply_op(BARS_SRC, {"kind": "navbar_all", "props": {"align": {"literal": "center"}}, "style": {"background": {"literal": "#4F46E5"}, "glass": {"literal": True}}})["source"]
    assert s.count("navbar_uruvakku(") == 2 and compile_source(s).ok
    assert s.index("screen_title") < s.index("navbar_uruvakku") < s.index("text_kaattu")   # after the title, before the content
    assert describe_app(s)["bars"]["navbar"] == ["home", "other"]
    s = apply_op(s, {"kind": "navbar_all", "props": {"visible": {"literal": False}}})["source"]
    assert s.count("visible=false") == 2
    s = apply_op(s, {"kind": "navbar_all", "props": {"visible": None, "align": None}, "style": {"glass": None}})["source"]
    assert "visible" not in s and "align" not in s and "glass" not in s and "#4F46E5" in s
    assert apply_op(BARS_SRC, {"kind": "navbar_all", "props": {"back": None}})["source"] == BARS_SRC       # nothing to set: nothing created
    s = apply_op(s, {"kind": "navbar_all", "remove": True})["source"]
    assert "navbar_uruvakku" not in s and compile_source(s).ok
    with pytest.raises(DesignError):
        apply_op(BARS_SRC, {"kind": "navbar_all", "props": {"align": {"literal": "middle"}}})
    only = apply_op(BARS_SRC, {"kind": "navbar_all", "screens": ["other"], "props": {"subtitle": {"literal": "s"}}})["source"]
    assert only.count("navbar_uruvakku") == 1 and "summa" not in only.split('screen_uruvakku("other")')[1]


def test_tabs_all_replaces_and_removes():
    from apppanrom.lang.designer import describe_app
    tabs = [{"label": "Home", "icon": "H", "go": "home"}, {"label": "Other", "icon": "O", "go": "other"}]
    s = apply_op(BARS_SRC, {"kind": "tabs_all", "tabs": tabs})["source"]
    assert s.count("tabbar_uruvakku") == 2 and s.count("tab_item(") == 4 and compile_source(s).ok
    s = apply_op(s, {"kind": "tabs_all", "tabs": [{"label": "Only", "go": "home"}]})["source"]
    assert s.count("tabbar_uruvakku") == 2 and s.count("tab_item(") == 2          # replaced, not duplicated
    s = apply_op(s, {"kind": "tabs_all", "tabs": []})["source"]
    assert "tabbar" not in s and describe_app(s)["bars"]["tabbar"] == []
    with pytest.raises(DesignError):
        apply_op(BARS_SRC, {"kind": "tabs_all", "tabs": [{"label": "X", "go": "nope"}]})   # unknown screen
    with pytest.raises(DesignError):
        apply_op(BARS_SRC, {"kind": "tabs_all", "tabs": [{"label": str(i)} for i in range(6)]})


def test_bar_pieces_only_go_where_they_fit():
    s = apply_op(BARS_SRC, {"kind": "insert", "type": "navbar_uruvakku", "screen": "home"})["source"]
    s = apply_op(s, {"kind": "insert", "type": "tabbar_uruvakku", "screen": "home"})["source"]
    assert "tab_item(" in s and compile_source(s).ok
    for op in [{"type": "navbar_uruvakku", "screen": "home"}, {"type": "tabbar_uruvakku", "screen": "home"}, {"type": "nav_action", "screen": "home"},
               {"type": "tab_item", "screen": "home"}, {"type": "text_kaattu", "target_line": 4, "position": "inside"}]:
        with pytest.raises(DesignError):
            apply_op(s, {"kind": "insert", **op})
    ok = apply_op(s, {"kind": "insert", "type": "nav_action", "target_line": 4, "position": "inside"})["source"]
    assert 'nav_action("Action"' in ok and compile_source(ok).ok
