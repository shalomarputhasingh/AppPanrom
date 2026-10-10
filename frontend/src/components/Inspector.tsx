import { PRESETS, PALETTES, SCREEN_THEMES, GROUPS, ANIMATIONS, type StyleChange } from '../stylePresets';
import { useEffect, useRef, useState } from 'react';
import type { DesignInput, DesignNodeInfo, DesignValue, Spec } from '../types';

type OnOp = (op: Record<string, unknown>) => Promise<string | null>;

interface Props {
  node: DesignNodeInfo | null;
  spec: Spec | null;
  disabled: boolean;
  onOp: OnOp;
  /** Hover preview of an edit on the canvas (null = stop previewing). */
  onPreview(op: Record<string, unknown> | null): void;
  onReplay(): void;
  onDelete(): void;
  onDuplicate(): void;
  onGoto(line: number): void;
  onCreateHandler(name: string, event: string): Promise<string | null>;
}

const LABELS: Record<string, string> = {
  text: 'Text', label: 'Label', name: 'Name (id)', placeholder: 'Placeholder', initial: 'Initial value', enabled: 'Enabled', options: 'Options',
  src: 'Image URL', alt: 'Alt text', items: 'Items', value: 'Value (0-100)',
  background: 'Background', text_color: 'Text color', border_color: 'Border color', padding: 'Padding', margin: 'Margin', gap: 'Gap',
  corner_radius: 'Corner radius', border_width: 'Border width', font_size: 'Font size', font_weight: 'Font weight', text_align: 'Text align',
  opacity: 'Opacity', width: 'Width', height: 'Height', align: 'Align (cross axis)', justify: 'Justify (main axis)', wrap: 'Wrap',
  scroll: 'Scroll', visible: 'Visible', shadow: 'Shadow', clay: 'Clay (3D soft)', glass: 'Glass', neumorphic: 'Soft UI (neumorphic)', brutal: 'Brutal',
  background_to: 'Gradient to', gradient_angle: 'Gradient angle', animate: 'Animation', animate_duration: 'Duration (s)', animate_delay: 'Delay (s)', click_pannumbodhu: 'On click', change_aagumbodhu: 'On change', submit_pannumbodhu: 'On submit',
};
const label = (k: string) => LABELS[k] ?? k;

/** Text-ish input that commits on blur / Enter and re-syncs when the underlying value changes. */
function CommitInput({ value, onCommit, disabled, type = 'text', mono, ...rest }: {
  value: string; onCommit(v: string): void; disabled?: boolean; type?: string; mono?: boolean; placeholder?: string; 'aria-label': string; min?: number; max?: number; step?: number;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v !== value) onCommit(v); };
  return (
    <input
      {...rest} type={type} value={v} disabled={disabled} className={mono ? 'mono' : undefined}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') setV(value); }}
    />
  );
}

function Row({ name, children, error, extra }: { name: string; children: React.ReactNode; error?: string | null; extra?: React.ReactNode }) {
  return (
    <div className="insp-row">
      <span className="insp-label">{label(name)}</span>
      <div className="insp-ctl">{children}</div>
      {extra && <div className="insp-extra">{extra}</div>}
      {error && <div className="error-text small insp-err" role="alert">{error}</div>}
    </div>
  );
}

function useOp(onOp: OnOp) {
  const [error, setError] = useState<string | null>(null);
  const run = async (op: Record<string, unknown>) => { setError(await onOp(op)); };
  return { error, run };
}

function PropRow({ name, type, required, value, disabled, onOp, node }: {
  name: string; type: string; required: boolean; value?: DesignValue; disabled: boolean; onOp: OnOp; node: DesignNodeInfo;
}) {
  const { error, run } = useOp(onOp);
  const [forceExpr, setForceExpr] = useState(false);
  const isExpr = forceExpr || type === 'list' || (!!value && !value.literal);
  const set = (v: DesignInput) => run({ kind: 'set_prop', line: node.line, name, value: v });
  const lit = value?.literal?.value;
  let control;
  if (isExpr) {
    control = (
      <CommitInput mono aria-label={`${label(name)} (expression)`} value={value?.expr ?? ''} disabled={disabled}
        placeholder={type === 'list' ? '["One", "Two"]' : 'expression, e.g. "Count: " + str(n)'}
        onCommit={(t) => set(t.trim() === '' && !required ? null : { expr: t })} />
    );
  } else if (type === 'bool') {
    control = (
      <select aria-label={label(name)} disabled={disabled} value={lit === undefined ? '' : String(lit)}
        onChange={(e) => set(e.target.value === '' ? null : { literal: e.target.value === 'true' })}>
        <option value="">default</option><option value="true">true</option><option value="false">false</option>
      </select>
    );
  } else if (type === 'num') {
    control = (
      <CommitInput type="number" aria-label={label(name)} value={lit === undefined ? '' : String(lit)} disabled={disabled}
        onCommit={(t) => set(t === '' && !required ? null : { literal: Number(t) })} />
    );
  } else {
    control = (
      <CommitInput aria-label={label(name)} value={lit === undefined ? '' : String(lit)} disabled={disabled}
        onCommit={(t) => set(t === '' && !required ? null : { literal: t })} />
    );
  }
  return (
    <Row name={name} error={error}>
      {control}
      {type !== 'list' && type !== 'bool' && (
        <button className={`btn small fx ${isExpr ? 'on' : ''}`} title="Switch between a plain value and a code expression" aria-pressed={isExpr}
          onClick={() => setForceExpr(!isExpr)} disabled={disabled || (!!value && !value.literal)}>ƒx</button>
      )}
    </Row>
  );
}

function hex6(v: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  const m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(v);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase() : '#000000';
}

const SLIDER_MAX: Record<string, number> = { corner_radius: 100, padding: 80, margin: 80, gap: 80, border_width: 20, font_size: 96, opacity: 1, gradient_angle: 360, animate_duration: 5, animate_delay: 5 };

function Swatches({ onPick, onHover, disabled, current }: { onPick(hex: string): void; onHover(hex: string | null): void; disabled: boolean; current?: string }) {
  return (
    <div className="swatches" role="group" aria-label="Colour palette">
      {PALETTES.map((p) => (
        <div key={p.name} className="swatch-row" title={p.name}>
          {p.colors.map((c) => (
            <button key={c} type="button" className={`swatch ${current?.toLowerCase() === c.toLowerCase() ? 'on' : ''}`} style={{ background: c }}
              aria-label={`${p.name} ${c}`} title={`${p.name} ${c}`} disabled={disabled} onClick={() => onPick(c)}
              onMouseEnter={() => onHover(c)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(c)} onBlur={() => onHover(null)} />
          ))}
        </div>
      ))}
    </div>
  );
}

function StyleRow({ k, def, value, disabled, onOp, onPreview, node }: {
  k: string; def: Spec['styles'][string]; value?: DesignValue; disabled: boolean; onOp: OnOp; onPreview(op: Record<string, unknown> | null): void; node: DesignNodeInfo;
}) {
  const { error, run } = useOp(onOp);
  const set = (v: DesignInput) => run({ kind: 'set_style', line: node.line, key: k, value: v });
  const lit = value?.literal?.value;
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  let control;
  let extra: React.ReactNode = null;
  if (value && !value.literal) {
    control = <CommitInput mono aria-label={`${label(k)} (expression)`} value={value.expr} disabled={disabled} onCommit={(t) => set(t.trim() ? { expr: t } : null)} />;
  } else if (def.type === 'color') {
    control = (
      <>
        <input type="color" aria-label={`${label(k)} picker`} disabled={disabled} value={hex6(String(lit ?? ''))}
          onChange={(e) => { const v = e.target.value.toUpperCase(); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => set({ literal: v }), 200); }} />
        <CommitInput mono aria-label={label(k)} value={lit === undefined ? '' : String(lit)} placeholder="#RRGGBB" disabled={disabled}
          onCommit={(t) => set(t.trim() === '' ? null : { literal: t.trim() })} />
      </>
    );
    extra = <Swatches disabled={disabled} current={lit === undefined ? undefined : String(lit)} onPick={(c) => set({ literal: c })}
      onHover={(c) => onPreview(c ? { kind: 'set_style', line: node.line, key: k, value: { literal: c } } : null)} />;
  } else if (def.type === 'number') {
    const step = k === 'opacity' ? 0.05 : k === 'animate_duration' || k === 'animate_delay' ? 0.1 : 1;
    control = (
      <>
        <input type="range" className="slider" aria-label={`${label(k)} slider`} disabled={disabled} min={def.min} max={SLIDER_MAX[k] ?? def.max ?? 100} step={step}
          value={lit === undefined ? (def.min ?? 0) : Number(lit)}
          onChange={(e) => { const v = Number(e.target.value); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => set({ literal: v }), 120); }} />
        <CommitInput type="number" aria-label={label(k)} value={lit === undefined ? '' : String(lit)} disabled={disabled}
          min={def.min} max={def.max} step={step} onCommit={(t) => set(t === '' ? null : { literal: Number(t) })} />
      </>
    );
  } else if (def.type === 'size') {
    control = (
      <CommitInput aria-label={label(k)} value={lit === undefined ? '' : String(lit)} placeholder='48, "50%" or fill' disabled={disabled}
        onCommit={(t) => { const x = t.trim(); set(x === '' ? null : { literal: /^\d+(\.\d+)?$/.test(x) ? Number(x) : x.replace(/^"|"$/g, '') }); }} />
    );
  } else if (def.type === 'enum') {
    control = (
      <select aria-label={label(k)} disabled={disabled} value={lit === undefined ? '' : String(lit)} onChange={(e) => set(e.target.value ? { literal: e.target.value } : null)}>
        <option value="">default</option>
        {def.values!.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  } else {
    control = (
      <select aria-label={label(k)} disabled={disabled} value={lit === undefined ? '' : String(lit)} onChange={(e) => set(e.target.value ? { literal: e.target.value === 'true' } : null)}>
        <option value="">default</option><option value="true">true</option><option value="false">false</option>
      </select>
    );
  }
  return (
    <Row name={k} error={error} extra={extra}>
      {control}
      {value && <button className="btn small" aria-label={`Reset ${label(k)}`} title="Remove this style" disabled={disabled} onClick={() => set(null)}>×</button>}
    </Row>
  );
}

function EventRow({ ev, fn, node, disabled, onOp, onGoto, onCreateHandler }: {
  ev: string; fn?: string; node: DesignNodeInfo; disabled: boolean; onOp: OnOp; onGoto(l: number): void; onCreateHandler: Props['onCreateHandler'];
}) {
  const { error, run } = useOp(onOp);
  const [err2, setErr2] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [calling, setCalling] = useState(false);
  const [name, setName] = useState('');
  const NEW = '__new__';
  const create = async () => {
    setErr2(await onCreateHandler(name.trim(), ev));
    setNaming(false);
  };
  const isCall = !!fn && fn.includes('(');
  return (
    <Row name={ev} error={error || err2}>
      {(isCall || calling) ? (
        <>
          <CommitInput mono aria-label={`${label(ev)} (call with arguments)`} value={fn ?? ''} disabled={disabled} placeholder="delete_item(i)"
            onCommit={(t) => { setCalling(false); void run({ kind: 'set_event', line: node.line, event: ev, function: t.trim() || null }); }} />
          <button className="btn small" title="Use a plain handler instead" onClick={() => { setCalling(false); void run({ kind: 'set_event', line: node.line, event: ev, function: null }); }}>×</button>
        </>
      ) : naming ? (
        <>
          <input autoFocus aria-label="New handler name" className="mono" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setNaming(false); }} placeholder="my_handler" />
          <button className="btn small primary" onClick={() => void create()} disabled={!name.trim()}>Create</button>
        </>
      ) : (
        <>
          <select aria-label={label(ev)} disabled={disabled} value={fn ?? ''}
            onChange={(e) => {
              if (e.target.value === '__call__') { setCalling(true); return; }
              if (e.target.value === NEW) { setName(`${node.component.replace(/_.*$/, '')}_${ev.split('_')[0]}ed`.replace('buttoned', 'button_clicked')); setNaming(true); return; }
              void run({ kind: 'set_event', line: node.line, event: ev, function: e.target.value || null });
            }}>
            <option value="">(none)</option>
            {fn && !node.handlers.includes(fn) && <option value={fn}>{fn} (not a valid handler)</option>}
            {node.handlers.map((h) => <option key={h} value={h}>{h}</option>)}
            <option value={NEW}>＋ New handler…</option>
            <option value="__call__">ƒ Call with arguments…</option>
          </select>
          {fn && node.handler_lines[fn] && <button className="btn small" onClick={() => onGoto(node.handler_lines[fn])} title="Show this function in the code">Code</button>}
        </>
      )}
    </Row>
  );
}


/** Style section: one-click looks, then grouped, collapsible controls. */
function StylePanel({ node, spec, disabled, onOp, onPreview, onReplay, onGoto }: { node: DesignNodeInfo; spec: Spec | null; disabled: boolean; onOp: OnOp; onPreview(op: Record<string, unknown> | null): void; onReplay(): void; onGoto(line: number): void }) {
  const { error, run } = useOp(onOp);
  if (node.style_dynamic) {
    return (
      <section data-testid="style-computed">
        <h4>Style</h4>
        <p className="small">This component's style is computed by your code:</p>
        <pre className="code-block">style={node.style_expr}</pre>
        <p className="muted small">Change the function that returns it, or replace it with a style you can edit here.</p>
        <div className="row">
          <button className="btn small" onClick={() => onGoto(node.line)}>Show in code</button>
          <button className="btn small" disabled={disabled} data-testid="reset-style" onClick={() => void run({ kind: 'reset_style', line: node.line })}>Replace with an editable style</button>
        </div>
        {error && <div className="error-text small" role="alert">{error}</div>}
      </section>
    );
  }
  if (!spec) return null;
  const isScreen = node.kind === 'screen';
  const allowed = new Set(node.allowed.style);
  /** The set_styles operation for a look, limited to keys this component allows. */
  const opFor = (styles: StyleChange, fallbackBg?: string): Record<string, unknown> | null => {
    const out: StyleChange = {};
    for (const [k, v] of Object.entries(styles)) if (allowed.has(k)) out[k] = v;
    // clay/outline look wrong without a colour: add a sensible one only if the component has none
    if (fallbackBg && allowed.has('background') && !node.style.background && !('background' in out)) out.background = { literal: fallbackBg };
    return Object.keys(out).length ? { kind: 'set_styles', line: node.line, styles: out } : null;
  };
  const apply = (styles: StyleChange, fallbackBg?: string) => { const op = opFor(styles, fallbackBg); if (op) void run(op); };
  /** hover / keyboard focus shows the result on the canvas without changing the code */
  const hover = (styles: StyleChange, fallbackBg?: string) => ({
    onMouseEnter: () => onPreview(opFor(styles, fallbackBg)), onMouseLeave: () => onPreview(null),
    onFocus: () => onPreview(opFor(styles, fallbackBg)), onBlur: () => onPreview(null),
  });
  const clearAll = () => {
    const out: StyleChange = {};
    for (const k of Object.keys(node.style)) out[k] = null;
    if (Object.keys(out).length) void run({ kind: 'set_styles', line: node.line, styles: out });
  };
  const used = Object.keys(node.style).length;
  return (
    <section data-testid="style-panel">
      <h4>Style</h4>
      {!isScreen ? (
        <div className="presets" role="group" aria-label="Style presets">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="preset" data-testid={`preset-${p.id}`} title={p.hint} disabled={disabled}
              onClick={() => apply(p.styles, p.fallbackBackground)} {...hover(p.styles, p.fallbackBackground)}>
              <span className={`preset-chip preset-${p.id}`} aria-hidden="true" />
              {p.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="presets" role="group" aria-label="Screen themes">
          {SCREEN_THEMES.map((t) => (
            <button key={t.name} type="button" className="preset" disabled={disabled} title={`${t.name} screen`}
              onClick={() => apply(t.styles)} {...hover(t.styles)}>
              <span className="preset-chip" style={{ background: t.css }} aria-hidden="true" />
              {t.name}
            </button>
          ))}
        </div>
      )}
      {error && <div className="error-text small" role="alert">{error}</div>}
      {GROUPS.map((g) => {
        const keys = g.keys.filter((k) => allowed.has(k) && spec.styles[k]);
        if (!keys.length) return null;
        const setCount = keys.filter((k) => node.style[k]).length;
        return (
          <details key={`${node.line}-${g.id}`} className="insp-group" open={g.open || setCount > 0}>
            <summary>{g.label}{setCount > 0 && <span className="count">{setCount}</span>}</summary>
            {g.id === 'motion' && (
              <div className="chips" role="group" aria-label="Animations">
                {ANIMATIONS.map((a) => (
                  <button key={a.id} type="button" className={`chip ${node.style.animate?.literal?.value === a.id ? 'on' : ''}`} disabled={disabled} data-testid={`anim-${a.id}`}
                    onClick={() => void run({ kind: 'set_style', line: node.line, key: 'animate', value: { literal: a.id } })}
                    onMouseEnter={() => onPreview({ kind: 'set_style', line: node.line, key: 'animate', value: { literal: a.id } })} onMouseLeave={() => onPreview(null)}
                    onFocus={() => onPreview({ kind: 'set_style', line: node.line, key: 'animate', value: { literal: a.id } })} onBlur={() => onPreview(null)}>{a.name}</button>
                ))}
                <button type="button" className="chip replay" disabled={disabled || !node.style.animate} onClick={onReplay} title="Play the animation again" data-testid="anim-replay">▶ Replay</button>
                {node.style.animate && <button type="button" className="chip" disabled={disabled} onClick={() => void run({ kind: 'set_style', line: node.line, key: 'animate', value: null })}>None</button>}
              </div>
            )}
            {keys.map((k) => (
              <StyleRow key={`${node.line}-${k}`} k={k} def={spec.styles[k]} value={node.style[k]} disabled={disabled} onOp={onOp} onPreview={onPreview} node={node} />
            ))}
          </details>
        );
      })}
      {used > 0 && <button type="button" className="btn small clear-all" disabled={disabled} onClick={clearAll}>Clear all styles ({used})</button>}
    </section>
  );
}

export function Inspector({ node, spec, disabled, onOp, onPreview, onReplay, onDelete, onDuplicate, onGoto, onCreateHandler }: Props) {
  if (!node) {
    return (
      <div className="panel-body empty-insp">
        <p><strong>Nothing selected</strong></p>
        <p className="muted">Click a component on the phone (or in the Outline) to edit it. Click the empty screen area to style the whole screen.</p>
        <ul className="tips muted small">
          <li>Try a one-click look: <b>Clay</b>, <b>Elevated</b>, <b>Outline</b>…</li>
          <li>Pick colours from the palette, or drag the sliders.</li>
          <li><kbd>Del</kbd> deletes · <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates · drag to move.</li>
        </ul>
      </div>
    );
  }
  const isScreen = node.kind === 'screen';
  return (
    <div className="panel-body inspector" data-testid="inspector">
      <div className="insp-head">
        <strong data-testid="inspector-title">{isScreen ? `Screen “${node.name}”` : node.component}</strong>
        <span className="muted small mono"> line {node.line}</span>
        {!isScreen && (
          <span className="insp-actions">
            <button className="btn small" onClick={onDuplicate} disabled={disabled}>Duplicate</button>
            <button className="btn small danger-outline" onClick={onDelete} disabled={disabled} data-testid="inspector-delete">Delete</button>
          </span>
        )}
      </div>
      <div className="insp-cols">
        {!isScreen && (
          <section>
            <h4>Properties</h4>
            {node.allowed.props.map((p) => (
              <PropRow key={`${node.line}-${p.name}`} name={p.name} type={p.type} required={p.required} value={node.props[p.name]} disabled={disabled} onOp={onOp} node={node} />
            ))}
            {node.allowed.events.length > 0 && <h4>Events</h4>}
            {node.allowed.events.map((ev) => (
              <EventRow key={`${node.line}-${ev}`} ev={ev} fn={node.events[ev]} node={node} disabled={disabled} onOp={onOp} onGoto={onGoto} onCreateHandler={onCreateHandler} />
            ))}
          </section>
        )}
        <StylePanel node={node} spec={spec} disabled={disabled} onOp={onOp} onPreview={onPreview} onReplay={onReplay} onGoto={onGoto} />
      </div>
    </div>
  );
}
