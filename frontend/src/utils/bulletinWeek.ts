/**
 * Shared helpers for the weekly bulletin screens (/bulletin, /team-bulletin,
 * /weekly-share, /share-bulletins): which week a bulletin covers, how that
 * week is written on screen and on the posters, and the Vertex poster palette.
 *
 * Weeks run Monday–Sunday and are keyed by their Sunday ("week ending"),
 * stored as a date-only YYYY-MM-DD string. "Today" is read in app time (UK),
 * not the phone's own zone, so every admin lands on the same week.
 */
import { APP_LOCALE, APP_TZ } from './appTime';

/** Today's calendar date in app time, as a UTC-midnight Date. */
function appToday(): Date {
  try {
    const parts = new Intl.DateTimeFormat(APP_LOCALE, {
      timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
    const y = get('year'); const m = get('month'); const d = get('day');
    if (y && m && d) return new Date(Date.UTC(y, m - 1, d));
  } catch { /* fall back to the device clock below */ }
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function isoAddDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Sunday that ends the current week (app time). */
export function currentWeekEndingISO(): string {
  const d = appToday();
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? 0 : 7 - dow));
  return d.toISOString().slice(0, 10);
}

/** The last completed week's Sunday — what a bulletin covers by default. */
export function lastWeekEndingISO(): string {
  return isoAddDays(currentWeekEndingISO(), -7);
}

// Date-only strings are formatted in UTC on purpose so the day never rolls.
const fmtGB = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString(APP_LOCALE, { ...opts, timeZone: 'UTC' });

/** "29 Sept – 5 Oct" for the week ending `weekEnding`. */
export function prettyWeekRange(weekEnding: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return `${fmtGB(isoAddDays(weekEnding, -6), opts)} – ${fmtGB(weekEnding, opts)}`;
}

/** "5 Oct 2026". */
export function prettyDate(iso: string): string {
  return fmtGB(iso, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "5 OCTOBER" — the week-ending stamp on the posters. */
export function posterWeekEnding(weekEnding: string): string {
  return fmtGB(weekEnding, { day: 'numeric', month: 'long' }).toUpperCase();
}

/** Today in app time, long form ("30 September 2026") — poster footers. */
export function todayLong(): string {
  return new Date().toLocaleDateString(APP_LOCALE, {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: APP_TZ,
  });
}

/**
 * Vertex palette for the print/poster HTML (posters can't read theme tokens).
 * Contrast: paper/rule text on forest/deep, forest text on lime.
 */
export const POSTER = {
  forest: '#102d25',
  deep: '#0b211c',
  mid: '#244c3b',
  lime: '#b7df58',
  limeDark: '#8caf38',
  paper: '#f0f4e9',
  card: '#f9faf4',
  ink: '#17362b',
  muted: '#50675a',
  rule: '#cedbc7',
  amber: '#e7b65c',
  font: "'Fraunces', Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
} as const;

/** Initials-avatar backgrounds — all dark enough for white initials. */
export const AVATAR_PALETTE = ['#4f6f2e', '#244c3b', '#3f6b2a', '#5a4a1f', '#1f4d5c', '#4a3a5c', '#6b3a2a', '#2f5d50'];

export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

export function initialsOf(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
