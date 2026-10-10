import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { apppanromLanguage, builtinNames, highlight } from '../lang';
import type { Diagnostic, Spec } from '../types';

export interface EditorHandle {
  jumpTo(line: number, col: number): void;
  /** Scrolls a line into view without taking focus (used when the designer selects a component). */
  reveal(line: number): void;
  /** Replaces the whole document with the smallest possible change, so scroll position and undo history survive. */
  replaceAll(text: string): void;
  undo(): void;
  redo(): void;
}

interface Props {
  initialValue: string;
  readOnly?: boolean;
  spec: Spec | null;
  diagnostics: Diagnostic[];
  onChange(value: string): void;
  onSave(): void;
}

function toCm(view: EditorView, d: Diagnostic): CmDiagnostic {
  const doc = view.state.doc;
  const line = doc.line(Math.min(Math.max(d.line, 1), doc.lines));
  const from = Math.min(line.from + Math.max(d.col - 1, 0), line.to);
  let to = d.end_col ? Math.min(line.from + d.end_col - 1, line.to) : from;
  if (to <= from) {
    const m = /^[A-Za-z0-9_]+/.exec(doc.sliceString(from, line.to));
    to = Math.min(from + (m ? m[0].length : 1), Math.max(line.to, from + 1), doc.length);
  }
  return { from, to: Math.max(to, from), severity: d.severity, message: d.message + (d.suggestion ? `\n${d.suggestion}` : '') };
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ initialValue, readOnly, spec, diagnostics, onChange, onSave }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  const language = useMemo(() => apppanromLanguage(spec ? builtinNames(spec) : new Set()), [spec]);

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), lintGutter(), indentUnit.of('    '),
          language, highlight,
          EditorState.readOnly.of(!!readOnly),
          EditorView.contentAttributes.of({ 'aria-label': 'Code editor' }),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (cb.current.onSave(), true) },
            indentWithTab, ...defaultKeymap, ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
        ],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // The editor instance is recreated per file/language only; the document is owned by CodeMirror afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch(setDiagnostics(v.state, diagnostics.map((d) => toCm(v, d))));
  }, [diagnostics, language]);

  useImperativeHandle(ref, () => ({
    reveal(line) {
      const v = viewRef.current;
      if (!v) return;
      const l = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines));
      v.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
    },
    replaceAll(text) {
      const v = viewRef.current;
      if (!v) return;
      const old = v.state.doc.toString();
      if (old === text) return;
      let pre = 0;
      while (pre < old.length && pre < text.length && old[pre] === text[pre]) pre++;
      let suf = 0;
      while (suf < old.length - pre && suf < text.length - pre && old[old.length - 1 - suf] === text[text.length - 1 - suf]) suf++;
      v.dispatch({ changes: { from: pre, to: old.length - suf, insert: text.slice(pre, text.length - suf) } });
    },
    undo() { const v = viewRef.current; if (v) undo(v); },
    redo() { const v = viewRef.current; if (v) redo(v); },
    jumpTo(line, col) {
      const v = viewRef.current;
      if (!v) return;
      const l = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines));
      const pos = Math.min(l.from + Math.max(col - 1, 0), l.to);
      v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      v.focus();
    },
  }));

  return <div className="editor" ref={host} data-testid="editor" />;
});
