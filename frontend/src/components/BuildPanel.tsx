import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { Build, Diagnostic, SystemStatus } from '../types';

interface Props {
  projectId: string;
  /** Saves the editor buffer first; resolves false if saving failed. */
  ensureSaved(): Promise<boolean>;
  onProblems(d: Diagnostic[]): void;
}

const LABEL: Record<Build['status'], string> = { queued: 'Queued', running: 'Building…', succeeded: 'Succeeded', failed: 'Failed' };
const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function BuildPanel({ projectId, ensureSaved, onProblems }: Props) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const offset = useRef(0);
  const logEnd = useRef<HTMLPreElement>(null);

  const loadBuilds = useCallback(async () => {
    const list = await api.builds(projectId);
    setBuilds(list);
    return list;
  }, [projectId]);

  useEffect(() => {
    api.status().then(setStatus, (e) => setError(e.message));
    loadBuilds().then((l) => l[0] && setSelected(l[0].id), () => undefined);
  }, [projectId, loadBuilds]);

  const current = builds.find((b) => b.id === selected) ?? null;
  const active = current && (current.status === 'queued' || current.status === 'running');

  // When the selected build changes, restart log streaming from the top.
  useEffect(() => {
    offset.current = 0;
    setLog('');
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.buildLog(selected, offset.current);
        if (stop) return;
        if (r.text) setLog((t) => t + r.text);
        offset.current = r.next_offset;
        const b = await api.build(selected);
        if (stop) return;
        setBuilds((list) => list.map((x) => (x.id === b.id ? b : x)));
        if (b.status === 'queued' || b.status === 'running') timer = window.setTimeout(tick, 1000);
        else if (!r.done || r.text) timer = window.setTimeout(tick, 300);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    let timer = window.setTimeout(tick, 0);
    return () => { stop = true; window.clearTimeout(timer); };
  }, [selected, active]);

  useEffect(() => logEnd.current?.scrollTo?.({ top: logEnd.current.scrollHeight }), [log]);

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      if (!(await ensureSaved())) throw new Error('Could not save your code; build cancelled.');
      const b = await api.startBuild(projectId);
      setBuilds((l) => [b, ...l]);
      setSelected(b.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'source_invalid') {
        onProblems(e.details as Diagnostic[]);
        setError('Your code has errors. Fix them (see Diagnostics) before building.');
      } else setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const prereq = status?.android;
  return (
    <div className="panel-body build-panel">
      <div className="build-top">
        <div>
          <button className="btn primary" onClick={start} disabled={starting || !!active} data-testid="build-btn">
            {active ? 'Building…' : 'Build debug APK'}
          </button>
          <p className="muted small">Debug APK, signed with the Android debug key. Not for the Play Store.</p>
        </div>
        {prereq && (
          <details className={`prereq ${prereq.ok ? 'ok' : 'bad'}`} open={!prereq.ok && builds.length === 0}>
            <summary>{prereq.ok ? '✓ Android build tools ready' : '⚠ Android build tools not ready'}</summary>
            <ul>
              {prereq.checks.map((c) => (
                <li key={c.name}>
                  <b>{c.ok ? '✓' : '✗'} {c.name}</b>: {c.detail}
                  {!c.ok && <div className="muted small">Fix: {c.fix}</div>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}

      {current && (
        <div className="build-current" data-testid="build-current">
          <div className="row">
            <span className={`badge ${current.status}`} data-testid="build-status">{LABEL[current.status]}</span>
            <span className="mono small">{current.id}</span>
            {current.duration_s != null && <span className="muted small">{current.duration_s}s</span>}
          </div>
          {current.status === 'failed' && <p className="error-text">{current.message}</p>}
          {current.artifact && (
            <p>
              <a className="btn primary" href={api.artifactUrl(current.id)} download={current.artifact.name} data-testid="download-btn">
                Download {current.artifact.name}
              </a>{' '}
              <span className="muted small">{fmtSize(current.artifact.size)} · sha256 {current.artifact.sha256.slice(0, 12)}… · {current.signing}</span>
            </p>
          )}
          <pre className="buildlog" ref={logEnd} aria-label="Build log" data-testid="build-log">{log || (active ? 'Waiting for output…' : '')}</pre>
        </div>
      )}

      {builds.length > 0 && (
        <>
          <h4>Build history</h4>
          <ul className="history">
            {builds.map((b) => (
              <li key={b.id}>
                <button className={`hist ${b.id === selected ? 'sel' : ''}`} onClick={() => setSelected(b.id)}>
                  <span className={`badge ${b.status}`}>{LABEL[b.status]}</span>
                  <span className="mono small">{b.id}</span>
                  <span className="muted small">v{b.version} · {new Date(b.created_at).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {builds.length === 0 && !error && <p className="muted">No builds yet.</p>}
    </div>
  );
}
