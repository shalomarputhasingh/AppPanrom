import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Diagnostic, LogLine, Project, Spec } from '../types';
import { BuildPanel } from './BuildPanel';
import { ConsolePanel } from './ConsolePanel';
import { Dialog } from './Dialog';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { Editor, type EditorHandle } from './Editor';
import { PhonePreview, type PreviewState } from './PhonePreview';
import { ReferencePanel } from './ReferencePanel';
import { SettingsPanel } from './SettingsPanel';

type Bottom = 'console' | 'diagnostics' | 'build';
type Side = 'files' | 'settings' | 'reference';
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
const MAIN = 'main.apn';
let logId = 0;
const clock = () => new Date().toLocaleTimeString([], { hour12: false });

export function Workspace({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [file, setFile] = useState(MAIN);
  const [initial, setInitial] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [save, setSave] = useState<SaveState>('saved');
  const [diags, setDiags] = useState<Diagnostic[]>([]);
  const [checked, setChecked] = useState(false);
  const [preview, setPreview] = useState<{ state: PreviewState; ir: unknown; runKey: number }>({ state: 'empty', ir: null, runKey: 0 });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [bottom, setBottom] = useState<Bottom>('console');
  const [side, setSide] = useState<Side>('files');
  const [newFile, setNewFile] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmExample, setConfirmExample] = useState<string | null>(null);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);

  const text = useRef('');
  const dirty = useRef(false);
  const saveTimer = useRef<number>();
  const valTimer = useRef<number>();
  const valSeq = useRef(0);
  const editor = useRef<EditorHandle>(null);

  const log = useCallback((level: LogLine['level'], t: string) => {
    setLogs((l) => [...l.slice(-499), { id: ++logId, level, text: t, time: clock() }]);
  }, []);

  // ---- load project
  useEffect(() => {
    let live = true;
    api.project(projectId).then((p) => live && setProject(p), (e) => live && setLoadError(e.message));
    api.spec().then((s) => live && setSpec(s), () => undefined);
    return () => { live = false; };
  }, [projectId]);

  const openFile = useCallback(async (name: string) => {
    const content = await api.readFile(projectId, name);
    text.current = content;
    dirty.current = false;
    setFile(name);
    setInitial(content);
    setEditorKey((k) => k + 1);
    setSave('saved');
    setDiags([]);
    setChecked(false);
    return content;
  }, [projectId]);

  useEffect(() => {
    openFile(MAIN).then(
      (src) => validate(src),
      (e) => setLoadError(e.message),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ---- save / validate
  const doSave = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(saveTimer.current);
    if (!dirty.current) return true;
    setSave('saving');
    const snapshot = text.current;
    try {
      await api.writeFile(projectId, file, snapshot);
      if (text.current === snapshot) { dirty.current = false; setSave('saved'); } else setSave('dirty');
      return true;
    } catch (e) {
      setSave('error');
      log('error', `Save failed: ${(e as Error).message}`);
      return false;
    }
  }, [projectId, file, log]);

  const validate = useCallback((src: string) => {
    const seq = ++valSeq.current;
    api.validate(projectId, src).then((r) => {
      if (seq !== valSeq.current) return;
      setDiags(r.diagnostics);
      setChecked(true);
    }, () => undefined);
  }, [projectId]);

  const onChange = useCallback((v: string) => {
    text.current = v;
    dirty.current = true;
    setSave('dirty');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void doSave(), 1200);
    if (file === MAIN) {
      window.clearTimeout(valTimer.current);
      valTimer.current = window.setTimeout(() => validate(v), 450);
    }
  }, [doSave, validate, file]);

  useEffect(() => () => { window.clearTimeout(saveTimer.current); window.clearTimeout(valTimer.current); }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty.current) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // ---- run
  const run = useCallback(async () => {
    if (file !== MAIN) { log('warning', 'Only main.apn is run. Select main.apn first.'); return; }
    setPreview((p) => ({ ...p, state: 'loading' }));
    if (!(await doSave())) { setPreview((p) => ({ ...p, state: 'empty' })); return; }
    try {
      const r = await api.preview(projectId, text.current);
      setDiags(r.diagnostics);
      setChecked(true);
      const errors = r.diagnostics.filter((d) => d.severity === 'error');
      if (!r.ok || !r.ir) {
        setPreview((p) => ({ state: 'error', ir: null, runKey: p.runKey + 1 }));
        log('error', `Run failed: ${errors.length} error${errors.length === 1 ? '' : 's'}. First: ${errors[0]?.file}:${errors[0]?.line}:${errors[0]?.col} ${errors[0]?.message}`);
        setBottom('diagnostics');
        return;
      }
      setPreview((p) => ({ state: 'ready', ir: r.ir, runKey: p.runKey + 1 }));
      log('system', `Running "${r.ir.app.name}" (${r.ir.app.id} v${r.ir.app.version})` + (r.diagnostics.length ? ` with ${r.diagnostics.length} warning(s)` : ''));
      setBottom((b) => (b === 'diagnostics' ? 'console' : b));
    } catch (e) {
      setPreview((p) => ({ ...p, state: 'empty' }));
      log('error', (e as Error).message);
    }
  }, [file, doSave, projectId, log]);

  const restart = useCallback(() => setPreview((p) => ({ ...p, runKey: p.runKey + 1 })), []);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [run]);

  // ---- files
  const createFile = async () => {
    setFileError(null);
    let name = newFile.trim();
    if (name && !/\.[a-z]+$/.test(name)) name += '.apn';
    try {
      await doSave();
      await api.writeFile(projectId, name, '');
      setProject(await api.project(projectId));
      setNewFile('');
      await openFile(name);
    } catch (e) {
      setFileError((e as Error).message);
    }
  };
  const removeFile = async () => {
    const name = confirmDeleteFile;
    setConfirmDeleteFile(null);
    if (!name) return;
    try {
      await api.deleteFile(projectId, name);
      setProject(await api.project(projectId));
      if (name === file) await openFile(MAIN);
    } catch (e) {
      setFileError((e as Error).message);
    }
  };
  const useExample = async (code: string) => {
    setConfirmExample(null);
    if (file !== MAIN) await openFile(MAIN);
    text.current = code;
    dirty.current = true;
    setInitial(code);
    setEditorKey((k) => k + 1);
    setSave('dirty');
    validate(code);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void doSave(), 300);
  };

  const errorCount = useMemo(() => diags.filter((d) => d.severity === 'error').length, [diags]);
  const warnCount = diags.length - errorCount;

  if (loadError) {
    return (
      <main className="center-screen"><p className="error-text" role="alert">{loadError}</p><button className="btn" onClick={onClose}>Back to projects</button></main>
    );
  }
  if (!project || initial === null) return <main className="center-screen" role="status"><p>Loading project…</p></main>;

  const saveLabel = { saved: 'All changes saved', dirty: 'Unsaved changes', saving: 'Saving…', error: 'Save failed' }[save];
  return (
    <div className="workspace">
      <header className="topbar">
        <button className="btn" onClick={async () => { if (await doSave()) onClose(); }} aria-label="Back to projects">← Projects</button>
        <h1 className="proj-name" title={project.app_id}>{project.name}</h1>
        <span className={`save-state ${save}`} data-testid="save-state" role="status">{saveLabel}</span>
        <div className="spacer" />
        <button className="btn" onClick={() => void doSave()} disabled={save === 'saved' || save === 'saving'}>Save</button>
        <button className="btn primary" onClick={() => void run()} data-testid="run-btn" title="Run (Ctrl+Enter)">▶ Run</button>
        <button className="btn" onClick={() => setBottom('build')} data-testid="goto-build">Build APK</button>
      </header>

      <aside className="sidebar">
        <div className="tabs" role="tablist">
          {(['files', 'settings', 'reference'] as Side[]).map((s) => (
            <button key={s} role="tab" aria-selected={side === s} className={side === s ? 'on' : ''} onClick={() => setSide(s)}>{s[0].toUpperCase() + s.slice(1)}</button>
          ))}
        </div>
        <div className="side-body">
          {side === 'files' && (
            <>
              <ul className="files" aria-label="Project files">
                {project.files.map((f) => (
                  <li key={f} className={f === file ? 'on' : ''}>
                    <button onClick={async () => { if (f !== file && (await doSave())) await openFile(f); }}>{f}{f === MAIN && <small> (entry)</small>}</button>
                    {f !== MAIN && <button className="x" aria-label={`Delete ${f}`} onClick={() => setConfirmDeleteFile(f)}>×</button>}
                  </li>
                ))}
              </ul>
              <form className="row" onSubmit={(e) => { e.preventDefault(); void createFile(); }}>
                <input aria-label="New file name" placeholder="notes.md" value={newFile} onChange={(e) => setNewFile(e.target.value)} />
                <button className="btn small" disabled={!newFile.trim()}>Add</button>
              </form>
              {fileError && <p className="error-text small" role="alert">{fileError}</p>}
              <p className="muted small">Only <code>main.apn</code> is compiled. Other files are notes stored with the project.</p>
            </>
          )}
          {side === 'settings' && <SettingsPanel project={project} onSaved={(p) => { setProject(p); validate(text.current); }} />}
          {side === 'reference' && <ReferencePanel spec={spec} onUseExample={(c) => setConfirmExample(c)} />}
        </div>
      </aside>

      <section className="editor-pane" aria-label={`Editing ${file}`}>
        <div className="file-tab mono">{file}</div>
        <Editor key={editorKey} ref={editor} initialValue={initial} spec={spec} diagnostics={file === MAIN ? diags : []} onChange={onChange} onSave={() => void doSave()} />
      </section>

      <section className="preview-pane">
        <PhonePreview state={preview.state} ir={preview.ir} runKey={preview.runKey} projectId={projectId} errorCount={errorCount} onLog={log} onRestart={restart} />
      </section>

      <section className="bottom">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={bottom === 'console'} className={bottom === 'console' ? 'on' : ''} onClick={() => setBottom('console')}>Console</button>
          <button role="tab" aria-selected={bottom === 'diagnostics'} className={bottom === 'diagnostics' ? 'on' : ''} onClick={() => setBottom('diagnostics')} data-testid="tab-diagnostics">
            Diagnostics {checked && (errorCount > 0 ? <span className="pill err">{errorCount}</span> : warnCount > 0 ? <span className="pill warn">{warnCount}</span> : null)}
          </button>
          <button role="tab" aria-selected={bottom === 'build'} className={bottom === 'build' ? 'on' : ''} onClick={() => setBottom('build')} data-testid="tab-build">Build</button>
        </div>
        {bottom === 'console' && <ConsolePanel lines={logs} onClear={() => setLogs([])} />}
        {bottom === 'diagnostics' && <DiagnosticsPanel diagnostics={diags} checked={checked} onJump={(d) => editor.current?.jumpTo(d.line, d.col)} />}
        {bottom === 'build' && <BuildPanel projectId={projectId} ensureSaved={doSave} onProblems={(d) => { setDiags(d); setChecked(true); }} />}
      </section>

      {confirmExample !== null && (
        <Dialog title="Replace your code?" confirmLabel="Replace" danger onConfirm={() => void useExample(confirmExample)} onCancel={() => setConfirmExample(null)}>
          <p>The example will replace the contents of <code>main.apn</code>. Use undo (Ctrl+Z) in the editor if you change your mind before it saves.</p>
        </Dialog>
      )}
      {confirmDeleteFile && (
        <Dialog title="Delete file?" confirmLabel="Delete" danger onConfirm={() => void removeFile()} onCancel={() => setConfirmDeleteFile(null)}>
          <p><code>{confirmDeleteFile}</code> will be permanently deleted.</p>
        </Dialog>
      )}
    </div>
  );
}
