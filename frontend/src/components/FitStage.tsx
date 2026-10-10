import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Shows a fixed-size device (the phone) scaled to fit the space it is given, so the whole phone and its buttons are visible on any
 * screen without scrolling. `zoom="100"` keeps real size and scrolls instead.
 */
export function FitStage({ w, h, zoom, children }: { w: number; h: number; zoom: 'fit' | '100'; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      if (zoom === '100') { setScale(1); return; }
      const s = Math.min((el.clientWidth - 8) / w, (el.clientHeight - 8) / h, 1);
      setScale(Math.max(0.35, Number.isFinite(s) ? s : 1));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h, zoom]);
  return (
    <div className={`stage ${zoom === '100' ? 'scroll' : ''}`} ref={box} data-scale={scale.toFixed(2)}>
      <div style={{ width: w * scale, height: h * scale, flex: 'none' }}>
        <div style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: 'top left' }}>{children}</div>
      </div>
    </div>
  );
}
