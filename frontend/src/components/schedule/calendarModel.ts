import { ScheduleBlock } from '../../utils/scheduleNotifications';
import { dowOf, hhmmToMin } from '../../utils/calendarDates';

// The office timetable runs in lanes, the columns of the Owner's schedule
// sheet. Mirrors backend/core/schedule_template.py.
export const GROUPS = ['s4', 'ld', 's2', 's1'] as const;
export type Group = typeof GROUPS[number];
export const GROUP_LABEL: Record<string, string> = { s4: 'Stage 4+', ld: 'Leaders', s2: 'Stage 2', s1: 'Stage 1' };

export type Lane = { key: string; label: string; groups: string[] };

export function blockGroups(b: ScheduleBlock): string[] {
  const g = (b.groups || []).filter((x) => (GROUPS as readonly string[]).includes(x));
  if (g.length) return GROUPS.filter((x) => g.includes(x));
  if (b.audience === 'personal') return [];
  if (b.audience === 'leaders' || b.audience === 'core_leaders') return ['s4', 'ld'];
  if (b.audience === 'trainees') return ['s2', 's1'];
  return [...GROUPS];
}

export const isPersonal = (b: ScheduleBlock) => b.audience === 'personal';

/** Does the block happen on this date? Dated blocks once; others weekly. */
export function occursOn(b: ScheduleBlock, iso: string): boolean {
  return b.date ? b.date === iso : b.day_of_week === dowOf(iso);
}

export function isDone(b: ScheduleBlock, iso: string): boolean {
  return b.kind === 'task' && (b.done_dates || []).includes(iso);
}

/** Lanes for one day's office blocks: Stage 1 and 2 share a lane ("Stage 1/2")
 *  unless a block that day is only for one of them (Wednesday). */
export function lanesForDay(officeBlocks: ScheduleBlock[]): Lane[] {
  const split = officeBlocks.some((b) => {
    const g = blockGroups(b);
    return g.includes('s2') !== g.includes('s1');
  });
  return split
    ? [{ key: 's4', label: 'Stage 4+', groups: ['s4'] }, { key: 'ld', label: 'Leaders', groups: ['ld'] },
       { key: 's2', label: 'Stage 2', groups: ['s2'] }, { key: 's1', label: 'Stage 1', groups: ['s1'] }]
    : [{ key: 's4', label: 'Stage 4+', groups: ['s4'] }, { key: 'ld', label: 'Leaders', groups: ['ld'] },
       { key: 's12', label: 'Stage 1/2', groups: ['s2', 's1'] }];
}

export function laneOf(lanes: Lane[], group: string): number {
  return lanes.findIndex((l) => l.groups.includes(group));
}

export type Placed = { block: ScheduleBlock; start: number; end: number; left: number; width: number };

/** Office mode: each block spans the lanes it covers (first to last). */
export function placeInLanes(blocks: ScheduleBlock[], lanes: Lane[], from = 0, span = 1): Placed[] {
  const n = lanes.length;
  const out: Placed[] = [];
  for (const b of blocks) {
    const idx = blockGroups(b).map((g) => laneOf(lanes, g)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const lo = Math.min(...idx), hi = Math.max(...idx);
    const start = hhmmToMin(b.start_time) ?? 0, end = hhmmToMin(b.end_time) ?? start + 30;
    out.push({ block: b, start, end, left: from + (lo / n) * span, width: ((hi - lo + 1) / n) * span });
  }
  return out;
}

/** Google-style overlap layout: events that overlap share the width in
 *  side-by-side columns. Positions are fractions of [from, from + span]. */
export function placeOverlapping(blocks: ScheduleBlock[], from = 0, span = 1): Placed[] {
  const items = blocks
    .map((b) => {
      const start = hhmmToMin(b.start_time) ?? 0;
      return { block: b, start, end: Math.max(start + 15, hhmmToMin(b.end_time) ?? start + 30) };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed[] = [];
  let cluster: { item: typeof items[number]; col: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) {
      out.push({ ...c.item, left: from + (c.col / cols) * span, width: span / cols });
    }
    cluster = [];
  };
  for (const it of items) {
    if (it.start >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => c.item.end > it.start).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ item: it, col });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  if (cluster.length) flush();
  return out;
}

/** Readable text on a block colour. */
export function textOn(hex: string): string {
  if (!hex || !hex.startsWith('#')) return '#ffffff';
  const c = hex.length === 4 ? hex.slice(1).split('').map((x) => x + x).join('') : hex.slice(1);
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#0b211c' : '#ffffff';
}

export const REMINDER_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'None' },
  { value: 0, label: 'At start' },
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hr' },
  { value: 1440, label: '1 day' },
];

export function reminderLabel(v: number | null | undefined): string {
  if (v === undefined) return '5 min before';
  if (v === null) return 'No reminder';
  if (v === 0) return 'At the start';
  const o = REMINDER_OPTIONS.find((x) => x.value === v);
  return o ? `${o.label} before` : `${v} min before`;
}

// Office palette (the Owner's sheet) first, then brighter personal colours.
export const OFFICE_COLOURS = ['#9a7600', '#4a2c10', '#4a2236', '#1d4468', '#2a6197', '#13284f', '#4f420a', '#2c5a26', '#22d3e6', '#3d2f63'];
export const PERSONAL_COLOURS = ['#b7df58', '#4fd1c5', '#60a5fa', '#a78bfa', '#e0607e', '#e7b65c', '#f97316', '#94a3b8'];
