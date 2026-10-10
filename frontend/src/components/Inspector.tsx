import { useEffect, useRef, useState } from 'react';
import type { DesignInput, DesignNodeInfo, DesignValue, Spec } from '../types';

type OnOp = (op: Record<string, unknown>) => Promise<string | null>;

interface Props {
  node: DesignNodeInfo | null;
  spec: Spec | null;
  disabled: boolean;
  onOp: OnOp;
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
  scroll: 'Scroll', visible: 'Visible', shadow: 'Shadow', clay: 'Clay (3D soft)', click_pannumbodhu: 'On click', change_aagumbodhu: 'On change', submit_pannumbodhu: 'On submit',
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

function Row({ name, children, error }: { name: string; children: React.ReactNode; error?: string | null }) {
  return (
    <div className="insp-row">
      <span className="insp-label">{label(name)}</span>
      <div className="insp-ctl">{children}</div>
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

function StyleRow({ k, def, value, disabled, onOp, node }: {
  k: string; def: Spec['styles'][string]; value?: DesignValue; disabled: boolean; onOp: OnOp; node: DesignNodeInfo;
}) {
  const { error, run } = useOp(onOp);
  const set = (v: DesignInput) => run({ kind: 'set_style', line: node.line, key: k, value: v });
  const lit = value?.literal?.value;
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  let control;
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
  } else if (def.type === 'number') {
    control = (
      <CommitInput type="number" aria-label={label(k)} value={lit === undefined ? '' : String(lit)} disabled={disabled}
        min={def.min} max={def.max} step={k === 'opacity' ? 0.1 : 1} onCommit={(t) => set(t === '' ? null : { literal: Number(t) })} />
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
    <Row name={k} error={error}>
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
  const [name, setName] = useState('');
  const NEW = '__new__';
  const create = async () => {
    setErr2(await onCreateHandler(name.trim(), ev));
    setNaming(false);
  };
  return (
    <Row name={ev} error={error || err2}>
      {naming ? (
        <>
          <input autoFocus aria-label="New handler name" className="mono" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setNaming(false); }} placeholder="my_handler" />
          <button className="btn small primary" onClick={() => void create()} disabled={!name.trim()}>Create</button>
        </>
      ) : (
        <>
          <select aria-label={label(ev)} disabled={disabled} value={fn ?? ''}
            onChange={(e) => {
              if (e.target.value === NEW) { setName(`${node.component.replace(/_.*$/, '')}_${ev.split('_')[0]}ed`.replace('buttoned', 'button_clicked')); setNaming(true); return; }
              void run({ kind: 'set_event', line: node.line, event: ev, function: e.target.value || null });
            }}>
            <option value="">(none)</option>
            {fn && !node.handlers.includes(fn) && <option value={fn}>{fn} (not a valid handler)</option>}
            {node.handlers.map((h) => <option key={h} value={h}>{h}</option>)}
            <option value={NEW}>＋ New handler…</option>
          </select>
          {fn && node.handler_lines[fn] && <button className="btn small" onClick={() => onGoto(node.handler_lines[fn])} title="Show this function in the code">Code</button>}
        </>
      )}
    </Row>
  );
}

export function Inspector({ node, spec, disabled, onOp, onDelete, onDuplicate, onGoto, onCreateHandler }: Props) {
  if (!node) {
    return <div className="panel-body"><p className="muted">Select a component on the phone or in the outline to edit its properties.</p></div>;
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
        <section>
          <h4>Style</h4>
          {node.style_dynamic && <p className="muted small">This style is computed in code; edit it in the editor.</p>}
          {!node.style_dynamic && spec && node.allowed.style.map((k) => (
            <StyleRow key={`${node.line}-${k}`} k={k} def={spec.styles[k]} value={node.style[k]} disabled={disabled} onOp={onOp} node={node} />
          ))}
        </section>
      </div>
    </div>
  );
}
