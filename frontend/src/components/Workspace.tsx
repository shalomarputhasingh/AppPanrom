import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { AppPermission, DesignNodeInfo, DesignTree, Diagnostic, DropInfo, LogLine, Project, Spec } from '../types';
import { BuildPanel } from './BuildPanel';
import { ConsolePanel } from './ConsolePanel';
import { DesignCanvas, type CanvasHandle } from './DesignCanvas';
import { Inspector } from './Inspector';
import { Outline } from './Outline';
import { Palette } from './Palette';
import { Dialog } from './Dialog';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { Editor, type EditorHandle } from './Editor';
import { PhonePreview, type PreviewState } from './PhonePreview';
import { ReferencePanel } from './ReferencePanel';
import { SettingsPanel } from './SettingsPanel';
import { ShortcutsDialog } from './ShortcutsDialog';
import { ThemeToggle } from './ThemeToggle';

type Bottom = 'console' | 'diagnostics' | 'build' | 'inspector';
type Side = 'files' | 'design' | 'settings' | 'reference';
type Mode = 'run' | 'design';
type Sync = 'ok' | 'pending' | 'errors';
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
  const [showKeys, setShowKeys] = useState(false);
  const [taMessages, setTaMessages] = useState<boolean>(() => { try { return window.localStorage.getItem('apppanrom.ta') === '1'; } catch { return false; } });
  const setTa = useCallback((v: boolean) => { setTaMessages(v); try { window.localStorage.setItem('apppanrom.ta', v ? '1' : '0'); } catch { /* ignore */ } }, []);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);
  // ---- designer state
  const [mode, setMode] = useState<Mode>('run');
  const [designIr, setDesignIr] = useState<unknown>(null);
  const [sync, setSync] = useState<Sync>('pending');
  const [selected, setSelected] = useState<number | null>(null);
  const [tree, setTree] = useState<DesignTree | null>(null);
  const [nodeInfo, setNodeInfo] = useState<DesignNodeInfo | null>(null);
  const [designError, setDesignError] = useState<string | null>(null);
  const [addingScreen, setAddingScreen] = useState<string | null>(null);

  const text = useRef('');
  const dirty = useRef(false);
  const saveTimer = useRef<number>();
  const valTimer = useRef<number>();
  const valSeq = useRef(0);
  const editor = useRef<EditorHandle>(null);
  const canvas = useRef<CanvasHandle | null>(null);
  const designEditing = useRef(false);
  const syncRef = useRef<Sync>('pending');
  const pendingScreen = useRef<string | null>(null);
  syncRef.current = sync;

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

  /** Compiles the buffer: feeds diagnostics, and (when it compiles) the design canvas. The source text is the only model. */
  const validate = useCallback((src: string) => {
    const seq = ++valSeq.current;
    setSync('pending');
    api.preview(projectId, src).then((r) => {
      if (seq !== valSeq.current) return;
      setDiags(r.diagnostics);
      setChecked(true);
      if (r.ok && r.ir) {
        setDesignIr(r.ir); setSync('ok');
        const fresh = r.ir;
        setPreview((p) => (p.state === 'ready' ? { ...p, ir: fresh } : p)); // hot reload: the running preview follows the code
      } else setSync('errors');
    }, () => undefined);
  }, [projectId]);

  const onChange = useCallback((v: string) => {
    text.current = v;
    dirty.current = true;
    setSave('dirty');
    if (!designEditing.current) { setSelected(null); setSync('pending'); } // lines shift when code is typed

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
    setMode('run');
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
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void doSave(); }
      else if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        const t = e.target as HTMLElement | null;
        if (!t || !(t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) { e.preventDefault(); setShowKeys(true); }
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [run, doSave]);

  // ---- designer: every action is a text edit of main.apn; the editor, autosave and compiler pick it up like typing
  const applyDesignEdit = useCallback(async (op: Record<string, unknown>, quiet = false): Promise<string | null> => {
    if (syncRef.current !== 'ok') {
      const m = 'Fix the errors in your code first; the designer needs code that compiles.';
      if (!quiet) setDesignError(m);
      return m;
    }
    try {
      const r = await api.designEdit(projectId, text.current, op);
      designEditing.current = true;
      editor.current?.replaceAll(r.source);
      designEditing.current = false;
      window.clearTimeout(valTimer.current);
      validate(r.source);
      setSelected(r.line);
      if (r.line) editor.current?.reveal(r.line);
      setDesignError(null);
      return null;
    } catch (e) {
      designEditing.current = false;
      const m = (e as Error).message;
      if (!quiet) setDesignError(m);
      return m;
    }
  }, [projectId, validate]);

  const getText = useCallback(() => text.current, []);
  /** Rewrites the whole file between the English and the Tanglish vocabulary (one undoable replace). */
  const convertCode = useCallback(async (to: 'tanglish' | 'english'): Promise<string | null> => {
    try {
      const r = await api.convert(text.current, to);
      designEditing.current = true;
      editor.current?.replaceAll(r.source);
      designEditing.current = false;
      window.clearTimeout(valTimer.current);
      validate(r.source);
      if (to === 'tanglish') setTa(true);
      return null;
    } catch (e) {
      designEditing.current = false;
      return (e as Error).message;
    }
  }, [validate, setTa]);

  const onCanvasDrop = useCallback((d: DropInfo) => {
    void applyDesignEdit(d.source === 'new'
      ? { kind: 'insert', type: d.type, target_line: d.target_line, position: d.position, screen: d.screen }
      : { kind: 'move', line: d.line, target_line: d.target_line, position: d.position, screen: d.screen });
  }, [applyDesignEdit]);

  const addFromPalette = useCallback((type: string) => {
    const screen = tree?.screen;
    if (selected != null && nodeInfo && nodeInfo.line === selected) {
      void applyDesignEdit({ kind: 'insert', type, target_line: selected, position: nodeInfo.container ? 'inside' : 'after', screen });
    } else void applyDesignEdit({ kind: 'insert', type, screen });
  }, [applyDesignEdit, selected, nodeInfo, tree]);

  const deleteSelected = useCallback(() => {
    if (selected != null && nodeInfo?.kind === 'component') void applyDesignEdit({ kind: 'delete', line: selected });
  }, [applyDesignEdit, selected, nodeInfo]);
  const duplicateSelected = useCallback(() => {
    if (selected != null && nodeInfo?.kind === 'component') void applyDesignEdit({ kind: 'duplicate', line: selected });
  }, [applyDesignEdit, selected, nodeInfo]);

  const inspectorOp = useCallback((op: Record<string, unknown>) => applyDesignEdit({ ...op }, true), [applyDesignEdit]);
  /** Creates `function name():` in the code and wires the selected component's event to it, as one visible edit. */
  const createHandler = useCallback(async (name: string, event: string): Promise<string | null> => {
    if (syncRef.current !== 'ok' || selected == null) return 'Fix the errors in your code first.';
    try {
      const a = await api.designEdit(projectId, text.current, { kind: 'create_handler', name });
      const delta = a.source.split('\n').length - text.current.split('\n').length;
      const line = selected + delta;
      const b = await api.designEdit(projectId, a.source, { kind: 'set_event', line, event, function: name });
      designEditing.current = true;
      editor.current?.replaceAll(b.source);
      designEditing.current = false;
      window.clearTimeout(valTimer.current);
      validate(b.source);
      setSelected(line);
      if (a.line) editor.current?.reveal(a.line);
      return null;
    } catch (e) {
      designEditing.current = false;
      return (e as Error).message;
    }
  }, [projectId, selected, validate]);

  const addScreen = async () => {
    const name = (addingScreen ?? '').trim();
    if (!name) return;
    const err = await applyDesignEdit({ kind: 'add_screen', name });
    if (!err) { pendingScreen.current = name; setAddingScreen(null); }
  };

  useEffect(() => {
    if (pendingScreen.current && canvas.current) { canvas.current.setScreen(pendingScreen.current); pendingScreen.current = null; }
  }, [designIr]);

  useEffect(() => {
    if (mode !== 'design' || selected == null) { setNodeInfo(null); return; }
    if (sync !== 'ok') return;
    let live = true;
    api.designNode(projectId, text.current, selected).then(
      (n) => { if (live) { setNodeInfo(n); setBottom((b) => (b === 'console' || b === 'diagnostics' ? 'inspector' : b)); } },
      () => { if (live) { setNodeInfo(null); } },
    );
    return () => { live = false; };
  }, [mode, selected, sync, designIr, projectId]);

  useEffect(() => {
    if (mode !== 'design') return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('.cm-editor') || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
      else if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [mode, deleteSelected, duplicateSelected]);

  const enterMode = async (m: Mode) => {
    if (m === 'design') {
      if (file !== MAIN && (await doSave())) await openFile(MAIN);
      setSide('design');
      validate(text.current);
    }
    setMode(m);
  };

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
        <ThemeToggle />
        <button className="btn" onClick={() => setShowKeys(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">⌨</button>
        <button className="btn" onClick={() => void doSave()} disabled={save === 'saved' || save === 'saving'} title="Save (Ctrl+S)">Save</button>
        <button className="btn primary" onClick={() => void run()} data-testid="run-btn" title="Run (Ctrl+Enter)">▶ Run</button>
        <button className="btn" onClick={() => setBottom('build')} data-testid="goto-build">Build APK</button>
      </header>

      <aside className="sidebar">
        <div className="tabs" role="tablist">
          {(['files', 'design', 'settings', 'reference'] as Side[]).map((s) => (
            <button key={s} role="tab" aria-selected={side === s} className={side === s ? 'on' : ''} onClick={() => setSide(s)}>{s === 'reference' ? 'Docs' : s[0].toUpperCase() + s.slice(1)}</button>
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
          {side === 'design' && (
            mode !== 'design' ? (
              <div className="empty small"><p>The designer lets you drag components onto the phone and edit them visually. Every change is written into your code.</p>
                <button className="btn primary" onClick={() => void enterMode('design')} data-testid="open-designer">Open designer</button></div>
            ) : (
              <>
                <Palette disabled={sync !== 'ok' || file !== MAIN} onAdd={addFromPalette} />
                <h4>Outline</h4>
                <Outline tree={tree} selected={selected} onSelect={(l) => setSelected(l)} />
              </>
            )
          )}
          {side === 'settings' && (
            <SettingsPanel project={project} onSaved={(p) => { setProject(p); validate(text.current); }} getText={getText} rev={designIr}
              onOp={(op) => applyDesignEdit(op, true)} onConvert={convertCode} ready={sync === 'ok'} taMessages={taMessages} setTaMessages={setTa} />
          )}
          {side === 'reference' && <ReferencePanel spec={spec} onUseExample={(c) => setConfirmExample(c)} />}
        </div>
      </aside>

      <section className="editor-pane" aria-label={`Editing ${file}`}>
        <div className="file-tab mono">{file}</div>
        <Editor key={editorKey} ref={editor} initialValue={initial} spec={spec} diagnostics={file === MAIN ? diags : []} onChange={onChange} onSave={() => void doSave()} />
      </section>

      <section className="preview-pane">
        <div className="preview-col">
          <div className="seg" role="tablist" aria-label="Preview mode">
            <button role="tab" aria-selected={mode === 'run'} className={mode === 'run' ? 'on' : ''} onClick={() => void enterMode('run')} data-testid="mode-run">▶ Preview</button>
            <button role="tab" aria-selected={mode === 'design'} className={mode === 'design' ? 'on' : ''} onClick={() => void enterMode('design')} data-testid="mode-design">✎ Design</button>
          </div>
          {mode === 'run' ? (
            <PhonePreview state={preview.state} ir={preview.ir} runKey={preview.runKey} projectId={projectId} errorCount={errorCount} codeOk={sync === 'ok'} onLog={log} onRestart={restart} />
          ) : (
            <div className="design-pane">
              <div className="design-toolbar">
                <label className="sr-only" htmlFor="screen-pick">Screen</label>
                <select id="screen-pick" value={tree?.screen ?? ''} onChange={(e) => canvas.current?.setScreen(e.target.value)} disabled={!tree} data-testid="screen-pick">
                  {(tree?.screens ?? []).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                {addingScreen === null ? (
                  <button className="btn small" onClick={() => setAddingScreen('')} disabled={sync !== 'ok'}>+ Screen</button>
                ) : (
                  <form className="row" onSubmit={(e) => { e.preventDefault(); void addScreen(); }}>
                    <input autoFocus aria-label="New screen name" placeholder="details" value={addingScreen} onChange={(e) => setAddingScreen(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAddingScreen(null)} />
                    <button className="btn small primary" disabled={!addingScreen.trim()}>Add</button>
                  </form>
                )}
                <span className="spacer" />
                <button className="btn small" onClick={() => editor.current?.undo()} title="Undo (also Ctrl+Z in the editor)" aria-label="Undo">↶</button>
                <button className="btn small" onClick={() => editor.current?.redo()} title="Redo" aria-label="Redo">↷</button>
                <button className="btn small" onClick={duplicateSelected} disabled={!nodeInfo || nodeInfo.kind !== 'component' || sync !== 'ok'} aria-label="Duplicate" title="Duplicate (Ctrl+D)">⧉</button>
                <button className="btn small danger-outline" onClick={deleteSelected} disabled={!nodeInfo || nodeInfo.kind !== 'component' || sync !== 'ok'} data-testid="toolbar-delete" aria-label="Delete" title="Delete (Del)">✕</button>
              </div>
              {sync === 'errors' && (
                <p className="design-banner" role="alert" data-testid="design-stale">
                  Your code has {errorCount} error{errorCount === 1 ? '' : 's'}. Showing the last valid design; fix the errors (see Diagnostics) to keep designing.
                </p>
              )}
              {designError && <p className="design-banner err" role="alert" data-testid="design-error">{designError} <button className="btn small" onClick={() => setDesignError(null)}>Dismiss</button></p>}
              <div className="phone" data-testid="design-phone">
                <div className="phone-notch" />
                <div className={`phone-screen ${sync === 'errors' ? 'stale' : ''}`}>
                  {designIr ? (
                    <DesignCanvas ir={designIr} selectedLine={selected} onSelect={setSelected} onDrop={onCanvasDrop} onTree={setTree} ctrlRef={canvas} />
                  ) : (
                    <div className="phone-msg err" role="alert"><strong>Nothing to design yet</strong><span>Fix the errors in your code first.</span></div>
                  )}
                </div>
              </div>
              <p className="muted small center-text">Drag components from the palette. Click to select, drag to move, Delete to remove.</p>
            </div>
          )}
        </div>
      </section>

      <section className="bottom">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={bottom === 'console'} className={bottom === 'console' ? 'on' : ''} onClick={() => setBottom('console')}>Console</button>
          <button role="tab" aria-selected={bottom === 'diagnostics'} className={bottom === 'diagnostics' ? 'on' : ''} onClick={() => setBottom('diagnostics')} data-testid="tab-diagnostics">
            Diagnostics {checked && (errorCount > 0 ? <span className="pill err">{errorCount}</span> : warnCount > 0 ? <span className="pill warn">{warnCount}</span> : null)}
          </button>
          {mode === 'design' && (
            <button role="tab" aria-selected={bottom === 'inspector'} className={bottom === 'inspector' ? 'on' : ''} onClick={() => setBottom('inspector')} data-testid="tab-inspector">Inspector</button>
          )}
          <button role="tab" aria-selected={bottom === 'build'} className={bottom === 'build' ? 'on' : ''} onClick={() => setBottom('build')} data-testid="tab-build">Build</button>
        </div>
        {bottom === 'console' && <ConsolePanel lines={logs} onClear={() => setLogs([])} />}
        {bottom === 'diagnostics' && <DiagnosticsPanel tanglish={taMessages} diagnostics={diags} checked={checked} onJump={(d) => editor.current?.jumpTo(d.line, d.col)} />}
        {bottom === 'inspector' && mode === 'design' && (
          <Inspector node={nodeInfo} spec={spec} disabled={sync !== 'ok'} onOp={inspectorOp} onDelete={deleteSelected} onDuplicate={duplicateSelected}
            onGoto={(l) => editor.current?.jumpTo(l, 1)} onCreateHandler={createHandler} />
        )}
        {bottom === 'build' && <BuildPanel projectId={projectId} ensureSaved={doSave} onProblems={(d) => { setDiags(d); setChecked(true); }}
          permissions={(designIr as { permissions?: AppPermission[] } | null)?.permissions ?? []} />}
      </section>

      {showKeys && <ShortcutsDialog onClose={() => setShowKeys(false)} />}
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
