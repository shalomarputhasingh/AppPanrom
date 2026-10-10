import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Dashboard } from './components/Dashboard';
import { Workspace } from './components/Workspace';

function readHash(): string | null {
  const m = /^#\/p\/(p_[0-9a-f]{12})$/.exec(window.location.hash);
  return m ? m[1] : null;
}

export function App() {
  const [projectId, setProjectId] = useState<string | null>(readHash);
  const [backend, setBackend] = useState<'checking' | 'up' | 'down'>('checking');

  const check = useCallback(() => {
    setBackend('checking');
    api.health().then(() => setBackend('up'), () => setBackend('down'));
  }, []);
  useEffect(check, [check]);
  useEffect(() => {
    const on = () => setProjectId(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const open = (id: string | null) => {
    window.location.hash = id ? `#/p/${id}` : '#/';
  };

  if (backend !== 'up') {
    return (
      <main className="center-screen" role="status">
        <h1>AppPanrom Studio</h1>
        {backend === 'checking' ? (
          <p>Connecting to the backend…</p>
        ) : (
          <>
            <p className="error-text">Cannot reach the AppPanrom backend.</p>
            <p>
              Start it with <code>cd backend &amp;&amp; uvicorn apppanrom.main:create_app --factory --port 8000</code>, then retry.
            </p>
            <button className="btn primary" onClick={check}>Retry</button>
          </>
        )}
      </main>
    );
  }
  return projectId ? <Workspace projectId={projectId} onClose={() => open(null)} /> : <Dashboard onOpen={open} />;
}
