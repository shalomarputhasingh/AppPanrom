import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Project } from '../types';
import { Dialog } from './Dialog';

export function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  const load = useCallback(() => {
    api.projects().then(setProjects, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const p = await api.createProject(name.trim());
      setName('');
      onOpen(p.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    try {
      await api.patchProject(renaming.id, { name: renaming.name.trim() });
      setRenaming(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await api.deleteProject(deleting.id);
      setDeleting(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="dashboard">
      <header className="dash-head">
        <div>
          <h1>AppPanrom Studio</h1>
          <p className="muted">Tanglish-la app panna oru studio. Write code, preview it live, build an Android APK.</p>
        </div>
      </header>

      <form className="row create" onSubmit={create}>
        <label className="sr-only" htmlFor="new-name">New project name</label>
        <input id="new-name" value={name} maxLength={60} placeholder="New project name (e.g. Vanakkam App)" onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={!name.trim()}>Create project</button>
      </form>
      {error && <p className="error-text" role="alert">{error}</p>}

      {projects === null && !error && <p className="muted">Loading projects…</p>}
      {projects && projects.length === 0 && (
        <div className="empty">
          <h2>No projects yet</h2>
          <p>Create your first project above. It starts with a working sample app you can run immediately.</p>
        </div>
      )}
      <ul className="project-grid">
        {projects?.map((p) => (
          <li key={p.id} className="card">
            {renaming?.id === p.id ? (
              <form className="row" onSubmit={rename}>
                <input autoFocus aria-label="Project name" value={renaming.name} maxLength={60} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} />
                <button className="btn primary" disabled={!renaming.name.trim()}>Save</button>
                <button type="button" className="btn" onClick={() => setRenaming(null)}>Cancel</button>
              </form>
            ) : (
              <>
                <h3>{p.name}</h3>
                <p className="muted mono">{p.app_id} · v{p.version}</p>
                <p className="muted small">Updated {new Date(p.updated_at).toLocaleString()}</p>
                <div className="row">
                  <button className="btn primary" onClick={() => onOpen(p.id)}>Open</button>
                  <button className="btn" onClick={() => setRenaming({ id: p.id, name: p.name })}>Rename</button>
                  <button className="btn danger-outline" onClick={() => setDeleting(p)}>Delete</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {deleting && (
        <Dialog title="Delete project?" confirmLabel="Delete project" danger onConfirm={remove} onCancel={() => setDeleting(null)}>
          <p>
            <strong>{deleting.name}</strong> and its source files, build history and APKs will be permanently deleted. This cannot be undone.
          </p>
        </Dialog>
      )}
    </main>
  );
}
