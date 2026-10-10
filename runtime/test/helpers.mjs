import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const AP = require('../apppanrom-runtime.js');
export const SPEC = require('../../spec/schema.json');
const backend = path.resolve(here, '../../backend');

/** Compile AppPanrom source with the real Python compiler. */
export function compile(src) {
  const r = spawnSync('python3', ['-m', 'apppanrom.cli', 'compile', '-'], { cwd: backend, input: src, encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  if (!out.ok) throw new Error('compile failed: ' + JSON.stringify(out.diagnostics));
  return out.ir;
}

/** Create + init a headless runtime that records logs/toasts/messages. */
export function boot(src, extra = {}) {
  const ir = compile(src);
  const logs = [], toasts = [], messages = [];
  const rt = AP.createRuntime(ir, {
    log: (level, text) => logs.push({ level, text }),
    toast: (t) => toasts.push(t),
    message: (t) => messages.push(t),
    ...extra,
  });
  rt.init();
  return { rt, ir, logs, toasts, messages };
}

export function flat(view) {
  const out = [];
  const walk = (list) => list.forEach((n) => { out.push(n); if (n.children) walk(n.children); });
  walk(view.children);
  return out;
}
