import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { AppInfo, Project } from '../types';
import { BAR_LOOKS } from '../stylePresets';

interface Props {
  project: Project;
  onSaved(p: Project): void;
  /** Current editor text (the single source of truth: every control below edits it). */
  getText(): string;
  /** Changes whenever the code compiles again; triggers a refresh of what the menu shows. */
  rev: unknown;
  onOp(op: Record<string, unknown>): Promise<string | null>;
  onPreview(op: Record<string, unknown> | null): void;
  onConvert(to: 'tanglish' | 'english'): Promise<string | null>;
  ready: boolean;
  taMessages: boolean;
  setTaMessages(v: boolean): void;
}

function Commit({ value, onCommit, disabled, label, mono, placeholder }: { value: string; onCommit(v: string): void; disabled?: boolean; label: string; mono?: boolean; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const done = () => { if (v !== value) onCommit(v); };
  return (
    <input aria-label={label} value={v} disabled={disabled} className={mono ? 'mono' : undefined} placeholder={placeholder}
      onChange={(e) => setV(e.target.value)} onBlur={done}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } if (e.key === 'Escape') setV(value); }} />
  );
}

function Section({ title, hint, children, open = true }: { title: string; hint?: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="set-section" open={open}>
      <summary>{title}</summary>
      {hint && <p className="muted small set-hint">{hint}</p>}
      {children}
    </details>
  );
}

export function SettingsPanel({ project, onSaved, getText, rev, onOp, onPreview, onConvert, ready, taMessages, setTaMessages }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [iconMsg, setIconMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [iconVer, setIconVer] = useState(0);
  const [newVar, setNewVar] = useState({ name: '', expr: '0' });
  const [newScreen, setNewScreen] = useState('');
  const [projName, setProjName] = useState(project.name);
  const [tabs, setTabs] = useState<{ label: string; icon: string; go: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => setProjName(project.name), [project.name]);

  useEffect(() => {
    let live = true;
    api.designApp(project.id, getText()).then((i) => { if (live) { setInfo(i); setErr(null); } }, (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [project.id, rev, getText]);

  const run = async (op: Record<string, unknown>) => { setErr(await onOp(op)); };
  const eff = {
    name: info?.code.name ?? project.name, id: info?.code.id ?? project.app_id, version: info?.code.version ?? project.version,
    theme: info?.code.theme ?? project.theme, start: info?.code.start_screen ?? info?.screens[0]?.name ?? '',
  };
  /** App settings are written into main.apn; the project record keeps the same values as defaults (dashboard, builds). */
  const setApp = async (key: 'name' | 'id' | 'version' | 'theme' | 'start_screen', value: string) => {
    const e = await onOp({ kind: 'set_app', key, value });
    setErr(e);
    if (!e && (key === 'id' || key === 'version' || key === 'theme')) {
      const patch = { id: { app_id: value }, version: { version: value }, theme: { theme: value } }[key] as Parameters<typeof api.patchProject>[1];
      try { onSaved(await api.patchProject(project.id, patch)); } catch { /* the code is the truth; the record is only a default */ }
    }
  };
  const disabled = !ready;

  const uploadIcon = async (file: File | undefined) => {
    if (!file) return;
    try {
      await api.uploadIcon(project.id, file);
      setIconVer((v) => v + 1);
      onSaved(await api.project(project.id));
      setIconMsg({ ok: true, text: 'Icon updated.' });
    } catch (e) { setIconMsg({ ok: false, text: (e as Error).message }); }
    if (fileInput.current) fileInput.current.value = '';
  };
  const removeIcon = async () => {
    try {
      await api.deleteIcon(project.id);
      onSaved(await api.project(project.id));
      setIconMsg({ ok: true, text: 'Icon removed; the default Android icon will be used.' });
    } catch (e) { setIconMsg({ ok: false, text: (e as Error).message }); }
  };

  return (
    <div className="settings" data-testid="settings">
      {!ready && <p className="design-banner">Fix the errors in your code first; the menu edits the code and needs it to compile.</p>}
      {err && <p className="error-text small" role="alert">{err}</p>}

      <Section title="App" hint="Every field here is written into main.apn (app_uruvakku, app_id_set, …) and shown from it.">
        <label>App name<Commit label="App name" value={eff.name} disabled={disabled} onCommit={(v) => void setApp('name', v)} /></label>
        <label>Application ID<Commit label="Application ID" mono value={eff.id} disabled={disabled} onCommit={(v) => void setApp('id', v)} /></label>
        <label>Version<Commit label="Version" mono value={eff.version} disabled={disabled} placeholder="1.0.0" onCommit={(v) => void setApp('version', v)} /></label>
        <label>Theme
          <select aria-label="Theme" value={eff.theme} disabled={disabled} onChange={(e) => void setApp('theme', e.target.value)}>
            <option value="light">light</option><option value="dark">dark</option>
          </select>
        </label>
        <label>Start screen
          <select aria-label="Start screen" value={eff.start} disabled={disabled} onChange={(e) => void setApp('start_screen', e.target.value)}>
            {(info?.screens ?? []).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </label>
      </Section>

      <Section title="Screens" hint="Rename updates every screen_ku_poo(...) that points to it. Delete is refused while something still opens the screen.">
        <ul className="plain set-list" aria-label="Screens">
          {(info?.screens ?? []).map((s) => (
            <li key={s.name} className="set-item">
              <Commit label={`Screen name ${s.name}`} mono value={s.name} disabled={disabled} onCommit={(v) => void run({ kind: 'rename_screen', name: s.name, new_name: v })} />
              <button className="btn small danger-outline" aria-label={`Delete screen ${s.name}`} disabled={disabled} onClick={() => void run({ kind: 'delete_screen', name: s.name })}>Delete</button>
            </li>
          ))}
        </ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (newScreen.trim()) { void run({ kind: 'add_screen', name: newScreen.trim() }).then(() => setNewScreen('')); } }}>
          <input aria-label="New screen name" className="mono" placeholder="new_screen" value={newScreen} onChange={(e) => setNewScreen(e.target.value)} disabled={disabled} />
          <button className="btn small" disabled={disabled || !newScreen.trim()}>Add screen</button>
        </form>
      </Section>

      <Section title="Variables" hint="Global variables are the app's state. Edit the starting value; changes are written as `mari name = value`.">
        <ul className="plain set-list" aria-label="Global variables">
          {(info?.globals ?? []).map((g) => (
            <li key={g.name} className="set-item">
              <code className="var-name">{g.name}</code>
              <Commit label={`Value of ${g.name}`} mono value={g.expr} disabled={disabled} onCommit={(v) => void run({ kind: 'set_global', name: g.name, expr: v })} />
              <button className="btn small danger-outline" aria-label={`Delete variable ${g.name}`} disabled={disabled} onClick={() => void run({ kind: 'delete_global', name: g.name })}>×</button>
            </li>
          ))}
          {info && info.globals.length === 0 && <li className="muted small">No variables yet.</li>}
        </ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (newVar.name.trim()) { void run({ kind: 'add_global', name: newVar.name.trim(), expr: newVar.expr }).then(() => setNewVar({ name: '', expr: '0' })); } }}>
          <input aria-label="New variable name" className="mono" placeholder="name" value={newVar.name} onChange={(e) => setNewVar({ ...newVar, name: e.target.value })} disabled={disabled} />
          <input aria-label="New variable value" className="mono" placeholder='0, "text", [], {}' value={newVar.expr} onChange={(e) => setNewVar({ ...newVar, expr: e.target.value })} disabled={disabled} />
          <button className="btn small" disabled={disabled || !newVar.name.trim()}>Add</button>
        </form>
      </Section>


      <Section title="Top bar & tabs" hint="Customise or remove the bar at the top of every screen, and add bottom tabs. These write navbar_uruvakku / tabbar_uruvakku into each screen's code.">
        <div className="row">
          <span className="badge" data-testid="bars-info">Top bar on {info?.bars.navbar.length ?? 0}/{info?.screens.length ?? 0} screens · tabs on {info?.bars.tabbar.length ?? 0}</span>
        </div>
        <label className="check-row">
          <input type="checkbox" aria-label="Show top bar" defaultChecked disabled={disabled}
            onChange={(e) => void run({ kind: 'navbar_all', props: { visible: e.target.checked ? null : { literal: false } } })} /> Show the top bar
        </label>
        <label>Title position
          <select aria-label="Title position" defaultValue="left" disabled={disabled} onChange={(e) => void run({ kind: 'navbar_all', props: { align: e.target.value === 'left' ? null : { literal: e.target.value } } })}>
            <option value="left">left</option><option value="center">center</option><option value="right">right</option>
          </select>
        </label>
        <label className="check-row">
          <input type="checkbox" aria-label="Back arrow" defaultChecked disabled={disabled}
            onChange={(e) => void run({ kind: 'navbar_all', props: { back: e.target.checked ? null : { literal: false } } })} /> Back arrow
        </label>
        <div className="set-sub">Look</div>
        <div className="presets" role="group" aria-label="Top bar looks">
          {BAR_LOOKS.map((b) => (
            <button key={b.id} type="button" className="preset" data-testid={`bar-${b.id}`} disabled={disabled} onClick={() => void run({ kind: 'navbar_all', style: b.styles, props: {} })}
              onMouseEnter={() => onPreview({ kind: 'navbar_all', style: b.styles, props: {} })} onMouseLeave={() => onPreview(null)}>
              <span className="preset-chip" style={{ background: b.css, color: b.ink, border: '1px solid rgba(0,0,0,.15)', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 700 }} aria-hidden="true">Aa</span>
              {b.name}
            </button>
          ))}
        </div>
        <div className="row">
          <label className="inline-lbl">Bar colour <input type="color" aria-label="Bar colour" defaultValue="#4F46E5" disabled={disabled} onChange={(e) => void run({ kind: 'navbar_all', props: {}, style: { background: { literal: e.target.value.toUpperCase() } } })} /></label>
          <label className="inline-lbl">Text <input type="color" aria-label="Bar text colour" defaultValue="#FFFFFF" disabled={disabled} onChange={(e) => void run({ kind: 'navbar_all', props: {}, style: { text_color: { literal: e.target.value.toUpperCase() } } })} /></label>
          <button className="btn small" disabled={disabled} data-testid="bar-reset" title="Remove every navbar_uruvakku and go back to the plain default bar" onClick={() => void run({ kind: 'navbar_all', remove: true })}>Reset to default bar</button>
        </div>
        <div className="set-sub">Bottom tabs</div>
        <ul className="plain set-list" aria-label="Tabs">
          {tabs.map((t, i) => (
            <li key={i} className="set-item">
              <input aria-label={`Tab ${i + 1} icon`} className="tab-icon" value={t.icon} maxLength={4} placeholder="🏠" onChange={(e) => setTabs(tabs.map((x, j) => (j === i ? { ...x, icon: e.target.value } : x)))} />
              <input aria-label={`Tab ${i + 1} label`} value={t.label} placeholder="Label" onChange={(e) => setTabs(tabs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <select aria-label={`Tab ${i + 1} screen`} value={t.go} onChange={(e) => setTabs(tabs.map((x, j) => (j === i ? { ...x, go: e.target.value } : x)))}>
                {(info?.screens ?? []).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              <button className="btn small" aria-label={`Remove tab ${i + 1}`} onClick={() => setTabs(tabs.filter((_, j) => j !== i))}>×</button>
            </li>
          ))}
        </ul>
        <div className="row">
          <button className="btn small" disabled={tabs.length >= 5 || !info?.screens.length} onClick={() => setTabs([...tabs, { label: '', icon: '', go: info?.screens[Math.min(tabs.length, info.screens.length - 1)].name ?? '' }])}>＋ Add tab</button>
          <button className="btn small" disabled={!info?.screens.length} onClick={() => setTabs((info?.screens ?? []).slice(0, 5).map((s) => ({ label: s.name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), icon: '•', go: s.name })))}>One tab per screen</button>
          <button className="btn small primary" data-testid="tabs-apply" disabled={disabled || tabs.length === 0 || tabs.some((t) => !t.label.trim())} onClick={() => void run({ kind: 'tabs_all', tabs: tabs.map((t) => ({ label: t.label.trim(), icon: t.icon.trim(), go: t.go })) })}>Apply tabs to all screens</button>
          <button className="btn small" disabled={disabled || !(info?.bars.tabbar.length)} data-testid="tabs-remove" onClick={() => void run({ kind: 'tabs_all', tabs: [] })}>Remove tabs</button>
        </div>
      </Section>

      <Section title="Language" hint="Same program, two vocabularies. Conversion rewrites your code (strings and comments are untouched) and can be undone with Ctrl+Z.">
        <div className="row">
          <span className="badge" data-testid="vocab">{info?.style === 'tanglish' ? 'Tanglish vocabulary' : 'English vocabulary'}</span>
          <button className="btn small" disabled={disabled || info?.style === 'tanglish'} data-testid="to-tanglish" onClick={async () => setErr(await onConvert('tanglish'))}>Convert code to Tanglish</button>
          <button className="btn small" disabled={disabled || info?.style !== 'tanglish'} data-testid="to-english" onClick={async () => setErr(await onConvert('english'))}>Convert to English</button>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={taMessages} onChange={(e) => setTaMessages(e.target.checked)} /> Show error hints in Tanglish
        </label>
        <p className="muted small">The designer keeps writing in whichever vocabulary your file uses.</p>
      </Section>

      <Section title="Icon">
        <div className="icon-box">
          <div className="row">
            {project.has_icon ? <img className="icon-prev" alt="App icon preview" src={`${api.iconUrl(project.id)}?v=${iconVer}`} /> : <span className="icon-prev none" aria-hidden>?</span>}
            <input ref={fileInput} type="file" accept="image/png" aria-label="Upload app icon (PNG)" onChange={(e) => void uploadIcon(e.target.files?.[0])} />
            {project.has_icon && <button type="button" className="btn small" onClick={() => void removeIcon()}>Remove</button>}
          </div>
          <p className="muted small">Square PNG, 192–1024 px, max 500 KB. Used as the launcher icon in the APK.</p>
          {iconMsg && <p className={iconMsg.ok ? 'ok-text small' : 'error-text small'} role="status">{iconMsg.text}</p>}
        </div>
      </Section>

      <Section title="Project" open={false}>
        <label>Project name (Studio only)
          <Commit label="Project name" value={projName} onCommit={async (v) => { try { onSaved(await api.patchProject(project.id, { name: v })); setErr(null); } catch (e) { setErr((e as Error).message); } }} />
        </label>
      </Section>
    </div>
  );
}
