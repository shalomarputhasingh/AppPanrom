import type { DesignTree, DesignTreeNode } from '../types';

const NAMES: Record<string, string> = {
  column_uruvakku: 'Column', row_uruvakku: 'Row', center_ama: 'Center', card_uruvakku: 'Card', title: 'Title', text_kaattu: 'Text',
  button: 'Button', input_uruvakku: 'Text field', password_input: 'Password', number_input: 'Number', checkbox_uruvakku: 'Checkbox',
  toggle_uruvakku: 'Toggle', dropdown_uruvakku: 'Dropdown', image_kaattu: 'Image', list_kaattu: 'List', progress_kaattu: 'Progress',
  loading_kaattu: 'Loading', divider_kaattu: 'Divider',
};

function Node({ n, sel, onSelect }: { n: DesignTreeNode; sel: number | null; onSelect(l: number): void }) {
  return (
    <li>
      <button className={`outline-item ${sel === n.line ? 'on' : ''}`} onClick={() => onSelect(n.line)} data-testid={`outline-${n.line}`}>
        <b>{NAMES[n.c] ?? n.c}</b> {n.label && <span className="muted">{n.label}</span>}
        <span className="muted small"> :{n.line}</span>
      </button>
      {n.children && n.children.length > 0 && (
        <ul>{n.children.map((c, i) => <Node key={`${c.line}-${i}`} n={c} sel={sel} onSelect={onSelect} />)}</ul>
      )}
    </li>
  );
}

export function Outline({ tree, selected, onSelect }: { tree: DesignTree | null; selected: number | null; onSelect(l: number): void }) {
  if (!tree) return <p className="muted small">The outline appears once the code compiles.</p>;
  if (tree.children.length === 0) return <p className="muted small">This screen is empty. Drag a component onto the phone.</p>;
  return (
    <ul className="outline" aria-label="Component outline">
      {tree.children.map((c, i) => <Node key={`${c.line}-${i}`} n={c} sel={selected} onSelect={onSelect} />)}
    </ul>
  );
}
