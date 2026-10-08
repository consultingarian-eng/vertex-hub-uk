// Team color palette — the per-team identity tint used across the Bells
// feature (Cards / Table / Team views + the public office board).
//
// Colors are deterministic per leader/team key, so a team keeps the same
// hue everywhere. Since the "Ink & Cube" overhaul the palette is
// THEME-AWARE: the pale pastel set is the LIGHT palette (pale pill, dark
// type on white cards); a parallel DARK palette keeps the same hue per
// index but flips the roles — vivid rail, deep tinted pill, pale type —
// so a team card is a raised forest card, not a paper island on the abyss
// (spec §2.5).
//
// API is additive: `teamColor(key)` still returns the LIGHT tint, so every
// existing caller (TableView, EntryRow, app/public/bells/[office]) behaves
// exactly as before. Pass a scheme — `teamColor(key, 'dark')` — or use the
// `useTeamColor(key)` hook to follow the active theme.
//
// Every value in both palettes stays a 6-DIGIT HEX: callers concatenate a
// hex alpha onto them (TableView does `tint.border + '26'`). Never return
// an rgba() string from here.

import { useTheme } from '../theme/ThemeContext';

export type TeamTint = {
  border: string;   // left rail / accent (vivid in both themes)
  bg: string;       // subtle card background
  pill: string;     // pill background
  text: string;     // strong text color for labels (readable on `bg`/`pill`/card)
};

export type TeamScheme = 'light' | 'dark';

// Light: pale pastel fills, dark type. Contrast measured on a white card —
// every `text` ≥ 5.0:1 on #FFFFFF and ≥ 4.5:1 on its own `pill`.
const PALETTE: TeamTint[] = [
  { border: '#8CAF38', bg: '#F6FAEC', pill: '#E6F2C7', text: '#4A6614' }, // lime
  { border: '#34d399', bg: '#ecfdf5', pill: '#d1fae5', text: '#047857' }, // green
  { border: '#fbbf24', bg: '#fffbeb', pill: '#fef3c7', text: '#b45309' }, // amber
  { border: '#60A5FA', bg: '#EFF6FF', pill: '#DBEAFE', text: '#1D4ED8' }, // blue
  { border: '#FB7185', bg: '#FFF1F2', pill: '#FFE4E6', text: '#BE123C' }, // rose
  { border: '#22d3ee', bg: '#ecfeff', pill: '#cffafe', text: '#0e7490' }, // cyan
  { border: '#fb923c', bg: '#fff7ed', pill: '#ffedd5', text: '#c2410c' }, // orange
  { border: '#8FA596', bg: '#F5F8F3', pill: '#E3EBE0', text: '#3D5446' }, // sage (fallback)
];

// Dark: same hue per index, roles flipped. `bg` is a deep tinted panel that
// still reads as RAISED above the #061410 abyss; `pill` is a deeper chip of
// the same hue; `text` is the pale tone (≥ 11:1 on the #102d25 card,
// ≥ 8.7:1 on its own pill). `border` keeps the vivid hue — it is a rail /
// dot / rule, never type (#22d3ee is decoration only, never text).
const PALETTE_DARK: TeamTint[] = [
  { border: '#B7DF58', bg: '#1A2E14', pill: '#2A4418', text: '#E2F2B8' }, // lime
  { border: '#34D399', bg: '#0F2A24', pill: '#14432F', text: '#A7F3D0' }, // green
  { border: '#FBBF24', bg: '#2C2113', pill: '#463415', text: '#FDE68A' }, // amber
  { border: '#60A5FA', bg: '#13233A', pill: '#1B335A', text: '#BFDBFE' }, // blue
  { border: '#FB7185', bg: '#2E1419', pill: '#4A1D26', text: '#FECDD3' }, // rose
  { border: '#22D3EE', bg: '#0E2A33', pill: '#12414C', text: '#A5F3FC' }, // cyan
  { border: '#FB923C', bg: '#2E1D12', pill: '#4A2C13', text: '#FED7AA' }, // orange
  { border: '#8FA596', bg: '#16241E', pill: '#243A30', text: '#D5E2D2' }, // sage (fallback)
];

// Hash a string into a small unsigned int.
function hashStr(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function paletteFor(scheme: TeamScheme): TeamTint[] {
  return scheme === 'dark' ? PALETTE_DARK : PALETTE;
}

/**
 * Deterministic color pick for a team. `key` should be the leader_id
 * (preferred) or leader_name as a fallback. Same key → same hue in both
 * palettes (the index is scheme-independent).
 *
 * When `key` is null / empty, we return the slate fallback (no team).
 *
 * `scheme` defaults to 'light' so existing callers are untouched.
 */
export function teamColor(key: string | null | undefined, scheme: TeamScheme = 'light'): TeamTint {
  const palette = paletteFor(scheme);
  if (!key) return palette[palette.length - 1];
  return palette[hashStr(key) % (palette.length - 1)];
}

/** The "no team" slate fallback for a given theme. */
export function noTeamTint(scheme: TeamScheme = 'light'): TeamTint {
  const palette = paletteFor(scheme);
  return palette[palette.length - 1];
}

export const NO_TEAM_TINT: TeamTint = PALETTE[PALETTE.length - 1];
export const NO_TEAM_TINT_DARK: TeamTint = PALETTE_DARK[PALETTE_DARK.length - 1];

/**
 * Same as `teamColor`, but follows the active theme. Use inside components
 * that render on a themed surface (team cards, chips) so the tint flips
 * with the app instead of staying pastel on the dark abyss.
 */
export function useTeamColor(key: string | null | undefined): TeamTint {
  const { effective } = useTheme();
  return teamColor(key, effective === 'dark' ? 'dark' : 'light');
}

/** The active theme's scheme — handy when a component tints many teams in one pass. */
export function useTeamScheme(): TeamScheme {
  const { effective } = useTheme();
  return effective === 'dark' ? 'dark' : 'light';
}
