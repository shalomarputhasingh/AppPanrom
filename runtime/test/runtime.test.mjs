import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AP, SPEC, boot, compile, flat } from './helpers.mjs';

const wrap = (fnBody, screenBody = '    title("x")') =>
  `${fnBody}\nscreen_uruvakku("home"):\n${screenBody}\n`;

test('runtime stdlib matches spec/schema.json exactly', () => {
  assert.deepEqual(AP.stdlibNames().sort(), Object.keys(SPEC.functions).sort());
});

test('runtime component list matches spec/schema.json exactly', () => {
  assert.deepEqual([...AP.COMPONENT_NAMES].sort(), Object.keys(SPEC.components).sort());
});

test('sample app renders view tree from IR', () => {
  const src = readFileSync(new URL('../../examples/vanakkam.apn', import.meta.url), 'utf8');
  const { rt } = boot(src);
  const view = rt.render();
  assert.equal(view.screen, 'home');
  assert.equal(view.title, 'Vanakkam');
  const kinds = flat(view).map((n) => n.c);
  assert.deepEqual(kinds.slice(0, 5), ['column_uruvakku', 'title', 'text_kaattu', 'input_uruvakku', 'button']);
  assert.equal(view.style.background, '#F3F4F6');
});

test('typing into input, button click, message and state update', () => {
  const src = readFileSync(new URL('../../examples/vanakkam.apn', import.meta.url), 'utf8');
  const { rt, messages, toasts } = boot(src);
  let v = rt.render();
  assert.ok(!flat(v).some((n) => n.props.text && n.props.text.startsWith('Button click count')));
  rt.fire('welcome'); // empty name -> toast
  assert.equal(toasts.length, 1);
  rt.setInputFromUI('name', 'Shalom');
  rt.fire('welcome');
  assert.deepEqual(messages, ['Vanakkam Shalom!']);
  v = rt.render();
  assert.ok(flat(v).some((n) => n.props.text === 'Button click count: 2'));
});

test('navigation: forward, back, unknown target, data passing', () => {
  const { rt } = boot(wrap(
    `function go():\n    screen_data_set("who", "Nanba")\n    screen_ku_poo("two")\nfunction back():\n    screen_back_poo()\nfunction bad():\n    screen_ku_poo(str("zzz"))`,
    '    button("go", click_pannumbodhu=go)\n    button("bad", click_pannumbodhu=bad)',
  ) + 'screen_uruvakku("two"):\n    text_kaattu("Hi " + screen_data_get("who"))\n    button("b", click_pannumbodhu=back)\n');
  rt.fire('go');
  let v = rt.render();
  assert.equal(v.screen, 'two');
  assert.equal(flat(v)[0].props.text, 'Hi Nanba');
  assert.equal(rt.canGoBack(), true);
  rt.fire('back');
  assert.equal(rt.render().screen, 'home');
  assert.equal(rt.goBack(), false);
});

test('unknown screen at runtime is a logged error, not a crash', () => {
  const { rt, logs } = boot(wrap('function bad():\n    screen_ku_poo(str("zzz"))', '    button("b", click_pannumbodhu=bad)'));
  rt.fire('bad');
  assert.match(logs.at(-1).text, /Screen 'zzz' does not exist/);
  assert.match(logs.at(-1).text, /line 2/);
});

function run(body, expr) {
  const { rt } = boot(wrap(`function f():\n${body.split('\n').map((l) => '    ' + l).join('\n')}`));
  return rt.callFunction('f', []);
}

test('expressions, operators and truthiness', () => {
  assert.equal(run('return 1 + 2 * 3 - 4 / 2'), 5);
  assert.equal(run('return 7 % 4'), 3);
  assert.equal(run('return "a" + "b"'), 'ab');
  assert.equal(run('return 1 < 2 and not (2 < 1)'), true);
  assert.equal(run('return [1, 2] == [1, 2]'), true);
  assert.equal(run('return "" or 0'), false);
  assert.equal(run('return -(3)'), -3);
});

test('strict typing: no silent coercion', () => {
  assert.throws(() => run('mari a = "a"\nreturn a + 1'), /Cannot use '\+' between text and number\. Use str/);
  assert.throws(() => run('mari a = "a"\nreturn 1 < a'), /Cannot compare/);
  assert.throws(() => run('mari z = 0\nreturn 1 / z'), /Division by zero/);
  assert.throws(() => run('return int("abc")'), /Cannot convert/);
  assert.throws(() => run('return text_upper(5)'), /must be text/);
});

test('conditionals, loops, functions, recursion', () => {
  const { rt } = boot(wrap(`function classify(n):
    enna_na n > 10:
        return "periya"
    illana_enna n > 5:
        return "medium"
    illana:
        return "small"

function sum_to(n):
    mari total = 0
    mari i = 0
    irukkura_varai i < n:
        i = i + 1
        total = total + i
    return total

function items_len():
    mari c = 0
    ovvoru x in ["a", "b", "c"]:
        c = c + 1
    ovvoru i in range(4):
        c = c + i
    return c

function fact(n):
    enna_na n <= 1:
        return 1
    return n * fact(n - 1)`));
  assert.equal(rt.callFunction('classify', [11]), 'periya');
  assert.equal(rt.callFunction('classify', [6]), 'medium');
  assert.equal(rt.callFunction('classify', [1]), 'small');
  assert.equal(rt.callFunction('sum_to', [100]), 5050);
  assert.equal(rt.callFunction('items_len', []), 9);
  assert.equal(rt.callFunction('fact', [10]), 3628800);
});

test('try/catch catches runtime errors, error is text', () => {
  const r = run(`mari msg = ""
try:
    mari z = 0
    mari x = 1 / z
catch error:
    msg = error
return msg`);
  assert.match(r, /Division by zero/);
});

test('collections and stdlib', () => {
  assert.equal(run('mari l = [3, 1, 2]\nappend(l, 0)\nreturn text_join(sort(l), ",")'), '0,1,2,3');
  assert.equal(run('mari l = [1, 2, 3]\nreturn remove(l, 1) + length(l)'), 4);
  assert.equal(run('mari d = {"a": 1}\nd["b"] = 2\nreturn length(d) + d["b"]'), 4);
  assert.equal(run('mari d = {"a": 1}\nreturn dict_get(d, "zz", 9)'), 9);
  assert.throws(() => run('mari d = {"a": 1}\nreturn d["zz"]'), /not found/);
  assert.throws(() => run('mari l = [1]\nreturn l[5]'), /out of range/);
  assert.equal(run('return text_replace("a-b-c", "-", "+")'), 'a+b+c');
  assert.equal(run('return text_split("a,b", ",")[1]'), 'b');
  assert.equal(run('return text_contains("Vanakkam", "nak")'), true);
  assert.equal(run('return round(3.14159, 2)'), 3.14);
  assert.equal(run('return max([4, 9, 2]) + min(1, 2) + abs(-3) + sum([1, 2])'), 16);
  assert.equal(run('return json_decode(json_encode({"x": [1, 2]}))["x"][1]'), 2);
  assert.throws(() => run('return json_decode("{bad")'), /invalid JSON/);
  assert.equal(run('return type_of([]) + type_of({}) + type_of(1) + type_of("s") + type_of(null) + type_of(true)'), 'listdictnumbertextnullbool');
  assert.equal(run('return str(1.5) + str([1, "a"]) + str(null)'), '1.5[1, "a"]null');
  const n = run('return random_number(3, 3)');
  assert.equal(n, 3);
  assert.match(run('return now_iso()'), /^\d{4}-\d\d-\d\dT/);
});

test('step limit stops endless loops and cannot be caught', () => {
  const { rt, logs } = boot(wrap('function spin():\n    try:\n        irukkura_varai true:\n            mari x = 1\n    catch error:\n        error_kaattu("caught")\n', '    button("b", click_pannumbodhu=spin)'));
  const t0 = Date.now();
  rt.fire('spin');
  assert.ok(Date.now() - t0 < 5000);
  assert.match(logs.at(-1).text, /ran too long/);
  assert.ok(!logs.some((l) => l.text === 'caught'));
});

test('recursion limit', () => {
  const { rt, logs } = boot(wrap('function r(n):\n    return r(n + 1)\nfunction go():\n    r(0)', '    button("b", click_pannumbodhu=go)'));
  rt.fire('go');
  assert.match(logs.at(-1).text, /Too much recursion/);
});

test('output limits: long messages truncated, huge lists refused', () => {
  const { rt, messages } = boot(wrap('function big():\n    message_kaattu(text_replace("x", "x", "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"))\nfunction many():\n    mari l = range(1000000)'));
  rt.fire('big');
  assert.ok(messages[0].length <= AP.LIMITS.logLength);
  assert.throws(() => rt.callFunction('many', []), /too large/);
});

test('rendering is pure: effects and global changes are refused', () => {
  const { rt, logs } = boot('mari n = 0\nfunction bump():\n    n = n + 1\nfunction sneaky():\n    toast_kaattu("hi")\n    return 1\nscreen_uruvakku("home"):\n    mari z = sneaky()\n    title("x")\n');
  assert.throws(() => rt.render(), /cannot be used while the screen is being drawn/);
});

test('global state lives across events and re-render shows it', () => {
  const { rt } = boot('mari n = 0\nfunction bump():\n    n = n + 1\nscreen_uruvakku("home"):\n    text_kaattu("n=" + str(n))\n    button("b", click_pannumbodhu=bump)\n');
  assert.equal(rt.render().children[0].props.text, 'n=0');
  rt.fire('bump'); rt.fire('bump');
  assert.equal(rt.render().children[0].props.text, 'n=2');
});

test('handler errors are logged with position and do not break the app', () => {
  const { rt, logs, toasts } = boot('function boom():\n    mari z = 0\n    mari x = 1 / z\nscreen_uruvakku("home"):\n    button("b", click_pannumbodhu=boom)\n');
  rt.fire('boom');
  assert.match(logs.at(-1).text, /In handler 'boom'.*line 3.*Division by zero/);
  assert.equal(toasts.length, 1);
  assert.equal(rt.render().children.length, 1);
});

test('inputs: initial values, input_set, types, unknown names', () => {
  const src = `function t():
    input_set("nm", "Z")
    return input_value("nm") + str(input_value("chk")) + str(input_value("num")) + input_value("dd")
function bad():
    return input_value("ghost")
function wrong():
    input_set("chk", "yes")
screen_uruvakku("home"):
    input_uruvakku("nm", initial="A")
    checkbox_uruvakku("chk", initial=true)
    number_input("num")
    dropdown_uruvakku("dd", options=["x", "y"])
`;
  const { rt } = boot(src);
  assert.equal(rt.callFunction('t', []), 'Ztruenullx');
  assert.throws(() => rt.callFunction('bad', []), /No input component named 'ghost'/);
  assert.throws(() => rt.callFunction('wrong', []), /must be true\/false/);
  rt.setInputFromUI('num', 42);
  assert.equal(rt.getInput('num'), 42);
  const v = rt.render();
  assert.equal(flat(v).find((n) => n.props.name === 'nm').props.value, 'Z');
});

test('change_aagumbodhu handler fires through the same path', () => {
  const { rt, messages } = boot(`function changed():\n    message_kaattu("got " + input_value("q"))\nscreen_uruvakku("home"):\n    input_uruvakku("q", change_aagumbodhu=changed)\n`);
  rt.setInputFromUI('q', 'abc');
  rt.fire('changed');
  assert.deepEqual(messages, ['got abc']);
});

test('styles are validated and scoped per component', () => {
  const { rt, logs } = boot(`mari bad = "red"
screen_uruvakku("home", style={"background": "#000000"}):
    button("a", style={"background": "#112233", "corner_radius": 8})
    button("b")
    title("t", style={"text_color": bad})
`);
  const v = rt.render();
  assert.deepEqual(v.children[0].style, { background: '#112233', corner_radius: 8 });
  assert.deepEqual(v.children[1].style, {});
  assert.deepEqual(v.children[2].style, {});
  assert.deepEqual(v.style, { background: '#000000' });
  assert.ok(logs.some((l) => l.level === 'warning' && /text_color/.test(l.text)));
  rt.render();
  assert.equal(logs.filter((l) => /text_color/.test(l.text)).length, 1, 'warning logged once');
});

test('dynamic component prop errors are reported with position', () => {
  const { rt } = boot('mari items = 5\nscreen_uruvakku("home"):\n    list_kaattu(items)\n');
  assert.throws(() => rt.render(), (e) => /needs a list/.test(e.message) && e.pos[0] === 3);
});

test('image sources are restricted to https and data:image', () => {
  const { rt, logs } = boot('screen_uruvakku("home"):\n    image_kaattu("file:///etc/passwd")\n    image_kaattu("javascript:alert(1)")\n    image_kaattu("https://example.com/a.png", alt="ok")\n');
  const v = rt.render();
  assert.equal(v.children[0].props.src, '');
  assert.equal(v.children[1].props.src, '');
  assert.equal(v.children[2].props.src, 'https://example.com/a.png');
  assert.ok(logs.some((l) => /not shown/.test(l.text)));
});

test('storage: save/read/delete/clear, namespacing, size limit, defaults', () => {
  const storage = AP.memoryStorage();
  storage.setItem('ap:other.app:k', '"keep"');
  const src = wrap(`function t():
    data_save_pannu("n", {"a": [1, 2]})
    mari got = data_edu("n")
    data_save_pannu("s", "hello")
    return str(got["a"][1]) + data_edu("s") + str(data_edu("missing", 7))
function del():
    data_delete_pannu("s")
    return data_edu("s", "gone")
function clr():
    data_clear_pannu()
    return data_edu("n", "cleared")
function big():
    mari s = "x"
    ovvoru i in range(19):
        s = s + s
    data_save_pannu("big", s)`);
  const { rt } = boot(src, { storage, namespace: 'proj1' });
  assert.equal(rt.callFunction('t', []), '2hello7');
  assert.equal(rt.callFunction('del', []), 'gone');
  assert.throws(() => rt.callFunction('big', []), /too large/);
  assert.equal(rt.callFunction('clr', []), 'cleared');
  assert.equal(storage.getItem('ap:other.app:k'), '"keep"', 'clear only touches own namespace');
  const { rt: rt2 } = boot(src, { storage, namespace: 'proj2' });
  assert.equal(rt2.callFunction('t', []), '2hello7');
  assert.equal(storage.keys().filter((k) => k.startsWith('ap:proj2:')).length, 2);
});

test('persistence across runtime restarts (same namespace)', () => {
  const storage = AP.memoryStorage();
  const src = wrap('function save():\n    data_save_pannu("c", 41)\nfunction load():\n    return data_edu("c", 0) + 1');
  boot(src, { storage, namespace: 'p' }).rt.callFunction('save', []);
  assert.equal(boot(src, { storage, namespace: 'p' }).rt.callFunction('load', []), 42);
});

test('raw JS/Python/shell source cannot execute (no host access in runtime)', () => {
  assert.throws(() => compile('__import__("os").system("id")\n'));
  assert.throws(() => compile('function f():\n    eval("1")\nscreen_uruvakku("h"):\n    title("x")\n'));
  assert.throws(() => compile('function f():\n    constructor("return process")()\nscreen_uruvakku("h"):\n    title("x")\n'));
});

test('dictionary keys named like JS builtins are safe', () => {
  assert.equal(run('mari d = {}\nd["__proto__"] = 5\nd["constructor"] = 1\nreturn length(d)'), 2);
  assert.equal(run('mari d = {"a": 1}\nreturn dict_get(d, "toString", "none")'), 'none');
});

test('summa is a no-op that keeps empty containers/handlers valid', () => {
  const { rt } = boot('function noop():\n    summa\nscreen_uruvakku("home"):\n    column_uruvakku():\n        summa\n');
  rt.fire('noop');
  const v = rt.render();
  assert.deepEqual(v.children[0].children, []);
});

test('device features go through the host and are validated and render-guarded', () => {
  const calls = [];
  const device = { clipboard: (t) => calls.push(['copy', t]), vibrate: (ms) => calls.push(['vib', ms]) };
  const src = `function go():
    clipboard_copy("hello " + "nanba")
    vibrate_pannu(50)
function bad():
    vibrate_pannu(0)
function sneaky():
    clipboard_copy("x")
    return 1
screen_uruvakku("home"):
    button("b", click_pannumbodhu=go)
`;
  const { rt } = boot(src, { device });
  rt.fire('go');
  assert.deepEqual(calls, [['copy', 'hello nanba'], ['vib', 50]]);
  assert.throws(() => rt.callFunction('bad', []), /1 to 5000/);
  const { rt: rt2 } = boot('function sneaky():\n    clipboard_copy("x")\n    return 1\nscreen_uruvakku("home"):\n    mari z = sneaky()\n    title("x")\n', { device });
  assert.throws(() => rt2.render(), /cannot be used while the screen is being drawn/);
});

test('device features degrade to warnings when unsupported', () => {
  const { rt, logs } = boot('function go():\n    clipboard_copy("x")\n    vibrate_pannu(10)\nscreen_uruvakku("home"):\n    button("b", click_pannumbodhu=go)\n');
  rt.fire('go');
  assert.ok(logs.some((l) => l.level === 'warning' && /clipboard/.test(l.text)));
  assert.ok(logs.some((l) => l.level === 'warning' && /vibrat/.test(l.text)));
});

test('setScreen shows a specific screen for design tooling', () => {
  const { rt } = boot('screen_uruvakku("a"):\n    title("A")\nscreen_uruvakku("b"):\n    title("B")\n');
  assert.equal(rt.setScreen('b'), true);
  assert.equal(rt.render().children[0].props.text, 'B');
  assert.equal(rt.setScreen('zzz'), false);
});

test('handlers with arguments: each list item carries its own values, evaluated when the screen is drawn', () => {
  const { rt, logs } = boot(wrap(
    'mari items = ["a", "b", "c"]\nmari log = ""\nfunction del_item(i):\n    remove(items, i)\nfunction note(i, label):\n    log = log + label + str(i) + ";"',
    '    ovvoru i in range(length(items)):\n        button(items[i], click_pannumbodhu=del_item(i))\n        button("n" + items[i], click_pannumbodhu=note(i, "x"))\n    text_kaattu(log)',
  ));
  let v = rt.render();
  const btns = () => flat(rt.render()).filter((n) => n.c === 'button');
  assert.deepEqual(btns().map((b) => b.props.label), ['a', 'na', 'b', 'nb', 'c', 'nc']);
  assert.deepEqual(btns()[2].events.click_pannumbodhu, { fn: 'del_item', args: [1] });
  rt.fire(btns()[2].events.click_pannumbodhu); // delete "b" using the values captured when drawn
  assert.deepEqual(btns().map((b) => b.props.label), ['a', 'na', 'c', 'nc']);
  rt.fire(btns()[3].events.click_pannumbodhu);
  assert.ok(flat(rt.render()).some((n) => n.props.text === 'x1;'));
  assert.deepEqual(logs.filter((l) => l.level === 'error'), []);
});

test('navbar and tab bar: views, switching screens without history, hidden bar', () => {
  const src = 'app_uruvakku("T")\nmari n = 0\nfunction bump():\n    n = n + 1\nfunction hide():\n    screen_maathu("two")\n' +
    'screen_uruvakku("one"):\n    navbar_uruvakku(title="Hello", subtitle="sub", align="center"):\n        nav_action("Add", icon="+", click_pannumbodhu=bump)\n    text_kaattu("n=" + str(n))\n' +
    '    tabbar_uruvakku():\n        tab_item("One", icon="1", go="one")\n        tab_item("Two", icon="2", go="two")\n' +
    'screen_uruvakku("two"):\n    navbar_uruvakku(visible=false)\n    text_kaattu("second")\n    tabbar_uruvakku():\n        tab_item("One", go="one")\n        tab_item("Two", go="two")\n';
  const { rt, logs } = boot(src);
  const kids = () => rt.render().children;
  const nav = kids().find((k) => k.c === 'navbar_uruvakku');
  assert.deepEqual([nav.props.title, nav.props.subtitle, nav.props.align, nav.props.back, nav.props.visible], ['Hello', 'sub', 'center', true, true]);
  assert.equal(nav.children[0].props.icon, '+');
  rt.fire(nav.children[0].events.click_pannumbodhu);
  assert.ok(flat(rt.render()).some((n) => n.props.text === 'n=1'));
  let tabs = kids().find((k) => k.c === 'tabbar_uruvakku').children;
  assert.deepEqual(tabs.map((t) => t.props.active), [true, false]);   // active is automatic
  assert.equal(rt.switchScreen('two'), true);                        // what a tab tap does: no history entry
  assert.equal(rt.currentScreen(), 'two');
  assert.equal(rt.canGoBack(), false);
  tabs = kids().find((k) => k.c === 'tabbar_uruvakku').children;
  assert.deepEqual(tabs.map((t) => t.props.active), [false, true]);
  assert.equal(kids().find((k) => k.c === 'navbar_uruvakku').props.visible, false);
  rt.fire('hide');                                                   // screen_maathu from code
  assert.deepEqual(logs.filter((l) => l.level === 'error'), []);
});
