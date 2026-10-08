"""Public HTML pages — served at ROOT paths (no /api/ prefix) so they are
accessible on the deployed Emergent host (which routes non-/api traffic to
the backend since there is no separate frontend deploy).

Currently only serves the Bells public share page, which:
  - Renders a self-contained HTML page with inline CSS + JS
  - Hits the existing JSON endpoint /api/public/bells/{slug} for data
  - Requires the same `?code=...` share code as the JSON endpoint

Vertex vocabulary on this page: `total_sales` = sign-ups, `over30` = £15+
(Target/Premium) sign-ups, `under30` = £12 (Standard) sign-ups, `earnings` =
estimated BA fees in £. The API still carries membership fields; Vertex
doesn't use memberships, so the page never shows them.
"""
import json

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from core.app_time import APP_TZ_NAME

router = APIRouter()


_BELLS_PAGE_HTML = r"""<!DOCTYPE html>
<html lang="en-GB">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>__OFFICE__ · Bells Weekly Snapshot</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,800&display=swap" rel="stylesheet" />
    <style>
        :root {
            /* Vertex brand — forest + lime. Lime always carries forest text;
               forest carries paper/white text. */
            --primary: #102d25;
            --primary-light: #244c3b;
            --gradient: linear-gradient(135deg, #244c3b 0%, #102d25 100%);
            --accent: #b7df58;
            --on-accent: #102d25;
            --accent-wash: #e9f3d2;
            --font-display: 'Fraunces', Georgia, 'Times New Roman', serif;
            --font-label: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
            --text: #17362b;
            --text-muted: #50675a;
            --bg: #f0f4e9;
            --surface: #f9faf4;
            --border: #cedbc7;
            /* Traffic-light thresholds are computed in JS (trafficLightBg())
               with their own hardcoded rgba values — untouched by this
               rebrand. These vars are only used for minor status text. */
            --green: #059669;
            --amber: #d97706;
            --red: #b91c1c;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { font-family: var(--font-display); background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased; }
        body { padding: 16px 12px 60px; max-width: 960px; margin: 0 auto; }
        .lock-box { max-width: 440px; margin: 60px auto 0; background: var(--surface); padding: 28px 24px; border-radius: 16px; border: 1px solid var(--border); box-shadow: 0 8px 28px rgba(16,45,37,0.10); }
        /* The logo is a transparent lime wordmark: always on forest, never on white. */
        .lock-logo { height: 56px; width: auto; max-width: 220px; display: block; margin: 0 auto 14px; background: var(--primary); padding: 10px 16px; border-radius: 12px; box-sizing: border-box; }
        .lock-title { font-family: var(--font-display); font-size: 22px; font-weight: 800; text-align: center; margin-bottom: 6px; letter-spacing: -0.2px; }
        .lock-sub { font-size: 13px; color: var(--text-muted); text-align: center; margin-bottom: 20px; line-height: 1.5; }
        .lock-sub b { color: var(--text); font-weight: 800; text-transform: uppercase; letter-spacing: 0.3px; }
        .lock-input { width: 100%; padding: 12px 14px; font-size: 16px; border: 1.5px solid var(--border); border-radius: 10px; margin-bottom: 10px; text-align: center; letter-spacing: 1px; outline: none; transition: border-color 0.15s; }
        .lock-input:focus { border-color: var(--primary); }
        .lock-error { font-size: 12px; color: var(--red); text-align: center; margin-bottom: 8px; min-height: 16px; }
        .btn-primary { display: block; width: 100%; padding: 13px; border: none; border-radius: 10px; background: var(--accent); color: var(--on-accent); font-size: 15px; font-weight: 800; cursor: pointer; transition: opacity 0.15s; }
        .btn-primary:hover:not(:disabled) { opacity: 0.92; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .lock-hint { font-size: 11px; color: var(--text-muted); text-align: center; margin-top: 14px; line-height: 1.5; font-style: italic; }

        .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; gap: 12px; }
        .header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .h-logo { height: 34px; width: auto; max-width: 120px; flex-shrink: 0; background: var(--primary); padding: 6px 9px; border-radius: 8px; box-sizing: border-box; }
        .h-title { font-family: var(--font-display); font-size: 22px; font-weight: 800; letter-spacing: -0.3px; }
        .h-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
        .btn-small { border: 1px solid var(--border); background: var(--surface); padding: 6px 10px; border-radius: 8px; font-size: 11px; font-weight: 700; color: var(--text-muted); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .btn-small:hover { background: var(--accent-wash); color: var(--primary); }

        .week-picker { display: flex; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 6px; margin-bottom: 10px; }
        .week-btn { border: none; background: transparent; padding: 10px 12px; font-size: 18px; cursor: pointer; color: var(--text); border-radius: 8px; }
        .week-btn:hover { background: var(--bg); }
        .week-center { flex: 1; text-align: center; }
        .week-title { font-family: var(--font-display); font-size: 15px; font-weight: 800; }
        .week-sub { font-size: 11px; color: var(--text-muted); margin-top: 1px; }
        .jump-today { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 4px; font-size: 12px; color: var(--primary); font-weight: 700; cursor: pointer; background: none; border: none; width: 100%; margin-bottom: 8px; }

        .actions { display: flex; gap: 8px; margin-bottom: 12px; }
        .action-btn { flex: 0 1 auto; padding: 8px 14px; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; font-size: 12px; font-weight: 700; cursor: pointer; color: var(--text); display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
        .action-btn.primary { background: var(--accent); border-color: #8caf38; color: var(--on-accent); }
        .action-btn:hover { opacity: 0.9; }

        /* Each chips-row sizes its columns based on the number of chips it
           actually contains, so 4-chip / 3-chip / 2-chip rows all line up
           with even spacing. */
        .chips-row { display: flex; gap: 6px; margin-bottom: 6px; }
        .chip { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 6px; text-align: center; box-shadow: 0 1px 3px rgba(16,45,37,0.05); }
        .chip-lbl-row { display: flex; align-items: center; justify-content: center; gap: 4px; }
        .chip-icon { width: 14px; height: 14px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; line-height: 1; }
        .chip-lbl { font-family: var(--font-label); font-size: 10px; font-weight: 700; color: var(--text-muted); letter-spacing: 0.5px; text-transform: uppercase; }
        .chip-val { font-size: 16px; font-weight: 800; margin-top: 4px; font-variant-numeric: tabular-nums; color: var(--text); }
        .chip-val.highlight { color: var(--primary); }
        /* Option A — neutral surface; tinted icon-chip carries the meaning.
           No top border, no coloured number text — single visual hierarchy. */
        .chip-icon.green  { background: rgba(34, 197, 94, 0.12);  color: #16a34a; }
        .chip-icon.primary{ background: rgba(183, 223, 88, 0.35); color: var(--primary); }

        .daily { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px; margin-bottom: 12px; }
        .daily-title { font-family: var(--font-label); font-size: 11px; font-weight: 700; color: var(--text-muted); letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 8px; }
        .daily-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
        .daily-cell { text-align: center; padding: 6px 0; cursor: pointer; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); transition: background 0.15s; user-select: none; -webkit-tap-highlight-color: rgba(183, 223, 88, 0.3); }
        .daily-cell.has-sales { background: rgba(183, 223, 88, 0.18); border-color: rgba(140, 175, 56, 0.45); }
        .daily-cell:hover, .daily-cell:active { background: var(--bg); }
        .daily-lbl { font-size: 10px; font-weight: 700; color: var(--text-muted); }
        .daily-val { font-size: 17px; font-weight: 800; margin-top: 2px; font-variant-numeric: tabular-nums; color: var(--text); }
        .daily-val.active { color: var(--text); }

        /* Day breakdown modal */
        .day-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: none; align-items: flex-end; justify-content: center; z-index: 100; }
        .day-overlay.open { display: flex; }
        .day-sheet { background: var(--surface); width: 100%; max-width: 560px; border-top-left-radius: 20px; border-top-right-radius: 20px; padding: 16px; padding-bottom: 28px; max-height: 88vh; overflow-y: auto; box-shadow: 0 -10px 30px rgba(0,0,0,0.25); animation: slideUp 0.22s ease-out; }
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .day-handle { width: 40px; height: 4px; border-radius: 2px; background: var(--border); margin: 0 auto 12px; }
        .day-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
        .day-head-title { flex: 1; font-size: 17px; font-weight: 800; color: var(--text); }
        .day-head-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; font-weight: 600; }
        .day-close { background: none; border: none; font-size: 24px; cursor: pointer; color: var(--text-muted); padding: 4px 8px; line-height: 1; }
        .day-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
        .day-tile { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px; min-height: 60px; }
        .day-tile-head { display: flex; align-items: center; gap: 4px; }
        .day-tile-lbl { font-size: 9px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase; color: var(--text-muted); }
        .day-tile-val { font-size: 17px; font-weight: 900; margin-top: 4px; font-variant-numeric: tabular-nums; color: var(--text); }
        .day-tile.primary .day-tile-val { color: var(--primary); }
        .day-section-title { font-size: 12px; font-weight: 800; color: var(--text-muted); margin-bottom: 8px; letter-spacing: 0.4px; text-transform: uppercase; }
        .day-rep-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-radius: 8px; background: var(--bg); border: 1px solid var(--border); margin-bottom: 6px; }
        .day-rep-name { font-size: 14px; font-weight: 700; color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .day-rep-stats { display: flex; gap: 10px; font-size: 12px; font-weight: 800; }
        .day-rep-stats .tier { color: var(--text-muted); }
        .day-empty { text-align: center; padding: 24px; border-radius: 10px; border: 1px dashed var(--border); color: var(--text-muted); font-size: 13px; }

        .tbl-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow-x: auto; margin-bottom: 12px; -webkit-overflow-scrolling: touch; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 800px; }
        thead { background: #e4ecd9; }
        th { padding: 9px 6px; font-weight: 800; text-align: center; font-size: 11px; border-bottom: 1px solid var(--border); white-space: nowrap; }
        th.name-col, td.name-col { text-align: left; padding-left: 12px; min-width: 140px; max-width: 180px; }
        td { padding: 9px 6px; text-align: center; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
        tr:last-child td { border-bottom: none; }
        tr:nth-child(even) { background: #f4f7ee; }
        .name-col .name-text { font-weight: 700; }
        .role-tag { display: inline-block; font-size: 9px; font-weight: 800; color: var(--text-muted); margin-left: 4px; letter-spacing: 0.3px; text-transform: uppercase; }
        tr.team-row td:first-child { border-left-width: 3px !important; border-left-style: solid; }

        /* Team section header (Excel-sheet style) */
        tr.team-section-header td { padding: 0 !important; border-bottom: 1px solid rgba(0,0,0,0.08); }
        tr.team-section-header:nth-child(even) td { background: inherit; }
        .team-section-row { display: flex; align-items: center; padding: 7px 12px; gap: 10px; }
        .team-section-left { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
        .team-section-icon { font-size: 13px; }
        .team-section-name { font-weight: 900; font-size: 13px; letter-spacing: 0.3px; }
        .team-section-leader { font-size: 11px; font-weight: 600; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .team-section-right { display: flex; align-items: center; gap: 4px; }
        .team-section-stat { font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums; }
        .team-section-dot { font-size: 12px; font-weight: 900; opacity: 0.4; }
        .leader-star { display: inline-block; margin-right: 4px; font-size: 11px; vertical-align: middle; }
        td.money { color: var(--primary); font-weight: 800; }
        .cell-muted { color: #5f7266; }
        .cell-rt { color: var(--amber); }
        .cell-nc { color: var(--text-muted); }
        /* AB = scheduled absence (pre-determined day off). Just bold red
           so it stands out from blank/0 cells without crowding adjacent
           columns when two consecutive days are AB. */
        .cell-ab { color: #dc2626; font-weight: 800; letter-spacing: 0.3px; }
        /* Approved-absence tooltip — hover on desktop, tap (:focus) on touch.
           The cell is position:relative so the bubble anchors to it; the table
           scrolls horizontally, so the bubble is clamped to a sane width. */
        td.has-tip { position: relative; cursor: help; text-decoration: underline dotted rgba(220,38,38,0.6); text-underline-offset: 3px; outline: none; }
        td.has-tip .tip {
            display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
            z-index: 40; min-width: 170px; max-width: 240px; padding: 8px 10px; border-radius: 8px;
            background: #1f2937; color: #f9fafb; font-size: 11px; font-weight: 600; line-height: 1.45;
            text-align: left; letter-spacing: 0; white-space: normal; text-decoration: none;
            box-shadow: 0 6px 20px rgba(0,0,0,0.28); pointer-events: none;
        }
        td.has-tip .tip::after {
            content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
            border: 5px solid transparent; border-top-color: #1f2937;
        }
        td.has-tip:hover .tip, td.has-tip:focus .tip { display: block; }
        .cell-pc { color: #0891b2; font-weight: 800; letter-spacing: 0.3px; }

        /* Tabs */
        .tabs { display: flex; gap: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 4px; margin-bottom: 12px; }
        .tab { flex: 1; padding: 8px; border: none; background: transparent; font-size: 12px; font-weight: 800; color: var(--text-muted); letter-spacing: 0.3px; cursor: pointer; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-transform: uppercase; }
        .tab.active { background: var(--gradient); color: #f0f4e9; }
        .tab:hover:not(.active) { color: var(--text); }

        /* Teams view */
        .teams-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 10px; }
        .team-card { border-radius: 12px; padding: 12px; margin-bottom: 10px; border: 1px solid var(--border); border-left-width: 4px; }
        .team-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .team-name { font-family: var(--font-display); font-size: 16px; font-weight: 800; }
        .team-lead-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
        .team-share { padding: 4px 10px; border-radius: 10px; min-width: 64px; text-align: center; }
        .team-share-val { font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; }
        .team-share-lbl { font-size: 9px; font-weight: 700; letter-spacing: 0.3px; }
        .team-metrics { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 8px; }
        .team-metric { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 6px 4px; text-align: center; }
        .team-metric-lbl { font-size: 9px; font-weight: 700; color: var(--text-muted); letter-spacing: 0.3px; }
        .team-metric-val { font-size: 14px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
        .team-metric-val.money { color: var(--primary); }
        .team-secondary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
        .team-sec { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
        .team-sec-lbl { font-size: 9px; font-weight: 700; letter-spacing: 0.3px; color: var(--text-muted); }
        .team-sec-val { font-size: 12px; font-weight: 700; margin-top: 1px; font-variant-numeric: tabular-nums; }
        .team-sec.delta-pos { background: #ecfdf5; }
        .team-sec.delta-pos .team-sec-lbl, .team-sec.delta-pos .team-sec-val { color: #059669; }
        .team-sec.delta-neg { background: #fef2f2; }
        .team-sec.delta-neg .team-sec-lbl, .team-sec.delta-neg .team-sec-val { color: #dc2626; }

        .empty { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 36px 20px; text-align: center; color: var(--text-muted); }
        .footer-note { text-align: center; font-size: 10px; color: var(--text-muted); font-style: italic; margin-top: 16px; }
        .hint-swipe { font-size: 11px; color: var(--text-muted); font-style: italic; text-align: center; padding: 6px; }
        .loading { text-align: center; padding: 60px 20px; color: var(--text-muted); font-size: 13px; }

        @media (max-width: 500px) {
            body { padding: 12px 10px 60px; }
            .h-title { font-size: 20px; }
            .chips-row { grid-template-columns: repeat(3, 1fr); }
        }
    </style>
</head>
<body>
    <div id="app"></div>
    <div id="dayOverlay" class="day-overlay" onclick="closeDayModal()"></div>

    <script>
        // ─────────────────── helpers ───────────────────
        const SLUG = "__SLUG__";
        // App time (UK) — "this week" is the same week for every viewer.
        const APP_TZ = __APP_TZ_JSON__;
        const LOCALE = 'en-GB';
        function fmtMoney(n) {
            const v = Number(n);
            return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'GBP', minimumFractionDigits: 0, maximumFractionDigits: 0 })
                .format(Number.isFinite(v) ? v : 0);
        }
        const storageKey = `bells-code:${SLUG}`;

        const $app = document.getElementById('app');
        const params = new URLSearchParams(window.location.search);
        const codeFromUrl = params.get('code') || '';
        const weekFromUrl = params.get('week') || '';

        function currentWeekEnding() {
            // Today's date in app time, then forward to its Sunday.
            let d;
            try {
                const parts = new Intl.DateTimeFormat(LOCALE, { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
                const get = (t) => Number((parts.find((p) => p.type === t) || {}).value || 0);
                d = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
                if (isNaN(d.getTime())) throw new Error('tz');
            } catch (e) {
                const now = new Date();
                d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
            }
            const dow = d.getUTCDay();
            d.setUTCDate(d.getUTCDate() + (dow === 0 ? 0 : 7 - dow));
            return d.toISOString().slice(0, 10);
        }

        function isoAddDays(iso, delta) {
            const d = new Date(iso + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + delta);
            return d.toISOString().slice(0, 10);
        }

        function prettyRange(end) {
            const d = new Date(end + 'T00:00:00Z');
            const start = new Date(d); start.setUTCDate(start.getUTCDate() - 6);
            const opts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
            return start.toLocaleDateString(LOCALE, opts) + ' – ' + d.toLocaleDateString(LOCALE, opts);
        }

        // "5 Oct 2026" for a YYYY-MM-DD date (UTC so the day never rolls).
        function prettyDate(iso) {
            const d = new Date(iso + 'T00:00:00Z');
            if (isNaN(d.getTime())) return iso;
            return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
        }

        let state = {
            code: codeFromUrl || localStorage.getItem(storageKey) || '',
            week: weekFromUrl || currentWeekEnding(),
            data: null,
            loading: false,
            error: null,
            view: 'players',  // 'players' | 'teams'
        };

        if (codeFromUrl) localStorage.setItem(storageKey, codeFromUrl);

        // ─────────────────── team color palette (mirrors app) ───────────────
        const TEAM_PALETTE = [
            { border: '#60a5fa', bg: '#eff6ff', pill: '#dbeafe', text: '#1d4ed8' },
            { border: '#34d399', bg: '#ecfdf5', pill: '#d1fae5', text: '#047857' },
            { border: '#fbbf24', bg: '#fffbeb', pill: '#fef3c7', text: '#b45309' },
            { border: '#a78bfa', bg: '#f5f3ff', pill: '#ede9fe', text: '#6d28d9' },
            { border: '#f472b6', bg: '#fdf2f8', pill: '#fce7f3', text: '#be185d' },
            { border: '#22d3ee', bg: '#ecfeff', pill: '#cffafe', text: '#0e7490' },
            { border: '#fb923c', bg: '#fff7ed', pill: '#ffedd5', text: '#c2410c' },
        ];
        function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
        function teamColor(key) { if (!key) return null; return TEAM_PALETTE[hashStr(key) % TEAM_PALETTE.length]; }

        // ─────────────────── data ───────────────────
        async function fetchData() {
            if (!state.code) { render(); return; }
            state.loading = true; state.error = null; render();
            try {
                const url = `/api/public/bells/${encodeURIComponent(SLUG)}?code=${encodeURIComponent(state.code)}&week=${encodeURIComponent(state.week)}`;
                const res = await fetch(url);
                if (res.status === 401) {
                    state.error = 'Invalid share code.';
                    state.code = '';
                    localStorage.removeItem(storageKey);
                    state.data = null;
                } else if (res.status === 403) {
                    state.error = 'Public sharing is not enabled for this office. Contact your admin.';
                    state.data = null;
                } else if (res.status === 404) {
                    state.error = 'Office not found.';
                    state.data = null;
                } else if (!res.ok) {
                    state.error = 'Error loading data (' + res.status + ').';
                    state.data = null;
                } else {
                    state.data = await res.json();
                }
            } catch (e) {
                state.error = 'Network error: ' + (e.message || 'unknown');
            } finally {
                state.loading = false;
                render();
            }
        }

        // ─────────────────── render ───────────────────
        function escapeHtml(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
                '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
            })[c]);
        }

        function renderLockScreen() {
            $app.innerHTML = `
                <div class="lock-box">
                    <img src="/api/logo.png" alt="Vertex Hub" class="lock-logo" />
                    <div class="lock-title">Protected Weekly Snapshot</div>
                    <div class="lock-sub">Enter the share code for <b>${escapeHtml(SLUG)}</b> to view this week's Bells data.</div>
                    <input id="codeInput" class="lock-input" type="text" placeholder="Share code" autocomplete="off" autocapitalize="off" />
                    <div class="lock-error">${escapeHtml(state.error || '')}</div>
                    <button id="unlockBtn" class="btn-primary">Unlock</button>
                    <div class="lock-hint">Don't have the code? Ask your admin. Once unlocked, this page auto-refreshes with the latest data every time you visit.</div>
                </div>
            `;
            const inp = document.getElementById('codeInput');
            const btn = document.getElementById('unlockBtn');
            inp.focus();
            const submit = () => {
                const v = inp.value.trim();
                if (!v) return;
                state.code = v;
                state.error = null;
                localStorage.setItem(storageKey, v);
                fetchData();
            };
            btn.addEventListener('click', submit);
            inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        }

        function renderMain() {
            if (state.loading && !state.data) {
                $app.innerHTML = '<div class="loading">Loading...</div>';
                return;
            }
            if (state.error) {
                $app.innerHTML = `
                    <div class="header">
                        <div class="header-left">
                            <img src="/api/logo.png" alt="Vertex Hub" class="h-logo" />
                            <div><div class="h-title">${escapeHtml(SLUG)}</div><div class="h-sub">Weekly Sign-ups Snapshot · Public View</div></div>
                        </div>
                        <button id="lockBtn" class="btn-small">🔒 Lock</button>
                    </div>
                    <div class="empty"><div style="color: var(--red);">${escapeHtml(state.error)}</div></div>
                `;
                document.getElementById('lockBtn').addEventListener('click', clearCode);
                return;
            }
            if (!state.data) { $app.innerHTML = '<div class="loading">Loading...</div>'; return; }

            const d = state.data;
            const t = d.office_totals || {};
            const entries = d.entries || [];
            const csvUrl = `/api/public/bells/${encodeURIComponent(SLUG)}/csv?code=${encodeURIComponent(state.code)}&week=${encodeURIComponent(state.week)}`;

            // Daily totals strip
            const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
            const dailyTotals = t.daily_totals || [0,0,0,0,0,0,0];
            const dailyHtml = days.map((lbl, i) => `
                <div class="daily-cell ${dailyTotals[i] > 0 ? 'has-sales' : ''}" onclick="openDayModal(${i})" role="button" tabindex="0" aria-label="View ${lbl} totals">
                    <div class="daily-lbl">${lbl}</div>
                    <div class="daily-val">${dailyTotals[i] || 0}</div>
                </div>`).join('');

            // "12 Jul, 15:04" (app time) — when an absence was signed off.
            const absStamp = (iso) => {
                if (!iso) return '';
                const t = new Date(iso);
                if (isNaN(t.getTime())) return '';
                return t.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', timeZone: APP_TZ })
                    + ', ' + t.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: APP_TZ });
            };

            // Cell helper
            const cell = (day) => {
                if (!day) return { text: '—', cls: 'cell-muted' };
                if (day.status === 'off') return { text: '—', cls: 'cell-muted' };
                // AB = scheduled absence (pre-determined day off). Stands
                // out from blank/0 cells with a red pill so leaders can
                // tell apart "didn't work" vs. "approved off".
                if (day.status === 'ab') return { text: 'Ab', cls: 'cell-ab' };
                if (day.status === 'nc') return { text: 'nc', cls: 'cell-nc' };
                if (day.status === 'pc') return { text: 'pc', cls: 'cell-pc' };
                const tot = (day.over30 || 0) + (day.under30 || 0);
                if (day.status === 'rt') return { text: tot > 0 ? `rt ${tot}` : 'rt', cls: 'cell-rt' };
                return { text: String(tot), cls: tot > 0 ? '' : 'cell-muted' };
            };

            // ── Group entries by primary_team (Excel-sheet style) ──
            const groupsMap = new Map();
            entries.forEach((e) => {
                const pt = e.primary_team || null;
                const key = pt && pt.leader_id ? pt.leader_id : '__no_team__';
                if (!groupsMap.has(key)) {
                    groupsMap.set(key, {
                        key,
                        team_name: pt ? pt.team_name : 'Unassigned',
                        leader_id: pt ? pt.leader_id : null,
                        leader_name: pt ? pt.leader_name : null,
                        members: [],
                        total_sales: 0,
                        total_earnings: 0,
                    });
                }
                const g = groupsMap.get(key);
                g.members.push(e);
                g.total_sales += e.total_sales || 0;
                g.total_earnings += e.earnings || 0;
            });
            // Within each group, the SERVER returns members in the correct
            // hierarchical order (section leader pinned at top, then leaves
            // newest-first followed by branches with their sub-trees inline).
            // Do NOT re-sort here — that would clobber the server order.
            // (Intentionally left as a no-op for clarity; previous version
            // did its own leader→role→alpha sort which broke nesting.)
            // SECTION order also comes from the server (admin-led teams
            // pinned first, then desc by sales, unassigned last) — preserve
            // encounter order; only make sure unassigned sinks to the bottom.
            const groups = Array.from(groupsMap.values()).sort((a, b) => {
                if (a.key === '__no_team__' && b.key !== '__no_team__') return 1;
                if (b.key === '__no_team__' && a.key !== '__no_team__') return -1;
                return 0; // stable sort → server order kept
            });
            // Crew goal = team_weekly_goal on the section leader's own row
            groups.forEach((g) => {
                const lead = g.members.find((m) => m.user_id && m.user_id === g.leader_id);
                g.crew_goal = lead && lead.team_weekly_goal != null ? lead.team_weekly_goal : null;
                // Sections are exclusive, so a leader whose reports are
                // themselves section leaders sits alone in theirs and
                // total_sales is just their personal number. The crew goal
                // covers the whole downline, so compare against that.
                g.crew_sales = lead && lead.team_subtree_sales != null ? lead.team_subtree_sales : null;
            });

            // Traffic light background — everyone with 4+ prior weeks.
            // Admins run the office — they aren't measured by the rep light.
            function trafficLightBg(e) {
                if (e.role === 'admin') return null;
                const priorWeeks = e.prior_weeks ?? 0;
                if (priorWeeks < 4) return null;
                const lw = e.last_week_total;
                if (lw == null) return null;
                const ppw = e.prev_prev_week_total ?? null;
                // What Good Looks Like: Super Green 10+, Green 8-9, Amber 6-7,
                // Red 5 and under (core/week_bands.py — keep in step).
                if (lw >= 10) return 'rgba(34,197,94,0.30)';
                if (lw >= 8)  return 'rgba(34,197,94,0.18)';
                if (lw >= 6)  return 'rgba(234,179,8,0.25)';
                const alsoRedPrev = ppw != null && ppw <= 5;
                return alsoRedPrev ? 'rgba(185,28,28,0.35)' : 'rgba(239,68,68,0.22)';
            }

            // Total column count for the team header colspan
            const TOTAL_COLS = 1 /* name */ + 2 /* LW/Goal */ + 7 /* days */ + 3 /* tot/days/PA */ + 1 /* £15+ % */ + 1 /* est. fees */;

            const rowsHtml = groups.map((g) => {
                const tint = g.key === '__no_team__'
                    ? { border: '#94a3b8', bg: '#f8fafc', pill: '#e2e8f0', text: '#334155' }
                    : (teamColor(g.leader_id || g.team_name) || TEAM_PALETTE[0]);
                const headerLeader = g.leader_name ? ` · led by ${escapeHtml(g.leader_name)}` : '';
                const headerHtml = `
                    <tr class="team-section-header">
                        <td colspan="${TOTAL_COLS}" style="background:${tint.pill};border-left:4px solid ${tint.border};color:${tint.text};">
                            <div class="team-section-row">
                                <div class="team-section-left">
                                    <span class="team-section-icon">👥</span>
                                    <span class="team-section-name">${escapeHtml(g.team_name)}</span>
                                    <span class="team-section-leader">${headerLeader}</span>
                                </div>
                                <div class="team-section-right">
                                    <span class="team-section-stat">${(() => { const hit = g.crew_sales != null ? g.crew_sales : g.total_sales; return g.crew_goal != null ? `${hit} / ${g.crew_goal} goal${hit >= g.crew_goal ? ' ✅' : ''}` : `${g.total_sales} sign-ups`; })()}</span>
                                    <span class="team-section-dot">·</span>
                                    <span class="team-section-stat">${fmtMoney(g.total_earnings)}</span>
                                </div>
                            </div>
                        </td>
                    </tr>`;
                const memberRowsHtml = g.members.map((e) => {
                    const isLeader = e.user_id && g.leader_id && e.user_id === g.leader_id;
                    const roleLabel = isLeader ? 'Coach' : (e.role === 'trainee' ? 'BA' : (e.role === 'leader' ? 'Coach' : ''));
                    const tlBg = trafficLightBg(e);
                    const rowStyle = tlBg
                        ? `style="background:${tlBg};border-left:3px solid ${tint.border};"`
                        : `style="border-left:3px solid ${tint.border};"`;
                    const nameCellStyle = tlBg ? `style="background:${tlBg};"` : (isLeader ? `style="background:${tint.bg};"` : '');
                    const nameStyle = isLeader ? `style="color:${tint.text};font-weight:900;"` : '';
                    const leaderIcon = isLeader ? `<span class="leader-star" style="color:${tint.text};">★</span>` : '';
                    const lwVal = e.last_week_total != null ? e.last_week_total : '—';
                    const goalVal = e.weekly_goal != null ? e.weekly_goal : '—';
                    const daysHtml = (e.days || []).map((dd, di) => {
                        const c = cell(dd);
                        // An approved AB carries its reason + sign-off, so the
                        // sheet explains itself on hover (desktop) or tap
                        // (touch) instead of sending people to the app.
                        const ab = (dd && dd.status === 'ab' && e.absence_details)
                            ? e.absence_details[String(di)] : null;
                        if (ab) {
                            const parts = [];
                            if (ab.reason) parts.push('“' + ab.reason + '”');
                            const who = ab.decided_by_name ? 'Approved by ' + ab.decided_by_name : 'Approved';
                            parts.push(ab.decided_at ? who + ' · ' + absStamp(ab.decided_at) : who);
                            if (ab.requested_by) parts.push('Requested by ' + ab.requested_by);
                            const tip = escapeHtml(parts.join('\n'));
                            return `<td class="${c.cls} has-tip" tabindex="0" data-tip="${tip}">${escapeHtml(c.text)}<span class="tip">${tip.replace(/\n/g, '<br>')}</span></td>`;
                        }
                        return `<td class="${c.cls}">${escapeHtml(c.text)}</td>`;
                    }).join('');
                    return `
                        <tr class="team-row" ${rowStyle}>
                            <td class="name-col" ${nameCellStyle}>${leaderIcon}<span class="name-text" ${nameStyle}>${escapeHtml(e.user_name)}</span>${roleLabel ? `<span class="role-tag">${roleLabel}</span>` : ''}</td>
                            <td>${lwVal}</td>
                            <td>${goalVal}</td>
                            ${daysHtml}
                            <td style="font-weight:800">${e.total_sales || 0}</td>
                            <td>${e.days_worked || 0}</td>
                            <td>${(e.piece_average || 0).toFixed(1)}</td>
                            <td class="pct-cell">${e.total_sales > 0 ? Math.round(((e.total_over30 || 0) / e.total_sales) * 100) + '%' : '—'}</td>
                            <td class="money">${fmtMoney(e.earnings || 0)}</td>
                        </tr>`;
                }).join('');
                return headerHtml + memberRowsHtml;
            }).join('');

            // Teams tab rendering
            const teams = d.teams || [];
            const officeSalesTotal = teams.reduce((s, t) => s + (t.total_sales || 0), 0);
            const teamsCount = teams.length;
            const workingNow = teams.reduce((s, t) => s + (t.working_today || 0), 0);
            const teamsSummaryHtml = `
                <div class="teams-summary">
                    <div class="chip"><div class="chip-lbl">Teams</div><div class="chip-val">${teamsCount}</div></div>
                    <div class="chip"><div class="chip-lbl">Total Sign-ups</div><div class="chip-val highlight">${officeSalesTotal}</div></div>
                    <div class="chip"><div class="chip-lbl">Working Now</div><div class="chip-val">${workingNow}</div></div>
                </div>
            `;
            const teamCardsHtml = teams.map((team) => {
                const tint = teamColor(team.leader_id) || TEAM_PALETTE[0];
                const sharePct = officeSalesTotal > 0 ? Math.round((team.total_sales / officeSalesTotal) * 100) : 0;
                const delta = team.sales_delta || 0;
                const deltaPositive = delta >= 0;
                const deltaClass = deltaPositive ? 'delta-pos' : 'delta-neg';
                const deltaPctStr = team.sales_delta_pct !== null && team.sales_delta_pct !== undefined
                    ? ` (${team.sales_delta_pct > 0 ? '+' : ''}${team.sales_delta_pct}%)`
                    : '';
                const workingStr = (team.working_today || 0) > 0 ? ` · ${team.working_today} working today` : '';
                return `
                    <div class="team-card" style="border-left-color:${tint.border};background:${tint.bg};">
                        <div class="team-card-head">
                            <div style="flex:1;min-width:0;">
                                <div class="team-name" style="color:${tint.text};">${escapeHtml(team.team_name || '—')}</div>
                                <div class="team-lead-sub">Led by ${escapeHtml(team.leader_name || '')} · ${team.member_count} member${team.member_count === 1 ? '' : 's'}${workingStr}</div>
                            </div>
                            <div class="team-share" style="background:${tint.pill};color:${tint.text};">
                                <div class="team-share-val" style="color:${tint.text};">${sharePct}%</div>
                                <div class="team-share-lbl" style="color:${tint.text};">of office</div>
                            </div>
                        </div>
                        <div class="team-metrics">
                            <div class="team-metric"><div class="team-metric-lbl">Sign-ups</div><div class="team-metric-val" style="font-weight:800;">${team.total_sales}</div></div>
                            <div class="team-metric"><div class="team-metric-lbl">P/A</div><div class="team-metric-val">${(team.piece_average || 0).toFixed(1)}</div></div>
                            <div class="team-metric"><div class="team-metric-lbl">Scoring</div><div class="team-metric-val">${team.scoring_pct || 0}%</div></div>
                            <div class="team-metric"><div class="team-metric-lbl">🍃 Green %</div><div class="team-metric-val">${team.green_pct ?? 0}%</div></div>
                        </div>
                        <div class="team-metrics">
                            <div class="team-metric"><div class="team-metric-lbl">£15+</div><div class="team-metric-val">${team.total_over30 ?? 0}</div></div>
                            <div class="team-metric"><div class="team-metric-lbl">£12</div><div class="team-metric-val">${team.total_under30 ?? 0}</div></div>
                            <div class="team-metric"><div class="team-metric-lbl">£15+ %</div><div class="team-metric-val">${team.pct_over30 ?? 0}%</div></div>
                        </div>
                        <div class="team-secondary">
                            <div class="team-sec">
                                <div class="team-sec-lbl">Weekly Avg / BA</div>
                                <div class="team-sec-val">${(team.weekly_average || 0).toFixed(1)}</div>
                            </div>
                            <div class="team-sec">
                                <div class="team-sec-lbl">Days</div>
                                <div class="team-sec-val">${team.days_worked || 0}</div>
                            </div>
                            <div class="team-sec ${deltaClass}">
                                <div class="team-sec-lbl">vs Last Wk</div>
                                <div class="team-sec-val">${deltaPositive ? '+' : ''}${delta}${deltaPctStr}</div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            const isCurrentWeek = state.week === currentWeekEnding();

            $app.innerHTML = `
                <div class="header">
                    <div class="header-left">
                        <img src="/api/logo.png" alt="Vertex Hub" class="h-logo" />
                        <div>
                            <div class="h-title">${escapeHtml(d.office_name || SLUG)}</div>
                            <div class="h-sub">Weekly Sign-ups Snapshot · Public View</div>
                        </div>
                    </div>
                    <button id="lockBtn" class="btn-small">🔒 Lock</button>
                </div>

                <div class="week-picker">
                    <button class="week-btn" id="prevWeek">‹</button>
                    <div class="week-center">
                        <div class="week-title">${prettyRange(state.week)}</div>
                        <div class="week-sub">w/e ${escapeHtml(prettyDate(state.week))}</div>
                    </div>
                    <button class="week-btn" id="nextWeek">›</button>
                </div>
                ${!isCurrentWeek ? `<button class="jump-today" id="jumpToday">↻ Jump to this week</button>` : ''}

                <div class="actions">
                    <button class="action-btn" id="refreshBtn">↻ Refresh</button>
                    <a class="action-btn primary" href="${csvUrl}" download>⬇ CSV Export</a>
                </div>

                <div class="chips-row">
                    <div class="chip"><div class="chip-lbl">Sign-ups</div><div class="chip-val highlight">${t.total_sales || 0}</div></div>
                    <div class="chip"><div class="chip-lbl">P/A</div><div class="chip-val">${(t.piece_average || 0).toFixed(1)}</div></div>
                    <div class="chip"><div class="chip-lbl">Scoring</div><div class="chip-val">${t.scoring_pct ?? 0}%</div></div>
                    <div class="chip"><div class="chip-lbl-row"><span class="chip-icon green">🍃</span><span class="chip-lbl">Green %</span></div><div class="chip-val">${t.green_pct ?? 0}%</div></div>
                </div>
                <div class="chips-row" style="margin-bottom:12px;">
                    <div class="chip"><div class="chip-lbl">£15+</div><div class="chip-val">${t.total_over30 || 0}</div></div>
                    <div class="chip"><div class="chip-lbl">£12</div><div class="chip-val">${t.total_under30 || 0}</div></div>
                    <div class="chip"><div class="chip-lbl">£15+ %</div><div class="chip-val">${t.pct_over30 ?? 0}%</div></div>
                </div>

                <div class="daily">
                    <div class="daily-title">Daily Sign-ups <span style="text-transform:none;font-weight:600;color:var(--text-muted);">· tap a day for stats</span></div>
                    <div class="daily-row">${dailyHtml}</div>
                </div>

                <div class="tabs">
                    <button class="tab ${state.view === 'players' ? 'active' : ''}" data-view="players">👤 Players</button>
                    <button class="tab ${state.view === 'teams' ? 'active' : ''}" data-view="teams">🎯 Teams</button>
                </div>

                ${state.view === 'teams' ? (
                    teams.length === 0
                        ? `<div class="empty">No teams defined yet. Coaches can set a team name in the app to start grouping members here.</div>`
                        : `${teamsSummaryHtml}${teamCardsHtml}`
                ) : (entries.length === 0 ? `
                    <div class="empty">No entries for this week yet.</div>
                ` : `
                    <div class="tbl-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th class="name-col">Name</th>
                                    <th>LW</th>
                                    <th>Goal</th>
                                    ${days.map(d => `<th>${d}</th>`).join('')}
                                    <th>Tot</th><th>Days</th><th>P/A</th><th>£15+ %</th><th>Est. fees</th>
                                </tr>
                            </thead>
                            <tbody>${rowsHtml}</tbody>
                        </table>
                        <div class="hint-swipe">Swipe horizontally to see all columns.</div>
                    </div>
                `)}

                <div class="footer-note">Data refreshes every visit. Shared via Vertex Hub · Last loaded at ${new Date().toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: APP_TZ })}</div>
            `;

            document.getElementById('lockBtn').addEventListener('click', clearCode);
            document.getElementById('prevWeek').addEventListener('click', () => { state.week = isoAddDays(state.week, -7); fetchData(); });
            document.getElementById('nextWeek').addEventListener('click', () => { state.week = isoAddDays(state.week, 7); fetchData(); });
            document.getElementById('refreshBtn').addEventListener('click', () => fetchData());
            const jt = document.getElementById('jumpToday');
            if (jt) jt.addEventListener('click', () => { state.week = currentWeekEnding(); fetchData(); });
            document.querySelectorAll('.tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    const v = btn.getAttribute('data-view');
                    if (v && v !== state.view) { state.view = v; render(); }
                });
            });
        }

        function clearCode() {
            state.code = '';
            state.data = null;
            state.error = null;
            localStorage.removeItem(storageKey);
            render();
        }

        // ── Day breakdown modal ─────────────────────────────────────────
        function openDayModal(dayIdx) {
            const data = state.data;
            if (!data || !data.entries) return;
            const entries = data.entries;
            // Compute office totals for this single day.
            // "Working" = anyone clocked in for the day (status 'in' or 'rt',
            // or anyone with sign-ups) — NOT just people who signed someone up.
            // Memberships aren't used by Vertex: a stray stored value only
            // counts towards "working" here and is never shown.
            let over30 = 0, under30 = 0, working = 0;
            const reps = [];
            entries.forEach((e) => {
                const d = (e.days || [])[dayIdx];
                if (!d) return;
                const o = Number(d.over30 || 0);
                const u = Number(d.under30 || 0);
                const m = Number(d.memberships || 0);
                const tot = o + u;
                const isWorking = d.status === 'in' || d.status === 'rt' || tot > 0 || m > 0;
                if (isWorking) working++;
                over30 += o; under30 += u;
                if (tot > 0) reps.push({ name: e.user_name, over30: o, under30: u });
            });
            const sales = over30 + under30;
            const hiRate = sales > 0 ? Math.round((over30 / sales) * 100) : 0;
            const pa = working > 0 ? (sales / working).toFixed(1) : '0.0';

            // Date label for this day
            const we = data.week_ending;
            let dayLabel = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][dayIdx];
            try {
                const end = new Date(we + 'T00:00:00Z');
                const monday = new Date(end); monday.setUTCDate(end.getUTCDate() - 6);
                const target = new Date(monday); target.setUTCDate(monday.getUTCDate() + dayIdx);
                dayLabel = target.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
            } catch (e) {}

            reps.sort((a, b) => (b.over30 + b.under30) - (a.over30 + a.under30));
            const repsHtml = reps.length === 0
                ? `<div class="day-empty">No sign-ups recorded for this day yet.</div>`
                : reps.map(r => `
                    <div class="day-rep-row">
                        <div class="day-rep-name">${escapeHtml(r.name)}</div>
                        <div class="day-rep-stats">
                            ${r.over30 > 0 ? `<span class="tier">${r.over30} × £15+</span>` : ''}
                            ${r.under30 > 0 ? `<span class="tier">${r.under30} × £12</span>` : ''}
                        </div>
                    </div>`).join('');

            const overlay = document.getElementById('dayOverlay');
            overlay.innerHTML = `
                <div class="day-sheet" onclick="event.stopPropagation()">
                    <div class="day-handle"></div>
                    <div class="day-head">
                        <div style="flex:1;">
                            <div class="day-head-title">${dayLabel}</div>
                            <div class="day-head-sub">Office totals · read-only</div>
                        </div>
                        <button class="day-close" onclick="closeDayModal()" aria-label="Close">×</button>
                    </div>
                    <div class="day-tiles">
                        <div class="day-tile primary"><div class="day-tile-head"><span class="chip-icon primary">⚡</span><span class="day-tile-lbl">Sign-ups</span></div><div class="day-tile-val">${sales}</div></div>
                        <div class="day-tile"><div class="day-tile-head"><span class="day-tile-lbl">P/A</span></div><div class="day-tile-val">${pa}</div></div>
                        <div class="day-tile"><div class="day-tile-head"><span class="day-tile-lbl">£15+</span></div><div class="day-tile-val">${over30}</div></div>
                        <div class="day-tile"><div class="day-tile-head"><span class="day-tile-lbl">£12</span></div><div class="day-tile-val">${under30}</div></div>
                        <div class="day-tile"><div class="day-tile-head"><span class="day-tile-lbl">£15+ %</span></div><div class="day-tile-val">${hiRate}%</div></div>
                        <div class="day-tile"><div class="day-tile-head"><span class="chip-icon green">🍃</span><span class="day-tile-lbl">Working</span></div><div class="day-tile-val">${working}</div></div>
                    </div>
                    <div class="day-section-title">BAs with sign-ups (${reps.length})</div>
                    ${repsHtml}
                </div>`;
            overlay.classList.add('open');
        }
        function closeDayModal() {
            const overlay = document.getElementById('dayOverlay');
            overlay.classList.remove('open');
            overlay.innerHTML = '';
        }
        // Close on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeDayModal();
        });

        function render() {
            if (!state.code) renderLockScreen();
            else renderMain();
        }

        // Initial fetch
        if (state.code) fetchData();
        else render();
    </script>
</body>
</html>
"""


@router.get("/public/bells/{office_slug}", response_class=HTMLResponse)
async def public_bells_html(office_slug: str):
    """Serves a self-contained HTML page that fetches weekly bells data from
    /api/public/bells/{office_slug}. Access is protected by the office's share code
    (either in the URL as ?code=... or entered on the unlock screen)."""
    safe_slug = "".join(c for c in (office_slug or "") if c.isalnum() or c in "-_")[:60]
    html = (
        _BELLS_PAGE_HTML.replace("__SLUG__", safe_slug or "")
        .replace("__OFFICE__", safe_slug.capitalize() or "Bells")
        # json.dumps gives a quoted JS string literal; "</" can't close the script.
        .replace("__APP_TZ_JSON__", json.dumps(APP_TZ_NAME).replace("</", "<\\/"))
    )
    return HTMLResponse(content=html, status_code=200)
