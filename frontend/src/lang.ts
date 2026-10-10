import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Spec } from './types';

const KEYWORDS = new Set([
  'mari', 'function', 'return', 'enna_na', 'illana_enna', 'illana', 'ovvoru', 'in', 'irukkura_varai', 'try', 'catch',
  'and', 'or', 'not',
]);
const ATOMS = new Set(['true', 'false', 'null', 'sari', 'thappu', 'onnum_illa']);
/** Tanglish keyword aliases (seyal, thirumbi_kudu, ...). Filled from the backend spec by builtinNames(). */
const TA_KEYWORDS = new Set<string>();

/** CodeMirror language for AppPanrom. `builtins` come from the backend spec so the editor never drifts from the language. */
export function apppanromLanguage(builtins: Set<string>) {
  return StreamLanguage.define({
    token(stream) {
      if (stream.eatSpace()) return null;
      if (stream.match('#')) { stream.skipToEnd(); return 'comment'; }
      const q = stream.peek();
      if (q === '"' || q === "'") {
        stream.next();
        let esc = false;
        let ch: string | void;
        while ((ch = stream.next()) != null) {
          if (ch === q && !esc) break;
          esc = !esc && ch === '\\';
        }
        return 'string';
      }
      if (stream.match(/^\d+(\.\d+)?/)) return 'number';
      if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
        const w = stream.current();
        if (KEYWORDS.has(w) || TA_KEYWORDS.has(w)) return 'keyword';
        if (ATOMS.has(w)) return 'atom';
        if (builtins.has(w)) return 'function';
        return 'variableName';
      }
      stream.next();
      return 'operator';
    },
    languageData: { commentTokens: { line: '#' } },
    tokenTable: {},
  });
}

export const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: 'var(--tok-keyword)', fontWeight: '600' },
    { tag: t.string, color: 'var(--tok-string)' },
    { tag: t.number, color: 'var(--tok-number)' },
    { tag: t.comment, color: 'var(--tok-comment)', fontStyle: 'italic' },
    { tag: t.atom, color: 'var(--tok-number)' },
    { tag: t.function(t.variableName), color: 'var(--tok-function)' },
    { tag: t.operator, color: 'var(--tok-operator)' },
  ]),
);

export function builtinNames(spec: Spec): Set<string> {
  const ta = spec.tanglish;
  TA_KEYWORDS.clear();
  if (ta) Object.values(ta.keywords).forEach((k) => { if (!ATOMS.has(k)) TA_KEYWORDS.add(k); });
  return new Set([
    ...(ta ? [...Object.values(ta.components), ...Object.values(ta.functions)] : []),
    ...Object.keys(spec.components),
    ...Object.keys(spec.functions),
    ...Object.keys(spec.config_functions),
    'screen_uruvakku',
    'screen_title',
  ]);
}
