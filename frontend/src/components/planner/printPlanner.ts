/**
 * Monthly Planner — Print/PDF helper.
 *
 * Builds a print-ready HTML document from the live planner draft and uses
 * expo-print + expo-sharing to either spawn the device's print sheet (web)
 * or generate a PDF and trigger the native share sheet (iOS/Android).
 *
 * Layout target: A4, 14pt body, sectioned (Header → Goals → Targets →
 * Monthly Planning → Learning → Budget → SWOT → Gap Analysis). Mirrors the
 * on-screen sections so coaches can review printed copies that match the app.
 */
import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { APP_LOCALE, formatMoney } from '../../utils/appTime';

// ── Helpers ──────────────────────────────────────────────────────────────
const escapeHtml = (s: any): string =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const nl2br = (s: any): string => escapeHtml(s).replaceAll('\n', '<br/>');

const fmtMoney = (n: any): string => {
  const v = Number(n);
  if (!isFinite(v) || v === 0) return '—';
  return formatMoney(v);
};

const fmtNum = (n: any): string => {
  const v = Number(n);
  if (!isFinite(v) || v === 0) return '—';
  return v.toLocaleString(APP_LOCALE);
};

const prettyMonth = (m: string): string => {
  if (!m) return '';
  const [y, mm] = m.split('-').map(Number);
  return new Date(y, mm - 1, 1).toLocaleString(APP_LOCALE, { month: 'long', year: 'numeric' });
};

// ── HTML section builders ────────────────────────────────────────────────
const goalCell = (label: string, value: string) => `
  <div class="goal-cell">
    <div class="goal-label">${escapeHtml(label)}</div>
    <div class="goal-value">${value ? nl2br(value) : '<span class="muted">—</span>'}</div>
  </div>
`;

// v2 goals (structured KPIs + Rocks). Legacy planners use the 6-cell grid.
const HORIZON_PDF: Record<string, string> = { short: '1 mo', medium: '3 mo', long: '6 mo' };

const goalsV2Html = (goals: any): string => {
  const kpiBody = (goals.kpis || []).filter((k: any) => k && k.name).map((k: any) => `
    <tr>
      <td>${escapeHtml(k.name)}</td>
      <td class="r">${k.target ? escapeHtml(String(k.target)) : '—'}</td>
      <td>${HORIZON_PDF[k.horizon] || '1 mo'}</td>
      <td>${k.reward ? escapeHtml(k.reward) : '—'}</td>
    </tr>`).join('');
  const rockBody = (goals.rocks || []).filter((r: any) => r && r.name).map((r: any) => `
    <tr>
      <td class="ck">${r.done ? '✓' : '·'}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${HORIZON_PDF[r.horizon] || '1 mo'}</td>
      <td>${r.reward ? escapeHtml(r.reward) : '—'}</td>
    </tr>`).join('');
  const kpiTable = kpiBody ? `
    <div class="subsection">
      <h3>KPIs — the numbers</h3>
      <table class="data">
        <thead><tr><th>KPI</th><th class="r">Target</th><th>By</th><th>Reward</th></tr></thead>
        <tbody>${kpiBody}</tbody>
      </table>
    </div>` : '';
  const rockTable = rockBody ? `
    <div class="subsection">
      <h3>Rocks — did I / didn't I</h3>
      <table class="data">
        <thead><tr><th class="ck">Done</th><th>Rock</th><th>By</th><th>Reward</th></tr></thead>
        <tbody>${rockBody}</tbody>
      </table>
    </div>` : '';
  const visionHtml = goals.vision
    ? `<div class="subsection"><h3>6-Month Vision</h3><div class="goal-value">${nl2br(goals.vision)}</div></div>`
    : '';
  const inner = kpiTable + rockTable + visionHtml;
  return `
    <section>
      <h2>Goals</h2>
      ${inner || '<div class="goal-value"><span class="muted">No goals set.</span></div>'}
    </section>`;
};

const planningTable = (title: string, rows: any[]) => {
  const body = (rows || []).filter((r) => r && (r.topic || r.who || r.when))
    .map((r) => `
      <tr>
        <td>${escapeHtml(r.topic || '')}</td>
        <td>${escapeHtml(r.who || '')}</td>
        <td>${escapeHtml(r.when || '')}</td>
        <td class="ck">${r.completed ? '✓' : '·'}</td>
      </tr>`).join('');
  if (!body) return '';
  return `
    <div class="subsection">
      <h3>${escapeHtml(title)}</h3>
      <table class="data">
        <thead><tr><th>Topic / Action</th><th>Who</th><th>When</th><th class="ck">Done</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
};

const budgetTable = (title: string, rows: any[]) => {
  const items = (rows || []).filter((r) => r && (r.label || r.amount));
  if (!items.length) return '';
  const total = items.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);
  const body = items.map((r) => `
    <tr>
      <td>${escapeHtml(r.label || '')}</td>
      <td class="r">${fmtMoney(r.amount)}</td>
      <td class="r">${fmtNum(r.sales)}</td>
    </tr>`).join('');
  return `
    <div class="subsection">
      <h3>${escapeHtml(title)}</h3>
      <table class="data">
        <thead><tr><th>Line item</th><th class="r">Amount</th><th class="r">Sign-ups</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td><strong>Total</strong></td><td class="r"><strong>${fmtMoney(total)}</strong></td><td></td></tr></tfoot>
      </table>
    </div>`;
};

const swotQuadrant = (label: string, value: string, helpful: boolean) => `
  <div class="swot-cell ${helpful ? 'helpful' : 'unhelpful'}">
    <div class="swot-label">${escapeHtml(label)}</div>
    <div class="swot-value">${value ? nl2br(value) : '<span class="muted">—</span>'}</div>
  </div>
`;

// ── Main HTML builder ────────────────────────────────────────────────────
export interface PlannerHtmlOpts {
  ownerName: string;
  month: string;        // YYYY-MM
  draft: any;           // shape from /api/monthly-planners/{month}
  traits: string[];     // gap analysis trait list (rendered as score table)
  showGap: boolean;     // hide for trainees
}

export function buildPlannerHtml({ ownerName, month, draft, traits, showGap }: PlannerHtmlOpts): string {
  const goals = draft?.goals || {};
  const planning = draft?.monthly_planning || {};
  const learning = draft?.learning || {};
  const budget = draft?.budget || {};
  const swot = draft?.swot || {};
  const gapScores = draft?.gap_analysis?.scores || {};
  const targets = draft?.targets || {};
  const today = new Date().toLocaleDateString(APP_LOCALE, { month: 'long', day: 'numeric', year: 'numeric' });

  const goalsIsV2 = goals && (goals.version === 2 || Array.isArray(goals.kpis));
  const goalsHtml = goalsIsV2 ? goalsV2Html(goals) : `
    <section>
      <h2>Goals</h2>
      <div class="goal-grid">
        ${goalCell('Short Term · Business', goals.short_business)}
        ${goalCell('Short Term · Personal', goals.short_personal)}
        ${goalCell('Medium Term · Business', goals.medium_business)}
        ${goalCell('Medium Term · Personal', goals.medium_personal)}
        ${goalCell('Long Term · Business', goals.long_business)}
        ${goalCell('Long Term · Personal', goals.long_personal)}
      </div>
    </section>`;

  const targetsHtml = (Number(targets.monthly_sales) > 0 || Number(targets.personal_best) > 0) ? `
    <section>
      <h2>Targets</h2>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Monthly Sales Focus</div><div class="kpi-value">${fmtNum(targets.monthly_sales)}</div></div>
        <div class="kpi"><div class="kpi-label">Personal Best Target</div><div class="kpi-value">${fmtNum(targets.personal_best)}</div></div>
      </div>
    </section>` : '';

  const salesImpacts = planning.sales_impacts || {};
  const planningHtml = `
    <section>
      <h2>Monthly Planning</h2>
      ${(salesImpacts.coach_others || salesImpacts.still_to_master) ? `
        <div class="subsection">
          <h3>Sales Impacts</h3>
          <div class="goal-grid">
            ${goalCell('I can coach others on…', salesImpacts.coach_others)}
            ${goalCell('Still to master…', salesImpacts.still_to_master)}
          </div>
        </div>` : ''}
      ${planningTable('Development', planning.development)}
      ${planningTable('Recruitment', planning.recruitment)}
      ${planningTable('Networking', planning.networking)}
    </section>`;

  const learningItems = (learning.items || []).filter((it: any) => it && (it.topic || it.mentor || it.notes));
  const learningHtml = (learning.summary || learningItems.length) ? `
    <section>
      <h2>What I'm learning &amp; who from</h2>
      ${learning.summary ? `<p>${nl2br(learning.summary)}</p>` : ''}
      ${learningItems.length ? `
        <table class="data">
          <thead><tr><th>Topic</th><th>Mentor</th><th>Notes</th></tr></thead>
          <tbody>
            ${learningItems.map((it: any) => `
              <tr>
                <td>${escapeHtml(it.topic || '')}</td>
                <td>${escapeHtml(it.mentor || '')}</td>
                <td>${escapeHtml(it.notes || '')}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : ''}
    </section>` : '';

  const budgetHtml = `
    <section>
      <h2>Budget Calculator</h2>
      ${budget.sale_value ? `<p class="meta">Sign-up value: <strong>${fmtMoney(budget.sale_value)}</strong></p>` : ''}
      ${budgetTable('Needs', budget.needs)}
      ${budgetTable('Wants', budget.wants)}
      ${(Number(budget.total_sales_required) > 0) ? `
        <div class="kpi-row">
          <div class="kpi big">
            <div class="kpi-label">Total sign-ups required</div>
            <div class="kpi-value">${fmtNum(budget.total_sales_required)}</div>
          </div>
        </div>` : ''}
    </section>`;

  const swotHtml = `
    <section>
      <h2>SWOT</h2>
      <div class="swot-grid">
        ${swotQuadrant('Strengths', swot.strengths, true)}
        ${swotQuadrant('Weaknesses', swot.weaknesses, false)}
        ${swotQuadrant('Opportunities', swot.opportunities, true)}
        ${swotQuadrant('Threats', swot.threats, false)}
      </div>
    </section>`;

  const gapRows = (traits || []).map((t) => {
    const score = Number(gapScores[t] || 0);
    const filled = '●'.repeat(score) + '○'.repeat(Math.max(0, 5 - score));
    return `
      <tr>
        <td>${escapeHtml(t)}</td>
        <td class="dots">${filled}</td>
        <td class="r">${score || '—'}</td>
      </tr>`;
  }).join('');
  const gapHtml = (showGap && traits && traits.length) ? `
    <section class="page-break">
      <h2>Gap Analysis</h2>
      <table class="data">
        <thead><tr><th>Trait</th><th>Score (1-5)</th><th class="r">#</th></tr></thead>
        <tbody>${gapRows}</tbody>
      </table>
    </section>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Monthly Planner — ${escapeHtml(ownerName)} — ${escapeHtml(prettyMonth(month))}</title>
  <style>
    @page { size: A4; margin: 14mm 14mm 18mm 14mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #050F0C; font-size: 11.5pt; line-height: 1.45; }
    header { border-bottom: 2px solid #2F6A4B; padding-bottom: 10px; margin-bottom: 18px; }
    header .h-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
    header h1 { font-size: 20pt; margin: 0; color: #050F0C; }
    header .month { font-size: 11pt; color: #3D5446; font-weight: 600; }
    header .printed { font-size: 9pt; color: #6B8070; text-align: right; }
    h2 { font-size: 13pt; margin: 18px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #DDE7D4; color: #050F0C; }
    h3 { font-size: 11pt; margin: 12px 0 6px; color: #234435; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    section { break-inside: avoid; }
    .page-break { break-before: page; }
    .muted { color: #6B8070; }
    .meta { font-size: 10pt; color: #3D5446; margin: 0 0 8px; }
    .goal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .goal-cell { border: 1px solid #DDE7D4; border-radius: 8px; padding: 10px 12px; background: #F7FAF1; min-height: 60px; }
    .goal-label { font-size: 9.5pt; color: #6B8070; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
    .goal-value { font-size: 11pt; color: #050F0C; }
    .subsection { margin-top: 8px; }
    table.data { width: 100%; border-collapse: collapse; margin-top: 4px; }
    table.data th, table.data td { border: 1px solid #DDE7D4; padding: 6px 8px; text-align: left; vertical-align: top; }
    table.data th { background: #F7FAF1; font-size: 9.5pt; color: #3D5446; text-transform: uppercase; letter-spacing: .04em; }
    table.data tfoot td { background: #EDF3E4; }
    table.data .r { text-align: right; }
    table.data .ck { text-align: center; width: 50px; }
    table.data .dots { font-family: -apple-system, "Helvetica Neue", monospace; letter-spacing: 2px; color: #2F6A4B; width: 100px; }
    .kpi-row { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
    .kpi { flex: 1; min-width: 170px; border: 1px solid #DDE7D4; border-radius: 10px; padding: 10px 14px; background: #F7FAF1; }
    .kpi.big { flex: 1; background: #f2f6e9; border-color: #aec879; }
    .kpi-label { font-size: 9.5pt; color: #6B8070; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .kpi-value { font-size: 22pt; font-weight: 800; color: #050F0C; font-variant-numeric: tabular-nums; }
    .swot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .swot-cell { border-radius: 8px; padding: 10px 12px; min-height: 80px; }
    .swot-cell.helpful { background: #ecfdf5; border: 1px solid #a7f3d0; }
    .swot-cell.unhelpful { background: #fef2f2; border: 1px solid #fecaca; }
    .swot-label { font-size: 10pt; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; color: #050F0C; }
    .swot-value { font-size: 10.5pt; color: #102D25; }
    p { margin: 0 0 8px; }
  </style>
</head>
<body>
  <header>
    <div class="h-row">
      <div>
        <h1>${escapeHtml(ownerName)}</h1>
        <div class="month">${escapeHtml(prettyMonth(month))} · Monthly Goal Planner</div>
      </div>
      <div class="printed">Printed ${escapeHtml(today)}</div>
    </div>
  </header>

  ${goalsHtml}
  ${targetsHtml}
  ${planningHtml}
  ${learningHtml}
  ${budgetHtml}
  ${swotHtml}
  ${gapHtml}
</body>
</html>`;
}

// ── Public: trigger Print/Share PDF ───────────────────────────────────────
export async function printOrSharePlanner(opts: PlannerHtmlOpts): Promise<void> {
  const html = buildPlannerHtml(opts);
  const fileName = `Monthly_Planner_${opts.ownerName.replaceAll(/\s+/g, '_')}_${opts.month}`;

  if (Platform.OS === 'web') {
    // On web, expo-print falls back to window.print(); easier: open a tab w/ the HTML.
    try {
      // Use printAsync — on web it writes the HTML into a hidden iframe and calls .print()
      await Print.printAsync({ html });
      return;
    } catch {
      // Last-ditch fallback for web — pop the HTML into a new window.
      try {
        const w = window.open('', '_blank');
        if (w) {
          w.document.write(html);
          w.document.close();
          // Don't auto-print — let the user choose; they can hit Cmd/Ctrl+P.
        }
      } catch {/* swallow — caller toasts */}
      return;
    }
  }

  // Native: produce PDF, then push through the share sheet.
  const { uri } = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) {
    // ⚠️ iOS quirk: Sharing.shareAsync's Promise can stay pending forever
    // when the user cancels the share sheet. Return as soon as we hand off
    // so the caller's busy-state machinery never gets stuck. Silently
    // swallow — cancel is not a failure.
    Sharing.shareAsync(uri, {
      UTI: 'com.adobe.pdf',
      mimeType: 'application/pdf',
      dialogTitle: `Share ${fileName}`,
    }).catch(() => {});
  } else {
    // Fall back to the native print dialog.
    await Print.printAsync({ uri }).catch(() => {});
  }
}
