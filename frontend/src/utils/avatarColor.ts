/**
 * avatarColor — stable, pleasant color per person derived from their name.
 *
 * Lists of people (grading queue, contacts, team) read much faster when each
 * avatar keeps its own hue everywhere in the app. Palette is hand-picked to
 * sit well on both light and dark surfaces (no yellows-on-white, no muddy
 * browns), and `bg` variants are translucent so they adapt to the theme.
 */

const HUES = [
  { fg: '#3B82F6', bg: 'rgba(59, 130, 246, 0.14)' },   // blue
  { fg: '#6B8A24', bg: 'rgba(140, 175, 56, 0.18)' },  // lime (brand)
  { fg: '#DB2777', bg: 'rgba(219, 39, 119, 0.14)' },  // pink
  { fg: '#EA580C', bg: 'rgba(234, 88, 12, 0.14)' },   // orange
  { fg: '#059669', bg: 'rgba(5, 150, 105, 0.14)' },   // emerald
  { fg: '#0891B2', bg: 'rgba(8, 145, 178, 0.14)' },   // cyan
  { fg: '#3A7A56', bg: 'rgba(58, 122, 86, 0.16)' },    // leaf (brand)
  { fg: '#B7791F', bg: 'rgba(231, 182, 92, 0.18)' },  // amber (brand)
];

export function avatarColor(name: string | null | undefined): { fg: string; bg: string } {
  const s = (name || '').trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return HUES[Math.abs(hash) % HUES.length];
}
