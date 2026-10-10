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

const OFF: StyleChange = { clay: null, glass: null, neumorphic: null, brutal: null, shadow: null };
const NO_BORDER: StyleChange = { border_width: null, border_color: null };

export const PRESETS: StylePreset[] = [
  { id: 'clay', name: 'Clay', hint: 'Soft, puffy 3D look (claymorphism)', fallbackBackground: '#C4B5FD',
    styles: { ...OFF, ...NO_BORDER, clay: lit(true), corner_radius: lit(28) } },
  { id: 'glass', name: 'Glass', hint: 'Frosted translucent glass (put it on a gradient screen)', fallbackBackground: '#FFFFFF',
    styles: { ...OFF, ...NO_BORDER, glass: lit(true), corner_radius: lit(24) } },
  { id: 'neu', name: 'Soft UI', hint: 'Neumorphism: same colour as the surface, soft light and dark shadows', fallbackBackground: '#E5E7EB',
    styles: { ...OFF, ...NO_BORDER, neumorphic: lit(true), corner_radius: lit(20) } },
  { id: 'brutal', name: 'Brutal', hint: 'Neo-brutalism: thick black outline, hard shadow', fallbackBackground: '#FDE047',
    styles: { ...OFF, brutal: lit(true), border_width: null, border_color: null, corner_radius: lit(0), text_color: lit('#111111') } },
  { id: 'minimal', name: 'Minimal', hint: 'White, hairline border, quiet', fallbackBackground: '#FFFFFF',
    styles: { ...OFF, background: lit('#FFFFFF'), text_color: lit('#111827'), border_width: lit(1), border_color: lit('#E5E7EB'), corner_radius: lit(8) } },
  { id: 'flat', name: 'Flat', hint: 'Plain, no shadow, small corners',
    styles: { ...OFF, ...NO_BORDER, corner_radius: lit(10) } },
  { id: 'elevated', name: 'Elevated', hint: 'Clean card with a drop shadow',
    styles: { ...OFF, ...NO_BORDER, shadow: lit('medium'), corner_radius: lit(16) } },
  { id: 'outline', name: 'Outline', hint: 'White with a coloured border', fallbackBackground: '#FFFFFF',
    styles: { ...OFF, background: lit('#FFFFFF'), text_color: lit('#4F46E5'), border_width: lit(2), border_color: lit('#4F46E5'), corner_radius: lit(14) } },
  { id: 'pill', name: 'Pill', hint: 'Fully rounded ends', styles: { corner_radius: lit(100) } },
  { id: 'sharp', name: 'Sharp', hint: 'Square corners, no effects', styles: { ...OFF, corner_radius: lit(0) } },
];

export const ANIMATIONS: { id: string; name: string }[] = [
  { id: 'fade_in', name: 'Fade in' }, { id: 'slide_up', name: 'Slide up' }, { id: 'pop', name: 'Pop' }, { id: 'zoom_in', name: 'Zoom' },
  { id: 'bounce', name: 'Bounce' }, { id: 'pulse', name: 'Pulse' }, { id: 'shake', name: 'Shake' }, { id: 'float', name: 'Float' },
];

export interface Palette { name: string; colors: string[] }
export const PALETTES: Palette[] = [
  { name: 'Clay pastels', colors: ['#FCA5A5', '#FDBA74', '#FDE68A', '#86EFAC', '#93C5FD', '#C4B5FD', '#F9A8D4', '#E9E4FF'] },
  { name: 'Vivid', colors: ['#EF4444', '#F97316', '#EAB308', '#22C55E', '#3B82F6', '#6366F1', '#A855F7', '#EC4899'] },
  { name: 'Neutrals', colors: ['#FFFFFF', '#F3F4F6', '#D1D5DB', '#9CA3AF', '#6B7280', '#374151', '#1F2937', '#111827'] },
];

/** Whole-screen looks: a background (optionally a gradient) plus a readable text colour for the children. */
export const SCREEN_THEMES: { name: string; styles: StyleChange; css: string }[] = [
  { name: 'Lavender', styles: { background: lit('#E9E4FF'), background_to: null }, css: '#E9E4FF' },
  { name: 'Mint', styles: { background: lit('#D9F7E8'), background_to: null }, css: '#D9F7E8' },
  { name: 'Light', styles: { background: lit('#F9FAFB'), background_to: null }, css: '#F9FAFB' },
  { name: 'Midnight', styles: { background: lit('#1E1B4B'), background_to: null, text_color: lit('#E0E7FF') }, css: '#1E1B4B' },
  { name: 'Aurora', styles: { background: lit('#6366F1'), background_to: lit('#EC4899'), gradient_angle: lit(135) }, css: 'linear-gradient(135deg,#6366F1,#EC4899)' },
  { name: 'Ocean', styles: { background: lit('#06B6D4'), background_to: lit('#3B82F6'), gradient_angle: lit(160) }, css: 'linear-gradient(160deg,#06B6D4,#3B82F6)' },
  { name: 'Sunset', styles: { background: lit('#F97316'), background_to: lit('#DB2777'), gradient_angle: lit(150) }, css: 'linear-gradient(150deg,#F97316,#DB2777)' },
  { name: 'Candy', styles: { background: lit('#FBCFE8'), background_to: lit('#BFDBFE'), gradient_angle: lit(135) }, css: 'linear-gradient(135deg,#FBCFE8,#BFDBFE)' },
];

/** Inspector sections: label, keys (in order), and whether the section starts open. */
export const GROUPS: { id: string; label: string; keys: string[]; open?: boolean }[] = [
  { id: 'color', label: 'Colours', keys: ['background', 'background_to', 'gradient_angle', 'text_color', 'border_color'], open: true },
  { id: 'shape', label: 'Shape & looks', keys: ['corner_radius', 'clay', 'glass', 'neumorphic', 'brutal', 'shadow', 'border_width', 'opacity'], open: true },
  { id: 'motion', label: 'Animation', keys: ['animate', 'animate_duration', 'animate_delay'] },
  { id: 'space', label: 'Size & spacing', keys: ['width', 'height', 'padding', 'margin'] },
  { id: 'text', label: 'Text', keys: ['font_size', 'font_weight', 'text_align'] },
  { id: 'layout', label: 'Layout', keys: ['gap', 'align', 'justify', 'wrap', 'scroll', 'visible'] },
];
