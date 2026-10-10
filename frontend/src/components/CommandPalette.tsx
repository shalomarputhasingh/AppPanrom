import { useEffect, useMemo, useRef, useState } from 'react';

export interface Command { id: string; label: string; hint?: string; keys?: string; group: string; run(): void; disabled?: boolean }

/** Ctrl/Cmd+K: type to find anything the Studio can do. Arrow keys + Enter, Escape closes. */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose(): void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => input.current?.focus(), []);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => !c.disabled && words.every((w) => `${c.group} ${c.label} ${c.hint ?? ''}`.toLowerCase().includes(w)));
  }, [commands, q]);
  useEffect(() => setI(0), [q]);
  useEffect(() => { (list.current?.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }); }, [i]);
  const go = (c?: Command) => { if (!c) return; onClose(); setTimeout(c.run, 0); };
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div className="palette-box" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} className="palette-input" aria-label="Search commands" placeholder="Type a command…  (run, save, design, add button, go to screen, Tanglish…)" value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(shown.length - 1, x + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); go(shown[i]); }
          }} />
        <ul className="palette-list" ref={list} role="listbox" aria-label="Commands">
          {shown.length === 0 && <li className="palette-empty muted">No command matches “{q}”.</li>}
          {shown.map((c, n) => (
            <li key={c.id} role="option" aria-selected={n === i} className={n === i ? 'on' : ''} onMouseEnter={() => setI(n)} onClick={() => go(c)}>
              <span className="palette-group">{c.group}</span>
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="muted small palette-hint">{c.hint}</span>}
              {c.keys && <kbd>{c.keys}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
