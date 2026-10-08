/**
 * Weekly Bulletin — Monday-morning leaderboard generator.
 *
 * Pulls cross-office Bells data for a chosen week and renders two top-5
 * boards: Sign-ups, and £15+ % (the share of a rep's sign-ups at £15/month
 * or more — Target or Premium). Admins and leaders can export the same
 * ready-to-view countrywide result; the underlying data is read-only.
 *
 * The API still returns `top_membership` (memberships aren't used by Vertex)
 * — it is deliberately never rendered.
 *
 * Permissions: admins + leaders (gated server-side too).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { remoteImageDataUri } from '../src/utils/remoteImageDataUri';
import { showAlert } from '../src/utils/showAlert';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Image, Modal, Pressable, Platform,  } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { exportPdfFromHtml, openBlankPrintWindow } from '../src/utils/deliverPdf';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Constants from 'expo-constants';
import { useColors } from '../src/theme/ThemeContext';
import { apiService } from '../src/api/client';
import { toast } from '../src/utils/toast';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { Aurora } from '../src/components/ui/Aurora';
import { formatMoney } from '../src/utils/appTime';
import {
  isoAddDays, lastWeekEndingISO as lastSundayISO, prettyWeekRange, prettyDate,
  posterWeekEnding, todayLong, POSTER, colorForName, initialsOf,
} from '../src/utils/bulletinWeek';

// Resolve absolute URL to the logo so expo-print can embed it in generated
// PDFs (file:// HTML can't resolve protocol-relative paths).
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL
  || (Constants.expoConfig?.extra as any)?.EXPO_PUBLIC_BACKEND_URL
  || '';
const LOGO_URL = `${BACKEND_URL}/api/logo.png`;
// Inlined base64 logo for the PDF (remote <img> prints as a broken blue square).
let _logoUri: string | null = null;

// ── Types matching backend `/bulletin/weekly` payload ──────────────────────
// `sales` = sign-ups, `over30` = £15+ sign-ups, `earnings` = estimated BA fees (£).
type SalesRow = { rank: number; user_id: string | null; name: string; office: string; avatar?: string | null; sales: number; earnings: number };
type PctRow   = { rank: number; user_id: string | null; name: string; office: string; avatar?: string | null; sales: number; memberships?: number; over30?: number; pct: number };
export type Bulletin = {
  week_ending: string;
  min_sales_pct: number;
  top_sales: SalesRow[];
  /** Still sent by the API; not used by Vertex and never rendered. */
  top_membership?: PctRow[];
  top_gold: PctRow[];
};

// ── Avatar tile (used in cards) ────────────────────────────────────────────
function Avatar({ uri, name, size = 56 }: { uri?: string | null; name: string; size?: number }) {
  if (uri) {
    // base64 data URLs come straight from /api/auth/me; otherwise prefix.
    const src = uri.startsWith('data:') || uri.startsWith('http') ? uri : `data:image/jpeg;base64,${uri}`;
    return (
      <Image
        source={{ uri: src }}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#ddd' }}
      />
    );
  }
  const bg = colorForName(name);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '900', fontSize: size * 0.36, letterSpacing: 0.3 }}>
        {initialsOf(name)}
      </Text>
    </View>
  );
}

// ── Generic leaderboard card ───────────────────────────────────────────────
function LeaderboardCard({
  title, accent, onAccent, valueColor, rows, valueLabel, formatValue, secondaryLabel, formatSecondary, emptyHint,
  styles,
}: {
  title: string;
  accent: string;
  /** Header text colour on the accent band (forest on lime, white on forest). */
  onAccent: string;
  /** Metric colour on the card face — must read on a light surface. */
  valueColor: string;
  rows: any[];
  valueLabel: string;
  formatValue: (r: any) => string;
  secondaryLabel?: string;
  formatSecondary?: (r: any) => string;
  emptyHint: string;
  styles: any;
}) {
  return (
    <View style={[styles.boardCard, { borderColor: accent }]}>
      <View style={[styles.boardHeader, { backgroundColor: accent }]}>
        <Text style={[styles.boardTitle, { color: onAccent }]}>{title}</Text>
      </View>
      {rows.length === 0 ? (
        <View style={styles.boardEmpty}>
          <Text style={styles.boardEmptyText}>{emptyHint}</Text>
        </View>
      ) : (
        rows.map((r) => (
          <View key={r.rank} style={[styles.boardRow, r.rank === 1 && styles.boardRowFirst]}>
            <View style={[styles.rankBadge, r.rank === 1 && styles.rankBadgeFirst]}>
              <Text style={[styles.rankBadgeText, r.rank === 1 && styles.rankBadgeTextFirst]}>#{r.rank}</Text>
            </View>
            <Avatar uri={r.avatar} name={r.name} size={r.rank === 1 ? 50 : 40} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={[styles.repName, r.rank === 1 && styles.repNameFirst]} numberOfLines={1}>
                {r.name}
              </Text>
              <Text style={styles.repMeta} numberOfLines={1}>
                {r.office}{secondaryLabel ? ` · ${formatSecondary!(r)}` : ''}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[styles.metricValue, { color: valueColor }]}>{formatValue(r)}</Text>
              <Text style={styles.metricLabel}>{valueLabel}</Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

export default function BulletinScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const params = useLocalSearchParams<{ autoshare?: string; week_ending?: string }>();
  const autoshare = params?.autoshare === '1';
  const [weekEnding, setWeekEnding] = useState<string>(params.week_ending || lastSundayISO());
  const [showWeekPicker, setShowWeekPicker] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [autoshareFired, setAutoshareFired] = useState(false);

  const q = useQuery({
    queryKey: ['bulletin', weekEnding],
    queryFn: () => apiService.getWeeklyBulletin(weekEnding).then((r) => r.data as Bulletin),
    staleTime: 1000 * 60 * 5,
  });

  const data = q.data;

  // ── Build a list of recent Sunday week-endings for the picker. We show
  // the last 12 to keep the modal light.
  const weekChoices = useMemo(() => {
    const today = lastSundayISO();
    const arr: string[] = [];
    for (let i = 0; i < 12; i++) arr.push(isoAddDays(today, -7 * i));
    return arr;
  }, []);

  const exportPdf = async () => {
    if (!data) return;
    const printWin = openBlankPrintWindow(); // sync, before any await (iOS popup blocker)
    try {
      setPdfBusy(true);
      _logoUri = await remoteImageDataUri(LOGO_URL);
      const html = buildBulletinHtml(data);
      // A tall 612×1008pt page (US Legal size) gives the dark bulletin extra
      // vertical room so it lands on one page on native; web prints the HTML directly.
      await exportPdfFromHtml(html, { width: 612, height: 1008, dialogTitle: 'Share Weekly Bulletin', filename: 'weekly-bulletin.pdf' }, printWin);
    } catch (e: any) {
      if (printWin && !printWin.closed) { try { printWin.close(); } catch { /* ignore */ } }
      toast.error('PDF failed', e?.message || 'Try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  // ── Auto-share trigger (fired when /weekly-share routes us in with
  // ?autoshare=1 and the bulletin data has finished loading). One-shot
  // guard via autoshareFired so we never fire twice if the data refetches.
  useEffect(() => {
    if (!autoshare) return;
    if (autoshareFired) return;
    if (!data) return;
    if (pdfBusy) return;
    setAutoshareFired(true);
    // Defer one tick to make sure we're past the initial mount/render
    setTimeout(() => { exportPdf(); }, 250);
  }, [autoshare, autoshareFired, data, pdfBusy]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Header bar */}
      <View style={styles.headerBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Weekly Bulletin</Text>
        <TouchableOpacity
          onPress={exportPdf}
          disabled={pdfBusy || !data}
          style={[styles.headerBtn, (pdfBusy || !data) && { opacity: 0.4 }]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Export and share as PDF"
        >
          <Ionicons name={pdfBusy ? 'hourglass-outline' : 'share-outline'} size={20} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* Week picker chip */}
      <TouchableOpacity style={styles.weekChipRow} onPress={() => setShowWeekPicker(true)}>
        <Ionicons name="calendar-outline" size={14} color={colors.primary} />
        <Text style={styles.weekChipText}>{prettyWeekRange(weekEnding)}</Text>
        <Ionicons name="chevron-down" size={14} color={colors.primary} />
      </TouchableOpacity>

      <ScrollView contentContainerStyle={{ paddingBottom: 32 + tabBarClearance }} showsVerticalScrollIndicator={false}>
        {/* Vertex branding banner (visible in-app + sets the tone) */}
        <View style={styles.bannerWrap}>
          <View style={styles.bannerInner}>
            <Aurora />
            <Image source={{ uri: '/api/logo.png' }} style={styles.bannerLogo} resizeMode="contain" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.bannerLabel}>Vertex Hub · Weekly Bulletin</Text>
              <Text style={styles.bannerWeek}>w/e {prettyDate(weekEnding)} · All offices</Text>
            </View>
            <Ionicons name="trophy" size={28} color={POSTER.lime} />
          </View>
        </View>

        {q.isLoading ? (
          <View style={{ padding: 32, alignItems: 'center' }}>
            <BrandLoader size={52} />
            <Text style={{ marginTop: 12, color: colors.textMuted, fontWeight: '700' }}>Loading bulletin…</Text>
          </View>
        ) : q.isError ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={24} color="#ef4444" />
            <Text style={styles.errorText}>Couldn't load bulletin. {(q.error as any)?.response?.data?.detail || 'Try again.'}</Text>
            <TouchableOpacity onPress={() => q.refetch()} style={styles.retryBtn}>
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : !data ? null : (
          <View style={{ paddingHorizontal: 12 }}>
            <LeaderboardCard
              title="🏆 Top 5 Brand Ambassadors"
              accent={POSTER.forest}
              onAccent={POSTER.paper}
              valueColor={colors.text}
              rows={data.top_sales}
              valueLabel="Sign-ups"
              formatValue={(r) => `${r.sales}`}
              secondaryLabel="fees"
              formatSecondary={(r) => `${formatMoney(r.earnings || 0)} est. fees`}
              emptyHint="No sign-ups recorded for this week."
              styles={styles}
            />

            <View style={{ height: 14 }} />

            <LeaderboardCard
              title="Top 5 £15+ %"
              accent={POSTER.lime}
              onAccent={POSTER.forest}
              valueColor={colors.text}
              rows={data.top_gold}
              valueLabel="£15+ %"
              formatValue={(r) => `${r.pct.toFixed(1)}%`}
              secondaryLabel="sign-ups"
              formatSecondary={(r) => `${r.over30}/${r.sales} at £15+`}
              emptyHint={`No reps with ${data.min_sales_pct}+ sign-ups this week.`}
              styles={styles}
            />

            <View style={styles.footerLine}>
              <Text style={styles.footerText}>£15+ % = share of sign-ups at £15/month or more (Target or Premium)</Text>
              <Text style={styles.footerText}>£15+ % needs {data.min_sales_pct}+ sign-ups to qualify · Tied? More sign-ups wins.</Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Week picker modal */}
      <Modal visible={showWeekPicker} animationType="slide" transparent onRequestClose={() => setShowWeekPicker(false)}>
        <Pressable style={styles.pickerBackdrop} onPress={() => setShowWeekPicker(false)}>
          <Pressable style={[styles.pickerSheet, { backgroundColor: colors.surface }]} onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.pickerHandle} />
            <Text style={styles.pickerTitle}>Select Week</Text>
            <ScrollView style={{ maxHeight: 380 }}>
              {weekChoices.map((wk) => (
                <TouchableOpacity
                  key={wk}
                  style={[styles.pickerRow, weekEnding === wk && styles.pickerRowActive]}
                  onPress={() => { setWeekEnding(wk); setShowWeekPicker(false); }}
                >
                  <Text style={[styles.pickerRowText, weekEnding === wk && styles.pickerRowTextActive]}>
                    {prettyWeekRange(wk)}
                  </Text>
                  <Text style={[styles.pickerRowSub, weekEnding === wk && styles.pickerRowTextActive]}>w/e {prettyDate(wk)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ── HTML builder for PDF export ────────────────────────────────────────────
// A dark forest poster: a #1 hero with a big circular photo and a trophy
// badge, a banner-ribbon name plate, numbered lime chips for ranks 2-5, a
// cityscape silhouette tying the page together, and the £15+ % board below.
// Vertex branding sits in the masthead. All styling is inline so expo-print
// renders it identically on iOS / Android / web.
export function buildBulletinHtml(b: Bulletin): string {
  const P = POSTER;
  const escape = (s: string) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  const avatarHtml = (r: any, size: number, ring?: string) => {
    const src = r.avatar
      ? (r.avatar.startsWith('data:') || r.avatar.startsWith('http') ? r.avatar : `data:image/jpeg;base64,${r.avatar}`)
      : '';
    if (src) {
      return `<img src="${src}" style="width:${size}pt;height:${size}pt;border-radius:50%;object-fit:cover;background:${P.mid};${ring ? `border:3pt solid ${ring};box-sizing:border-box;` : ''}" />`;
    }
    const bg = colorForName(r.name || '');
    return `<div style="width:${size}pt;height:${size}pt;border-radius:50%;background:${bg};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:${Math.round(size * 0.36)}pt;letter-spacing:0.3pt;${ring ? `border:3pt solid ${ring};box-sizing:border-box;` : ''}">${escape(initialsOf(r.name || ''))}</div>`;
  };

  // "WEEK ENDING 5 OCTOBER" stamp (UTC formatting — a date-only string never rolls).
  const weStamp = posterWeekEnding(b.week_ending);

  // ── Hero (#1 in Top Sign-ups) — big circular photo with trophy + ribbon
  const hero = b.top_sales[0];
  const heroBlock = hero ? `
    <div style="position:relative;display:inline-block;width:170pt;text-align:center;">
      <div style="position:relative;width:170pt;height:170pt;display:inline-block;">
        ${avatarHtml(hero, 170, P.lime)}
        <!-- Trophy corner badge -->
        <div style="position:absolute;right:-6pt;bottom:6pt;width:46pt;height:46pt;border-radius:50%;background:${P.amber};display:flex;align-items:center;justify-content:center;border:3pt solid ${P.paper};box-shadow:0 1pt 3pt rgba(0,0,0,0.25);font-size:22pt;">🏆</div>
        <!-- Ribbon hangs from the badge -->
        <div style="position:absolute;right:8pt;bottom:-14pt;width:0;height:0;border-left:9pt solid transparent;border-right:9pt solid transparent;border-top:14pt solid ${P.limeDark};"></div>
      </div>
      <!-- Banner-ribbon name plate -->
      <div style="position:relative;margin-top:18pt;background:${P.mid};color:${P.paper};padding:10pt 20pt;font-weight:900;letter-spacing:0.6pt;font-size:17pt;text-transform:uppercase;clip-path:polygon(8pt 0,calc(100% - 8pt) 0,100% 50%,calc(100% - 8pt) 100%,8pt 100%,0 50%);">
        ${escape((hero.name || '').toUpperCase())}<br/>
        <span style="font-family:${P.mono};font-size:10pt;letter-spacing:0.8pt;color:${P.lime};">${hero.sales} SIGN-UPS · ${escape((hero.office || '').toUpperCase())}<br/>${escape(formatMoney(hero.earnings || 0))} EST. FEES</span>
      </div>
    </div>` : '';

  // ── Numbered list for ranks 2..5 of Top Sign-ups (right column next to hero)
  // Light text on the dark canvas; the lime chip carries the sign-up count.
  const numberedRowHtml = (name: string, office: string, value: string, earnings?: number) => `
    <div style="display:flex;align-items:center;gap:12pt;padding:8pt 0;border-bottom:0.6pt solid ${P.mid};">
      <div style="background:${P.lime};color:${P.forest};width:34pt;height:34pt;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:15pt;font-variant-numeric:tabular-nums;flex-shrink:0;">${value}</div>
      <div style="flex:1;line-height:1.15;">
        <div style="color:${P.paper};font-weight:900;font-size:16pt;letter-spacing:0.5pt;text-transform:uppercase;">${escape(name)}</div>
        <div style="font-family:${P.mono};color:${P.rule};font-weight:700;font-size:9.5pt;letter-spacing:0.8pt;text-transform:uppercase;">${escape(office)}${earnings != null ? ` · <span style="color:${P.amber};">${escape(formatMoney(earnings))}</span>` : ''}</div>
      </div>
    </div>`;
  const restList = b.top_sales.slice(1).map((r) =>
    numberedRowHtml(r.name || '', r.office || '', String(r.sales), r.earnings)
  ).join('');

  // ── Mini-hero for #1 in £15+ % — circular photo with a lime ring, name +
  // office + big pct text below. Sits beside the rest list (ranks 2-5).
  const miniHeroBlock = (r: any, valueText: string) => `
    <div style="text-align:center;">
      <div style="display:inline-block;">${avatarHtml(r, 90, P.lime)}</div>
      <div style="margin-top:8pt;color:${P.paper};font-weight:900;font-size:14pt;letter-spacing:0.5pt;text-transform:uppercase;line-height:1.1;">${escape(r.name || '')}</div>
      <div style="font-family:${P.mono};color:${P.rule};font-weight:700;font-size:9pt;letter-spacing:0.8pt;text-transform:uppercase;margin-top:2pt;">${escape(r.office || '')}</div>
      <div style="color:${P.lime};font-weight:900;font-size:22pt;font-variant-numeric:tabular-nums;margin-top:5pt;letter-spacing:0.4pt;">${escape(valueText)}</div>
    </div>`;

  // Ranks 2..5 in the £15+ % panel — numbered rank chip + name + office + pct.
  const compactRow = (rank: number, r: any, valueText: string) => `
    <div style="display:flex;align-items:center;gap:10pt;padding:6pt 0;border-bottom:0.6pt solid ${P.mid};">
      <div style="background:${P.mid};color:${P.paper};width:24pt;height:24pt;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11pt;flex-shrink:0;">${rank}</div>
      <div style="flex:1;line-height:1.15;min-width:0;">
        <div style="color:${P.paper};font-weight:900;font-size:13pt;letter-spacing:0.3pt;">${escape(r.name || '')}</div>
        <div style="font-family:${P.mono};color:${P.rule};font-weight:700;font-size:8.5pt;letter-spacing:0.8pt;text-transform:uppercase;">${escape(r.office || '')} · ${r.over30 ?? 0}/${r.sales} at £15+</div>
      </div>
      <div style="color:${P.lime};font-weight:900;font-size:14pt;font-variant-numeric:tabular-nums;">${escape(valueText)}</div>
    </div>`;

  // The £15+ % panel: mini-hero on the left, ranks 2-5 on the right.
  const pctRows = b.top_gold || [];
  const fmtPct = (r: any) => `${r.pct.toFixed(1)}%`;
  const pctPanelBody = pctRows.length === 0
    ? `<div style="color:${P.rule};font-style:italic;font-size:11pt;padding:14pt 0;text-align:center;">No reps with ${b.min_sales_pct}+ sign-ups this week</div>`
    : `<table style="width:100%;border-collapse:collapse;"><tr>
        <td style="width:40%;vertical-align:top;padding-right:12pt;">${miniHeroBlock(pctRows[0], fmtPct(pctRows[0]))}</td>
        <td style="width:60%;vertical-align:top;padding-left:14pt;border-left:1pt dashed ${P.mid};">
          ${pctRows.slice(1).map((r) => compactRow(r.rank, r, fmtPct(r))).join('') || `<div style="color:${P.rule};font-style:italic;font-size:11pt;padding:10pt 0;">Only one rep qualified this week.</div>`}
        </td>
      </tr></table>`;

  // Cityscape silhouette — pure SVG so it renders in expo-print's HTML pipe
  // without external images. Bands of buildings with windows for visual depth.
  const cityscape = `
    <svg viewBox="0 0 600 90" preserveAspectRatio="none" style="display:block;width:100%;height:55pt;margin-top:8pt;">
      <rect x="0" y="0" width="600" height="90" fill="${P.forest}" />
      <g fill="${P.mid}">
        <rect x="0"   y="40" width="40" height="50" />
        <rect x="38"  y="22" width="46" height="68" />
        <rect x="82"  y="50" width="32" height="40" />
        <rect x="112" y="32" width="50" height="58" />
        <rect x="160" y="46" width="38" height="44" />
        <rect x="196" y="18" width="58" height="72" />
        <rect x="252" y="38" width="42" height="52" />
        <rect x="292" y="26" width="48" height="64" />
        <rect x="338" y="50" width="34" height="40" />
        <rect x="370" y="34" width="52" height="56" />
        <rect x="420" y="20" width="44" height="70" />
        <rect x="462" y="46" width="38" height="44" />
        <rect x="498" y="30" width="50" height="60" />
        <rect x="546" y="44" width="54" height="46" />
      </g>
      <g fill="${P.amber}" opacity="0.6">
        ${(() => {
          // Sprinkle window dots deterministically
          const dots: string[] = [];
          for (let x = 6; x < 600; x += 10) {
            for (let y = 30; y < 86; y += 8) {
              if (((x * 31 + y * 17) % 7) === 0) {
                dots.push(`<rect x="${x}" y="${y}" width="2" height="2" />`);
              }
            }
          }
          return dots.join('');
        })()}
      </g>
    </svg>`;

  // Big "BA HIGH ROLLERS" banner above the hero
  const titleBanner = `
    <div style="text-align:center;margin:8pt 0 16pt 0;">
      <span style="color:${P.lime};font-size:18pt;letter-spacing:1pt;">★ ★</span>
      <span style="background:${P.lime};color:${P.forest};padding:8pt 22pt;font-weight:900;font-size:18pt;letter-spacing:1.4pt;border-radius:4pt;margin:0 10pt;">BA HIGH ROLLERS</span>
      <span style="color:${P.lime};font-size:18pt;letter-spacing:1pt;">★ ★</span>
      <div style="font-family:${P.mono};color:${P.rule};font-size:10pt;font-weight:700;letter-spacing:1.2pt;margin-top:9pt;text-transform:uppercase;">Sign-ups — Top 5</div>
    </div>`;

  // Forest masthead with the logo + week-ending pill
  const masthead = `
    <div style="background:${P.forest};padding:14pt 18pt;display:flex;align-items:center;justify-content:space-between;border-radius:0;border-bottom:3pt solid ${P.lime};">
      <div style="display:flex;align-items:center;gap:14pt;">
        <!-- Transparent lime wordmark — always on forest, never on white. -->
        <img src="${_logoUri || LOGO_URL}" style="height:30pt;width:auto;max-width:110pt;object-fit:contain;display:block;" />
        <div>
          <div style="color:${P.paper};font-weight:900;font-size:20pt;letter-spacing:1.5pt;text-transform:uppercase;">Weekly Bulletin</div>
          <div style="font-family:${P.mono};color:${P.rule};font-size:8.5pt;font-weight:700;letter-spacing:1pt;margin-top:2pt;text-transform:uppercase;">Vertex Organisation · w/e ${escape(prettyDate(b.week_ending))}</div>
        </div>
      </div>
      <div style="background:${P.lime};color:${P.forest};padding:6pt 12pt;border-radius:6pt;font-weight:900;font-size:10pt;letter-spacing:0.6pt;text-align:right;line-height:1.1;">
        WEEK ENDING<br/>
        <span style="font-size:13pt;">${escape(weStamp)}</span>
      </div>
    </div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  /* CRITICAL: WebKit's print-to-PDF pipeline strips body backgrounds and any
     CSS color it considers "print-paper". The declarations below force iOS
     expo-print to honour every background colour we set. Without them the
     bulletin's body bg renders white on page 1 and only div-bound colours
     (masthead/footer) show through. */
  *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
  @page { size: 612pt 1008pt; margin: 0; }
  html, body { margin: 0; padding: 0; background: ${P.deep} !important; -webkit-print-color-adjust: exact; }
  body { font-family: ${P.font}; color: ${P.paper}; }
  /* Full-page wrapper – guarantees a continuous dark canvas behind every
     section even when WebKit ignores body bg. min-height matches the page. */
  .bulletin-canvas { background: ${P.deep}; min-height: 1008pt; width: 100%; }
</style></head>
<body>
<div class="bulletin-canvas">
  ${masthead}

  <div style="padding: 14pt 22pt 0 22pt; background:${P.deep};">
    ${titleBanner}

    <!-- Hero row: big photo on left, numbered list on right -->
    <table style="width:100%;border-collapse:collapse;background:${P.deep};"><tr>
      <td style="width:50%;text-align:center;vertical-align:top;padding-right:8pt;background:${P.deep};">
        ${heroBlock || `<div style="color:${P.rule};font-style:italic;padding:30pt 0;font-size:11pt;">No sign-ups recorded for this week.</div>`}
      </td>
      <td style="width:50%;vertical-align:top;padding-left:14pt;border-left:2pt dashed ${P.mid};background:${P.deep};">
        ${restList || `<div style="color:${P.rule};font-style:italic;padding:10pt 0;font-size:11pt;">Only one rep ranked this week.</div>`}
      </td>
    </tr></table>
  </div>

  ${cityscape}

  <!-- £15+ % panel — forest card with lime accents -->
  <div style="background:${P.deep};padding:14pt 22pt;">
    <div style="background:${P.forest};border:1pt solid ${P.mid};border-radius:10pt;padding:14pt 16pt;">
      <div style="color:${P.lime};font-weight:900;font-size:14pt;letter-spacing:0.6pt;text-transform:uppercase;border-bottom:2pt solid ${P.lime};padding-bottom:7pt;margin-bottom:8pt;text-align:center;">★ Top £15+ %</div>
      <div style="font-family:${P.mono};font-size:8.5pt;color:${P.rule};font-weight:700;margin-bottom:12pt;letter-spacing:0.8pt;text-align:center;text-transform:uppercase;">Share of sign-ups at £15/month or more · min ${b.min_sales_pct} sign-ups</div>
      ${pctPanelBody}
    </div>
  </div>

  <div style="background:${P.deep};padding:12pt 22pt;text-align:center;border-top:1pt solid ${P.mid};">
    <div style="display:inline-flex;align-items:center;gap:8pt;">
      <img src="${_logoUri || LOGO_URL}" style="height:16pt;width:auto;max-width:60pt;object-fit:contain;background:${P.forest};border-radius:4pt;padding:3pt 5pt;" />
      <span style="font-family:${P.mono};color:${P.rule};font-size:8.5pt;font-weight:700;letter-spacing:1pt;text-transform:uppercase;">Vertex Organisation · ${escape(todayLong())}</span>
    </div>
  </div>
</div>
</body></html>`;
}

// ── Reusable poster export (consumed by /share-bulletins) ──────────────────
// Produces the exact poster HTML the in-screen share button feeds to
// exportPdfFromHtml: inlines the logo, then builds the page. No visual
// changes — the screen's own export keeps using exportPdf above.
export async function getSalesBulletinPosterHtml(b: Bulletin): Promise<string> {
  _logoUri = await remoteImageDataUri(LOGO_URL);
  return buildBulletinHtml(b);
}

// ── Styles ─────────────────────────────────────────────────────────────────
const createStyles = (colors: any) => StyleSheet.create({
  root: { flex: 1 },
  headerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '900', color: colors.text, letterSpacing: 0.3 },
  weekChipRow: {
    alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18,
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
    marginVertical: 10,
  },
  weekChipText: { fontSize: 13, fontWeight: '800', color: colors.text },
  bannerWrap: { paddingHorizontal: 12, marginBottom: 12 },
  bannerInner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.ink, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14,
    overflow: 'hidden',
  },
  // Transparent lime wordmark (~3:1) — sits on forest, never on white.
  bannerLogo: { width: 84, height: 30, backgroundColor: POSTER.forest, borderRadius: 6 },
  bannerLabel: { color: colors.inkText, fontWeight: '900', fontSize: 14, letterSpacing: 0.4 },
  bannerWeek: { color: colors.inkMuted, fontWeight: '700', fontSize: 11, marginTop: 2 },

  boardCard: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1.5, overflow: 'hidden' },
  boardHeader: { paddingHorizontal: 12, paddingVertical: 9 },
  boardTitle: { fontWeight: '900', fontSize: 13, letterSpacing: 0.4 },
  boardEmpty: { padding: 18, alignItems: 'center' },
  boardEmptyText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic' },
  boardRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  boardRowFirst: { backgroundColor: 'rgba(183,223,88,0.10)' },
  rankBadge: {
    backgroundColor: POSTER.mid, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4,
    minWidth: 30, alignItems: 'center',
  },
  rankBadgeFirst: { backgroundColor: POSTER.lime },
  rankBadgeText: { color: POSTER.paper, fontWeight: '900', fontSize: 11, letterSpacing: 0.3 },
  rankBadgeTextFirst: { color: POSTER.forest },
  repName: { fontSize: 14, fontWeight: '800', color: colors.text, letterSpacing: 0.2 },
  repNameFirst: { fontSize: 15, fontWeight: '900' },
  repMeta: { fontSize: 11, color: colors.textMuted, fontWeight: '700', marginTop: 1 },
  metricValue: { fontSize: 18, fontWeight: '900', letterSpacing: 0.3 },
  metricLabel: { fontSize: 9, color: colors.textMuted, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  footerLine: { paddingTop: 18, alignItems: 'center', gap: 4 },
  footerText: { fontSize: 10, color: colors.textMuted, fontWeight: '600' },

  errorBox: { padding: 24, alignItems: 'center', gap: 10 },
  errorText: { fontSize: 13, color: colors.text, textAlign: 'center', fontWeight: '700' },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  retryBtnText: { color: colors.onPrimary, fontWeight: '900', fontSize: 13 },

  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  pickerSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
  pickerHandle: { alignSelf: 'center', width: 38, height: 4, backgroundColor: colors.border, borderRadius: 2, marginBottom: 12 },
  pickerTitle: { fontSize: 17, fontWeight: '900', color: colors.text, marginBottom: 12 },
  pickerRow: { paddingVertical: 12, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: colors.border },
  pickerRowActive: { backgroundColor: colors.surfaceAlt, borderRadius: 10 },
  pickerRowText: { fontSize: 14, fontWeight: '800', color: colors.text },
  pickerRowSub: { fontSize: 11, color: colors.textMuted, marginTop: 2, fontWeight: '600' },
  pickerRowTextActive: { color: colors.primary },
});
