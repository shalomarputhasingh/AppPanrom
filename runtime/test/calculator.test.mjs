import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, flat } from './helpers.mjs';

const src = readFileSync(new URL('../../examples/calculator.apn', import.meta.url), 'utf8');
const NAMES = { '+': 'plus', '-': 'minus', x: 'times', '/': 'divide', '=': 'equals', C: 'clear', '.': 'dot', '<': 'back', s: 'sign', '%': 'percent' };

function calc(keys) {
  const { rt, logs } = boot(src);
  for (const k of keys) rt.fire('press_' + (NAMES[k] || k));
  assert.deepEqual(logs.filter((l) => l.level === 'error'), []);
  const texts = flat(rt.render()).filter((n) => n.props && typeof n.props.text === 'string').map((n) => n.props.text);
  return texts; // [title?, history, display]
}
const display = (keys) => calc(keys).slice(-1)[0];

test('calculator: basic arithmetic', () => {
  assert.equal(display('12+30='), '42');
  assert.equal(display('9-12='), '-3');
  assert.equal(display('6x7='), '42');
  assert.equal(display('8/4='), '2');
});
test('calculator: chaining, decimals, float noise', () => {
  assert.equal(display('2+3x4='), '20'); // left-to-right like a pocket calculator
  assert.equal(display('0.1+0.2='), '0.3');
  assert.equal(display('1/3='), '0.33333333');
  assert.equal(display('.5+.5='), '1');
});
test('calculator: clear, backspace, sign, percent', () => {
  assert.equal(display('123<<'), '1');
  assert.equal(display('123<<<'), '0');
  assert.equal(display('5s'), '-5');
  assert.equal(display('5ss'), '5');
  assert.equal(display('50%'), '0.5');
  assert.equal(display('99+1C'), '0');
});
test('calculator: divide by zero shows Error and recovers', () => {
  assert.equal(display('5/0='), 'Error');
  assert.equal(display('5/0=C7+1='), '8');
  assert.equal(display('5/0=+'), 'Error');
});
test('calculator: repeated operator and result reuse', () => {
  assert.equal(display('2+3=+4='), '9');
  assert.equal(display('9999999999999'), '999999999999'); // 12 digit limit
  assert.equal(display('1.2.3'), '1.23');
});
