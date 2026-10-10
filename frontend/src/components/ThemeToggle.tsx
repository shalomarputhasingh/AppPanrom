import { useEffect, useState } from 'react';

type Mode = 'auto' | 'light' | 'dark';
const KEY = 'apppanrom.theme';

function read(): Mode {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch { /* storage can be blocked; fall back to automatic */ }
  return 'auto';
}

export function applyTheme(mode: Mode) {
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}

/** Auto / light / dark switch for the Studio itself (not the app being built). */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(read);
  useEffect(() => {
    applyTheme(mode);
    try { if (mode === 'auto') window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, mode); } catch { /* ignore */ }
  }, [mode]);
  const next: Mode = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
  const icon = mode === 'auto' ? 'Auto' : mode === 'light' ? 'Light' : 'Dark';
  return (
    <button className="btn theme-toggle" onClick={() => setMode(next)} data-testid="theme-toggle"
      title={`Studio theme: ${mode}. Click for ${next}.`} aria-label={`Studio theme: ${mode}. Switch to ${next}.`}>
      <span className="small">{icon}</span>
    </button>
  );
}
