import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { showAlert } from '../../utils/showAlert';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Modal, Pressable, TextInput } from 'react-native';
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from 'react-native-draggable-flatlist';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { exportPdfFromHtml, openBlankPrintWindow } from '../../utils/deliverPdf';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../../theme/colors';
import { lightColors } from '../../theme/ThemeContext';
import { GRADIENT, useColors, useTheme } from '../../theme/ThemeContext';
import { DepthCard } from '../ui/DepthCard';
import { apiService } from '../../api/client';
import { useActiveOffice } from '../../office/ActiveOfficeContext';
import { toast } from '../../utils/toast';
import { APP_LOCALE } from '../../utils/appTime';

// ──────────────────────────────────────────────────────────────────────────
// Read-only "Excel-like" weekly plan view shown to Leaders (and as a
// preview to Admins). Themes are surfaced as a clean card-grid up top, then
// the plan body renders as a true day-by-day grid with a sticky label
// column + horizontally-scrollable day columns. Each day column is gently
// color-coded to make scanning the week easy.
// ──────────────────────────────────────────────────────────────────────────

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Soft pastel fills + slightly stronger borders per day for a colorful but
// professional look (and to differentiate columns when scrolled side-to-side)
const DAY_TINTS = ['#fef3c7', '#e0f2fe', '#dcfce7', '#eef5dc', '#ccfbf1', '#fee2e2'];
// Dark theme: the same hues as translucent washes over the raised card face,
// so the header row still reads as six distinct columns without six bright
// paper islands on the abyss.
// Alphas are capped so the day label (colors.text) still measures >=7:1 on
// every wash — the amber and green stops are the tight ones.
const DAY_TINTS_DARK = [
  'rgba(245,158,11,0.13)', 'rgba(14,165,233,0.18)', 'rgba(34,197,94,0.16)',
  'rgba(140,175,56,0.20)', 'rgba(20,184,166,0.18)', 'rgba(239,68,68,0.18)',
];
const DAY_BARS = ['#f59e0b', '#0ea5e9', '#22c55e', '#8caf38', '#14b8a6', '#ef4444'];
/** Today's column (0 = Mon … 5 = Sat), or -1 when the shown week isn't this one. */
function todayColumn(weekEnding?: string): number {
  const d = new Date();
  const dow = d.getDay();               // 0 = Sun … 6 = Sat
  if (dow === 0) return -1;             // Sunday isn't a column
  if (weekEnding) {
    // The plan's week ends on the upcoming Sunday — compare with ours.
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + ((7 - dow) % 7));
    const iso = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    if (iso !== weekEnding) return -1;
  }
  return dow - 1;
}
/** Spec §4 P1 schedule — the today column wears a lime wash, never lime text. */
const TODAY_TINT = 'rgba(183,223,88,0.10)';
/**
 * Dark theme only: today's HEADER cell takes the lime wash INSTEAD of its day
 * tint rather than on top of it — stacking both drops the day label under the
 * 7:1 the frozen header row has to hold.
 */
const TODAY_TINT_HEAD_DARK = 'rgba(183,223,88,0.13)';

const THEME_FIELDS: { key: string; label: string; icon: any; color: string }[] = [
  { key: 'expectations_1',         label: 'Expectations · 1',       icon: 'person-circle',  color: '#0ea5e9' },
  { key: 'expectations_2',         label: 'Expectations · 2',       icon: 'person-circle',  color: '#06b6d4' },
  { key: 'leaders',                label: 'Coaches Theme',          icon: 'star',           color: '#2F6A4B' },
  { key: 'topic_theme',            label: 'Topic Theme',            icon: 'bulb',           color: '#f59e0b' },
  { key: 'customer_service_theme', label: 'Customer Service',       icon: 'heart',          color: '#e0607e' },
  { key: 'competition',            label: 'Competition',            icon: 'trophy',         color: '#dc2626' },
  { key: 'concentration',          label: 'Concentration',          icon: 'flame',          color: '#f97316' },
  { key: 'news',                   label: 'News',                   icon: 'newspaper',      color: '#0284c7' },
  { key: 'social',                 label: 'Social',                 icon: 'happy',          color: '#8caf38' },
];

const STATS_FIELDS: { key: string; label: string; icon: any; color: string }[] = [
  { key: 'weekly_goal',       label: 'Weekly Goal',       icon: 'flag',               color: '#ef4444' },
  { key: 'promotions',        label: 'Advancements',      icon: 'rocket-outline',     color: '#8caf38' },
  { key: 'personal_recruits', label: 'Personal Recruits', icon: 'person-add-outline', color: '#22c55e' },
];

const COL_WIDTH = 124;
const LABEL_COL_WIDTH = 102;

type Cell = { day: number; topic: string; presenter: string };
type Row = { id: string; label: string; time_label: string; cells: Cell[] };
type Themes = Record<string, string>;
type Stats = Record<string, string>;

export default function WeeklyPlanGridView({
  themes,
  stats,
  rows,
  weekEnding,
  isAdmin = false,
}: {
  themes: Themes;
  stats?: Stats;
  rows: Row[];
  weekEnding?: string;
  isAdmin?: boolean;
}) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const dayTints = isDark ? DAY_TINTS_DARK : DAY_TINTS;
  const todayCol = todayColumn(weekEnding);
  const queryClient = useQueryClient();
  // Read from the office the Schedule tab is currently showing rather than
  // the viewer's own, so a super admin browsing office B sees office B's
  // bells and row layout. Taken from context rather than a prop because the
  // nested Manage Rows sheet writes row config too and would otherwise need
  // it threaded down.
  const { officeId } = useActiveOffice();
  // Zoom factor for the grid. Allows leaders to scale the table up/down for
  // readability without breaking the layout. Steps: 70% / 85% / 100% / 115% / 130%.
  const ZOOM_STEPS = [0.7, 0.85, 1.0, 1.15, 1.3];
  const [zoomIdx, setZoomIdx] = useState(2); // 1.0×
  const zoom = ZOOM_STEPS[zoomIdx];
  const [pdfBusy, setPdfBusy] = useState(false);
  const [showManageRows, setShowManageRows] = useState(false);
  // Measured per-row heights so the left label column can sync to the
  // tallest data cell in the same row. Prevents visual row drift when one
  // day has a wrapped topic/presenter longer than the default 48pt.
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({});

  // Live office sales count for this week — drives the "goal vs actual"
  // annotation on the Weekly Goal tile. Reuses the same query key as the
  // Bells screen so both views share one cached result.
  const bellsQ = useQuery({
    queryKey: ['bells', weekEnding, officeId],
    queryFn: () => apiService.listBells(weekEnding, officeId).then((r) => r.data),
    enabled: !!weekEnding,
    staleTime: 1000 * 30,
  });
  const weekSales: number | null = bellsQ.data?.office_totals?.total_sales ?? null;

  // Per-office row configuration (order + hidden) — drives both the on-screen
  // ordering and the PDF export. Shared cache key so the Manage Rows modal
  // can write-through and all views update together.
  const rowConfigQ = useQuery({
    queryKey: ['agenda', 'row-config', officeId],
    queryFn: () => apiService.getAgendaRowConfig(officeId).then((r) => r.data),
    staleTime: 1000 * 30,
  });
  const rowConfig = rowConfigQ.data as { row_order: string[]; hidden_rows: string[] } | undefined;

  const filledThemes = THEME_FIELDS.filter((f) => (themes?.[f.key] || '').trim());
  // Always render the weekly_goal tile (even if empty) so the live bells
  // count has a home. Other stats (promotions, recruits) only render when
  // the admin has actually filled them in.
  const filledStats = STATS_FIELDS.filter((s) => s.key === 'weekly_goal' || ((stats?.[s.key] ?? '') + '').trim());
  // Visible rows pipeline:
  //   1. Drop rows with blank labels (always).
  //   2. Drop rows whose label slug is in hidden_rows (admin-configured).
  //   3. Sort by row_order (admin-configured). Unlisted rows fall back to
  //      their schedule-driven incoming order (stable) at the end.
  // Slugs are lowercase-trimmed labels so label-case changes don't break.
  const visibleRows = useMemo(() => {
    const slug = (s: string) => (s || '').trim().toLowerCase();
    const hiddenSet = new Set((rowConfig?.hidden_rows || []).map(slug));
    const orderList = (rowConfig?.row_order || []).map(slug);
    const orderIdx = new Map<string, number>();
    orderList.forEach((k, i) => orderIdx.set(k, i));
    const labelled = rows.filter((r) => slug(r.label));
    const shown = labelled.filter((r) => !hiddenSet.has(slug(r.label)));
    // Stable sort by (orderIdx[slug] if known else Infinity, original index).
    return shown
      .map((r, i) => ({ r, i, idx: orderIdx.has(slug(r.label)) ? (orderIdx.get(slug(r.label)) as number) : Number.POSITIVE_INFINITY }))
      .sort((a, b) => (a.idx - b.idx) || (a.i - b.i))
      .map(({ r }) => r);
  }, [rows, rowConfig]);

  // Parse goal for %-to-goal annotation
  const weeklyGoalRaw = (stats?.weekly_goal ?? '').toString().trim();
  const weeklyGoalNum = (() => {
    const m = weeklyGoalRaw.match(/\d[\d,]*/);
    if (!m) return null;
    const n = parseInt(m[0].replace(/,/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const pctToGoal = (weeklyGoalNum && weekSales != null)
    ? Math.round((weekSales / weeklyGoalNum) * 100)
    : null;
  const hitGoal = pctToGoal != null && pctToGoal >= 100;

  // ── PDF EXPORT ─ Build a print-ready A4-landscape HTML version of the
  // weekly plan and hand it to expo-print. Mirrors the paper template:
  // a top "themes + stats" block, then a 6-day grid below with the same
  // category rows the leader sees on screen.
  const exportPdf = async () => {
    const printWin = openBlankPrintWindow(); // sync, before any await (iOS popup blocker)
    try {
      setPdfBusy(true);
      const escape = (s: string) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const themeRowsHtml = THEME_FIELDS.map((f) => {
        const v = (themes?.[f.key] || '').trim();
        return `<tr>
          <td class="th-label">${escape(f.label.toUpperCase())}</td>
          <td class="th-val">${escape(v)}</td>
        </tr>`;
      }).join('');
      const statsHtml = STATS_FIELDS.map((s) => {
        const v = (stats?.[s.key] ?? '').toString().trim();
        return `<div class="stat-row">
          <span class="stat-label">${escape(s.label)}:</span>
          <span class="stat-val">${escape(v) || '<span class="muted">—</span>'}</span>
        </div>`;
      }).join('');
      const dayHeaderHtml = DAY_LABELS.map((d, i) =>
        `<th class="day-h" style="background:${DAY_TINTS[i]};border-bottom:3px solid ${DAY_BARS[i]}">${escape(d.toUpperCase())}DAY</th>`,
      ).join('');
      const gridRowsHtml = visibleRows.map((row) => {
        const labelTrim = (row.label || '').trim().toLowerCase();
        const cellsHtml = DAY_LABELS.map((_, di) => {
          const cell = row.cells.find((c) => c.day === di);
          const presenter = (cell?.presenter || '').trim();
          const topic = (cell?.topic || '').trim();
          // Suppress topic if it just repeats the row label
          const topicIsDup = !!topic && topic.toLowerCase() === labelTrim;
          return `<td class="cell">
            ${presenter ? `<div class="pres">${escape(presenter)}</div>` : ''}
            ${topic && !topicIsDup ? `<div class="topic">${escape(topic)}</div>` : ''}
          </td>`;
        }).join('');
        return `<tr>
          <td class="row-label">${escape((row.label || '').toUpperCase())}</td>
          ${cellsHtml}
        </tr>`;
      }).join('');
      const weekLabel = weekEnding ? new Date(weekEnding + 'T00:00:00').toLocaleDateString(APP_LOCALE, {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      }) : '';
      // ── Dynamic single-page fit ────────────────────────────────────────
      // As leaders add more schedule rows, the grid was previously spilling
      // onto page 2. Pre-compute a per-row budget (cell height + padding +
      // border) that fits within the A4-landscape content area, no matter
      // how many rows the team throws at it. All numbers are in PDF points.
      //
      // A4 landscape is 842×595pt. With 7mm (~20pt) top/bottom margins we
      // get ~555pt of usable vertical space. Reserve ~195pt for heading +
      // themes/stats top-row + grid thead + footer + sub-title, leaving
      // ~360pt for the grid body. Each rendered row takes cellHeightPt +
      // 2*cellPadYPt + ~0.5pt border, so we subtract those from the budget
      // to derive the real cell height and clamp within sane bounds.
      const rowCount = Math.max(1, visibleRows.length);
      const availableForRowsPt = 360;
      const perRowBudgetPt = availableForRowsPt / rowCount;
      // Squeeze mode tightens padding + font size when rows are numerous.
      const squeeze = perRowBudgetPt < 25;
      const cellPadYPt = squeeze ? 1.2 : 2.5;
      const cellPadXPt = squeeze ? 3 : 4;
      const cellHeightPt = Math.max(10, Math.min(28, perRowBudgetPt - 2 * cellPadYPt - 0.5));
      const presFontPt = squeeze ? 7.2 : 8.5;
      const topicFontPt = squeeze ? 6 : 7;
      const rowLabelFontPt = squeeze ? 6.5 : 7.5;

      const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  /* Force single-page landscape A4. iOS ignores @page but still respects
     the width/height passed to printToFileAsync below, AND the sizing
     rules inside html/body. We combine: (a) tighter @page margins for
     Android/Chrome, (b) dynamic row-scaled spacing (see rowCount-derived
     cellHeightPt above) so the grid stays single-page no matter how many
     schedule rows are added, (c) page-break-inside rules so no row ever
     bleeds into a second page, and (d) html+body height pinned to A4
     landscape content area so the renderer clips rather than paginates. */
  @page { size: A4 landscape; margin: 7mm; }
  /* Hard height constraint applies in BOTH @media print AND iOS's inline
     HTML-to-PDF renderer (which doesn't always trigger @media print). Any
     overflow is clipped rather than paginated to a 2nd sheet. */
  html, body { width: 283mm; height: 196mm; max-height: 196mm; overflow: hidden; margin: 0; padding: 0; }
  @media print {
    table, tr, td, tbody, thead { page-break-inside: avoid !important; break-inside: avoid !important; }
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; color: #050F0C; }
  h1 { font-size: 14pt; margin: 0 0 1pt 0; letter-spacing: 0.5pt; }
  .week-sub { font-size: 8.5pt; color: #6b7280; margin-bottom: 6pt; }
  .top-row { display: flex; gap: 10pt; margin-bottom: 6pt; }
  .themes { flex: 2; border: 1pt solid #102D25; }
  .themes table { width: 100%; border-collapse: collapse; }
  .themes td { border: 0.5pt solid #102D25; padding: 2.5pt 6pt; font-size: 8pt; }
  .th-label { width: 30%; font-weight: 800; letter-spacing: 0.3pt; background: #EDF3E4; text-transform: uppercase; }
  .th-val { font-weight: 600; }
  .stats { flex: 1; border: 1pt solid #102D25; padding: 5pt 8pt; }
  .stats h3 { margin: 0 0 3pt 0; font-size: 8.5pt; letter-spacing: 0.5pt; text-transform: uppercase; color: #102D25; }
  .stat-row { display: flex; justify-content: space-between; padding: 2pt 0; border-bottom: 0.5pt solid #BED393; font-size: 8pt; }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { font-weight: 700; }
  .stat-val { font-weight: 800; }
  .muted { color: #6B8070; }
  table.grid { width: 100%; border-collapse: collapse; border: 1pt solid #102D25; table-layout: fixed; }
  table.grid th, table.grid td { border: 0.5pt solid #102D25; padding: ${cellPadYPt}pt ${cellPadXPt}pt; vertical-align: top; }
  table.grid th { background: #102D25; color: #fff; font-size: 8pt; font-weight: 800; letter-spacing: 0.4pt; text-align: center; }
  .day-h { color: #050F0C !important; }
  .row-label { width: 85pt; font-size: ${rowLabelFontPt}pt; font-weight: 800; letter-spacing: 0.3pt; text-transform: uppercase; background: #F7FAF1; }
  .cell { height: ${cellHeightPt}pt; font-size: 8pt; overflow: hidden; }
  .pres { font-weight: 800; font-size: ${presFontPt}pt; line-height: 1.1; ${squeeze ? 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' : ''} }
  .topic { font-size: ${topicFontPt}pt; font-style: italic; color: #3D5446; margin-top: 1pt; line-height: 1.1; ${squeeze ? 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' : ''} }
  .footer { font-size: 7pt; color: #6B8070; margin-top: 4pt; text-align: right; }
</style></head>
<body>
  <h1>Weekly Plan</h1>
  ${weekLabel ? `<div class="week-sub">Week ending ${escape(weekLabel)}</div>` : ''}
  <div class="top-row">
    <div class="themes">
      <table><tbody>${themeRowsHtml}</tbody></table>
    </div>
    <div class="stats">
      <h3>This Week</h3>
      ${statsHtml}
      ${weekSales != null ? `<div class="stat-row"><span class="stat-label">Bells so far:</span><span class="stat-val">${weekSales}${pctToGoal != null ? ` · ${pctToGoal}%` : ''}</span></div>` : ''}
    </div>
  </div>
  <table class="grid">
    <thead><tr><th></th>${dayHeaderHtml}</tr></thead>
    <tbody>${gridRowsHtml}</tbody>
  </table>
  <div class="footer">Generated ${new Date().toLocaleString(APP_LOCALE)}</div>
</body></html>`;
      // Release the busy flag before the share sheet (iOS can leave shareAsync
      // pending on Cancel). Native: A4 landscape (842×595) → share; web prints
      // the HTML directly via the browser dialog.
      setPdfBusy(false);
      exportPdfFromHtml(html, {
        width: 842, height: 595,
        dialogTitle: weekLabel ? `Weekly Plan — ${weekLabel}` : 'Weekly Plan',
        filename: 'weekly-plan.pdf',
      }, printWin).catch(() => {});
    } catch (e: any) {
      showAlert('Could not export PDF', e?.message || 'Please try again.');
    } finally {
      // Defensive: runs if we threw *before* clearing above.
      setPdfBusy(false);
    }
  };

  // Zoom now scales actual cell widths / heights / font sizes rather than
  // applying a CSS transform. Reason: transform: scale() visually shrinks
  // but doesn't change layout, so zooming out previously left blank space
  // on the right of the table while still requiring horizontal scroll to
  // reach the last day. Scaling real dimensions makes the layout engine
  // reflow the columns correctly so at 70% you actually see more days per
  // screen, as expected.
  const colW = Math.round(COL_WIDTH * zoom);
  const labelW = Math.round(LABEL_COL_WIDTH * zoom);
  const cellPadH = Math.max(4, Math.round(8 * zoom));
  const cellPadV = Math.max(3, Math.round(6 * zoom));
  const dayHeaderH = Math.max(22, Math.round(32 * zoom));
  const rowMinH = Math.max(32, Math.round(48 * zoom));
  const labelFontSize = Math.max(8, 10 * zoom);
  const presFontSize = Math.max(9, 12 * zoom);
  const topicFontSize = Math.max(8, 10 * zoom);
  const dayHeaderFontSize = Math.max(9, 11 * zoom);

  return (
    <View>
      {/* ── Stats strip ─ ── ── */}
      {filledStats.length > 0 && (
        <View style={styles.statsStrip}>
          {filledStats.map((s) => {
            const isGoal = s.key === 'weekly_goal';
            return (
              <DepthCard key={s.key} sheen={false} style={[styles.statTile, { borderTopColor: s.color }]}>
                <View style={styles.statRow}>
                  <Ionicons name={s.icon} size={11} color={s.color} />
                  <Text style={[styles.statLabel, { color: s.color }]}>{s.label.toUpperCase()}</Text>
                </View>
                <Text style={styles.statValue}>{stats?.[s.key]}</Text>
                {/* Only on Weekly Goal: live Bells sales count for this week */}
                {isGoal && weekSales != null && (
                  <View style={styles.goalActualRow}>
                    <Ionicons
                      name={hitGoal ? 'checkmark-circle' : 'pulse'}
                      size={10}
                      color={hitGoal ? '#16a34a' : colors.textMuted}
                    />
                    <Text style={[styles.goalActualText, hitGoal && { color: '#16a34a', fontWeight: '800' }]}>
                      {hitGoal ? `${weekSales} — GOAL HIT 🎯` : `${weekSales} so far${pctToGoal != null ? ` · ${pctToGoal}%` : ''}`}
                    </Text>
                  </View>
                )}
                {isGoal && weekSales == null && bellsQ.isLoading && (
                  <Text style={styles.goalActualLoading}>loading sign-ups…</Text>
                )}
              </DepthCard>
            );
          })}
        </View>
      )}

      {/* ── Themes ─ ── ── */}
      {filledThemes.length > 0 && (
        <DepthCard sheen={false} style={styles.themesCard}>
          <View style={styles.cardHead}>
            <Ionicons name="bookmark" size={14} color={colors.primary} />
            <Text style={styles.cardHeadText}>This Week's Themes</Text>
          </View>
          <View style={styles.themesGrid}>
            {filledThemes.map((f) => (
              <View key={f.key} style={[styles.themeCard, { borderLeftColor: f.color }]}>
                <View style={styles.themeRow}>
                  <Ionicons name={f.icon} size={11} color={f.color} />
                  <Text style={[styles.themeLabel, { color: f.color }]}>
                    {f.label.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.themeValue}>{themes[f.key]}</Text>
              </View>
            ))}
          </View>
        </DepthCard>
      )}

      {/* ── Plan grid ─ ── ── */}
      <DepthCard sheen={false} style={styles.gridCard}>
        <View style={[styles.cardHead, styles.gridCardHead]}>
          <Ionicons name="grid" size={14} color={colors.primary} />
          <Text style={styles.cardHeadText}>Daily Plan</Text>
          <View style={{ flex: 1 }} />
          {/* Zoom + PDF toolbar */}
          <View style={styles.toolbar}>
            <TouchableOpacity
              onPress={() => setZoomIdx((i) => Math.max(0, i - 1))}
              disabled={zoomIdx === 0}
              style={[styles.tbBtn, zoomIdx === 0 && styles.tbBtnDisabled]}
              testID="weekly-plan-zoom-out"
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            >
              <Ionicons name="remove" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setZoomIdx(2)} // reset to 100%
              style={styles.tbZoomLabel}
              testID="weekly-plan-zoom-reset"
            >
              <Text style={styles.tbZoomLabelText}>{Math.round(zoom * 100)}%</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
              disabled={zoomIdx === ZOOM_STEPS.length - 1}
              style={[styles.tbBtn, zoomIdx === ZOOM_STEPS.length - 1 && styles.tbBtnDisabled]}
              testID="weekly-plan-zoom-in"
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            >
              <Ionicons name="add" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
            <View style={styles.tbDivider} />
            {isAdmin && (
              <TouchableOpacity
                onPress={() => setShowManageRows(true)}
                style={styles.tbBtn}
                testID="weekly-plan-manage-rows"
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                accessibilityLabel="Manage rows"
              >
                <Ionicons name="options-outline" size={15} color={colors.textSecondary} />
                <Text style={styles.tbPdfText}>Rows</Text>
                {(rowConfig?.hidden_rows?.length || 0) > 0 && (
                  <View style={styles.tbBadge}>
                    <Text style={styles.tbBadgeText}>{rowConfig?.hidden_rows?.length}</Text>
                  </View>
                )}
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={exportPdf}
              disabled={pdfBusy || visibleRows.length === 0}
              style={[styles.tbBtn, (pdfBusy || visibleRows.length === 0) && styles.tbBtnDisabled]}
              testID="weekly-plan-export-pdf"
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            >
              <Ionicons
                name={pdfBusy ? 'hourglass-outline' : 'document-text-outline'}
                size={15}
                color={colors.primary}
              />
              <Text style={styles.tbPdfText}>PDF</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Manage Rows modal — admin only */}
        <ManageRowsSheet
          visible={showManageRows}
          onClose={() => setShowManageRows(false)}
          allLabels={Array.from(new Set(rows.map((r) => (r.label || '').trim()).filter(Boolean)))}
          currentOrder={rowConfig?.row_order || []}
          currentHidden={rowConfig?.hidden_rows || []}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['agenda', 'row-config'] });
            setShowManageRows(false);
          }}
          colors={colors}
        />

        {visibleRows.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="calendar-clear-outline" size={28} color={colors.textMuted} />
            <Text style={styles.emptyText}>No daily topics added yet.</Text>
          </View>
        ) : (
          // Frozen-left-column layout: the label column sits OUTSIDE the
          // horizontal scroller, the day columns + their header live INSIDE.
          // Zoom works by scaling real cell widths/heights (not CSS transform)
          // so the layout engine reflows — zooming out genuinely fits more
          // days on-screen. Row heights stay synced via onLayout.
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            {/* Frozen label column (always visible, does not scroll horizontally) */}
            <View style={[styles.labelCol, { width: labelW }]}>
              <View style={[styles.cornerCell, { height: dayHeaderH }]}>
                <Text style={styles.cornerText}> </Text>
              </View>
              {/* Left half of the 2px gradient rule that runs under the day headers */}
              <LinearGradient
                pointerEvents="none"
                colors={GRADIENT}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.headRule}
              />
              {visibleRows.map((row) => (
                <View
                  key={row.id}
                  style={[
                    styles.labelRowCell,
                    { minHeight: rowMinH, paddingHorizontal: cellPadH, paddingVertical: cellPadV },
                    rowHeights[row.id] ? { height: rowHeights[row.id] } : null,
                  ]}
                >
                  <Text style={[styles.labelText, { fontSize: labelFontSize }]} numberOfLines={2}>
                    {row.label || 'Topic'}
                  </Text>
                </View>
              ))}
            </View>

            {/* Scrollable day columns */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator
              style={{ flex: 1 }}
              contentContainerStyle={{ flexGrow: 1 }}
            >
              <View>
                {/* Day headers */}
                <View style={{ flexDirection: 'row' }}>
                  {DAY_LABELS.map((d, i) => (
                    <View
                      key={i}
                      style={[
                        styles.dayHeader,
                        {
                          width: colW,
                          height: dayHeaderH,
                          backgroundColor: todayCol === i && isDark ? TODAY_TINT_HEAD_DARK : dayTints[i],
                        },
                      ]}
                    >
                      {todayCol === i && !isDark && (
                        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: TODAY_TINT }]} />
                      )}
                      <Text style={[styles.dayHeaderText, { fontSize: dayHeaderFontSize }]}>{d}</Text>
                    </View>
                  ))}
                </View>
                {/* 2px brand rule under the whole day-header row (spec §4 P1) */}
                <LinearGradient
                  pointerEvents="none"
                  colors={GRADIENT}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={[styles.headRule, { width: colW * DAY_LABELS.length }]}
                />

                {/* Data rows */}
                {visibleRows.map((row, ri) => (
                  <View
                    key={row.id}
                    style={{ flexDirection: 'row' }}
                    onLayout={(e) => {
                      const h = Math.round(e.nativeEvent.layout.height);
                      if (!h) return;
                      setRowHeights((prev) => (prev[row.id] === h ? prev : { ...prev, [row.id]: h }));
                    }}
                  >
                    {DAY_LABELS.map((_, di) => {
                      const cell = row.cells.find((c) => c.day === di);
                      const has = !!(cell?.topic || cell?.presenter);
                      // Hide topic when it duplicates the row label (case-
                      // insensitive) — the frozen left column already shows it.
                      const topicTrim = (cell?.topic || '').trim();
                      const labelTrim = (row.label || '').trim();
                      const topicIsDup = topicTrim &&
                        topicTrim.toLowerCase() === labelTrim.toLowerCase();
                      const showTopic = !!topicTrim && !topicIsDup;
                      return (
                        <View
                          key={di}
                          style={[
                            styles.dataCell,
                            { width: colW, minHeight: rowMinH, paddingHorizontal: cellPadH, paddingVertical: cellPadV },
                            ri % 2 === 1 && styles.dataCellAlt,
                          ]}
                        >
                          {todayCol === di && (
                            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: TODAY_TINT }]} />
                          )}
                          {has ? (
                            <>
                              {!!cell?.presenter && (
                                <Text style={[styles.cellPresenter, { fontSize: presFontSize }]} numberOfLines={2}>
                                  {cell.presenter}
                                </Text>
                              )}
                              {showTopic && (
                                <Text style={[styles.cellTopic, { fontSize: topicFontSize }]} numberOfLines={2}>
                                  {cell!.topic}
                                </Text>
                              )}
                            </>
                          ) : (
                            <Text style={styles.cellEmpty}> </Text>
                          )}
                        </View>
                      );
                    })}
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>
        )}
      </DepthCard>

      {/* Footer hint */}
      <Text style={styles.footerHint}>
        Themes apply to the whole week. Each cell shows what's planned for {DAY_FULL[0]} – {DAY_FULL[5]}.
      </Text>
    </View>
  );
}

// ============================================================================
// ManageRowsSheet
// Admin-only bottom sheet for (a) reordering weekly-plan rows by drag and
// (b) showing/hiding each row with an eye toggle. Persists to the office's
// weekly_plan_row_order + weekly_plan_hidden_rows on save. Every row whose
// label has ever been used on the plan (passed in via `allLabels`) appears,
// regardless of whether it's currently populated — so admins can pre-hide
// rows the schedule hasn't filled yet.
// ============================================================================
type ManageRowsSheetProps = {
  visible: boolean;
  onClose: () => void;
  allLabels: string[];
  currentOrder: string[];
  currentHidden: string[];
  onSaved: () => void;
  colors: any;
};

type MRItem = { slug: string; label: string };
const slugify = (s: string) => (s || '').trim().toLowerCase();

function ManageRowsSheet({
  visible, onClose, allLabels, currentOrder, currentHidden, onSaved, colors,
}: ManageRowsSheetProps) {
  const styles = useMemo(() => createMRStyles(colors), [colors]);
  // Same office the grid above is rendering, so a super admin editing office
  // B's row layout doesn't overwrite office A's.
  const { officeId } = useActiveOffice();
  // Local draft — only committed on Save.
  const [items, setItems] = useState<MRItem[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Rebuild the draft every time the sheet opens or the inputs change.
  // Merge strategy:
  //   1. Start with the admin's saved row_order (drop any slug not in allLabels).
  //   2. Append any new labels not yet in the saved order (new rows appear at end).
  // This gives admins a stable left-sticky list that grows as the plan evolves.
  useEffect(() => {
    if (!visible) return;
    const labelBySlug = new Map<string, string>();
    allLabels.forEach((l) => { const s = slugify(l); if (s) labelBySlug.set(s, l); });
    const ordered: MRItem[] = [];
    const seen = new Set<string>();
    for (const slug of currentOrder) {
      if (labelBySlug.has(slug) && !seen.has(slug)) {
        ordered.push({ slug, label: labelBySlug.get(slug) || slug });
        seen.add(slug);
      }
    }
    for (const [slug, label] of labelBySlug.entries()) {
      if (!seen.has(slug)) ordered.push({ slug, label });
    }
    setItems(ordered);
    setHidden(new Set(currentHidden));
  }, [visible, allLabels, currentOrder, currentHidden]);

  const toggleHidden = (slug: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const save = async () => {
    try {
      setSaving(true);
      await apiService.putAgendaRowConfig({
        row_order: items.map((i) => i.slug),
        hidden_rows: Array.from(hidden),
        office_id: officeId,
      });
      toast.success('Row layout saved', 'All coaches will see the new order.');
      onSaved();
    } catch (e: any) {
      toast.error('Could not save', e?.response?.data?.detail || e?.message || 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = () => {
    // Schedule-driven fallback: clear the admin's config entirely so the
    // grid uses incoming `rows` order and every row is visible.
    showAlert(
      'Reset to default?',
      'This clears your custom row order and un-hides every row. The grid will fall back to the schedule-driven order.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: async () => {
          try {
            setSaving(true);
            await apiService.putAgendaRowConfig({ row_order: [], hidden_rows: [], office_id: officeId });
            toast.success('Reset complete', 'Rows will render in schedule order.');
            onSaved();
          } catch (e: any) {
            toast.error('Could not reset', e?.response?.data?.detail || e?.message || 'Try again.');
          } finally {
            setSaving(false);
          }
        } },
      ],
    );
  };

  const renderItem = useCallback(({ item, drag, isActive }: RenderItemParams<MRItem>) => {
    const isHidden = hidden.has(item.slug);
    return (
      <ScaleDecorator>
        <View style={[styles.row, isActive && styles.rowActive, isHidden && styles.rowHidden]}>
          <TouchableOpacity
            onLongPress={drag}
            delayLongPress={120}
            style={styles.dragHandle}
            accessibilityLabel="Drag to reorder"
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          >
            <Ionicons name="reorder-three" size={22} color={colors.textMuted} />
          </TouchableOpacity>
          <Text
            style={[styles.rowLabel, isHidden && { color: colors.textMuted, textDecorationLine: 'line-through' }]}
            numberOfLines={1}
          >
            {item.label}
          </Text>
          <TouchableOpacity
            onPress={() => toggleHidden(item.slug)}
            style={[styles.eyeBtn, isHidden && { backgroundColor: colors.background }]}
            accessibilityLabel={isHidden ? 'Show row' : 'Hide row'}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name={isHidden ? 'eye-off-outline' : 'eye-outline'} size={18} color={isHidden ? colors.textMuted : colors.primary} />
          </TouchableOpacity>
        </View>
      </ScaleDecorator>
    );
  }, [hidden, colors, styles]);

  const visibleCount = items.length - hidden.size;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape', 'landscape-left', 'landscape-right']}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation?.()}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>Manage Rows</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.sub}>
            Drag to reorder. Tap the eye to hide a row from coaches and the PDF.
            {'  '}
            <Text style={{ color: colors.textSecondary, fontWeight: '800' }}>
              {visibleCount} visible · {hidden.size} hidden
            </Text>
          </Text>
          <View style={{ flex: 1, marginTop: 4 }}>
            {items.length === 0 ? (
              <View style={{ padding: 28, alignItems: 'center' }}>
                <Ionicons name="albums-outline" size={28} color={colors.textMuted} />
                <Text style={{ marginTop: 8, fontSize: 12, color: colors.textMuted }}>
                  No rows defined yet. Add schedule blocks first.
                </Text>
              </View>
            ) : (
              <DraggableFlatList
                data={items}
                keyExtractor={(i) => i.slug}
                onDragEnd={({ data }) => setItems(data)}
                renderItem={renderItem}
                activationDistance={8}
                containerStyle={{ flex: 1 }}
              />
            )}
          </View>
          <View style={styles.footerRow}>
            <TouchableOpacity onPress={resetToDefault} style={styles.resetBtn} disabled={saving}>
              <Text style={styles.resetBtnText}>Reset to default</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={save} style={[styles.saveBtn, saving && { opacity: 0.6 }]} disabled={saving}>
              <Ionicons name={saving ? 'hourglass-outline' : 'checkmark'} size={16} color="#fff" />
              <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createMRStyles = (colors: any) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  // Open at ~80% of the screen so the drag list has room — prevents the
  // "tiny sheet at the bottom that can't be dragged up" UX problem.
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 14, paddingBottom: 24, height: '82%' },
  handle: { alignSelf: 'center', width: 38, height: 4, backgroundColor: '#91B69E', borderRadius: 2, marginBottom: 8 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '900', color: colors.text, letterSpacing: 0.3 },
  sub: { fontSize: 11, color: colors.textMuted, marginVertical: 8, lineHeight: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 10, borderBottomWidth: 0.5, borderBottomColor: colors.border, backgroundColor: colors.surface },
  rowActive: { backgroundColor: colors.surfaceAlt, transform: [{ scale: 1.02 }] },
  rowHidden: { opacity: 0.6 },
  dragHandle: { paddingHorizontal: 4 },
  rowLabel: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text, textTransform: 'uppercase', letterSpacing: 0.3 },
  eyeBtn: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4 },
  resetBtn: { paddingVertical: 10, paddingHorizontal: 12 },
  resetBtnText: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  // primaryDark is a FILL token in both themes (never text): white on it is
  // 9.8:1 in light and 6.55:1 in dark, where `primary` would only give 3.2:1.
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primaryDark, paddingVertical: 11, paddingHorizontal: 20, borderRadius: 12 },
  saveBtnText: { color: '#fff', fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
});

const createStyles = (colors: any, isDark = false) => {
  // Hairlines inside the grid: a black wash is invisible on the dark card, so
  // the rule flips to a white wash there.
  const hair = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const zebra = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)';
  return StyleSheet.create({
  // Themes
  themesCard: {
    backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1,
    borderColor: colors.border, padding: 14, marginBottom: 12,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  cardHeadText: { fontSize: 13, fontWeight: '800', color: colors.text, letterSpacing: 0.4, flexShrink: 0 },
  themesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  themeCard: {
    flexBasis: '48%', flexGrow: 1, paddingVertical: 8, paddingHorizontal: 10,
    borderLeftWidth: 3, backgroundColor: colors.surfaceAlt, borderRadius: 8,
    minWidth: 140,
  },
  themeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3 },
  themeLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  themeValue: { fontSize: 12, fontWeight: '600', color: colors.text, lineHeight: 16 },

  // Grid
  gridCard: {
    backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1,
    borderColor: colors.border, overflow: 'hidden', marginBottom: 8,
  },
  gridCardHead: {
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 0,
    borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surfaceAlt,
    // Admin gets two more toolbar buttons than a leader: let the toolbar drop
    // to its own line instead of clipping "PDF" off the card's right edge.
    flexWrap: 'wrap', rowGap: 8,
  },
  scrollHint: { fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.4 },
  // Toolbar (zoom + PDF) on the right side of the Daily Plan card head
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tbBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 5, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  tbBtnDisabled: { opacity: 0.35 },
  tbBadge: { marginLeft: 2, backgroundColor: colors.primaryDark, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1, minWidth: 16, alignItems: 'center' },
  tbBadgeText: { fontSize: 9, fontWeight: '900', color: '#fff', letterSpacing: 0.2 },
  tbZoomLabel: { paddingHorizontal: 6, paddingVertical: 5, minWidth: 38, alignItems: 'center', justifyContent: 'center' },
  tbZoomLabelText: { fontSize: 11, fontWeight: '800', color: colors.textSecondary, fontVariant: ['tabular-nums'] as any, letterSpacing: 0.2 },
  tbDivider: { width: 1, height: 16, backgroundColor: colors.border, marginHorizontal: 4 },
  tbPdfText: { fontSize: 11, fontWeight: '800', color: colors.primary, letterSpacing: 0.4 },
  gridBody: { flexDirection: 'row' },

  labelCol: {
    width: LABEL_COL_WIDTH,
    borderRightWidth: 2, borderRightColor: colors.border,
    backgroundColor: colors.surface,
  },
  cornerCell: {
    height: 32, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  // The 2px brand rule under the day-header row (and its stub over the gutter).
  headRule: { height: 2, width: '100%' },
  cornerText: {
    fontSize: 9, fontWeight: '900', color: colors.textMuted,
    letterSpacing: 0.6, textTransform: 'uppercase',
  },
  labelRowCell: {
    paddingHorizontal: 8, paddingVertical: 6, minHeight: 48,
    justifyContent: 'center', borderBottomWidth: 1,
    borderBottomColor: hair,
    backgroundColor: colors.surfaceAlt,
  },
  labelText: { fontSize: 11, fontWeight: '800', color: colors.text, lineHeight: 14, textTransform: 'uppercase', letterSpacing: 0.3 },

  dayHeader: {
    width: COL_WIDTH, height: 32, alignItems: 'center', justifyContent: 'center',
    borderRightWidth: 1, borderRightColor: hair, overflow: 'hidden',
  },
  // Light: ink on the pastel wash (≥12:1). Dark: the card's own text colour on
  // a translucent wash over the raised face (≥11:1) — never the pastel ink.
  dayHeaderText: {
    fontSize: 11, fontWeight: '900', color: isDark ? colors.text : '#0B211C',
    letterSpacing: 0.6, textTransform: 'uppercase',
  },
  dataCell: {
    width: COL_WIDTH, paddingHorizontal: 8, paddingVertical: 6, minHeight: 48,
    borderBottomWidth: 1, borderRightWidth: 1, borderColor: hair,
    justifyContent: 'center', overflow: 'hidden',
  },
  dataCellAlt: { backgroundColor: zebra },
  cellTopic: { fontSize: 10, fontWeight: '500', fontStyle: 'italic', color: colors.textMuted, lineHeight: 13, marginTop: 2 },
  presenterRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 4 },
  cellPresenter: { fontSize: 12, fontWeight: '800', color: colors.text, lineHeight: 15 },
  cellEmpty: { fontSize: 11, color: colors.textMuted, opacity: 0.25, textAlign: 'center' },

  // Stats strip
  statsStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  statTile: {
    flexBasis: '18%', flexGrow: 1, minWidth: 88,
    backgroundColor: colors.surface, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 8,
    borderWidth: 1, borderColor: colors.border,
    borderTopWidth: 3,
  },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginBottom: 2 },
  statLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 0.4 },
  statValue: { fontSize: 18, fontWeight: '900', color: colors.text, letterSpacing: -0.3 },
  goalActualRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 4 },
  goalActualText: { fontSize: 10, fontWeight: '700', color: colors.textMuted, fontVariant: ['tabular-nums'] as any, letterSpacing: 0.2 },
  goalActualLoading: { fontSize: 10, fontStyle: 'italic', color: colors.textMuted, marginTop: 4 },

  empty: { alignItems: 'center', padding: 28, gap: 6 },
  emptyText: { color: colors.textMuted, fontSize: 12 },

  footerHint: {
    fontSize: 10, color: colors.textMuted, textAlign: 'center',
    marginTop: 4, fontStyle: 'italic', paddingHorizontal: 16, lineHeight: 14,
  },
  });
};

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors, false);
