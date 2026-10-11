import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { changeCount, collapse, diffLines } from '../diff';
import type { AiStatus, Diagnostic } from '../types';

export interface AiTask { id: number; text: string; send: boolean }

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  code?: string | null;
  compiles?: boolean | null;
  diags?: Diagnostic[];
  attempts?: number;
  notes?: string[];
  error?: boolean;
  applied?: boolean;
}

interface Wait { text: string; until: number; total: number; scope: 'minute' | 'day'; model: string; fallbackPossible: boolean }

/** How long we are willing to sit and count down before handing control back to the user. */
const AUTO_WAIT_MAX_S = 300;

const human = (s: number) => (s < 90 ? `${Math.max(0, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

interface Props {
  projectId: string;
  getText(): string;
  /** Current compiler problems (errors are sent along so "fix my errors" works). */
  diagnostics: Diagnostic[];
  selection: { line: number; component: string } | null;
  onApply(code: string): void;
  /** A request that came from the command palette. */
  task: AiTask | null;
}

const storeKey = (id: string) => `apppanrom.ai.${id}`;
function load(id: string): Msg[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(storeKey(id)) ?? '[]');
    return Array.isArray(v) ? v.filter((m) => m && typeof m.text === 'string') : [];
  } catch { return []; }
}
function save(id: string, msgs: Msg[]) {
  try {
    const keep = msgs.slice(-16).map((m) => ({ ...m, code: m.code && m.code.length < 60_000 ? m.code : undefined }));
    window.localStorage.setItem(storeKey(id), JSON.stringify(keep));
  } catch { /* chat history is a convenience only */ }
}

const QUICK = [
  { label: 'Explain my code', text: 'Explain what my app does, screen by screen, in a few lines.', send: true },
  { label: 'Fix my errors', text: 'Fix the compiler problems in my code.', send: true, needsErrors: true },
  { label: 'Add a screen…', text: 'Add a new screen called ', send: false },
  { label: 'Make it prettier', text: 'Make the app look better: use a clay look with pastel colours, rounded corners and gentle animations. Keep all behaviour.', send: true },
  { label: 'Add a top bar & tabs', text: 'Give every screen a nice top bar and add bottom tabs to move between the screens.', send: true },
  { label: 'Tanglish dialogues', text: 'Rewrite the user-facing texts and messages in friendly Tanglish with relatable Tamil dialogues. Keep the code working.', send: true },
];

export function AiPanel({ projectId, getText, diagnostics, selection, onApply, task }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>(() => load(projectId));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [includeCode, setIncludeCode] = useState(true);
  const [keyInput, setKeyInput] = useState('');
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [wait, setWait] = useState<Wait | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [onLimit, setOnLimit] = useState<'wait' | 'fallback'>(() => { try { return window.localStorage.getItem('apppanrom.ai.onlimit') === 'fallback' ? 'fallback' : 'wait'; } catch { return 'wait'; } });
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(Date.now());

  const errors = useMemo(() => diagnostics.filter((d) => d.severity === 'error'), [diagnostics]);
  useEffect(() => { api.aiStatus().then(setStatus, () => setStatus(null)); }, []);
  useEffect(() => { save(projectId, msgs); }, [projectId, msgs]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [msgs.length, busy]);

  const send = useCallback(async (text: string, opts: { resend?: boolean; onLimit?: 'wait' | 'fallback' } = {}) => {
    const t = text.trim();
    if (!t || busy) return;
    setWait(null);
    const user: Msg = { id: ++nextId.current, role: 'user', text: t };
    const prior = opts.resend ? msgs : [...msgs, user];
    const history = [...prior].slice(-12).map((m) => ({ role: m.role, content: m.text || '(code only)' }));
    if (!opts.resend) setMsgs((m) => [...m, user]);
    setInput('');
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const r = await api.aiChat(projectId, {
        messages: history, source: getText(), include_code: includeCode,
        diagnostics: errors.slice(0, 20).map((d) => ({ line: d.line, message: d.message, suggestion: d.suggestion })),
        selection, on_limit: opts.onLimit ?? onLimit,
      }, ctl.signal);
      const notes: string[] = [];
      if (r.fallback_from) notes.push(`Answered by ${r.model.split('/').pop()} (backup) because ${r.fallback_from.split('/').pop()} was rate-limited.`);
      if (r.waited_s > 0) notes.push(`Waited ${human(r.waited_s)} for Groq's rate limit to reset.`);
      if (r.mode === 'edit') notes.push(r.trimmed ? 'Large file: sent only the relevant parts and got back small edits.' : 'Large file: answered with small edits.');
      setMsgs((m) => [...m, { id: ++nextId.current, role: 'assistant', text: r.text, code: r.code, compiles: r.compiles, diags: r.diagnostics, attempts: r.attempts, notes }]);
    } catch (e) {
      const err = e as ApiError;
      const d = err.details as { retry_after_s?: number; scope?: 'minute' | 'day'; model?: string; fallback_possible?: boolean } | undefined;
      if (err.code === 'aborted') setMsgs((m) => [...m, { id: ++nextId.current, role: 'assistant', text: 'Cancelled.', error: true }]);
      else if (err.code === 'ai_rate_limited' && d?.retry_after_s) {
        // Groq's free plan has small per-minute / per-day limits: wait for the reset and send the same request again
        setWait({ text: t, until: Date.now() + d.retry_after_s * 1000, total: d.retry_after_s, scope: d.scope ?? 'minute', model: d.model ?? '', fallbackPossible: !!d.fallback_possible });
        setNow(Date.now());
      } else {
        setMsgs((m) => [...m, { id: ++nextId.current, role: 'assistant', text: err.message, error: true }]);
        if (err.code === 'ai_not_configured' || err.code === 'ai_bad_key') api.aiStatus().then(setStatus, () => undefined);
      }
    } finally {
      setBusy(false);
      abort.current = null;
      api.aiStatus().then(setStatus, () => undefined);   // refresh the usage readout
    }
  }, [busy, msgs, projectId, getText, includeCode, errors, selection, onLimit]);

  // count down, then try again by itself (only for waits worth sitting through)
  useEffect(() => {
    if (!wait) return;
    const secs = (wait.until - Date.now()) / 1000;
    if (wait.scope === 'day' || wait.total > AUTO_WAIT_MAX_S) return;      // hours: do not sit and wait, tell the user instead
    const tick = window.setInterval(() => setNow(Date.now()), 500);
    const go = window.setTimeout(() => void send(wait.text, { resend: true }), Math.max(0, secs * 1000) + 300);
    return () => { window.clearInterval(tick); window.clearTimeout(go); };
  }, [wait, send]);

  const lastTask = useRef(0);
  useEffect(() => {
    if (!task || task.id === lastTask.current) return;
    lastTask.current = task.id;
    if (task.send) void send(task.text);
    else if (!task.text) setTimeout(() => area.current?.focus(), 0);
    else { setInput(task.text); setTimeout(() => area.current?.focus(), 0); }
  }, [task, send]);

  const saveKey = async () => {
    setKeyErr(null);
    try { setStatus(await api.aiSetKey(keyInput.trim())); setKeyInput(''); } catch (e) { setKeyErr((e as Error).message); }
  };
  const clearKey = async () => { try { setStatus(await api.aiClearKey()); } catch { /* ignore */ } };

  const configured = status?.configured ?? false;
  return (
    <div className="ai" data-testid="ai-panel">
      <div className="ai-head">
        <strong>✦ AI assistant</strong>
        <span className="badge" title="Groq runs the model; your messages (and your code if the box below is ticked) are sent to Groq">
          {status ? `${status.model.replace(/^openai\//, '')} · Groq` : '…'}
        </span>
        {msgs.length > 0 && <button className="btn small" onClick={() => { setMsgs([]); setOpen({}); }} title="Clear this chat">Clear</button>}
      </div>

      {status && !configured && (
        <div className="ai-setup" data-testid="ai-setup">
          <p><strong>Connect Groq to start.</strong> Get a free key at <code>console.groq.com/keys</code>, then either start the backend with <code>GROQ_API_KEY=…</code> (kept only in the environment), or paste it here to use it until the backend stops:</p>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void saveKey(); }}>
            <input type="password" aria-label="Groq API key" autoComplete="off" placeholder="gsk_…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
            <button className="btn small primary" disabled={keyInput.trim().length < 8}>Use key</button>
          </form>
          {keyErr && <p className="error-text small" role="alert">{keyErr}</p>}
        </div>
      )}
      {status?.configured && status.key_source === 'session' && (
        <p className="muted small ai-note">Using a key held in memory until the backend stops. <button className="linklike" onClick={() => void clearKey()}>Forget it now</button></p>
      )}

      <div className="ai-log" ref={log} aria-live="polite">
        {msgs.length === 0 && (
          <div className="ai-empty">
            <p>Ask for anything: “add a settings screen”, “why is my button not working?”, “make the cards glassy”.</p>
            <p className="muted small">Replies come with the full updated <code>main.apn</code>, already checked by the compiler. You review the changes, then apply them (Ctrl+Z undoes).</p>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`ai-msg ${m.role} ${m.error ? 'err' : ''}`}>
            {m.text && <p className="ai-text">{m.text}</p>}
            {m.notes?.map((n, i) => <p key={i} className="ai-note muted small">ⓘ {n}</p>)}
            {m.code && <CodeCard msg={m} open={!!open[m.id]} toggle={() => setOpen((o) => ({ ...o, [m.id]: !o[m.id] }))} getText={getText}
              onApply={() => { onApply(m.code as string); setMsgs((all) => all.map((x) => (x.id === m.id ? { ...x, applied: true } : x))); }} />}
          </div>
        ))}
        {wait && !busy && <WaitCard wait={wait} now={now} onCancel={() => setWait(null)} onRetry={() => void send(wait.text, { resend: true })}
          onBackup={() => void send(wait.text, { resend: true, onLimit: 'fallback' })} backup={status?.fallback_models[0]?.split('/').pop()} />}
        {busy && (
          <div className="ai-msg assistant" role="status">
            <p className="ai-text"><span className="ai-dots" aria-hidden>●●●</span> Thinking… <button className="linklike" onClick={() => abort.current?.abort()}>Cancel</button></p>
          </div>
        )}
      </div>

      <div className="chips ai-quick" role="group" aria-label="Quick requests">
        {QUICK.map((q) => (
          <button key={q.label} className="chip" disabled={busy || !configured || (q.needsErrors && errors.length === 0)} data-testid={`ai-quick-${q.label.split(' ')[0].toLowerCase()}`}
            title={q.needsErrors && errors.length === 0 ? 'No compiler errors right now' : q.text}
            onClick={() => (q.send ? void send(q.text) : (setInput(q.text), area.current?.focus()))}>{q.label}{q.needsErrors && errors.length > 0 ? ` (${errors.length})` : ''}</button>
        ))}
      </div>

      <Usage status={status} />
      <details className="ai-limits">
        <summary className="small">Limit settings: {onLimit === 'wait' ? 'wait and retry' : 'use backup model'}</summary>
        <div className="ai-onlimit row small" role="group" aria-label="When Groq's limit is reached">
        <label><input type="radio" name="onlimit" checked={onLimit === 'wait'} onChange={() => { setOnLimit('wait'); try { window.localStorage.setItem('apppanrom.ai.onlimit', 'wait'); } catch { /* ignore */ } }} /> wait and retry</label>
        <label title={status?.fallback_models.length ? `Use ${status.fallback_models[0]} (its limit is separate), but it is a smaller model` : 'No backup model configured'}>
          <input type="radio" name="onlimit" disabled={!status?.fallback_models.length} checked={onLimit === 'fallback'} onChange={() => { setOnLimit('fallback'); try { window.localStorage.setItem('apppanrom.ai.onlimit', 'fallback'); } catch { /* ignore */ } }} /> use backup model
        </label>
      </div>
      </details>
      <form className="ai-form" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <textarea ref={area} aria-label="Ask the AI" rows={3} value={input} disabled={!configured} placeholder={configured ? 'What should I build or fix?  (Ctrl+Enter to send)' : 'Connect Groq above first'}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(input); } }} />
        <div className="row between">
          <label className="check-row small" title="When off, only your message is sent. The AI then cannot see your app.">
            <input type="checkbox" checked={includeCode} onChange={(e) => setIncludeCode(e.target.checked)} /> Send my code{selection ? ` (+ selected ${selection.component})` : ''}
          </label>
          <button className="btn primary" disabled={busy || !configured || !input.trim()} data-testid="ai-send">Send</button>
        </div>
      </form>
    </div>
  );
}

function CodeCard({ msg, open, toggle, onApply, getText }: { msg: Msg; open: boolean; toggle(): void; onApply(): void; getText(): string }) {
  const code = msg.code as string;
  const diff = useMemo(() => (open ? diffLines(getText(), code) : []), [open, code, getText]);
  const counts = open ? changeCount(diff) : null;
  const errs = (msg.diags ?? []).filter((d) => d.severity === 'error');
  const same = getText().trimEnd() === code.trimEnd();
  return (
    <div className="ai-code" data-testid="ai-code">
      <div className="ai-code-head">
        <span className={`ai-ok ${msg.compiles ? 'ok' : 'bad'}`}>{msg.compiles ? '✓ compiles' : `✕ ${errs.length} error${errs.length === 1 ? '' : 's'}`}</span>
        {(msg.attempts ?? 1) > 1 && <span className="muted small" title="The first draft had compiler errors; the assistant fixed them using our compiler's messages">auto-fixed ×{(msg.attempts ?? 1) - 1}</span>}
        <span className="spacer" />
        <button className="btn small" onClick={toggle} data-testid="ai-diff">{open ? 'Hide changes' : 'Show changes'}</button>
        <button className="btn small" onClick={() => void navigator.clipboard?.writeText(code)}>Copy</button>
        <button className={`btn small ${msg.compiles ? 'primary' : 'danger-outline'}`} disabled={same || msg.applied} onClick={() => { if (msg.compiles || window.confirm(`This code still has ${errs.length} error(s). Apply it anyway?`)) onApply(); }} data-testid="ai-apply">
          {msg.applied ? 'Applied ✓' : same ? 'No changes' : msg.compiles ? 'Apply to editor' : 'Apply anyway'}
        </button>
      </div>
      {!msg.compiles && errs.length > 0 && (
        <ul className="ai-errs">{errs.slice(0, 4).map((d, i) => <li key={i}>line {d.line}: {d.message}</li>)}</ul>
      )}
      {msg.applied && <p className="muted small ai-note">Applied. Press Ctrl+Z in the editor to undo.</p>}
      {open && (
        <pre className="ai-diff" aria-label="Proposed changes">
          <span className="muted small">{counts ? `+${counts.added} −${counts.removed}` : ''}</span>
          {collapse(diff, 2).map((l, i) => (l.kind === 'gap'
            ? <span key={i} className="dl gap">⋯ {l.count} unchanged lines</span>
            : <span key={i} className={`dl ${l.kind}`}>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}{l.text}{'\n'}</span>))}
        </pre>
      )}
    </div>
  );
}

function WaitCard({ wait, now, onCancel, onRetry, onBackup, backup }: { wait: Wait; now: number; onCancel(): void; onRetry(): void; onBackup(): void; backup?: string }) {
  const left = Math.max(0, (wait.until - now) / 1000);
  const auto = wait.scope !== 'day' && wait.total <= AUTO_WAIT_MAX_S;
  return (
    <div className="ai-msg assistant ai-wait" role="status" data-testid="ai-wait">
      <p className="ai-text">
        <strong>⏳ Groq's {wait.scope === 'day' ? 'daily' : 'per-minute'} limit for {wait.model.split('/').pop() || 'this model'} is used up.</strong>{' '}
        {auto ? <>Trying again automatically in <span data-testid="ai-countdown">{Math.ceil(left)}</span> s (the free plan allows only a small amount per minute).</>
          : <>It resets in about {human(left)}. You can try again then{backup ? <>, or use the backup model ({backup}) now</> : null}.</>}
      </p>
      {auto && <div className="ai-bar" aria-hidden><span style={{ width: `${Math.min(100, 100 * (1 - left / Math.max(1, wait.total)))}%` }} /></div>}
      <div className="row">
        {auto && <button className="btn small" onClick={onRetry} title="Do not wait for the countdown">Try now</button>}
        {!auto && <button className="btn small" onClick={onRetry} disabled={left > 0} title={left > 0 ? 'Still limited' : ''}>Try again</button>}
        {wait.fallbackPossible && backup && <button className="btn small primary" onClick={onBackup} data-testid="ai-backup">Use {backup} now</button>}
        <button className="btn small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Usage({ status }: { status: AiStatus | null }) {
  if (!status?.configured) return null;
  const l = status.limits;
  const bits: string[] = [];
  if (l.requests_remaining !== null) bits.push(`${l.requests_remaining} requests left today`);
  if (l.tokens_remaining !== null) bits.push(`${l.tokens_remaining.toLocaleString()} tokens left this minute`);
  if (l.blocked_for_s > 0) bits.push(`limited for ${human(l.blocked_for_s)}`);
  return <p className="muted small ai-usage" data-testid="ai-usage">{status.tier === 'free' ? 'Groq free plan' : 'Groq'}{bits.length ? ' · ' + bits.join(' · ') : ' · limits are tracked automatically'}</p>;
}
