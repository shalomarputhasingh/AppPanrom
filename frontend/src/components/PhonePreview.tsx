import { useEffect, useMemo, useRef } from 'react';
import { buildPreviewDoc } from '../previewDoc';
import type { LogLine } from '../types';

export type PreviewState = 'empty' | 'loading' | 'error' | 'ready';

interface Props {
  state: PreviewState;
  ir: unknown;
  runKey: number;
  projectId: string;
  errorCount: number;
  onLog(level: LogLine['level'], text: string): void;
  onRestart(): void;
}

const storeKey = (id: string) => `apppanrom:preview-store:${id}`;

function loadStore(id: string): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(id)) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function saveStore(id: string, data: Record<string, string>) {
  try { localStorage.setItem(storeKey(id), JSON.stringify(data)); } catch { /* storage unavailable: preview data just won't persist */ }
}

export function PhonePreview({ state, ir, runKey, projectId, errorCount, onLog, onRestart }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => Math.random().toString(36).slice(2) + runKey, [runKey]);
  const doc = useMemo(
    () => (state === 'ready' && ir ? buildPreviewDoc(ir, loadStore(projectId), token) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, ir, runKey, projectId, token],
  );

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (e.source !== frame.current?.contentWindow || !m || m.token !== token) return;
      if (m.type === 'ap-log' && typeof m.text === 'string') onLog(m.level === 'info' || m.level === 'warning' || m.level === 'error' ? m.level : 'debug', m.text.slice(0, 2000));
      if (m.type === 'ap-store' && typeof m.key === 'string') {
        const data = loadStore(projectId);
        if (m.op === 'set') data[m.key] = String(m.value);
        else delete data[m.key];
        saveStore(projectId, data);
      }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [token, projectId, onLog]);

  const resetData = () => {
    try { localStorage.removeItem(storeKey(projectId)); } catch { /* ignore */ }
    onLog('system', 'Preview app data cleared.');
    onRestart();
  };

  return (
    <section className="phone-wrap" aria-label="Android preview">
      <div className="phone" data-testid="phone">
        <div className="phone-notch" />
        <div className="phone-screen">
          {state === 'empty' && (
            <div className="phone-msg"><strong>No preview yet</strong><span>Press <b>Run</b> to see your app here.</span></div>
          )}
          {state === 'loading' && <div className="phone-msg" role="status">Compiling…</div>}
          {state === 'error' && (
            <div className="phone-msg err" role="alert">
              <strong>{errorCount} error{errorCount === 1 ? '' : 's'} in your code</strong>
              <span>Fix them (see Diagnostics) and press Run again. The previous preview is not shown because it would be out of date.</span>
            </div>
          )}
          {doc && (
            <iframe key={`${runKey}`} ref={frame} title="App preview" data-testid="preview-frame" sandbox="allow-scripts" srcDoc={doc} />
          )}
        </div>
      </div>
      <div className="row center">
        <button className="btn" onClick={onRestart} disabled={state !== 'ready'}>Restart app</button>
        <button className="btn" onClick={resetData} disabled={state !== 'ready'} title="Clears data saved with data_save_pannu in the preview">Reset app data</button>
      </div>
      <p className="muted small center-text">Live preview — not an APK. Same runtime as the Android app.</p>
    </section>
  );
}
