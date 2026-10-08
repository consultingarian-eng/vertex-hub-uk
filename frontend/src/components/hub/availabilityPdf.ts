/**
 * Team availability for a week, as a one-page PDF to print or share
 * (WhatsApp, Files, AirDrop…).
 *
 * Built from the Performance Hub view on screen: every BA down the side,
 * Monday to Sunday across the top, grouped by team with the Team Leader
 * first. A day reads IN, OUT, ABSENT or NOT SET, and the bottom row counts
 * who is in each day.
 *
 * Delivery is the app's shared exporter (utils/deliverPdf): the share sheet
 * with a real .pdf on phones and the installed app, the print dialog
 * ("Save as PDF") on a desktop browser.
 */
import { exportPdfFromHtml } from '../../utils/deliverPdf';
import { ORG_NAME } from '../../theme/brand';
import { APP_LOCALE } from '../../utils/appTime';

type Day = { date?: string; status?: string; in_field?: boolean; phase?: string };
type Row = {
  user: { id: number | string; full_name: string };
  team?: { id: number; name: string } | null;
  team_leader?: boolean;
  days: Day[];
};

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
type Cell = 'in' | 'out' | 'absent' | 'notset' | 'na';

/** What a day means for availability. */
export function availability(d?: Day): Cell {
  const s = d?.status;
  if (!d || s === 'na') return 'na';
  if (s === 'planned_in' || s === 'present') return 'in';
  if (s === 'absent') return 'absent';
  if (s === 'not_set') return d.in_field ? 'in' : 'notset';
  return 'out';   // planned_out, not_present
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dayDate = (iso: string, withMonth = false) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(APP_LOCALE, { day: 'numeric', ...(withMonth ? { month: 'short' } : {}), timeZone: 'UTC' });
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const CELL: Record<Cell, string> = {
  in: '<span class="p in">IN</span>',
  out: '<span class="p out">OUT</span>',
  absent: '<span class="p ab">ABSENT</span>',
  notset: '<span class="p ns">NOT SET</span>',
  na: '<span class="na">·</span>',
};

export function buildAvailabilityHtml(rows: Row[], weekStart: string, scopeName?: string | null): string {
  const weekEnd = addDays(weekStart, 6);
  const sameMonth = weekStart.slice(0, 7) === weekEnd.slice(0, 7);
  const range = `${dayDate(weekStart, !sameMonth)} – ${new Date(`${weekEnd}T12:00:00Z`).toLocaleDateString(APP_LOCALE, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`;

  // Group by team (in the order teams first appear, alphabetical), No Team last.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = (r.team?.name || '').trim() || 'No Team';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const names = [...groups.keys()].sort((a, b) => (a === 'No Team' ? 1 : b === 'No Team' ? -1 : a.localeCompare(b)));
  const totals = [0, 0, 0, 0, 0, 0, 0];
  let body = '';
  for (const name of names) {
    const members = groups.get(name)!.sort((a, b) => Number(!!b.team_leader) - Number(!!a.team_leader) || a.user.full_name.localeCompare(b.user.full_name));
    body += `<tr class="team"><td colspan="8"><span class="tname">${esc(name)}</span><span class="tcount">${members.length} ${members.length === 1 ? 'person' : 'people'}</span></td></tr>`;
    members.forEach((r, i) => {
      const cells = DAYS.map((_, d) => {
        const c = availability(r.days?.[d]);
        if (c === 'in') totals[d] += 1;
        return `<td class="c">${CELL[c]}</td>`;
      }).join('');
      body += `<tr class="${i % 2 ? 'alt' : ''}"><td class="n">${esc(r.user.full_name)}${r.team_leader ? '<span class="lead">Team Leader</span>' : ''}</td>${cells}</tr>`;
    });
  }
  const head = DAYS.map((d, i) => `<th><div class="d">${d}</div><div class="dt">${dayDate(addDays(weekStart, i))}</div></th>`).join('');
  const foot = totals.map((n) => `<td class="c tot">${n}</td>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #ffffff; color: #17362b; font-family: 'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; }
.page { width: 595pt; padding: 22pt 24pt 18pt; }
.hero { background: #102d25; border-radius: 12pt; padding: 16pt 18pt; color: #f0f4e9; display: flex; align-items: flex-end; justify-content: space-between; }
.org { font-family: 'JetBrainsMono', monospace; font-size: 7.5pt; letter-spacing: 2pt; text-transform: uppercase; color: #b7df58; }
.title { font-family: 'Unbounded-SemiBold', 'Inter', sans-serif; font-size: 19pt; line-height: 23pt; margin-top: 5pt; letter-spacing: -0.3pt; }
.sub { font-size: 9pt; color: #b5c8b2; margin-top: 3pt; }
.week { text-align: right; }
.week .k { font-family: 'JetBrainsMono', monospace; font-size: 7pt; letter-spacing: 1.6pt; text-transform: uppercase; color: #b5c8b2; }
.week .v { font-family: 'Unbounded-SemiBold', 'Inter', sans-serif; font-size: 11.5pt; color: #b7df58; margin-top: 4pt; white-space: nowrap; }
table { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 12pt; }
th { background: #102d25; color: #f0f4e9; padding: 6pt 0 5pt; font-weight: 600; }
th:first-child { text-align: left; padding-left: 10pt; border-radius: 8pt 0 0 8pt; font-family: 'JetBrainsMono', monospace; font-size: 7pt; letter-spacing: 1.4pt; text-transform: uppercase; color: #b5c8b2; }
th:last-child { border-radius: 0 8pt 8pt 0; }
th .d { font-family: 'Unbounded-SemiBold', 'Inter', sans-serif; font-size: 8pt; letter-spacing: 0.4pt; text-transform: uppercase; }
th .dt { font-family: 'JetBrainsMono', monospace; font-size: 7pt; color: #b7df58; margin-top: 1pt; }
td { padding: 3.2pt 0; font-size: 8.6pt; border-bottom: 0.6pt solid #e3eadb; }
td.n { padding-left: 10pt; font-weight: 600; white-space: nowrap; overflow: hidden; max-width: 190pt; }
td.c { text-align: center; width: 52pt; }
tr.alt td { background: #f6f9f1; }
tr.team td { background: #eaf3d3; border-bottom: 0; padding: 4.5pt 10pt; border-radius: 6pt; }
tr.team .tname { font-family: 'Unbounded-SemiBold', 'Inter', sans-serif; font-size: 7.8pt; letter-spacing: 0.6pt; text-transform: uppercase; color: #102d25; }
tr.team .tcount { font-family: 'JetBrainsMono', monospace; font-size: 7pt; color: #4a6b58; margin-left: 8pt; }
.lead { font-size: 6.2pt; font-weight: 700; color: #102d25; background: #b7df58; border-radius: 99pt; padding: 1pt 5pt; margin-left: 6pt; vertical-align: 1pt; letter-spacing: 0.2pt; }
.p { display: inline-block; min-width: 40pt; padding: 2.2pt 0; border-radius: 99pt; font-size: 6.6pt; font-weight: 700; letter-spacing: 0.5pt; }
.in { background: #1f7a4d; color: #ffffff; }
.out { background: #eef1ea; color: #8a9a8f; }
.ab { background: #fde2e2; color: #b42318; }
.ns { background: #fff3d6; color: #9a6700; }
.na { color: #c3cdc3; }
tr.total td { border-bottom: 0; padding-top: 7pt; }
tr.total td.n { font-family: 'JetBrainsMono', monospace; font-size: 7.2pt; letter-spacing: 1.4pt; text-transform: uppercase; color: #4a6b58; font-weight: 400; }
td.tot { font-family: 'Unbounded-SemiBold', 'Inter', sans-serif; font-size: 12pt; color: #102d25; }
.key { display: flex; align-items: center; gap: 10pt; margin-top: 10pt; font-size: 7.4pt; color: #4a6b58; }
.key .p { min-width: 34pt; text-align: center; }
.key .sp { flex: 1; }
</style></head><body><div class="page">
  <div class="hero">
    <div>
      <div class="org">${esc(ORG_NAME)}</div>
      <div class="title">Team availability</div>
      <div class="sub">${esc(scopeName ? `${scopeName} · ` : '')}${rows.length} ${rows.length === 1 ? 'person' : 'people'} · who is in each day</div>
    </div>
    <div class="week"><div class="k">Week</div><div class="v">${esc(range)}</div></div>
  </div>
  <table>
    <thead><tr><th>Name</th>${head}</tr></thead>
    <tbody>${body}<tr class="total"><td class="n">In the field</td>${foot}</tr></tbody>
  </table>
  <div class="key">
    ${CELL.in} planned in ${CELL.out} planned out ${CELL.absent} planned in, did not go out ${CELL.notset} no plan set
    <span class="sp"></span><span>From Field IQ · ${esc(new Date().toLocaleDateString(APP_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }))}</span>
  </div>
</div></body></html>`;
}

/** Build the page and hand it to the share sheet / print dialog. */
export async function shareAvailability(rows: Row[], weekStart: string, scopeName?: string | null): Promise<void> {
  const html = buildAvailabilityHtml(rows, weekStart, scopeName);
  const weekEnd = addDays(weekStart, 6);
  await exportPdfFromHtml(html, {
    filename: `availability-week-ending-${weekEnd}.pdf`,
    dialogTitle: `Team availability · week ending ${dayDate(weekEnd, true)}`,
    width: 595,
    height: 842,
    imageAsPdf: true,
  });
}
