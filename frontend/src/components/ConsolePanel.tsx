import { useEffect, useRef } from 'react';
import type { LogLine } from '../types';

export function ConsolePanel({ lines, onClear }: { lines: LogLine[]; onClear(): void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [lines.length]);
  return (
    <div className="panel-body">
      <div className="panel-tools"><button className="btn small" onClick={onClear}>Clear</button></div>
      <div className="console" role="log" aria-live="polite" data-testid="console">
        {lines.length === 0 && <p className="muted">Output from your app (message_kaattu, debug_log, errors) appears here.</p>}
        {lines.map((l) => (
          <div key={l.id} className={`log ${l.level}`}>
            <span className="log-time">{l.time}</span>
            <span className="log-level">{l.level}</span>
            <span className="log-text">{l.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
