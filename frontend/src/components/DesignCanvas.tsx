import { useEffect, useRef } from 'react';
import { getRuntime } from '../runtime';
import type { DesignTree, DropInfo } from '../types';

export interface CanvasHandle {
  setScreen(name: string): void;
}

interface Props {
  ir: unknown;
  selectedLine: number | null;
  onSelect(line: number | null): void;
  onDrop(info: DropInfo): void;
  onTree(tree: DesignTree): void;
  ctrlRef: { current: CanvasHandle | null };
}

/**
 * The design canvas: the real AppPanrom runtime rendering the app in "design mode" inside a shadow root (so Studio
 * styles can't leak in). Clicking selects, dragging moves, and drops are reported as source-edit requests. Nothing here
 * edits state; the Studio turns each request into a text edit of main.apn and recompiles.
 */
export function DesignCanvas({ ir, selectedLine, onSelect, onDrop, onTree, ctrlRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const ctrl = useRef<ReturnType<typeof Object> | null>(null);
  const cb = useRef({ onSelect, onDrop, onTree });
  cb.current = { onSelect, onDrop, onTree };
  const first = useRef({ ir, selectedLine });

  useEffect(() => {
    const el = host.current!;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const AP = getRuntime();
    const c = AP.mount(first.current.ir, shadow, {
      namespace: 'design',
      storage: AP.memoryStorage(),
      log: () => undefined,
      design: {
        selectedLine: first.current.selectedLine,
        onSelect: (l: number | null) => cb.current.onSelect(l),
        onDrop: (i: DropInfo) => cb.current.onDrop(i),
        onTree: (t: DesignTree) => cb.current.onTree(t),
      },
    });
    ctrl.current = c;
    ctrlRef.current = { setScreen: (n) => c.setScreen(n) };
    return () => {
      c.destroy();
      ctrl.current = null;
      ctrlRef.current = null;
    };
  }, [ctrlRef]);

  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return; }
    (ctrl.current as unknown as { update(ir: unknown): void } | null)?.update(ir);
  }, [ir]);
  useEffect(() => {
    (ctrl.current as unknown as { select(l: number | null): void } | null)?.select(selectedLine);
  }, [selectedLine]);

  return <div className="design-canvas" ref={host} data-testid="design-canvas" />;
}
