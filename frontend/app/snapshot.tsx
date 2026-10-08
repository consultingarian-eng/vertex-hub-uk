/**
 * Weekly Snapshot — at-a-glance office dashboard for the current sales week.
 *
 * Shows:
 *   • Sales-vs-Goal headline (with the absolute number remaining)
 *   • Target-vs-actual chips: P/A (target 2.5), £15+ % (55%)
 *   • Top 5 by Sales volume   (rank · name · sales · P/A · £earnings)
 *   • Top 5 by earnings       (rank · name · £earnings · sales)
 *
 * Data comes from two existing endpoints we already call elsewhere in the app:
 *   GET /api/bells?week=&office=    → entries[] + office_totals
 *   GET /api/agenda?week=           → agenda.stats.weekly_goal
 *
 * Scope:
 *   • Admin       → strictly their own office (office picker hidden)
 *   • Super admin → free office switcher pinned to the top
 */
import React, { useMemo, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { apiService } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { ScrollReveal } from '../src/components/ui/ScrollFx';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { AnimatedNumber } from '../src/components/ui/AnimatedNumber';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { APP_LOCALE, formatMoney } from '../src/utils/appTime';

// Fixed product-side targets (per user spec)
const TARGET_PA = 2.5;
const TARGET_MEM_PCT = 55;
const TARGET_GOLD_PCT = 55;

/** Returns the ISO Sunday for the current week (used as Bells week_ending).
 * Uses LOCAL date parts (not toISOString) — same as bells.tsx — so an
 * evening in a timezone behind UTC doesn't roll the key to next week's
 * (empty) sheet. */
function currentWeekEndingISO(): string {
  const d = new Date();
  const day = d.getDay();              // 0=Sun..6=Sat
  const delta = (7 - day) % 7;         // days until Sunday
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Adds N weeks to an ISO date string (returns yyyy-mm-dd). Pure-UTC math on
 * the key string (like bells.tsx isoAddDays) — timezone can't shift the day. */
function shiftWeek(iso: string, weeks: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

function fmtWeekLabel(iso: string): string {
  const end = new Date(iso + 'T00:00:00');
  const start = new Date(end);
  start.setDate(end.getDate() - 6);
  const fmt = (dt: Date) => dt.toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

export default function WeeklySnapshotScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const { user } = useAuth();
  const isSuperAdmin = !!(user as any)?.is_super_admin;
  const [refreshing, setRefreshing] = useState(false);

  // Week state — defaults to current Sunday-ending week
  const [weekEnding, setWeekEnding] = useState<string>(currentWeekEndingISO());
  // Office state — admins are pinned to their own office; super admins can flip
  const [officeId, setOfficeId] = useState<string | undefined>(
    isSuperAdmin ? undefined : ((user as any)?.office_id),
  );

  const officesQ = useQuery({
    queryKey: ['offices'],
    queryFn: () => apiService.getOffices().then(r => r.data),
    enabled: isSuperAdmin,
  });

  const bellsQ = useQuery({
    queryKey: ['snapshot-bells', weekEnding, officeId],
    queryFn: () => apiService.listBells(weekEnding, officeId).then(r => r.data),
  });

  const agendaQ = useQuery({
    // ── Re-key on officeId so super-admins flipping between offices see
    // each office's actual weekly_goal / theme / targets — not the first
    // office's stale values. Backend supports `?office=` for super-admins.
    queryKey: ['snapshot-agenda', weekEnding, officeId],
    queryFn: () => apiService.getAgenda(weekEnding, officeId).then(r => r.data),
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([bellsQ.refetch(), agendaQ.refetch()]);
    setRefreshing(false);
  }, [bellsQ, agendaQ]);

  const { pullIndicator } = usePullToRefresh(onRefresh);

  // The bells endpoint returns snake_case `office_totals` (see bells.tsx) —
  // reading the camelCase name here is what kept every tile stuck at 0.
  const totals = (bellsQ.data as any)?.office_totals || {};
  const entries: any[] = (bellsQ.data as any)?.entries || [];

  // Weekly goal from agenda.stats.weekly_goal (could be "220" or "" or null)
  const weeklyGoalRaw = (agendaQ.data as any)?.agenda?.stats?.weekly_goal;
  const weeklyGoal = (() => {
    const n = parseInt(String(weeklyGoalRaw || '').replace(/[^0-9-]/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const salesSoFar = Number(totals.total_sales || 0);
  const gap = weeklyGoal != null ? Math.max(0, weeklyGoal - salesSoFar) : null;

  const officeName = (bellsQ.data as any)?.office_name || (() => {
    const o = (officesQ.data || []).find((x: any) => x.id === officeId);
    return o?.name || 'Office';
  })();

  // Sort entries for the two leaderboards
  const topBySales = useMemo(() =>
    entries
      .filter(e => (e.total_sales || 0) > 0)
      .slice()
      .sort((a, b) => (b.total_sales || 0) - (a.total_sales || 0))
      .slice(0, 5)
  , [entries]);

  const topByEarnings = useMemo(() =>
    entries
      .filter(e => (e.earnings || 0) > 0)
      .slice()
      .sort((a, b) => (b.earnings || 0) - (a.earnings || 0))
      .slice(0, 5)
  , [entries]);

  const { scrollY, onScroll } = useParallaxScroll();

  const isThisWeek = weekEnding === currentWeekEndingISO();
  const loading = bellsQ.isLoading || agendaQ.isLoading;

  return (
    <View style={{ flex: 1 }}>
      {pullIndicator}
      <Stack.Screen options={{ title: 'Weekly Snapshot', headerShown: true }} />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* Office picker — super admin only. Horizontal pill scroller. */}
        {isSuperAdmin && (officesQ.data || []).length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.officeRow} contentContainerStyle={{ gap: 8, paddingHorizontal: 4 }}>
            {(officesQ.data || []).map((o: any) => (
              <TouchableOpacity
                key={o.id}
                style={[styles.officeChip, officeId === o.id && styles.officeChipActive]}
                onPress={() => setOfficeId(o.id)}
              >
                <Text style={[styles.officeChipText, officeId === o.id && styles.officeChipTextActive]}>
                  {o.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* Week navigator */}
        <View style={styles.weekNav}>
          <TouchableOpacity onPress={() => setWeekEnding(shiftWeek(weekEnding, -1))} style={styles.weekArrow}>
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
          </TouchableOpacity>
          <View style={{ alignItems: 'center', flex: 1 }}>
            <Text style={styles.weekLabel}>{fmtWeekLabel(weekEnding)}</Text>
            <Text style={styles.weekSub}>{officeName} · w/e {weekEnding}</Text>
          </View>
          <TouchableOpacity onPress={() => setWeekEnding(shiftWeek(weekEnding, +1))} style={styles.weekArrow}>
            <Ionicons name="chevron-forward" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>
        {!isThisWeek && (
          <TouchableOpacity onPress={() => setWeekEnding(currentWeekEndingISO())} style={styles.todayBtn}>
            <Ionicons name="refresh" size={13} color={colors.primary} />
            <Text style={styles.todayBtnText}>Jump to this week</Text>
          </TouchableOpacity>
        )}

        {loading ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <BrandLoader size={56} />
          </View>
        ) : (
          <>
            {/* Headline: Sales vs Goal */}
            <ScrollReveal scrollY={scrollY}>
            <View style={styles.heroCard}>
              <Text style={styles.heroLabel}>SIGN-UPS THIS WEEK</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <AnimatedNumber value={salesSoFar} decimals={0} style={styles.heroValue} />
                {weeklyGoal != null && (
                  <Text style={styles.heroGoal}>/ {weeklyGoal} goal</Text>
                )}
              </View>
              {weeklyGoal == null ? (
                <Text style={styles.heroHint}>
                  No weekly goal set on the Weekly Plan for this week. Set one in Schedule → Weekly Plan to see your gap.
                </Text>
              ) : gap === 0 ? (
                <View style={[styles.gapPill, { backgroundColor: '#16a34a22', borderColor: '#16a34a' }]}>
                  <Ionicons name="trophy" size={14} color="#16a34a" />
                  <Text style={[styles.gapPillText, { color: '#16a34a' }]}>Goal hit! 🎉</Text>
                </View>
              ) : (
                <View style={[styles.gapPill, { backgroundColor: colors.primary + '14', borderColor: colors.primary }]}>
                  <Ionicons name="flag-outline" size={14} color={colors.primary} />
                  <Text style={[styles.gapPillText, { color: colors.primary }]}>
                    {gap} sign-up{gap === 1 ? '' : 's'} to goal
                  </Text>
                </View>
              )}
            </View>
            </ScrollReveal>

            {/* Target chips */}
            <ScrollReveal scrollY={scrollY}>
            <View style={styles.targetRow}>
              <TargetCard
                styles={styles}
                colors={colors}
                label="P/A"
                value={(totals.piece_average || 0).toFixed(1)}
                target={TARGET_PA.toFixed(1)}
                hit={(totals.piece_average || 0) >= TARGET_PA}
              />
              <TargetCard
                styles={styles}
                colors={colors}
                label="£15+ %"
                value={`${totals.pct_over30 ?? 0}%`}
                target={`${TARGET_GOLD_PCT}%`}
                hit={(totals.pct_over30 || 0) >= TARGET_GOLD_PCT}
                accent={colors.primary}
              />
            </View>
            </ScrollReveal>

            {/* Top 5 by sales */}
            <ScrollReveal scrollY={scrollY}>
            <Section title="🥇 Top 5 — Sign-ups" colors={colors}>
              {topBySales.length === 0 ? (
                <Text style={styles.emptyText}>No sign-ups recorded this week yet.</Text>
              ) : (
                topBySales.map((e, i) => (
                  <LeaderRow
                    key={e.id || e.user_id || `${e.user_name}-${i}`}
                    rank={i + 1}
                    name={e.user_name}
                    primary={`${e.total_sales} sign-up${e.total_sales === 1 ? '' : 's'}`}
                    secondary={`P/A ${(e.piece_average || 0).toFixed(1)} · ${formatMoney(e.earnings || 0)} BA${e.reliability_pct != null ? ` · ${e.reliability_pct}% rel` : ''}`}
                    styles={styles}
                    colors={colors}
                  />
                ))
              )}
            </Section>
            </ScrollReveal>

            {/* Top 5 by money made */}
            <ScrollReveal scrollY={scrollY}>
            <Section title="💰 Top 5 — Earnings" colors={colors}>
              {topByEarnings.length === 0 ? (
                <Text style={styles.emptyText}>No earnings recorded this week yet.</Text>
              ) : (
                topByEarnings.map((e, i) => (
                  <LeaderRow
                    key={e.id || e.user_id || `${e.user_name}-${i}`}
                    rank={i + 1}
                    name={e.user_name}
                    primary={formatMoney(e.earnings || 0)}
                    secondary={`${e.total_sales} sign-up${e.total_sales === 1 ? '' : 's'} · P/A ${(e.piece_average || 0).toFixed(1)}${e.reliability_pct != null ? ` · ${e.reliability_pct}% rel` : ''}`}
                    styles={styles}
                    colors={colors}
                    accent="#16a34a"
                  />
                ))
              )}
            </Section>
            </ScrollReveal>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ───────────────────────────── helpers ─────────────────────────────────────

function TargetCard({ styles, colors, label, value, target, hit, accent }: any) {
  return (
    <View style={[styles.targetCard, hit && { borderColor: '#16a34a', backgroundColor: '#16a34a0a' }]}>
      <Text style={[styles.targetLabel, { color: accent || colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.targetValue, hit && { color: '#16a34a' }]}>{value}</Text>
      <Text style={styles.targetTarget}>target {target}</Text>
      {hit && (
        <View style={styles.hitBadge}>
          <Ionicons name="checkmark-circle" size={11} color="#16a34a" />
        </View>
      )}
    </View>
  );
}

function Section({ title, children, colors }: any) {
  return (
    <View style={{ marginTop: 18 }}>
      <Text style={{ fontSize: 13, fontWeight: '900', color: colors.text, marginBottom: 8, paddingHorizontal: 4, letterSpacing: 0.3 }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function LeaderRow({ rank, name, primary, secondary, styles, colors, accent }: any) {
  const rankColor = rank === 1 ? '#f59e0b' : rank === 2 ? '#6B8070' : rank === 3 ? '#b45309' : (accent || colors.primary);
  return (
    <View style={styles.leaderRow}>
      <View style={[styles.rankBadge, { backgroundColor: rankColor }]}>
        <Text style={styles.rankBadgeText}>{rank}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.leaderName}>{name}</Text>
        <Text style={styles.leaderSub}>{secondary}</Text>
      </View>
      <Text style={[styles.leaderPrimary, accent && { color: accent }]}>{primary}</Text>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  content: { padding: 14 },
  officeRow: { marginBottom: 10, maxHeight: 44 },
  officeChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  officeChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  officeChipText: { fontSize: 12, fontWeight: '800', color: colors.textSecondary },
  officeChipTextActive: { color: colors.onPrimary },

  weekNav: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, padding: 8, borderWidth: 1, borderColor: colors.border },
  weekArrow: { padding: 8 },
  weekLabel: { fontSize: 15, fontWeight: '900', color: colors.text },
  weekSub: { fontSize: 11, color: colors.textMuted, fontWeight: '700', marginTop: 2 },
  todayBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'center', marginTop: 8, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: colors.primary + '14' },
  todayBtnText: { fontSize: 11, fontWeight: '800', color: colors.primary },

  heroCard: {
    marginTop: 16, padding: 18, borderRadius: 16,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  heroLabel: { fontSize: 11, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.8 },
  heroValue: { fontFamily: fonts.monoSemibold, fontSize: 44, fontWeight: '900', color: colors.text, marginTop: 4, lineHeight: 50 },
  heroGoal: { fontSize: 18, fontWeight: '700', color: colors.textSecondary },
  heroHint: { fontSize: 12, color: colors.textMuted, marginTop: 8, lineHeight: 17, fontStyle: 'italic' },
  gapPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, borderWidth: 1, marginTop: 10,
  },
  gapPillText: { fontSize: 13, fontWeight: '900', letterSpacing: 0.3 },

  targetRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  targetCard: {
    flex: 1, paddingVertical: 14, paddingHorizontal: 8, borderRadius: 12,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', position: 'relative',
  },
  targetLabel: { fontSize: 10, fontWeight: '900', letterSpacing: 0.5, textTransform: 'uppercase' },
  targetValue: { fontFamily: fonts.monoSemibold, fontSize: 22, fontWeight: '900', color: colors.text, marginTop: 4 },
  targetTarget: { fontSize: 10, color: colors.textMuted, fontWeight: '700', marginTop: 2 },
  hitBadge: { position: 'absolute', top: 6, right: 6 },

  leaderRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, padding: 12, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border, marginBottom: 6,
  },
  rankBadge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  rankBadgeText: { color: '#fff', fontWeight: '900', fontSize: 13 },
  leaderName: { fontSize: 14, fontWeight: '800', color: colors.text },
  leaderSub: { fontSize: 11.5, color: colors.textSecondary, marginTop: 2 },
  leaderPrimary: { fontSize: 15, fontWeight: '900', color: colors.text, fontVariant: ['tabular-nums'] as any },

  emptyText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', padding: 12, textAlign: 'center' },
});
