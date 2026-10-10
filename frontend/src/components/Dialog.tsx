import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Small accessible modal used for destructive confirmations. */
export function Dialog({ title, children, confirmLabel, danger, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div>{children}</div>
        <div className="row end">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button ref={ref} className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
