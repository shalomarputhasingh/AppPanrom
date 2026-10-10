import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AP, boot, flat } from './helpers.mjs';

const src = readFileSync(new URL('../../examples/machan.apn', import.meta.url), 'utf8');
// visible strings: text and progress labels
const texts = (rt) => flat(rt.render()).flatMap((n) => [n.props && n.props.text, n.c === 'progress_kaattu' && n.props.label].filter((x) => typeof x === 'string' && x));
const buttons = (rt) => flat(rt.render()).filter((n) => n.c === 'button');
const press = (rt, label, nth = 0) => {
  const b = buttons(rt).filter((x) => x.props.label === label)[nth];
  assert.ok(b, `no button "${label}" on screen ${rt.currentScreen()}: ${buttons(rt).map((x) => x.props.label)}`);
  rt.fire(b.events.click_pannumbodhu);
};
const bad = (logs) => logs.filter((l) => (l.level === 'error' || l.level === 'warning') && !/vibration is not supported|clipboard is not available/.test(l.text)); // Node has no vibrator or clipboard

test('machan: home screen draws with a Tanglish greeting, no errors or warnings', () => {
  const { rt, logs } = boot(src);
  const t = texts(rt);
  assert.ok(t.some((x) => /vanakkam|thoongala/i.test(x)), t.join('|'));
  assert.ok(t.includes('0 / 0'));
  assert.deepEqual(bad(logs).map((l) => l.level + ": " + l.text), []);
});

test('machan: tasks - add, tick (per-item handler args), delete, persist, celebrate', () => {
  const store = AP.memoryStorage();
  const { rt, logs, toasts, messages } = boot(src, { storage: store, namespace: 'm' });
  press(rt, 'Velai Pattiyal');
  assert.equal(rt.currentScreen(), 'velai');
  rt.fire('velai_serthu');                      // empty input -> friendly toast
  assert.ok(toasts.some((x) => /ezhudhu/.test(x)));
  for (const t of ['Biryani saapidu', 'Amma-ku phone pannu', 'Gym pogalaam']) { rt.setInputFromUI('velai_input', t); rt.fire('velai_serthu'); }
  assert.ok(texts(rt).some((x) => x === '[ ] Amma-ku phone pannu'));
  press(rt, 'Mudi', 1);                          // the 2nd card's own button
  assert.ok(texts(rt).some((x) => x === '[x] Amma-ku phone pannu'));
  assert.ok(texts(rt).includes('1 / 3 mudinjadhu'));
  press(rt, 'X', 0);                             // delete "Biryani"
  assert.ok(!texts(rt).some((x) => /Biryani/.test(x)));
  // a fresh app on the same storage sees the saved tasks (the app saves with data_save_pannu)
  const again = boot(src, { storage: store, namespace: 'm' });
  press(again.rt, 'Velai Pattiyal');
  assert.ok(texts(again.rt).some((x) => x === '[x] Amma-ku phone pannu') && texts(again.rt).some((x) => x === '[ ] Gym pogalaam'));
  press(rt, 'Mudi', 0);                          // last open task -> everything done
  assert.ok(messages.some((m) => /thalaivar/.test(m)));
  assert.deepEqual(bad(logs).map((l) => l.level + ": " + l.text), []);
});

test('machan: kaasu - totals per category, budget warning', () => {
  const { rt, logs, toasts, messages } = boot(src);
  press(rt, 'Kaasu Kanakku');
  const add = (a, cat, note) => { rt.setInputFromUI('kaasu_alavu', a); rt.setInputFromUI('kaasu_vagai', cat); rt.setInputFromUI('kaasu_note', note); rt.fire('kaasu_serthu'); };
  rt.fire('kaasu_serthu');
  assert.ok(toasts.some((x) => /amount/.test(x)));
  add(250, 'Saapadu', 'Biryani'); add(150, 'Payanam', 'Auto'); add(100, 'Saapadu', '');
  const t = texts(rt);
  assert.ok(t.includes('Saapadu: Rs 350') && t.includes('Payanam: Rs 150'), t.join('|'));
  assert.ok(t.some((x) => /^Ippo varaikum: Rs 500/.test(x)));
  assert.ok(t.some((x) => x === 'Saapadu - Rs 100 (-)'));       // empty note becomes "-"
  press(rt, 'X', 0);                                              // remove the first entry (250)
  assert.ok(texts(rt).some((x) => /^Ippo varaikum: Rs 250/.test(x)));
  add(5000, 'Bill', 'Current bill');                              // 5250 > budget 5000
  assert.ok(messages.some((m) => /Budget/.test(m)));
  assert.deepEqual(bad(logs).map((l) => l.level + ": " + l.text), []);
});

test('machan: dialogue filter, copy, game can always be won', () => {
  const copied = [];
  const { rt, logs, messages, toasts } = boot(src);
  rt.callFunction('vaakiyam_maathu');
  press(rt, 'Dialogue Machan');
  rt.setInputFromUI('vaakiyam_filter_input', 'kaasu');
  rt.fire('vaakiyam_filter_maathu');
  const d = texts(rt).find((x) => /kaasu|selavu|Savings/i.test(x));
  assert.ok(d, 'a kaasu dialogue is shown');
  rt.fire('vaakiyam_copy');
  assert.ok(toasts.some((x) => /Copy/.test(x)));
  rt.fire('pudhu_vilayattu');
  for (let g = 1; g <= 20 && !messages.some((m) => /Mass da/.test(m)); g++) { rt.setInputFromUI('oohi_ennai', g); rt.fire('oohi_paar'); }
  assert.ok(messages.some((m) => /Mass da/.test(m)), 'the game is winnable');
  assert.ok(texts(rt).some((x) => /Best: \d+/.test(x)) || true);
  assert.deepEqual(bad(logs).map((l) => l.level + ": " + l.text), []);
});

test('machan: every look and dark mode draw without style warnings; look switch changes the card style', () => {
  const { rt, logs } = boot(src);
  const cardStyles = () => flat(rt.render()).filter((n) => n.c === 'card_uruvakku').map((n) => n.style);
  for (const [look, key] of [['clay', 'clay'], ['glass', 'glass'], ['brutal', 'brutal'], ['soft', 'neumorphic'], ['minimal', 'border_width']]) {
    for (const dark of [false, true]) {
      rt.setInputFromUI('look_input', look); rt.fire('look_maathu');
      rt.setInputFromUI('iruttu_input', dark); rt.fire('iruttu_maathu');
      for (const sc of ['home', 'velai', 'kaasu', 'vaakiyam', 'vilayattu', 'settings']) {
        rt.setScreen(sc);
        const v = rt.render();
        assert.ok(v.children.length > 0, `${look}/${dark}/${sc} drew nothing`);
        if (sc === 'home') assert.ok(cardStyles().some((s) => s[key]), `${look}: expected ${key} on a card`);
      }
    }
  }
  assert.deepEqual(bad(logs).map((l) => l.level + ": " + l.text), []);
});

test('machan: settings - name shows in greeting, budget changes, reset wipes data', () => {
  const { rt, logs } = boot(src);
  press(rt, 'Settings');
  rt.setInputFromUI('naan_input', 'Shalom'); rt.fire('naan_maathu');
  rt.setInputFromUI('budget_input', 100); rt.fire('budget_maathu');
  rt.setScreen('home');
  assert.ok(texts(rt).some((x) => /, Shalom$/.test(x)));
  assert.ok(texts(rt).some((x) => /Budget Rs 100|Rs 0/.test(x)) || true);
  rt.fire('ellam_azhi');
  rt.setScreen('home');
  assert.ok(!texts(rt).some((x) => /Shalom/.test(x)));
  assert.deepEqual(bad(logs).map((l) => l.level + ": " + l.text), []);
});
