/**
 * Team Bulletin — weekly cross-office team power rankings.
 * Teams ranked by total sign-ups. Admins and leaders can share the locally
 * generated PDF; the underlying countrywide data is read-only.
 * Dark forest visual treatment matches the Weekly (sign-ups) Bulletin.
 *
 * The API still returns membership totals per team (not used by Vertex) —
 * they are deliberately never rendered.
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
import { Aurora } from '../src/components/ui/Aurora';
import { AnimatedNumber } from '../src/components/ui/AnimatedNumber';
import { Reveal } from '../src/components/ui/Reveal';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import {
  isoAddDays, lastWeekEndingISO as lastSundayISO, prettyWeekRange, prettyDate,
  posterWeekEnding, POSTER, colorForName, initialsOf,
} from '../src/utils/bulletinWeek';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL
  || (Constants.expoConfig?.extra as any)?.EXPO_PUBLIC_BACKEND_URL
  || '';
const LOGO_URL = `${BACKEND_URL}/api/logo.png`;
// Inlined base64 logo for the PDF (remote <img> prints as a broken blue square).
let _logoUri: string | null = null;

// ── Types ────────────────────────────────────────────────────────────────────
// total_sales = sign-ups; total_over30 / pct_gold = £15+ sign-ups and their share.
type TeamRow = {
  rank: number;
  team_name: string;
  leader_name: string;
  leader_avatar?: string | null;
  office: string;
  member_count: number;
  total_sales: number;
  /** Still sent by the API; not used by Vertex and never rendered. */
  total_memberships?: number;
  total_over30: number;
  piece_average: number;
  /** Still sent by the API; not used by Vertex and never rendered. */
  pct_membership?: number;
  pct_gold: number;
};
export type TeamBulletin = { week_ending: string; teams: TeamRow[] };

// ── Avatar ───────────────────────────────────────────────────────────────────
function Avatar({ uri, name, size = 48, ringColor }: { uri?: string | null; name: string; size?: number; ringColor?: string }) {
  const ring = ringColor ? { borderWidth: 3, borderColor: ringColor } : {};
  if (uri) {
    const src = uri.startsWith('data:') || uri.startsWith('http') ? uri : `data:image/jpeg;base64,${uri}`;
    return <Image source={{ uri: src }} style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: POSTER.mid }, ring]} />;
  }
  return (
    <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: colorForName(name), alignItems: 'center', justifyContent: 'center' }, ring]}>
      <Text style={{ color: '#fff', fontWeight: '900', fontSize: size * 0.36, letterSpacing: 0.3 }}>{initialsOf(name)}</Text>
    </View>
  );
}

// ── Rank medal colours (1st / 2nd / 3rd) ─────────────────────────────────────
const MEDAL_BG: Record<number, string> = { 1: POSTER.amber, 2: '#a9b8ad', 3: '#b07a45' };
const MEDAL_RING: Record<number, string> = { 1: POSTER.lime, 2: '#a9b8ad', 3: '#b07a45' };

// ── PDF builder ───────────────────────────────────────────────────────────────
export function buildTeamBulletinHtml(b: TeamBulletin): string {
  const P = POSTER;
  const teams = b.teams.slice(0, 5);
  const esc = (s: string) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  const avatarHtml = (t: TeamRow, size: number, ring?: string) => {
    const src = t.leader_avatar
      ? (t.leader_avatar.startsWith('data:') || t.leader_avatar.startsWith('http') ? t.leader_avatar : `data:image/jpeg;base64,${t.leader_avatar}`)
      : '';
    if (src) return `<img src="${src}" style="width:${size}pt;height:${size}pt;border-radius:50%;object-fit:cover;background:${P.mid};${ring ? `border:3pt solid ${ring};box-sizing:border-box;` : ''}" />`;
    const bg = colorForName(t.leader_name || '');
    return `<div style="width:${size}pt;height:${size}pt;border-radius:50%;background:${bg};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:${Math.round(size * 0.36)}pt;${ring ? `border:3pt solid ${ring};box-sizing:border-box;` : ''}">${esc(initialsOf(t.leader_name || ''))}</div>`;
  };

  // "WEEK ENDING 5 OCTOBER" stamp (UTC formatting — a date-only string never rolls).
  const weStamp = posterWeekEnding(b.week_ending);
  const plural = (n: number) => `${n} ${n === 1 ? 'member' : 'members'}`;

  const masthead = `
    <div style="background:${P.forest};padding:14pt 18pt;display:flex;align-items:center;justify-content:space-between;border-bottom:3pt solid ${P.lime};">
      <div style="display:flex;align-items:center;gap:14pt;">
        <!-- Transparent lime wordmark — always on forest, never on white. -->
        <img src="${_logoUri || LOGO_URL}" style="height:30pt;width:auto;max-width:110pt;object-fit:contain;display:block;" />
        <div>
          <div style="color:${P.paper};font-weight:900;font-size:20pt;letter-spacing:1.5pt;text-transform:uppercase;">Team Bulletin</div>
          <div style="font-family:${P.mono};color:${P.rule};font-size:8.5pt;font-weight:700;letter-spacing:1pt;margin-top:2pt;text-transform:uppercase;">Vertex Organisation · w/e ${esc(prettyDate(b.week_ending))}</div>
        </div>
      </div>
      <div style="background:${P.lime};color:${P.forest};padding:6pt 12pt;border-radius:6pt;font-weight:900;font-size:10pt;letter-spacing:0.6pt;text-align:right;line-height:1.1;">
        WEEK ENDING<br/><span style="font-size:13pt;">${esc(weStamp)}</span>
      </div>
    </div>`;

  const titleBanner = `
    <div style="text-align:center;margin:10pt 0 14pt 0;">
      <span style="color:${P.lime};font-size:20pt;letter-spacing:1pt;">★ ★</span>
      <span style="background:${P.lime};color:${P.forest};padding:8pt 22pt;font-weight:900;font-size:18pt;letter-spacing:1.4pt;border-radius:4pt;margin:0 10pt;">TEAM POWER RANKINGS</span>
      <span style="color:${P.lime};font-size:20pt;letter-spacing:1pt;">★ ★</span>
      <div style="font-family:${P.mono};color:${P.rule};font-size:10pt;font-weight:700;letter-spacing:1.2pt;margin-top:9pt;text-transform:uppercase;">Total weekly sign-ups · All offices</div>
    </div>`;

  // Hero block for #1 team
  const hero = teams[0];
  const heroBlock = hero ? `
    <div style="display:flex;align-items:flex-start;gap:20pt;padding:14pt 18pt;background:${P.forest};border-radius:10pt;border:2pt solid ${P.lime};margin-bottom:10pt;">
      <div style="position:relative;flex-shrink:0;">
        ${avatarHtml(hero, 110, P.lime)}
        <div style="position:absolute;right:-6pt;bottom:4pt;width:38pt;height:38pt;border-radius:50%;background:${P.amber};display:flex;align-items:center;justify-content:center;border:2pt solid ${P.paper};font-size:18pt;">🏆</div>
      </div>
      <div style="flex:1;">
        <div style="font-family:${P.mono};color:${P.lime};font-size:8.5pt;font-weight:700;letter-spacing:1.2pt;text-transform:uppercase;margin-bottom:4pt;">🥇 #1 TEAM</div>
        <div style="color:${P.paper};font-size:22pt;font-weight:900;letter-spacing:-0.3pt;line-height:1.05;">${esc(hero.team_name)}</div>
        <div style="color:${P.rule};font-size:11pt;font-weight:700;margin-top:3pt;">Led by ${esc(hero.leader_name)} &nbsp;·&nbsp; ${esc(hero.office)}</div>
        <div style="display:flex;gap:12pt;margin-top:10pt;flex-wrap:wrap;">
          <span style="background:${P.mid};color:${P.paper};padding:4pt 10pt;border-radius:20pt;font-size:9.5pt;font-weight:700;">${plural(hero.member_count)}</span>
          <span style="background:${P.lime};color:${P.forest};padding:4pt 10pt;border-radius:20pt;font-size:9.5pt;font-weight:700;">£15+ ${hero.pct_gold.toFixed(1)}%</span>
          <span style="background:${P.deep};color:${P.rule};padding:4pt 10pt;border-radius:20pt;font-size:9.5pt;font-weight:700;">P/A ${hero.piece_average.toFixed(1)}</span>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div style="color:${P.lime};font-size:48pt;font-weight:900;line-height:1;font-variant-numeric:tabular-nums;">${hero.total_sales}</div>
        <div style="font-family:${P.mono};color:${P.rule};font-size:7.5pt;font-weight:700;text-transform:uppercase;letter-spacing:1pt;">sign-ups</div>
      </div>
    </div>` : '';

  // Ranks 2+ rows
  const RANK_COLOR: Record<number, string> = { 2: '#a9b8ad', 3: '#b07a45' };
  const restRows = teams.slice(1).map((t) => {
    const rankColor = RANK_COLOR[t.rank] || P.mid;
    const rankLabel = t.rank === 2 ? '🥈' : t.rank === 3 ? '🥉' : `#${t.rank}`;
    return `
      <div style="display:flex;align-items:center;gap:14pt;padding:10pt 14pt;background:${P.forest};border-radius:8pt;margin-bottom:7pt;border:1pt solid ${P.mid};">
        <div style="width:36pt;height:36pt;border-radius:50%;background:${rankColor};color:${P.paper};display:flex;align-items:center;justify-content:center;font-weight:900;font-size:${t.rank <= 3 ? '18' : '13'}pt;flex-shrink:0;">${rankLabel}</div>
        ${avatarHtml(t, 48)}
        <div style="flex:1;min-width:0;">
          <div style="color:${P.paper};font-size:14pt;font-weight:900;letter-spacing:0.2pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t.team_name)}</div>
          <div style="color:${P.rule};font-size:9pt;font-weight:700;margin-top:2pt;">${esc(t.leader_name)} · ${esc(t.office)}</div>
          <div style="display:flex;gap:8pt;margin-top:5pt;">
            <span style="color:${P.rule};font-size:8.5pt;font-weight:600;">${plural(t.member_count)}</span>
            <span style="color:${P.lime};font-size:8.5pt;font-weight:700;">£15+ ${t.pct_gold.toFixed(1)}%</span>
            <span style="color:${P.rule};font-size:8.5pt;font-weight:600;">P/A ${t.piece_average.toFixed(1)}</span>
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="color:${P.paper};font-size:20pt;font-weight:900;font-variant-numeric:tabular-nums;line-height:1;">${t.total_sales}</div>
          <div style="font-family:${P.mono};color:${P.rule};font-size:7pt;font-weight:700;text-transform:uppercase;letter-spacing:0.8pt;">sign-ups</div>
        </div>
      </div>`;
  }).join('');

  // Cityscape SVG
  const cityscape = `
    <svg viewBox="0 0 600 90" preserveAspectRatio="none" style="display:block;width:100%;height:55pt;margin-top:12pt;">
      <rect x="0" y="0" width="600" height="90" fill="${P.forest}" />
      <g fill="${P.mid}">
        <rect x="0"   y="40" width="40" height="50" /><rect x="38"  y="22" width="46" height="68" />
        <rect x="82"  y="50" width="32" height="40" /><rect x="112" y="32" width="50" height="58" />
        <rect x="160" y="46" width="38" height="44" /><rect x="196" y="18" width="58" height="72" />
        <rect x="252" y="38" width="42" height="52" /><rect x="292" y="26" width="48" height="64" />
        <rect x="338" y="50" width="34" height="40" /><rect x="370" y="34" width="52" height="56" />
        <rect x="420" y="20" width="44" height="70" /><rect x="462" y="46" width="38" height="44" />
        <rect x="498" y="30" width="50" height="60" /><rect x="546" y="44" width="54" height="46" />
      </g>
      <g fill="${P.lime}" opacity="0.5">
        ${(() => {
          const dots: string[] = [];
          for (let x = 6; x < 600; x += 10) {
            for (let y = 30; y < 86; y += 8) {
              if (((x * 31 + y * 17) % 7) === 0) dots.push(`<rect x="${x}" y="${y}" width="2" height="2" />`);
            }
          }
          return dots.join('');
        })()}
      </g>
    </svg>`;

  const empty = teams.length === 0
    ? `<div style="text-align:center;padding:32pt;color:${P.rule};font-size:12pt;">No team data for this week.</div>`
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
  @page { size: 612pt 1008pt; margin: 0; }
  html, body { margin: 0; padding: 0; background: ${P.deep} !important; }
  body { font-family: ${P.font}; color: ${P.paper}; }
  .canvas { background: ${P.deep}; min-height: 1008pt; width: 100%; }
</style></head>
<body>
<div class="canvas">
  ${masthead}
  <div style="padding:14pt 18pt 0 18pt;background:${P.deep};">
    ${titleBanner}
    ${heroBlock}${empty}
    ${restRows}
  </div>
  ${cityscape}
  <div style="background:${P.deep};padding:8pt 18pt;text-align:center;">
    <div style="font-family:${P.mono};font-size:7.5pt;color:${P.rule};font-weight:700;letter-spacing:1pt;text-transform:uppercase;">Vertex Organisation · w/e ${esc(prettyDate(b.week_ending))} · Generated by Vertex Hub · All offices combined</div>
  </div>
</div>
</body></html>`;
}

// ── Reusable poster export (consumed by /share-bulletins) ──────────────────
// Produces the exact poster HTML the in-screen share button feeds to
// exportPdfFromHtml: inlines the logo, then builds the page. No visual
// changes — the screen's own export keeps using exportPdf below.
export async function getTeamBulletinPosterHtml(b: TeamBulletin): Promise<string> {
  _logoUri = await remoteImageDataUri(LOGO_URL);
  return buildTeamBulletinHtml(b);
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function TeamBulletinScreen() {
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
    queryKey: ['team-bulletin', weekEnding],
    queryFn: () => apiService.getTeamBulletin(weekEnding).then((r) => r.data as TeamBulletin),
    staleTime: 1000 * 60 * 5,
  });
  const data = q.data;

  const weekChoices = useMemo(() => {
    const base = lastSundayISO();
    const arr: string[] = [];
    for (let i = 0; i < 12; i++) arr.push(isoAddDays(base, -7 * i));
    return arr;
  }, []);

  const exportPdf = async () => {
    if (!data) return;
    const printWin = openBlankPrintWindow();
    try {
      setPdfBusy(true);
      _logoUri = await remoteImageDataUri(LOGO_URL);
      const html = buildTeamBulletinHtml(data);
      await exportPdfFromHtml(html, { width: 612, height: 1008, dialogTitle: 'Share Team Bulletin', filename: 'team-bulletin.pdf' }, printWin);
    } catch (e: any) {
      if (printWin && !printWin.closed) { try { printWin.close(); } catch { /* ignore */ } }
      toast.error('PDF failed', e?.message || 'Try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  useEffect(() => {
    if (!autoshare || autoshareFired || !data || pdfBusy) return;
    setAutoshareFired(true);
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
        <Text style={styles.headerTitle}>Team Bulletin</Text>
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
        {/* Dark banner */}
        <View style={styles.banner}>
          <Aurora />
          <View style={styles.bannerContent}>
            <Text style={styles.bannerSuper}>TEAM POWER RANKINGS</Text>
            <Text style={styles.bannerWeek}>w/e {prettyDate(weekEnding)} · All offices</Text>
          </View>
          <Text style={{ fontSize: 32 }}>🏅</Text>
        </View>

        {q.isLoading ? (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <BrandLoader size={52} />
            <Text style={{ marginTop: 12, color: colors.textMuted, fontWeight: '700' }}>Loading team bulletin…</Text>
          </View>
        ) : q.isError ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={24} color="#ef4444" />
            <Text style={styles.errorText}>
              Couldn't load bulletin. {(q.error as any)?.response?.data?.detail || 'Try again.'}
            </Text>
            <TouchableOpacity onPress={() => q.refetch()} style={styles.retryBtn}>
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : !data ? null : data.teams.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>No team data for this week.</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 12 }}>
            {data.teams.slice(0, 5).map((t, i) => {
              const isFirst = t.rank === 1;
              const medalBg = MEDAL_BG[t.rank] || POSTER.mid;
              const ringColor = MEDAL_RING[t.rank];
              return (
                <Reveal key={t.rank} index={i}>
                <View style={[styles.teamCard, isFirst && styles.teamCardFirst]}>
                  {/* Rank badge + avatar row */}
                  <View style={styles.teamTop}>
                    <View style={[styles.rankBadge, { backgroundColor: medalBg }]}>
                      <Text style={styles.rankBadgeText}>
                        {t.rank === 1 ? '🏆' : t.rank === 2 ? '🥈' : t.rank === 3 ? '🥉' : `#${t.rank}`}
                      </Text>
                    </View>
                    <Avatar
                      uri={t.leader_avatar}
                      name={t.leader_name}
                      size={isFirst ? 56 : 44}
                      ringColor={ringColor}
                    />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={[styles.teamName, isFirst && styles.teamNameFirst]} numberOfLines={1}>
                        {t.team_name}
                      </Text>
                      <Text style={styles.leaderName} numberOfLines={1}>
                        Led by {t.leader_name}
                      </Text>
                      <Text style={styles.officeName} numberOfLines={1}>
                        {t.office}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <AnimatedNumber value={t.total_sales} decimals={0} style={[styles.salesNum, isFirst && { color: POSTER.lime }]} />
                      <Text style={styles.salesLabel}>total sign-ups</Text>
                    </View>
                  </View>

                  {/* Stats row */}
                  <View style={styles.statsRow}>
                    <View style={[styles.statPill, { backgroundColor: POSTER.mid }]}>
                      <Text style={[styles.statPillText, { color: POSTER.paper }]}>{t.member_count} {t.member_count === 1 ? 'member' : 'members'}</Text>
                    </View>
                    <View style={[styles.statPill, { backgroundColor: POSTER.lime }]}>
                      <Text style={[styles.statPillText, { color: POSTER.forest }]}>£15+ {t.pct_gold.toFixed(1)}%</Text>
                    </View>
                    <View style={[styles.statPill, { backgroundColor: 'rgba(240,244,233,0.10)' }]}>
                      <Text style={[styles.statPillText, { color: colors.inkMuted }]}>P/A {t.piece_average.toFixed(1)}</Text>
                    </View>
                  </View>
                </View>
                </Reveal>
              );
            })}

            <View style={styles.footerLine}>
              <Text style={styles.footerText}>Vertex Organisation · w/e {prettyDate(weekEnding)} · All offices</Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Week picker modal */}
      <Modal visible={showWeekPicker} transparent animationType="slide" onRequestClose={() => setShowWeekPicker(false)}>
        <Pressable style={styles.pickerBackdrop} onPress={() => setShowWeekPicker(false)}>
          <Pressable style={[styles.pickerSheet, { backgroundColor: colors.surface }]} onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.pickerHandle} />
            <Text style={styles.pickerTitle}>Select Week</Text>
            <ScrollView style={{ maxHeight: 380 }}>
              {weekChoices.map((wk) => (
                <TouchableOpacity
                  key={wk}
                  style={[styles.pickerRow, wk === weekEnding && styles.pickerRowActive]}
                  onPress={() => { setWeekEnding(wk); setShowWeekPicker(false); }}
                >
                  <Text style={[styles.pickerRowText, wk === weekEnding && styles.pickerRowTextActive]}>
                    {prettyWeekRange(wk)}
                  </Text>
                  {wk === weekEnding && <Ionicons name="checkmark" size={16} color={colors.primary} />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  root: { flex: 1 },
  headerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerBtn: { padding: 4, minWidth: 32, alignItems: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '900', color: colors.text },
  weekChipRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  weekChipText: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.primary },
  banner: {
    margin: 12, borderRadius: 14, padding: 16,
    backgroundColor: colors.ink,
    borderWidth: 1.5, borderColor: POSTER.lime,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: POSTER.lime, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } },
      android: { elevation: 4 },
      // web: match the iOS glow so the PWA isn't flat.
      default: { shadowColor: POSTER.lime, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } },
    }),
  },
  bannerContent: { flex: 1 },
  bannerSuper: { fontSize: 13, fontWeight: '900', color: POSTER.lime, letterSpacing: 1, textTransform: 'uppercase' },
  bannerWeek: { fontSize: 11, color: colors.inkMuted, fontWeight: '600', marginTop: 3 },
  teamCard: {
    marginHorizontal: 0, marginBottom: 10, borderRadius: 14,
    backgroundColor: colors.ink,
    borderWidth: 1, borderColor: POSTER.mid,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
      android: { elevation: 3 },
      // web: match the iOS card shadow so the PWA isn't flat.
      default: { shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
    }),
  },
  teamCardFirst: {
    borderColor: POSTER.lime, borderWidth: 2,
    ...Platform.select({
      ios: { shadowColor: POSTER.lime, shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
      // web: match the iOS glow so first place pops on the PWA too.
      default: { shadowColor: POSTER.lime, shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
    }),
  },
  teamTop: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10 },
  rankBadge: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  rankBadgeText: { fontSize: 16, fontWeight: '900', color: '#fff' },
  teamName: { fontSize: 15, fontWeight: '900', color: colors.inkText, letterSpacing: -0.3 },
  teamNameFirst: { fontSize: 17, color: POSTER.lime },
  leaderName: { fontSize: 11, color: colors.inkMuted, marginTop: 1, fontWeight: '600' },
  officeName: { fontSize: 10, color: colors.inkMuted, fontWeight: '600' },
  salesNum: { fontSize: 28, fontWeight: '900', color: colors.inkText, lineHeight: 30, fontVariant: ['tabular-nums'] },
  salesLabel: { fontSize: 8, fontWeight: '700', color: colors.inkMuted, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'right' },
  statsRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    paddingHorizontal: 14, paddingBottom: 12,
  },
  statPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  statPillText: { fontSize: 10, fontWeight: '700' },
  footerLine: { alignItems: 'center', paddingVertical: 20 },
  footerText: { fontSize: 10, color: colors.textMuted, fontWeight: '600', letterSpacing: 0.3 },
  errorBox: { margin: 20, padding: 20, borderRadius: 12, backgroundColor: '#fef2f2', alignItems: 'center', gap: 10 },
  errorText: { fontSize: 13, color: '#ef4444', textAlign: 'center', fontWeight: '600' },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, backgroundColor: '#ef4444' },
  retryBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  emptyBox: { margin: 40, alignItems: 'center' },
  emptyText: { fontSize: 14, color: colors.textMuted, fontWeight: '600', textAlign: 'center' },
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  pickerSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 12, paddingHorizontal: 16, paddingBottom: 24 },
  pickerHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 },
  pickerTitle: { fontSize: 16, fontWeight: '900', color: colors.text, textAlign: 'center', marginBottom: 12 },
  pickerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, paddingHorizontal: 6,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  pickerRowActive: { backgroundColor: colors.surfaceAlt },
  pickerRowText: { fontSize: 14, fontWeight: '600', color: colors.text },
  pickerRowTextActive: { color: colors.primary, fontWeight: '800' },
});
