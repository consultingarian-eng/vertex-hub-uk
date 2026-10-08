// Public read-only Bells weekly snapshot — accessible without login.
// URL: /public/bells/{office-slug}?code=<share-code>&week=<YYYY-MM-DD (optional)>
// - Requires the office's unlock code (set by super admin from Admin → Offices).
// - Once entered, the code is persisted in localStorage/AsyncStorage so returning visitors skip the prompt.
// - Shows a weekly Table view (same layout as in-app Table) + a Daily Totals strip.
// - Offers CSV export for the current week.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { showAlert } from '../../../src/utils/showAlert';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Platform, Linking, Modal, Pressable,  } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../../../src/theme/colors';
import { lightColors } from '../../../src/theme/ThemeContext';
import { useColors } from '../../../src/theme/ThemeContext';
import { teamColor, NO_TEAM_TINT } from '../../../src/utils/teamColors';
import { APP_LOCALE, formatMoney } from '../../../src/utils/appTime';
import { SUPER_GREEN_WEEK_MIN, GREEN_WEEK_MIN, AMBER_WEEK_MIN, RED_WEEK_MAX } from '../../../src/utils/weekBands';

// ─────────────────────────── helpers ───────────────────────────
function currentWeekEndingISO(): string {
  const d = new Date();
  const dow = d.getDay();
  const offset = dow === 0 ? 0 : 7 - dow;
  d.setDate(d.getDate() + offset);
  // Use LOCAL date parts (not toISOString) so we don't skip to Monday when
  // it's late Sunday evening in timezones behind UTC.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function isoAddDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function prettyWeekRange(weekEnding: string): string {
  const end = new Date(weekEnding + 'T00:00:00Z');
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
  const fmt = (d: Date) => d.toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(start)} – ${fmt(end)}`;
}

// Tiny cross-platform storage shim (avoid auth/SecureStore — this is public-facing)
const storage = {
  get: async (key: string): Promise<string | null> => {
    try {
      if (Platform.OS === 'web') return (typeof window !== 'undefined' ? window.localStorage.getItem(key) : null);
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      return await AsyncStorage.getItem(key);
    } catch { return null; }
  },
  set: async (key: string, val: string) => {
    try {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') window.localStorage.setItem(key, val);
        return;
      }
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem(key, val);
    } catch { /* ignore */ }
  },
};

// API base URL (matches the pattern used in src/api/client.ts)
const API_BASE = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

type Day = { over30: number | null; under30: number | null; memberships: number | null; status: string };
type Entry = {
  user_id?: string | null;
  user_name: string;
  role?: string;
  days: Day[];
  total_sales: number;
  total_over30: number;
  total_under30: number;
  total_memberships: number;
  days_worked: number;
  piece_average: number;
  earnings: number;
  last_week_total?: number | null;
  prev_prev_week_total?: number | null;
  weekly_goal?: number | null;
  primary_team?: { leader_id: string; leader_name: string; team_name: string } | null;
};

type Payload = {
  office_name: string;
  office_slug: string;
  week_ending: string;
  previous_week_ending: string | null;
  entries: Entry[];
  office_totals: {
    total_sales: number;
    total_memberships: number;
    total_over30?: number;
    total_under30?: number;
    days_worked: number;
    earnings: number;
    piece_average: number;
    daily_totals: number[];
    pct_over30?: number;
    pct_under30?: number;
    pct_memberships?: number;
    scoring_pct?: number;
    green_pct?: number;
  };
};

// ─────────────────────────── main ───────────────────────────
export default function PublicBellsScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ office: string; code?: string; week?: string }>();
  const officeSlug = String(params.office || '');
  const codeFromUrl = typeof params.code === 'string' ? params.code : '';
  const weekFromUrl = typeof params.week === 'string' ? params.week : '';

  const [code, setCode] = useState<string | null>(codeFromUrl || null);
  const [codeDraft, setCodeDraft] = useState(codeFromUrl || '');
  const [weekEnding, setWeekEnding] = useState<string>(weekFromUrl || currentWeekEndingISO());
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeLoaded, setCodeLoaded] = useState(false);
  const [openDayIdx, setOpenDayIdx] = useState<number | null>(null);

  // Load stored code from storage on mount if no code in URL
  useEffect(() => {
    (async () => {
      if (codeFromUrl) {
        await storage.set(`bells-code:${officeSlug}`, codeFromUrl);
        setCodeLoaded(true);
        return;
      }
      const stored = await storage.get(`bells-code:${officeSlug}`);
      if (stored) {
        setCode(stored);
        setCodeDraft(stored);
      }
      setCodeLoaded(true);
    })();
  }, [officeSlug, codeFromUrl]);

  // Fetch data whenever code or week changes
  const fetchData = useCallback(async () => {
    if (!code) return;
    setLoading(true);
    setError(null);
    try {
      const url = `${API_BASE}/api/public/bells/${encodeURIComponent(officeSlug)}?code=${encodeURIComponent(code)}&week=${encodeURIComponent(weekEnding)}`;
      const resp = await fetch(url);
      if (resp.status === 401) {
        setError('Invalid share code. Ask your admin for the correct code.');
        setCode(null);
        setData(null);
        return;
      }
      if (resp.status === 403) {
        setError('Public sharing is not enabled for this office.');
        setData(null);
        return;
      }
      if (resp.status === 404) {
        setError('Office not found.');
        setData(null);
        return;
      }
      if (!resp.ok) {
        setError(`Error loading data (${resp.status}).`);
        setData(null);
        return;
      }
      const json = await resp.json();
      setData(json);
    } catch (e: any) {
      setError(`Network error: ${e?.message || 'unknown'}`);
    } finally {
      setLoading(false);
    }
  }, [code, weekEnding, officeSlug]);

  useEffect(() => { if (code && codeLoaded) fetchData(); }, [fetchData, code, codeLoaded]);

  const submitCode = async () => {
    const trimmed = codeDraft.trim();
    if (!trimmed) return;
    setCode(trimmed);
    await storage.set(`bells-code:${officeSlug}`, trimmed);
  };

  const clearCode = async () => {
    setCode(null);
    setCodeDraft('');
    setData(null);
    await storage.set(`bells-code:${officeSlug}`, '');
  };

  const openCsv = useCallback(() => {
    if (!code) return;
    const url = `${API_BASE}/api/public/bells/${encodeURIComponent(officeSlug)}/csv?code=${encodeURIComponent(code)}&week=${encodeURIComponent(weekEnding)}`;
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.open(url, '_blank');
    } else {
      Linking.openURL(url).catch(() => showAlert('Export', 'Unable to open CSV.'));
    }
  }, [code, officeSlug, weekEnding]);

  // ─── Gate: show unlock screen if no code ───
  if (!code) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 40 }]}>
        <View style={styles.unlockBox}>
          <View style={styles.unlockIconWrap}>
            <Ionicons name="lock-closed" size={32} color={colors.primary} />
          </View>
          <Text style={styles.unlockTitle}>Protected Weekly Snapshot</Text>
          <Text style={styles.unlockSubtitle}>
            Enter the share code for <Text style={{ fontWeight: '800' }}>{officeSlug}</Text> to view this week's Bells data.
          </Text>
          <TextInput
            style={styles.unlockInput}
            value={codeDraft}
            onChangeText={setCodeDraft}
            placeholder="Share code"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={false}
            onSubmitEditing={submitCode}
            returnKeyType="go"
          />
          {error ? <Text style={styles.unlockError}>{error}</Text> : null}
          <TouchableOpacity style={styles.unlockBtn} onPress={submitCode} disabled={!codeDraft.trim()}>
            <Text style={styles.unlockBtnText}>Unlock</Text>
          </TouchableOpacity>
          <Text style={styles.unlockHint}>
            Don't have the code? Contact your admin. The link auto-refreshes with the latest data each time you visit.
          </Text>
        </View>
      </View>
    );
  }

  // ─── Main view ───
  const entries = data?.entries || [];
  const totals = data?.office_totals;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 30, paddingHorizontal: 12 }}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{data?.office_name || officeSlug}</Text>
          <Text style={styles.headerSubtitle}>Weekly Sign-ups Snapshot · Public View</Text>
        </View>
        <TouchableOpacity style={styles.logoutBtn} onPress={clearCode}>
          <Ionicons name="log-out-outline" size={14} color={colors.textMuted} />
          <Text style={styles.logoutBtnText}>Lock</Text>
        </TouchableOpacity>
      </View>

      {/* Week picker */}
      <View style={styles.weekPicker}>
        <TouchableOpacity style={styles.weekArrow} onPress={() => setWeekEnding(isoAddDays(weekEnding, -7))}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.weekTitle}>{prettyWeekRange(weekEnding)}</Text>
          <Text style={styles.weekSubtitle}>w/e {weekEnding}</Text>
        </View>
        <TouchableOpacity style={styles.weekArrow} onPress={() => setWeekEnding(isoAddDays(weekEnding, 7))}>
          <Ionicons name="chevron-forward" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>
      {weekEnding !== currentWeekEndingISO() && (
        <TouchableOpacity onPress={() => setWeekEnding(currentWeekEndingISO())} style={styles.todayBtn}>
          <Ionicons name="refresh" size={13} color={colors.primary} />
          <Text style={styles.todayBtnText}>Jump to this week</Text>
        </TouchableOpacity>
      )}

      {/* Action row */}
      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={fetchData} disabled={loading}>
          <Ionicons name="refresh" size={14} color={colors.text} />
          <Text style={styles.actionBtnText}>Refresh</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionBtn, styles.actionBtnPrimary]} onPress={openCsv}>
          <Ionicons name="download-outline" size={14} color={colors.onPrimary} />
          <Text style={[styles.actionBtnText, { color: colors.onPrimary }]}>CSV Export</Text>
        </TouchableOpacity>
      </View>

      {loading && !data ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : error ? (
        <View style={styles.emptyBox}><Text style={{ color: '#b91c1c' }}>{error}</Text></View>
      ) : !totals ? null : (
        <>
          {/* ── 3-row office summary (matches in-app) ─────────────────── */}
          <View style={styles.totalsRow}>
            <Chip label="Sign-ups" value={`${totals.total_sales}`} highlight />
            <Chip label="P/A"     value={(totals.piece_average || 0).toFixed(1)} />
            <Chip label="Scoring" value={`${totals.scoring_pct ?? 0}%`} />
            <Chip label="Green %" value={`${totals.green_pct ?? 0}%`} accent="#22c55e" icon="leaf" />
          </View>
          <View style={styles.totalsRowSecondary}>
            <Chip label="£15+"   value={`${totals.total_over30 ?? 0}`}   accent="#f59e0b" icon="trending-up" />
            <Chip label="£12"    value={`${totals.total_under30 ?? 0}`}  accent="#6B8070" icon="checkmark-circle" />
            <Chip label="£15+ %" value={`${totals.pct_over30 ?? 0}%`}   accent="#f59e0b" />
          </View>

          {/* Daily totals strip — tap a day to see that day's office stats */}
          <View style={styles.officeDaily}>
            <Text style={styles.officeDailyTitle}>Daily Sign-ups · tap a day for stats</Text>
            <View style={styles.officeDailyRow}>
              {(totals.daily_totals || [0,0,0,0,0,0,0]).map((v, i) => (
                <TouchableOpacity
                  key={i}
                  style={[styles.officeDailyCell, v > 0 && styles.officeDailyCellActive]}
                  onPress={() => setOpenDayIdx(i)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.officeDailyLabel}>{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i]}</Text>
                  <Text style={styles.officeDailyValue}>{v}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Weekly Table */}
          {entries.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="document-text-outline" size={40} color={colors.textMuted} />
              <Text style={styles.emptyText}>No entries for this week yet.</Text>
            </View>
          ) : (
            <TableView entries={entries} />
          )}

          <Text style={styles.footer}>
            Data refreshes live. Shared via Vertex Hub.  ·  Last loaded at {new Date().toLocaleTimeString(APP_LOCALE, { hour: 'numeric', minute: '2-digit', hour12: true })}
          </Text>
        </>
      )}

      {/* Day breakdown modal — read-only snapshot of office stats for one day */}
      {openDayIdx !== null && entries.length > 0 && (
        <PublicDayBreakdownModal
          dayIdx={openDayIdx}
          entries={entries}
          weekEnding={weekEnding}
          onClose={() => setOpenDayIdx(null)}
        />
      )}
    </ScrollView>
  );
}

// hex (#RRGGBB) → rgba(r,g,b,a)
function hexToRgba(hex: string, alpha: number): string {
  const h = (hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length !== 6) return `rgba(58, 122, 86, ${alpha})`;
  const r = parseInt(full.substring(0, 2), 16);
  const g = parseInt(full.substring(2, 4), 16);
  const b = parseInt(full.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function Chip({ label, value, highlight, accent, icon }: { label: string; value: string; highlight?: boolean; accent?: string; icon?: any }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Option A — neutral surface; tinted icon-chip carries the meaning.
  const tint = accent ? hexToRgba(accent, 0.12) : 'transparent';
  return (
    <View style={styles.chip}>
      <View style={styles.chipLabelRow}>
        {icon && (
          <View style={[styles.chipIconWrap, { backgroundColor: tint }]}>
            <Ionicons name={icon} size={9} color={accent || colors.textMuted} />
          </View>
        )}
        <Text style={styles.chipLabel}>{label}</Text>
      </View>
      <Text style={[styles.chipValue, highlight && { color: colors.primary }]}>{value}</Text>
    </View>
  );
}

function TableView({ entries }: { entries: Entry[] }) {
  const colors = useColors();
  const tvStyles = useMemo(() => createTvStyles(colors), [colors]);

  const cellForDay = (d: Day): { text: string; color: string } => {
    if (!d) return { text: '—', color: '#6B8070' };
    if (d.status === 'off') return { text: '—', color: '#6B8070' };
    if (d.status === 'ab') return { text: 'ab', color: '#dc2626' };
    if (d.status === 'nc') return { text: 'nc', color: '#6b7280' };
    if (d.status === 'pc') return { text: 'pc', color: '#0891b2' };
    const tot = (d.over30 || 0) + (d.under30 || 0);
    if (d.status === 'rt') return { text: tot > 0 ? `rt ${tot}` : 'rt', color: '#d97706' };
    return { text: String(tot), color: tot > 0 ? colors.text : '#91B69E' };
  };

  // ── Group entries by primary_team.leader_id (Excel-sheet style) ──
  type Group = {
    key: string; team_name: string;
    leader_id: string | null; leader_name: string | null;
    members: Entry[]; total_sales: number; total_earnings: number;
  };
  const groups: Group[] = (() => {
    const map = new Map<string, Group>();
    for (const e of entries) {
      const pt = e.primary_team || null;
      const key = pt?.leader_id || '__no_team__';
      if (!map.has(key)) {
        map.set(key, {
          key,
          team_name: pt?.team_name || 'Unassigned',
          leader_id: pt?.leader_id || null,
          leader_name: pt?.leader_name || null,
          members: [],
          total_sales: 0,
          total_earnings: 0,
        });
      }
      const g = map.get(key)!;
      g.members.push(e);
      g.total_sales += e.total_sales || 0;
      g.total_earnings += e.earnings || 0;
    }
    for (const g of map.values()) {
      // NOTE: backend already returns entries hierarchically sorted; do not
      // re-sort here or we'd clobber the leaf-first/branches-after order.
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.key === '__no_team__' && b.key !== '__no_team__') return 1;
      if (b.key === '__no_team__' && a.key !== '__no_team__') return -1;
      return b.total_sales - a.total_sales;
    });
  })();

  const NAME_COL = 140, DAY_COL = 50, SUM_COL = 56, PCT_COL = 56, LW_COL = 44, GOAL_COL = 44, MONEY_COL = 76;
  const totalRowWidth = NAME_COL + DAY_COL * 7 + SUM_COL * 3 + PCT_COL + LW_COL + GOAL_COL + MONEY_COL;

  const trafficLightBg = (e: Entry): string | undefined => {
    const priorWeeks = (e as any).prior_weeks ?? 0;
    if (priorWeeks < 4) return undefined;
    const lw = e.last_week_total;
    if (lw == null) return undefined;
    const ppw = e.prev_prev_week_total ?? null;
    if (lw >= SUPER_GREEN_WEEK_MIN) return 'rgba(34,197,94,0.30)';
    if (lw >= GREEN_WEEK_MIN) return 'rgba(34,197,94,0.18)';
    if (lw >= AMBER_WEEK_MIN) return 'rgba(234,179,8,0.25)';
    const alsoRedPrev = ppw != null && ppw <= RED_WEEK_MAX;
    return alsoRedPrev ? 'rgba(185,28,28,0.35)' : 'rgba(239,68,68,0.22)';
  };

  const isWeb = Platform.OS === 'web';
  const stickyHeader: any = isWeb ? { position: 'sticky', top: 0, zIndex: 30, backgroundColor: colors.surface } : {};
  const stickyNameColHeader: any = isWeb ? { position: 'sticky', left: 0, top: 0, zIndex: 35, backgroundColor: colors.surface } : {};
  const stickyNameCol: any = isWeb ? { position: 'sticky', left: 0, zIndex: 15, backgroundColor: colors.surface } : {};

  const tableContent = (
    <View>
      <View style={[tvStyles.headerRow, stickyHeader]}>
        <View style={[tvStyles.nameCol, tvStyles.headerCell, stickyNameColHeader]}><Text style={tvStyles.headerText}>Name</Text></View>
        <View style={[{ width: LW_COL }, tvStyles.headerCell]}><Text style={tvStyles.headerText}>LW</Text></View>
        <View style={[{ width: GOAL_COL }, tvStyles.headerCell]}><Text style={tvStyles.headerText}>Goal</Text></View>
        {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d, i) => (
          <View key={i} style={[tvStyles.dayCol, tvStyles.headerCell]}><Text style={tvStyles.headerText}>{d}</Text></View>
        ))}
        <View style={[tvStyles.sumCol, tvStyles.headerCell]}><Text style={tvStyles.headerText}>Tot</Text></View>
        <View style={[tvStyles.sumCol, tvStyles.headerCell]}><Text style={tvStyles.headerText}>Days</Text></View>
        <View style={[tvStyles.sumCol, tvStyles.headerCell]}><Text style={tvStyles.headerText}>P/A</Text></View>
        <View style={[tvStyles.pctCol, tvStyles.headerCell]}><Text style={tvStyles.headerText}>£15+ %</Text></View>
        <View style={[tvStyles.moneyCol, tvStyles.headerCell]}><Text style={tvStyles.headerText}>Est. fees</Text></View>
      </View>

      {groups.map((g) => {
        const tint = g.key === '__no_team__' ? NO_TEAM_TINT : teamColor(g.leader_id || g.team_name);
        return (
          <View key={g.key}>
            {/* Team header band */}
            <View
              style={[
                tvStyles.teamHeader,
                { backgroundColor: tint.pill, borderLeftColor: tint.border, width: totalRowWidth },
              ]}
            >
              <View style={tvStyles.teamHeaderLeft}>
                <Ionicons name="people" size={13} color={tint.text} />
                <Text style={[tvStyles.teamHeaderText, { color: tint.text }]} numberOfLines={1}>{g.team_name}</Text>
                {g.leader_name && (
                  <Text style={[tvStyles.teamHeaderLeader, { color: tint.text }]} numberOfLines={1}>· led by {g.leader_name}</Text>
                )}
              </View>
              <View style={tvStyles.teamHeaderRight}>
                <Text style={[tvStyles.teamHeaderStat, { color: tint.text }]}>{g.total_sales} sign-ups</Text>
                <Text style={[tvStyles.teamHeaderDot, { color: tint.text }]}>·</Text>
                <Text style={[tvStyles.teamHeaderStat, { color: tint.text }]}>{formatMoney(g.total_earnings)}</Text>
              </View>
            </View>

            {g.members.map((e, i) => {
              const isLeader = !!(e.user_id && g.leader_id && e.user_id === g.leader_id);
              const tlBg = trafficLightBg(e);
              return (
              <View
                key={e.user_id || `n${g.key}-${i}`}
                style={[
                  tvStyles.bodyRow,
                  tlBg
                    ? { backgroundColor: tlBg }
                    : (i % 2 === 1 ? { backgroundColor: '#F7FAF1' } : (isLeader ? { backgroundColor: 'rgba(58, 122, 86, 0.05)' } : {})),
                ]}
              >
                <View style={[tvStyles.nameCol, tvStyles.bodyCell, stickyNameCol, { backgroundColor: tlBg ?? (isWeb ? colors.surface : undefined) }]}>
                  <View style={tvStyles.nameRow}>
                    {isLeader && <Ionicons name="star" size={11} color={colors.primary} style={{ marginRight: 4 }} />}
                    <Text
                      style={[tvStyles.nameText, isLeader && { fontWeight: '900' }]}
                      numberOfLines={1}
                    >{e.user_name}</Text>
                  </View>
                  <Text style={tvStyles.roleText}>
                    {isLeader ? 'Coach' : (e.role === 'trainee' ? 'BA' : (e.role === 'leader' ? 'Coach' : ''))}
                  </Text>
                </View>
                  <View style={[{ width: LW_COL }, tvStyles.bodyCell]}>
                    <Text style={[tvStyles.cellText, { color: '#6B8070' }]}>
                      {e.last_week_total != null ? String(e.last_week_total) : '—'}
                    </Text>
                  </View>
                  <View style={[{ width: GOAL_COL }, tvStyles.bodyCell]}>
                    <Text style={[tvStyles.cellText, { color: '#6B8070' }]}>
                      {e.weekly_goal != null ? String(e.weekly_goal) : '—'}
                    </Text>
                  </View>
                  {(e.days || []).map((d, j) => {
                    const cell = cellForDay(d);
                    return (
                      <View key={j} style={[tvStyles.dayCol, tvStyles.bodyCell]}>
                        <Text style={[tvStyles.cellText, { color: cell.color }]}>{cell.text}</Text>
                      </View>
                    );
                  })}
                  <View style={[tvStyles.sumCol, tvStyles.bodyCell]}><Text style={[tvStyles.cellText, { fontWeight: '800' }]}>{e.total_sales}</Text></View>
                  <View style={[tvStyles.sumCol, tvStyles.bodyCell]}><Text style={tvStyles.cellText}>{e.days_worked}</Text></View>
                  <View style={[tvStyles.sumCol, tvStyles.bodyCell]}><Text style={tvStyles.cellText}>{e.piece_average?.toFixed(1) ?? '0.0'}</Text></View>
                  <View style={[tvStyles.pctCol, tvStyles.bodyCell]}>
                    <Text style={[tvStyles.cellText, { fontWeight: '700', color: colors.textMuted }]}>
                      {e.total_sales > 0 ? `${Math.round(((e.total_over30 || 0) / e.total_sales) * 100)}%` : '—'}
                    </Text>
                  </View>
                  <View style={[tvStyles.moneyCol, tvStyles.bodyCell]}>
                    <Text style={[tvStyles.cellText, { color: colors.text, fontWeight: '800' }]}>{formatMoney(e.earnings || 0)}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );

  return (
    <View style={tvStyles.wrap}>
      {isWeb ? (
        <View style={[{ overflow: 'auto', maxHeight: 580 } as any]}>
          {tableContent}
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={true}>
          {tableContent}
        </ScrollView>
      )}
      <Text style={tvStyles.hint}>
        {isWeb ? 'Header and name column freeze as you scroll.' : 'Swipe horizontally to see all columns.'}
      </Text>
    </View>
  );
}

// ─────────────────────────── styles ───────────────────────────
const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  unlockBox: { alignSelf: 'center', maxWidth: 440, width: '100%', padding: 20, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  unlockIconWrap: { alignSelf: 'center', padding: 12, borderRadius: 50, backgroundColor: 'rgba(58, 122, 86, 0.1)', marginBottom: 12 },
  unlockTitle: { fontSize: 20, fontWeight: '800', color: colors.text, textAlign: 'center', marginBottom: 6 },
  unlockSubtitle: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginBottom: 20, lineHeight: 18 },
  unlockInput: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: colors.text, marginBottom: 10, textAlign: 'center', letterSpacing: 1 },
  unlockError: { fontSize: 12, color: '#b91c1c', textAlign: 'center', marginBottom: 8 },
  unlockBtn: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  unlockBtnText: { color: colors.onPrimary, fontWeight: '800', fontSize: 15 },
  unlockHint: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 14, fontStyle: 'italic', lineHeight: 16 },

  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: colors.text },
  headerSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
  logoutBtnText: { fontSize: 11, color: colors.textMuted, fontWeight: '700' },

  weekPicker: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, padding: 8, marginBottom: 6, borderWidth: 1, borderColor: colors.border },
  weekArrow: { padding: 6 },
  weekTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  weekSubtitle: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  todayBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 8 },
  todayBtnText: { fontSize: 12, color: colors.primary, fontWeight: '700' },

  actionRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  actionBtnPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  actionBtnText: { fontSize: 12, fontWeight: '700', color: colors.text },

  totalsRow: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  totalsRowSecondary: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  chip: { flex: 1, alignItems: 'center', padding: 10, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  chipLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chipIconWrap: { width: 14, height: 14, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  chipLabel: { fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase' },
  chipValue: { fontSize: 15, fontWeight: '800', color: colors.text, marginTop: 4, fontVariant: ['tabular-nums'] as any },

  officeDaily: { backgroundColor: colors.surface, borderRadius: 12, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: colors.border },
  officeDailyTitle: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, marginBottom: 6 },
  officeDailyRow: { flexDirection: 'row', gap: 4 },
  officeDailyCell: { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  officeDailyCellActive: { backgroundColor: hexToRgba(colors.primary, 0.08), borderColor: hexToRgba(colors.primary, 0.25) },
  officeDailyLabel: { fontSize: 10, fontWeight: '700', color: colors.textMuted },
  officeDailyValue: { fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 2, fontVariant: ['tabular-nums'] as any },

  emptyBox: { padding: 40, alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, marginTop: 10 },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 12, fontSize: 13 },

  footer: { fontSize: 10, color: colors.textMuted, textAlign: 'center', marginTop: 14, fontStyle: 'italic' },
});

const createTvStyles = (colors: any) => StyleSheet.create({
  wrap: { marginTop: 2 },
  headerRow: { flexDirection: 'row', backgroundColor: colors.surface, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderWidth: 1, borderColor: colors.border },
  bodyRow: { flexDirection: 'row', borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border },
  headerCell: { paddingVertical: 8, paddingHorizontal: 6, justifyContent: 'center', borderRightWidth: 1, borderRightColor: colors.border },
  bodyCell: { paddingVertical: 8, paddingHorizontal: 6, justifyContent: 'center', borderRightWidth: 1, borderRightColor: colors.border },
  headerText: { fontSize: 11, fontWeight: '800', color: colors.text, textAlign: 'center' },
  cellText: { fontSize: 12, color: colors.text, textAlign: 'center', fontVariant: ['tabular-nums'] as any },
  nameCol: { width: 140, paddingLeft: 10, alignItems: 'flex-start', justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  nameText: { fontSize: 12, fontWeight: '700', color: colors.text, flex: 1 },
  roleText: { fontSize: 9, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.3, textTransform: 'uppercase', marginTop: 1 },
  dayCol: { width: 50, alignItems: 'center' },
  sumCol: { width: 56, alignItems: 'center' },
  pctCol: { width: 56, alignItems: 'center' },
  moneyCol: { width: 76, alignItems: 'center' },
  hint: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 6, fontStyle: 'italic' },

  // Team header band (Excel-sheet style)
  teamHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 7,
    borderLeftWidth: 4, borderTopWidth: 1, borderBottomWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
  },
  teamHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  teamHeaderText: { fontSize: 13, fontWeight: '900', letterSpacing: 0.3 },
  teamHeaderLeader: { fontSize: 11, fontWeight: '600', opacity: 0.85, flexShrink: 1 },
  teamHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  teamHeaderStat: { fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] as any },
  teamHeaderDot: { fontSize: 12, fontWeight: '900', opacity: 0.4 },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
const tvStyles = createTvStyles(lightColors);

// ─────────────────────────── Day Breakdown Modal ───────────────────────────
function PublicDayBreakdownModal({ dayIdx, entries, weekEnding, onClose }: {
  dayIdx: number; entries: Entry[]; weekEnding: string; onClose: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createDayModalStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const dayLabel = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][dayIdx];

  // Compute office totals for this single day.
  // "Working" = anyone clocked in ('in' or 'rt') or anyone with sales — not
  // just reps who sold.
  const totals = useMemo(() => {
    let over30 = 0, under30 = 0, memberships = 0, working = 0, rt = 0, off = 0;
    const reps: Array<{ name: string; over30: number; under30: number; memberships: number; status: string }> = [];
    for (const e of entries) {
      const d = e.days?.[dayIdx];
      if (!d) continue;
      const o = Number(d.over30 || 0);
      const u = Number(d.under30 || 0);
      const m = Number(d.memberships || 0);
      const tot = o + u;
      if (d.status === 'off') off++;
      else if (d.status === 'rt') rt++;
      const isWorking = d.status === 'in' || d.status === 'rt' || tot > 0 || m > 0;
      if (isWorking) working++;
      over30 += o; under30 += u; memberships += m;
      if (tot > 0 || m > 0) reps.push({ name: e.user_name, over30: o, under30: u, memberships: m, status: d.status });
    }
    const sales = over30 + under30;
    const goldRate = sales > 0 ? Math.round((over30 / sales) * 100) : 0;
    const memRate = sales > 0 ? Math.round((memberships / sales) * 100) : 0;
    const pa = working > 0 ? +(sales / working).toFixed(1) : 0;
    return { over30, under30, sales, memberships, goldRate, memRate, pa, working, rt, off, reps };
  }, [entries, dayIdx]);

  // Pretty calendar date for this day
  const dayDate = useMemo(() => {
    try {
      const end = new Date(weekEnding + 'T00:00:00');
      const monday = new Date(end); monday.setDate(end.getDate() - 6);
      const target = new Date(monday); target.setDate(monday.getDate() + dayIdx);
      return target.toLocaleDateString(APP_LOCALE, { weekday: 'long', month: 'short', day: 'numeric' });
    } catch { return dayLabel; }
  }, [weekEnding, dayIdx, dayLabel]);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={[styles.sheet, { paddingBottom: 24 + insets.bottom }]} onPress={() => {}}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{dayDate}</Text>
              <Text style={styles.subtitle}>Office totals · read-only</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={28} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingBottom: 12 }}>
            {/* Stat tiles */}
            <View style={styles.statGrid}>
              <StatTile label="Sign-ups" value={`${totals.sales}`} accent={colors.primary} />
              <StatTile label="P/A" value={totals.pa.toFixed(1)} accent={colors.text} />
              <StatTile label="£15+" value={`${totals.over30}`} accent="#f59e0b" icon="trending-up" />
              <StatTile label="£12" value={`${totals.under30}`} accent="#6B8070" icon="checkmark-circle" />
              <StatTile label="£15+ %" value={`${totals.goldRate}%`} accent="#f59e0b" />
              <StatTile label="Working" value={`${totals.working}`} accent="#22c55e" icon="people" />
            </View>

            {/* Per-rep list */}
            <Text style={styles.sectionTitle}>Reps with sign-ups today ({totals.reps.length})</Text>
            {totals.reps.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="moon-outline" size={28} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 6 }}>No sign-ups recorded for this day yet.</Text>
              </View>
            ) : (
              totals.reps
                .slice()
                .sort((a, b) => (b.over30 + b.under30) - (a.over30 + a.under30))
                .map((r, i) => (
                  <View key={`${r.name}-${i}`} style={styles.repRow}>
                    <Text style={styles.repName} numberOfLines={1}>{r.name}</Text>
                    <View style={styles.repStats}>
                      {r.over30 > 0 && <Text style={[styles.repStat, { color: colors.textSecondary }]}>{r.over30} × £15+</Text>}
                      {r.under30 > 0 && <Text style={[styles.repStat, { color: colors.textMuted }]}>{r.under30} × £12</Text>}
                    </View>
                  </View>
                ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function StatTile({ label, value, accent, icon }: { label: string; value: string; accent: string; icon?: any }) {
  const colors = useColors();
  const styles = useMemo(() => createDayModalStyles(colors), [colors]);
  // Option A — neutral surface, tinted icon chip, brand accent only on primary tile
  const isPrimary = accent === colors.primary;
  const tint = hexToRgba(accent, 0.12);
  return (
    <View style={styles.tile}>
      <View style={styles.tileLabelRow}>
        {icon && (
          <View style={[styles.tileIconWrap, { backgroundColor: tint }]}>
            <Ionicons name={icon} size={9} color={accent} />
          </View>
        )}
        <Text style={[styles.tileLabel, { color: colors.textMuted }]}>{label}</Text>
      </View>
      <Text style={[styles.tileValue, { color: isPrimary ? accent : colors.text }]}>{value}</Text>
    </View>
  );
}

const createDayModalStyles = (colors: any) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 8 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 10 },
  title: { fontSize: 19, fontWeight: '900', color: colors.text },
  subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  tile: { width: '23%', backgroundColor: colors.surface, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: colors.border, minHeight: 64 },
  tileLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  tileIconWrap: { width: 14, height: 14, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },
  tileValue: { fontSize: 18, fontWeight: '900', fontVariant: ['tabular-nums'] as any },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: colors.textSecondary, marginBottom: 8, letterSpacing: 0.4 },
  emptyBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 24, borderRadius: 10, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  repRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, marginBottom: 6 },
  repName: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text },
  repStats: { flexDirection: 'row', gap: 10 },
  repStat: { fontSize: 12, fontWeight: '800' },
});
