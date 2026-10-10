import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Project } from '../types';

export function SettingsPanel({ project, onSaved }: { project: Project; onSaved(p: Project): void }) {
  const [f, setF] = useState({ name: project.name, app_id: project.app_id, version: project.version, theme: project.theme });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [iconMsg, setIconMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [iconVer, setIconVer] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => setF({ name: project.name, app_id: project.app_id, version: project.version, theme: project.theme }), [project]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(await api.patchProject(project.id, f));
      setMsg({ ok: true, text: 'Settings saved.' });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  };
  const uploadIcon = async (file: File | undefined) => {
    if (!file) return;
    try {
      await api.uploadIcon(project.id, file);
      setIconVer((v) => v + 1);
      onSaved(await api.project(project.id));
      setIconMsg({ ok: true, text: 'Icon updated.' });
    } catch (err) {
      setIconMsg({ ok: false, text: (err as Error).message });
    }
    if (fileInput.current) fileInput.current.value = '';
  };
  const removeIcon = async () => {
    try {
      await api.deleteIcon(project.id);
      onSaved(await api.project(project.id));
      setIconMsg({ ok: true, text: 'Icon removed; the default Android icon will be used.' });
    } catch (err) {
      setIconMsg({ ok: false, text: (err as Error).message });
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="settings" onSubmit={save}>
      <label>App name<input value={f.name} onChange={set('name')} maxLength={60} /></label>
      <label>Application ID<input value={f.app_id} onChange={set('app_id')} className="mono" /></label>
      <label>Version<input value={f.version} onChange={set('version')} className="mono" placeholder="1.0.0" /></label>
      <label>Theme
        <select value={f.theme} onChange={set('theme')}><option value="light">light</option><option value="dark">dark</option></select>
      </label>
      <div className="icon-box">
        <span className="insp-label">App icon</span>
        <div className="row">
          {project.has_icon ? <img className="icon-prev" alt="App icon preview" src={`${api.iconUrl(project.id)}?v=${iconVer}`} /> : <span className="icon-prev none" aria-hidden>?</span>}
          <input ref={fileInput} type="file" accept="image/png" aria-label="Upload app icon (PNG)" onChange={(e) => void uploadIcon(e.target.files?.[0])} />
          {project.has_icon && <button type="button" className="btn small" onClick={() => void removeIcon()}>Remove</button>}
        </div>
        <p className="muted small">Square PNG, 192–1024 px, max 500 KB. Used as the launcher icon in the APK; without one, the default Android icon is used.</p>
        {iconMsg && <p className={iconMsg.ok ? 'ok-text small' : 'error-text small'} role="status">{iconMsg.text}</p>}
      </div>
      <p className="muted small">
        These are defaults. If <code>main.apn</code> calls <code>app_uruvakku</code>, <code>app_id_set</code>, <code>app_version_set</code> or <code>app_theme_set</code>, the code wins.
        All four values go into the APK; nothing here is Studio-only.
      </p>
      <button className="btn primary">Save settings</button>
      {msg && <p className={msg.ok ? 'ok-text' : 'error-text'} role="status">{msg.text}</p>}
    </form>
  );
}
