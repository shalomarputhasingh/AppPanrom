import type { Diagnostic } from '../types';

interface Props {
  diagnostics: Diagnostic[];
  checked: boolean;
  onJump(d: Diagnostic): void;
}

export function DiagnosticsPanel({ diagnostics, checked, onJump }: Props) {
  if (!checked) return <div className="panel-body"><p className="muted">Diagnostics appear as you type.</p></div>;
  if (diagnostics.length === 0) return <div className="panel-body"><p className="ok-text" data-testid="no-problems">✓ No problems found.</p></div>;
  return (
    <div className="panel-body">
      <ul className="diag-list" data-testid="diagnostics">
        {diagnostics.map((d, i) => (
          <li key={i}>
            <button className={`diag ${d.severity}`} onClick={() => onJump(d)}>
              <span className="diag-loc mono">{d.file}:{d.line}:{d.col}</span>
              <span className="diag-sev">{d.severity}</span>
              <span className="diag-msg">{d.message}{d.suggestion && <em> {d.suggestion}</em>}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
