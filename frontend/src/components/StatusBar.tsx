interface Props {
  sync: 'ok' | 'errors' | 'pending';
  errors: number;
  warnings: number;
  save: string;
  saveLabel: string;
  live: boolean;
  vocab: 'English' | 'Tanglish';
  screen: string | null;
  selected: string | null;
  zoom: 'fit' | '100';
  onZoom(z: 'fit' | '100'): void;
  onDiagnostics(): void;
  onPalette(): void;
  onResetLayout(): void;
}

/** The thin bar at the bottom: what state is my project in, at a glance. */
export function StatusBar({ sync, errors, warnings, save, saveLabel, live, vocab, screen, selected, zoom, onZoom, onDiagnostics, onPalette, onResetLayout }: Props) {
  return (
    <footer className="statusbar" data-testid="statusbar" aria-label="Status">
      <button className={`sb-item ${errors ? 'bad' : warnings ? 'warn' : 'ok'}`} onClick={onDiagnostics} data-testid="sb-problems" title="Show problems">
        {sync === 'pending' ? '… checking' : errors ? `✕ ${errors} error${errors === 1 ? '' : 's'}` : warnings ? `⚠ ${warnings} warning${warnings === 1 ? '' : 's'}` : '✓ no problems'}
      </button>
      {save !== 'saved' && <span className={`sb-item save-state ${save}`}>{saveLabel}</span>}
      {live && <span className={`sb-item ${sync === 'ok' ? 'ok' : 'warn'}`} data-testid="sb-live">{sync === 'ok' ? '● live preview' : '⏸ preview paused'}</span>}
      <span className="sb-spacer" />
      {screen && <span className="sb-item muted" title="Current screen">screen: {screen}</span>}
      {selected && <span className="sb-item muted" title="Selected component">{selected}</span>}
      <span className="sb-item muted" title="Vocabulary of this file (Settings → Language converts it)">{vocab}</span>
      <span className="seg mini" role="group" aria-label="Phone size">
        <button className={zoom === 'fit' ? 'on' : ''} onClick={() => onZoom('fit')} title="Scale the phone to fit the panel">Fit</button>
        <button className={zoom === '100' ? 'on' : ''} onClick={() => onZoom('100')} title="Real size (scrolls)">100%</button>
      </span>
      <button className="sb-item" onClick={onResetLayout} title="Restore the default panel sizes">⟲ layout</button>
      <button className="sb-item" onClick={onPalette} title="Command palette (Ctrl+K)">⌘K</button>
    </footer>
  );
}
