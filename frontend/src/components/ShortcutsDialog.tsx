import { Dialog } from './Dialog';

const KEYS: [string, string][] = [
  ['Ctrl/⌘ + Enter', 'Run the app'],
  ['Ctrl/⌘ + S', 'Save now (autosave also runs)'],
  ['Ctrl/⌘ + Z / Y', 'Undo / redo (editor and designer)'],
  ['Delete', 'Delete the selected component'],
  ['Ctrl/⌘ + D', 'Duplicate the selected component'],
  ['Drag', 'Move a component, or drag from the palette'],
  ['?', 'Show this help'],
];

export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  return (
    <Dialog title="Keyboard shortcuts" confirmLabel="Close" onConfirm={onClose} onCancel={onClose}>
      <table className="shortcuts">
        <tbody>{KEYS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody>
      </table>
    </Dialog>
  );
}
