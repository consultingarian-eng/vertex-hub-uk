import { APP_TZ } from './appTime';

// Plain calendar dates ('YYYY-MM-DD') for the schedule calendar. Every "today"
// and "now" is read in the app timezone (UK time), never the device's.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function pad(n: number) { return String(n).padStart(2, '0'); }

function appParts(d: Date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: (+p.hour) % 24, mm: +p.minute };
}

/** Today in app time, 'YYYY-MM-DD'. */
export function todayISO(now = new Date()): string {
  const p = appParts(now);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Minutes since midnight, app time. */
export function nowMinutes(now = new Date()): number {
  const p = appParts(now);
  return p.hh * 60 + p.mm;
}

function toUTC(iso: string): Date {
  const [y, m, d] = iso.split('-').map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function fromUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(iso: string, n: number): string {
  const d = toUTC(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}

/** 0 = Monday … 6 = Sunday (the schedule's day_of_week). */
export function dowOf(iso: string): number {
  return (toUTC(iso).getUTCDay() + 6) % 7;
}

export function startOfWeek(iso: string): string {
  return addDays(iso, -dowOf(iso));
}

export function dayNum(iso: string): number { return toUTC(iso).getUTCDate(); }

/** '2 Oct 2026' */
export function prettyDate(iso: string): string {
  const d = toUTC(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** 'Friday 2 October' */
export function longDate(iso: string): string {
  const d = toUTC(iso);
  return `${DAY_FULL[dowOf(iso)]} ${d.getUTCDate()} ${MONTHS_FULL[d.getUTCMonth()]}`;
}

/** Week title: '28 Sep – 2 Oct 2026' (or '5 – 9 Oct 2026' in one month). */
export function rangeLabel(from: string, to: string): string {
  const a = toUTC(from), b = toUTC(to);
  const sameMonth = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
  const left = sameMonth ? `${a.getUTCDate()}` : `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]}`;
  return `${left} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

export function monthTitle(year: number, month0: number): string {
  return `${MONTHS_FULL[month0]} ${year}`;
}

/** The 6×7 Monday-first grid of dates for a month view. */
export function monthGrid(year: number, month0: number): string[] {
  const first = `${year}-${pad(month0 + 1)}-01`;
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function monthOf(iso: string): { year: number; month0: number } {
  const d = toUTC(iso);
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth() };
}

export function hhmmToMin(s?: string | null): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function minToHHMM(min: number): string {
  const c = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
  return `${pad(Math.floor(c / 60))}:${pad(c % 60)}`;
}

/** '9:15' / '1:30pm' style: compact 12-hour, am/pm only when it changes. */
export function shortTime(hhmm: string, withSuffix = true): string {
  const m = hhmmToMin(hhmm);
  if (m === null) return hhmm || '';
  let h = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${h}${mm ? `:${pad(mm)}` : ''}${withSuffix ? suffix : ''}`;
}

export function timeRange(start: string, end: string): string {
  const s = hhmmToMin(start) ?? 0, e = hhmmToMin(end) ?? 0;
  const samePart = (s < 720) === (e < 720);
  return `${shortTime(start, !samePart)} – ${shortTime(end)}`;
}

export function hourLabel(hour: number): string {
  const suffix = hour >= 12 ? 'pm' : 'am';
  let h = hour % 12; if (h === 0) h = 12;
  return `${h}${suffix}`;
}
