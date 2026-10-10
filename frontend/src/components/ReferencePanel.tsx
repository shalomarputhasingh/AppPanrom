import type { Spec } from '../types';
import { EXAMPLE_LIST } from '../templates';

export const EXAMPLES = EXAMPLE_LIST;

const SYNTAX = `mari count = 0                      # variable (declare once, then: count = count + 1)
function add(a, b):                 # function, 4-space indent
    return a + b
enna_na count > 10:                 # if / else-if / else
    ...
illana_enna count > 5:
    ...
illana:
    ...
ovvoru item in items:               # for-each (ovvoru i in range(5) to repeat)
irukkura_varai count < 5:           # while
try: ... catch error: ...           # error is the message text
screen_uruvakku("home", style={...}):   # a screen; children are indented
    column_uruvakku(style={"gap": 12}):
        button("Go", click_pannumbodhu=handler)`;

interface Props {
  spec: Spec | null;
  onUseExample(code: string): void;
}

export function ReferencePanel({ spec, onUseExample }: Props) {
  return (
    <div className="reference">
      <h4>Examples</h4>
      <ul className="plain">
        {EXAMPLES.map((e) => (
          <li key={e.name} className="row between">
            <span>{e.name}</span>
            <button className="btn small" onClick={() => onUseExample(e.code)}>Use in editor</button>
          </li>
        ))}
      </ul>
      <h4>Syntax</h4>
      <pre className="code-block">{SYNTAX}</pre>
      {!spec ? <p className="muted">Loading reference…</p> : (
        <>
          <h4>App settings</h4>
          <ul className="plain mono small">{Object.entries(spec.config_functions).map(([k, v]) => <li key={k}>{v.doc}</li>)}</ul>
          <h4>Components</h4>
          <ul className="plain mono small">{Object.entries(spec.components).map(([k, v]) => <li key={k}>{v.doc}</li>)}</ul>
          <h4>Functions</h4>
          <ul className="plain mono small">{Object.entries(spec.functions).map(([k, v]) => <li key={k}>{v.doc}</li>)}</ul>
          <h4>Style keys</h4>
          <ul className="plain mono small">
            {Object.entries(spec.styles).map(([k, v]) => (
              <li key={k}>{k}: {v.type === 'enum' ? v.values!.join(' | ') : v.min !== undefined ? `${v.type} ${v.min}–${v.max}` : v.type}</li>
            ))}
          </ul>
          <h4>Not implemented yet</h4>
          <p className="muted small mono">{spec.not_implemented.join(', ')}</p>
        </>
      )}
    </div>
  );
}
