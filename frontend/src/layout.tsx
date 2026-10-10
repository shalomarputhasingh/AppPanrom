import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';

export interface Layout { side: number; prev: number; bottom: number; sideOpen: boolean; bottomOpen: boolean; zoom: 'fit' | '100' }
export const DEFAULT_LAYOUT: Layout = { side: 250, prev: 400, bottom: 230, sideOpen: true, bottomOpen: true, zoom: 'fit' };
const KEY = 'apppanrom.layout';

function load(): Layout {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    return {
      side: clamp(Number(v.side) || DEFAULT_LAYOUT.side, 160, 520), prev: clamp(Number(v.prev) || DEFAULT_LAYOUT.prev, 300, 760),
      bottom: clamp(Number(v.bottom) || DEFAULT_LAYOUT.bottom, 120, 640),
      sideOpen: v.sideOpen !== false, bottomOpen: v.bottomOpen !== false, zoom: v.zoom === '100' ? '100' : 'fit',
    };
  } catch { return DEFAULT_LAYOUT; }
}
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Panel sizes and open/closed state, remembered between visits. */
export function useLayout(): [Layout, (patch: Partial<Layout>) => void, () => void] {
  const [lay, setLay] = useState<Layout>(load);
  useEffect(() => { try { window.localStorage.setItem(KEY, JSON.stringify(lay)); } catch { /* not persisted */ } }, [lay]);
  const update = useCallback((patch: Partial<Layout>) => setLay((l) => ({ ...l, ...patch })), []);
  const reset = useCallback(() => setLay(DEFAULT_LAYOUT), []);
  return [lay, update, reset];
}

interface SplitterProps {
  area: string;
  /** "v" = a vertical bar (drag left/right), "h" = a horizontal bar (drag up/down) */
  dir: 'v' | 'h';
  value: number; min: number; max: number;
  /** dragging towards the start of the screen makes the panel bigger (right / bottom panels) */
  invert?: boolean;
  onChange(v: number): void;
  onReset(): void;
  label: string;
}

/** A draggable, keyboard-operable divider between two panels. Double-click restores the default size. */
export function Splitter({ area, dir, value, min, max, invert, onChange, onReset, label }: SplitterProps) {
  const start = useRef<{ p: number; v: number } | null>(null);
  const [active, setActive] = useState(false);
  const sign = invert ? -1 : 1;
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { p: dir === 'v' ? e.clientX : e.clientY, v: value };
    setActive(true);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const d = (dir === 'v' ? e.clientX : e.clientY) - start.current.p;
    onChange(clamp(start.current.v + sign * d, min, max));
  };
  const up = () => { start.current = null; setActive(false); };
  const key = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    const grow = dir === 'v' ? (invert ? 'ArrowLeft' : 'ArrowRight') : (invert ? 'ArrowUp' : 'ArrowDown');
    const shrink = dir === 'v' ? (invert ? 'ArrowRight' : 'ArrowLeft') : (invert ? 'ArrowDown' : 'ArrowUp');
    if (e.key === grow) { e.preventDefault(); onChange(clamp(value + step, min, max)); }
    else if (e.key === shrink) { e.preventDefault(); onChange(clamp(value - step, min, max)); }
    else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); onReset(); }
  };
  return (
    <div className={`splitter ${dir} ${active ? 'active' : ''}`} style={{ gridArea: area }} role="separator" aria-orientation={dir === 'v' ? 'vertical' : 'horizontal'}
      aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max} tabIndex={0} title={`${label} (drag, arrow keys, double-click to reset)`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={onReset} onKeyDown={key} />
  );
}
