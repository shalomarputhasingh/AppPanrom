import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Project } from '../types';

export function SettingsPanel({ project, onSaved }: { project: Project; onSaved(p: Project): void }) {
  const [f, setF] = useState({ name: project.name, app_id: project.app_id, version: project.version, theme: project.theme });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="settings" onSubmit={save}>
      <label>App name<input value={f.name} onChange={set('name')} maxLength={60} /></label>
      <label>Application ID<input value={f.app_id} onChange={set('app_id')} className="mono" /></label>
      <label>Version<input value={f.version} onChange={set('version')} className="mono" placeholder="1.0.0" /></label>
      <label>Theme
        <select value={f.theme} onChange={set('theme')}><option value="light">light</option><option value="dark">dark</option></select>
      </label>
      <label>App icon<input disabled value="Not implemented yet — the default Android icon is used" /></label>
      <p className="muted small">
        These are defaults. If <code>main.apn</code> calls <code>app_uruvakku</code>, <code>app_id_set</code>, <code>app_version_set</code> or <code>app_theme_set</code>, the code wins.
        All four values go into the APK; nothing here is Studio-only.
      </p>
      <button className="btn primary">Save settings</button>
      {msg && <p className={msg.ok ? 'ok-text' : 'error-text'} role="status">{msg.text}</p>}
    </form>
  );
}
