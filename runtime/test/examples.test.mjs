// The example apps: every one compiles and draws every screen; the offline ones declare no permission at all
// (no INTERNET, no run-time prompt) and their logic is checked with real numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { AP, boot, flat } from './helpers.mjs';

const dir = new URL('../../examples/', import.meta.url);
const read = (n) => readFileSync(new URL(n + '.apn', dir), 'utf8');
const OFFLINE = ['kadan', 'alavu', 'palakkam', 'bill', 'padi', 'notes', 'counter', 'calculator', 'vanakkam', 'showcase', 'machan'];
const texts = (rt) => flat(rt.render()).flatMap((n) => (Array.isArray(n.props.items) ? n.props.items.map(String) : [String(n.props.text ?? n.props.label ?? '')]));
const has = (rt, re) => texts(rt).some((t) => re.test(t));

test('every example compiles and draws all its screens; offline ones need no INTERNET and ask for nothing while running', () => {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.apn'))) {
    const name = f.replace(/\.apn$/, '');
    const { rt, ir, logs } = boot(read(name));
    if (OFFLINE.includes(name)) assert.deepEqual(ir.permissions.filter((p) => p.runtime || /INTERNET/.test(p.permission)), [], name + ' must work offline and ask for nothing at run time');
    for (const s of ir.screen_order) { assert.ok(rt.setScreen(s)); assert.doesNotThrow(() => rt.render(), name + '/' + s); }
    assert.ok(!logs.some((l) => l.level === 'error'), name + ': ' + JSON.stringify(logs.filter((l) => l.level === 'error')));
  }
});

test('kadan: EMI of 1,00,000 at 12% for 1 year is Rs 8884.88; zero interest divides evenly; bad input is refused', () => {
  const { rt, toasts } = boot(read('kadan'));
  rt.setInputFromUI('thogai_input', 100000); rt.setInputFromUI('vatti_input', 12); rt.setInputFromUI('varusham_input', 1);
  rt.fire('kanakku_pannu');
  assert.ok(has(rt, /^Rs 8884\.88$/), texts(rt).join('|'));
  assert.ok(has(rt, /Mothama kattuvadhu: Rs 106618\.55/));
  rt.setScreen('pattiyal');
  assert.ok(has(rt, /Varusham 1: meedhi Rs 0/));
  rt.setScreen('home');
  rt.setInputFromUI('vatti_input', 0); rt.setInputFromUI('thogai_input', 120000);
  rt.fire('kanakku_pannu');
  assert.ok(has(rt, /^Rs 10000$/));
  rt.setInputFromUI('varusham_input', 99);
  rt.fire('kanakku_pannu');
  assert.equal(toasts.length, 1);
});

test('alavu: km to mile, swap, temperature and remembered history', () => {
  const { rt } = boot(read('alavu'));
  assert.ok(has(rt, /^0\.621371 mile$/), texts(rt).join('|'));
  rt.fire('swap');
  assert.ok(has(rt, /^1\.609344 km$/));
  rt.setInputFromUI('vagai_input', 'Veppam'); rt.fire('vagai_maathu');
  rt.setInputFromUI('alavu_input', 100); rt.setInputFromUI('to_input', 'Fahrenheit'); rt.fire('to_maathu');
  assert.ok(has(rt, /^212 Fahrenheit$/), texts(rt).join('|'));
  rt.setInputFromUI('to_input', 'Kelvin'); rt.fire('to_maathu');
  assert.ok(has(rt, /^373\.15 Kelvin$/));
  rt.fire('sevu');
  assert.ok(has(rt, /100 Celsius = 373\.15 Kelvin/));
});

const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

test('palakkam: streak counts consecutive days, a gap resets it, toggling today works and is saved', () => {
  const storage = AP.memoryStorage();
  storage.setItem('ap:com.apppanrom.palakkam:palakkangal', JSON.stringify([
    { n: 'A', d: [day(-1), day(-2), day(-3)] },     // done up to yesterday: streak 3, not done today
    { n: 'B', d: [day(0), day(-1), day(-3)] },      // gap two days ago: streak 2, done today
    { n: 'C', d: [day(-2)] },                       // missed yesterday: streak 0
  ]));
  const { rt } = boot(read('palakkam'), { storage });
  const t = texts(rt);
  assert.ok(t.includes('Thodar: 3 naal   |   Indha vaaram: 3 / 7'), t.join('|'));
  assert.ok(t.includes('Thodar: 2 naal   |   Indha vaaram: 3 / 7'));
  assert.ok(t.includes('Thodar: 0 naal   |   Indha vaaram: 1 / 7'));
  rt.fire('maathu', [0]);                            // A done today -> streak 4
  assert.ok(has(rt, /Thodar: 4 naal/));
  assert.deepEqual(JSON.parse(storage.getItem('ap:com.apppanrom.palakkam:palakkangal'))[0].d[0], day(0));
  rt.fire('maathu', [0]);                            // toggle back
  assert.ok(has(rt, /Thodar: 3 naal/));
  rt.fire('neekku_palakkam', [2]);
  assert.equal(JSON.parse(storage.getItem('ap:com.apppanrom.palakkam:palakkangal')).length, 2);
  rt.setInputFromUI('pudhu', 'Yoga'); rt.fire('serkka');
  assert.ok(has(rt, /^Yoga$/));
});

test('bill: split with tip, rounding up, and the empty-input guard', () => {
  const { rt, toasts } = boot(read('bill'));
  rt.setInputFromUI('bill_input', 1000); rt.setInputFromUI('aal_input', 3);
  assert.ok(has(rt, /^Rs 366\.67$/), texts(rt).join('|'));        // 10% tip is the default
  rt.fire('tip_vechchu', [0]);
  assert.ok(has(rt, /^Rs 333\.33$/));
  rt.setInputFromUI('mele_input', true); rt.fire('mele_maathu');
  assert.ok(has(rt, /^Rs 334$/));
  rt.fire('sevu');
  assert.ok(has(rt, /Rs 1000 \/ 3 per = Rs 334/), texts(rt).join('|'));
  rt.setInputFromUI('bill_input', 0); rt.fire('sevu');
  assert.equal(toasts.length, 1);
});

test('padi: flip, mark known, deck shrinks, finishing shows the end card, reset brings it back', () => {
  const storage = AP.memoryStorage();
  const { rt, ir } = boot(read('padi'), { storage });
  assert.ok(has(rt, /^Vanakkam$/) && has(rt, /Artham enna/));
  rt.fire('thirupu');
  assert.ok(has(rt, /Hello \/ greetings/));
  rt.fire('theriyum_aachu');
  assert.ok(has(rt, /^Nandri$/), 'next card after a known one');
  assert.equal(JSON.parse(storage.getItem('ap:com.apppanrom.padi:theriyum')).length, 1);
  rt.fire('theriyala');                                  // skip: moves on without marking
  assert.ok(!has(rt, /^Nandri$/));
  for (let i = 0; i < 80; i++) { rt.fire('thirupu'); rt.fire('theriyum_aachu'); }
  assert.ok(has(rt, /Semma machan/));
  rt.fire('meendum');
  assert.ok(has(rt, /^Vanakkam$/));
  assert.ok(ir.screens.home);
});
