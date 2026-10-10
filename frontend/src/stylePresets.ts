/** Data for the Inspector's style helpers: one-click looks, colour palettes and key grouping. All values are validated by the compiler. */
export type StyleChange = Record<string, { literal: string | number | boolean } | null>;

export interface StylePreset {
  id: string;
  name: string;
  hint: string;
  /** Style keys to set (null removes the key). Keys the component does not allow are skipped. */
  styles: StyleChange;
  /** Background to use when the component has none yet (clay and outline need a colour to look right). */
  fallbackBackground?: string;
}

const lit = (v: string | number | boolean) => ({ literal: v });

export const PRESETS: StylePreset[] = [
  { id: 'clay', name: 'Clay', hint: 'Soft, puffy 3D look (claymorphism)', fallbackBackground: '#C4B5FD',
    styles: { clay: lit(true), corner_radius: lit(28), shadow: null, border_width: null, border_color: null } },
  { id: 'flat', name: 'Flat', hint: 'Plain, no shadow, small corners',
    styles: { clay: null, shadow: null, corner_radius: lit(10), border_width: null, border_color: null } },
  { id: 'elevated', name: 'Elevated', hint: 'Clean card with a drop shadow',
    styles: { clay: null, shadow: lit('medium'), corner_radius: lit(16), border_width: null, border_color: null } },
  { id: 'outline', name: 'Outline', hint: 'White with a coloured border', fallbackBackground: '#FFFFFF',
    styles: { clay: null, shadow: null, background: lit('#FFFFFF'), text_color: lit('#4F46E5'), border_width: lit(2), border_color: lit('#4F46E5'), corner_radius: lit(14) } },
  { id: 'pill', name: 'Pill', hint: 'Fully rounded ends',
    styles: { corner_radius: lit(100) } },
  { id: 'sharp', name: 'Sharp', hint: 'Square corners, no effects',
    styles: { clay: null, shadow: null, corner_radius: lit(0) } },
];

export interface Palette { name: string; colors: string[] }
export const PALETTES: Palette[] = [
  { name: 'Clay pastels', colors: ['#FCA5A5', '#FDBA74', '#FDE68A', '#86EFAC', '#93C5FD', '#C4B5FD', '#F9A8D4', '#E9E4FF'] },
  { name: 'Vivid', colors: ['#EF4444', '#F97316', '#EAB308', '#22C55E', '#3B82F6', '#6366F1', '#A855F7', '#EC4899'] },
  { name: 'Neutrals', colors: ['#FFFFFF', '#F3F4F6', '#D1D5DB', '#9CA3AF', '#6B7280', '#374151', '#1F2937', '#111827'] },
];

/** Whole-screen looks: background plus a readable text colour for the children. */
export const SCREEN_THEMES: { name: string; styles: StyleChange }[] = [
  { name: 'Lavender', styles: { background: lit('#E9E4FF') } },
  { name: 'Peach', styles: { background: lit('#FFE8D6') } },
  { name: 'Mint', styles: { background: lit('#D9F7E8') } },
  { name: 'Sky', styles: { background: lit('#DBEAFE') } },
  { name: 'Light', styles: { background: lit('#F9FAFB') } },
  { name: 'Midnight', styles: { background: lit('#1E1B4B'), text_color: lit('#E0E7FF') } },
];

/** Inspector sections: label, keys (in order), and whether the section starts open. */
export const GROUPS: { id: string; label: string; keys: string[]; open?: boolean }[] = [
  { id: 'color', label: 'Colours', keys: ['background', 'text_color', 'border_color'], open: true },
  { id: 'shape', label: 'Shape & effects', keys: ['corner_radius', 'clay', 'shadow', 'border_width', 'opacity'], open: true },
  { id: 'space', label: 'Size & spacing', keys: ['width', 'height', 'padding', 'margin'] },
  { id: 'text', label: 'Text', keys: ['font_size', 'font_weight', 'text_align'] },
  { id: 'layout', label: 'Layout', keys: ['gap', 'align', 'justify', 'wrap', 'scroll', 'visible'] },
];
