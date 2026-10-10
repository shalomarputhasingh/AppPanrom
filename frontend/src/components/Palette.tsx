import type { DragEvent } from 'react';

export const NEW_TYPE = 'application/x-apppanrom-new';

export const GROUPS: { title: string; items: { type: string; label: string; glyph: string }[] }[] = [
  {
    title: 'Layout',
    items: [
      { type: 'column_uruvakku', label: 'Column', glyph: '▥' },
      { type: 'row_uruvakku', label: 'Row', glyph: '▤' },
      { type: 'center_ama', label: 'Center', glyph: '◎' },
      { type: 'card_uruvakku', label: 'Card', glyph: '▢' },
    ],
  },
  {
    title: 'Text & actions',
    items: [
      { type: 'title', label: 'Title', glyph: 'T' },
      { type: 'text_kaattu', label: 'Text', glyph: 'Aa' },
      { type: 'button', label: 'Button', glyph: '▭' },
    ],
  },
  {
    title: 'Inputs',
    items: [
      { type: 'input_uruvakku', label: 'Text field', glyph: '⌶' },
      { type: 'password_input', label: 'Password', glyph: '••' },
      { type: 'number_input', label: 'Number', glyph: '#' },
      { type: 'checkbox_uruvakku', label: 'Checkbox', glyph: '☑' },
      { type: 'toggle_uruvakku', label: 'Toggle', glyph: '◐' },
      { type: 'dropdown_uruvakku', label: 'Dropdown', glyph: '▾' },
    ],
  },
  {
    title: 'Navigation',
    items: [
      { type: 'navbar_uruvakku', label: 'Top bar', glyph: '▔' },
      { type: 'nav_action', label: 'Bar action', glyph: '⊕' },
      { type: 'tabbar_uruvakku', label: 'Tab bar', glyph: '▁' },
      { type: 'tab_item', label: 'Tab', glyph: '▫' },
    ],
  },
  {
    title: 'Display',
    items: [
      { type: 'image_kaattu', label: 'Image', glyph: '▨' },
      { type: 'list_kaattu', label: 'List', glyph: '☰' },
      { type: 'progress_kaattu', label: 'Progress', glyph: '▰' },
      { type: 'loading_kaattu', label: 'Loading', glyph: '◌' },
      { type: 'divider_kaattu', label: 'Divider', glyph: '—' },
    ],
  },
];

interface Props {
  disabled: boolean;
  onAdd(type: string): void;
}

/** Drag a component onto the phone canvas — or click / press Enter to add it next to the selection. */
export function Palette({ disabled, onAdd }: Props) {
  const start = (e: DragEvent, type: string) => {
    e.dataTransfer.setData(NEW_TYPE, type);
    e.dataTransfer.setData('text/plain', type);
    e.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <div className="palette" aria-label="Component palette">
      {GROUPS.map((g) => (
        <section key={g.title}>
          <h4>{g.title}</h4>
          <ul className="palette-grid">
            {g.items.map((i) => (
              <li key={i.type}>
                <button
                  className="palette-item"
                  draggable={!disabled}
                  disabled={disabled}
                  data-testid={`palette-${i.type}`}
                  title={`Drag onto the phone, or click to add ${i.label}`}
                  onDragStart={(e) => start(e, i.type)}
                  onClick={() => onAdd(i.type)}
                >
                  <span className="glyph" aria-hidden>{i.glyph}</span>
                  <span>{i.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
