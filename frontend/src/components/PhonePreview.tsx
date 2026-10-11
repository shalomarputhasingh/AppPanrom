import { useEffect, useMemo, useRef } from 'react';
import { api } from '../api';
import { buildPreviewDoc } from '../previewDoc';
import type { LogLine } from '../types';
import { FitStage } from './FitStage';

export type PreviewState = 'empty' | 'loading' | 'error' | 'ready';

interface Props {
  zoom: 'fit' | '100';
  state: PreviewState;
  ir: unknown;
  runKey: number;
  projectId: string;
  errorCount: number;
  /** false while the code does not compile: the preview keeps the last good version and says so. */
  codeOk: boolean;
  onLog(level: LogLine['level'], text: string): void;
  onRestart(): void;
}

/** One-shot location through the browser (it shows its own permission prompt). */
function deviceLocation(): Promise<{ lat?: number; lon?: number; accuracy?: number; denied?: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ error: 'This browser has no location support.' });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => resolve(e.code === e.PERMISSION_DENIED ? { denied: true } : { error: 'The location could not be read.' }),
      { timeout: 20000, maximumAge: 60000 },
    );
  });
}

/** A browser notification for the previewed app; asks permission the first time. */
async function deviceNotify(title: string, text: string): Promise<{ error?: string }> {
  try {
    if (typeof Notification === 'undefined') return { error: 'This browser has no notification support.' };
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') return { error: 'Notifications are turned off for the Studio in this browser.' };
    new Notification(title, { body: text });
    return {};
  } catch {
    return { error: 'The browser could not show the notification.' };
  }
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

export function PhonePreview({ zoom, state, ir, runKey, projectId, errorCount, codeOk, onLog, onRestart }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => Math.random().toString(36).slice(2) + runKey, [runKey]);
  // The document is rebuilt only when the app is (re)started. New code afterwards is pushed into the running app (hot reload),
  // so typing never reloads the iframe: no flash, state is kept, only changed components are patched.
  const latest = useRef(ir);
  latest.current = ir;
  const sent = useRef<unknown>(null);
  const doc = useMemo(
    () => {
      if (state !== 'ready' || !latest.current) return null;
      sent.current = latest.current;
      return buildPreviewDoc(latest.current, loadStore(projectId), token);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state === 'ready', runKey, projectId, token],
  );
  useEffect(() => {
    if (!doc || !ir || ir === sent.current) return;
    sent.current = ir;
    frame.current?.contentWindow?.postMessage({ type: 'ap-update', token, ir }, '*');
  }, [ir, doc, token]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (e.source !== frame.current?.contentWindow || !m || m.token !== token) return;
      if (m.type === 'ap-log' && typeof m.text === 'string') onLog(m.level === 'info' || m.level === 'warning' || m.level === 'error' ? m.level : 'debug', m.text.slice(0, 2000));
      if ((m.type === 'ap-http' || m.type === 'ap-location' || m.type === 'ap-notify') && typeof m.id === 'number') {
        const win = frame.current?.contentWindow;
        const reply = (res: object) => win?.postMessage({ type: 'ap-reply', token, id: m.id, res }, '*');
        if (m.type === 'ap-http' && m.req && typeof m.req.url === 'string') {
          const method = ['GET', 'POST', 'PUT', 'DELETE'].includes(m.req.method) ? m.req.method : 'GET';
          api.webRequest(method, m.req.url.slice(0, 2048), typeof m.req.body === 'string' ? m.req.body : null)
            .then(reply, () => reply({ status: 0, text: '', error: 'The Studio could not reach its web-request proxy.' }));
        } else if (m.type === 'ap-location') {
          deviceLocation().then(reply);
        } else if (m.type === 'ap-notify' && m.req) {
          deviceNotify(String(m.req.title ?? '').slice(0, 100), String(m.req.text ?? '').slice(0, 500)).then(reply);
        }
      }
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
    <section className="phone-wrap" aria-label="Android preview" title="Live preview, not an APK. Same runtime as the Android app.">
      <FitStage w={340} h={680} zoom={zoom}>
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
      </FitStage>
      <div className="row center">
        <button className="btn" onClick={onRestart} disabled={state !== 'ready'}>Restart app</button>
        <button className="btn" onClick={resetData} disabled={state !== 'ready'} title="Clears data saved with data_save_pannu in the preview">Reset app data</button>
      </div>
      {state === 'ready' && (
        <p className={`live-badge ${codeOk ? 'ok' : 'paused'}`} role="status" data-testid="live-badge">
          {codeOk ? '● Live: edits appear here instantly' : '⏸ Paused: fix the errors in your code (showing the last working version)'}
        </p>
      )}
    </section>
  );
}
