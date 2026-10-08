import React, { useCallback, useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  Platform, KeyboardAvoidingView, RefreshControl, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { colors } from '../src/theme/colors';
import { lightColors } from '../src/theme/ThemeContext';
import { useColors, useTheme, fonts } from '../src/theme/ThemeContext';
import { apiService } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { useActiveOffice } from '../src/office/ActiveOfficeContext';
import OfficeToggle from '../src/components/ui/OfficeToggle';
import TeamView from '../src/components/bells/TeamView';
import TableView from '../src/components/bells/TableView';
import DayBreakdownModal from '../src/components/bells/DayBreakdownModal';
import DailyBreakdownSheet from '../src/components/bells/DailyBreakdownSheet';
import { Skeleton } from '../src/components/ui/Skeleton';
import { EmptyState } from '../src/components/ui/EmptyState';
import { FAB } from '../src/components/ui/FAB';
import { haptics } from '../src/utils/haptics';
import { invalidateGoalQueries } from '../src/utils/goalSync';
import { toast } from '../src/utils/toast';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { Entry, TIER, DAY_LONG, appWeekEndingISO } from '../src/components/bells/types';
import { APP_LOCALE } from '../src/utils/appTime';
import { BellsEditLockProvider } from '../src/components/bells/BellsEditLockContext';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { PillTabs, Kicker } from '../src/components/ui/PillTabs';
import { APP_LOCALE as LOCALE, formatMoney } from '../src/utils/appTime';

// ── Helpers ───────────────────────────────────────────────────────────────
// The Sunday ending this week, read in app (UK) time — not the phone's own
// zone — so everyone on the team lands on the same bells week.
function currentWeekEndingISO(): string {
  return appWeekEndingISO();
}
function isoAddDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function prettyWeekRange(weekEnding: string): string {
  const end = new Date(weekEnding + 'T00:00:00Z');
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
  const fmt = (d: Date) => d.toLocaleDateString(APP_LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${fmt(start)} – ${fmt(end)}`;
}
// "4 Oct" for a YYYY-MM-DD week-ending date.
function prettyDate(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString(APP_LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
// Numbers as the old stat tiles showed them: one decimal only when needed
// ("2" for 2.0, "2.9" for 2.9) — same output, now a glowing StatBlock.
function statDecimals(n: number): number {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? 0 : 1;
}
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// The sparkles FAB is pinned to the bottom-right of the VIEWPORT (58 px button
// + 16 px inset), so anything in that column is covered at SOME scroll offset —
// and the seventh day keycap is a whole 44 px tap target. Keep the keycap row
// out of that column (the FAB then reads as docked in the gutter instead of
// sitting on "Sun"). The proper fix is FAB-side; this is the screen's guard.
const FAB_GUTTER = 52;
// Goal-hit fill for the XP bars (the old bars turned green at 100%).
const GOAL_HIT_GRADIENT = ['#34d399', '#10b981', '#059669'] as const;

// ── Main screen ───────────────────────────────────────────────────────────
export default function BellsScreenWithLock() {
  return (
    <BellsEditLockProvider>
      <BellsScreen />
    </BellsEditLockProvider>
  );
}

function BellsScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { width: windowWidth } = useWindowDimensions();

  const tabBarClearance = useTabBarClearance();
  const { user } = useAuth();
  const canUse = user?.role === 'admin' || user?.role === 'leader';
  const queryClient = useQueryClient();

  const [weekEnding, setWeekEnding] = useState<string>(currentWeekEndingISO());
  const [refreshing, setRefreshing] = useState(false);
  const [dayModal, setDayModal] = useState<number | null>(null); // 0..6 when a day is tapped
  const [viewMode, setViewMode] = useState<'table' | 'team'>('table');
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  // Super admins can switch which office they're viewing; everyone else is
  // pinned to their own. `officeId` is threaded into every bells query so the
  // whole screen follows the toggle.
  const { officeId } = useActiveOffice();
  const { scrollY, onScroll } = useParallaxScroll();

  const list = useQuery({
    queryKey: ['bells', weekEnding, officeId],
    queryFn: () => apiService.listBells(weekEnding, officeId).then((r) => r.data),
    staleTime: 1000 * 15,
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    haptics.tap();
    await queryClient.invalidateQueries({ queryKey: ['bells', weekEnding, officeId] });
    // Also the crew-goal surfaces — the table's goal pencil refreshes through
    // here, and a goal edit has to reach the team cards and Home too.
    invalidateGoalQueries(queryClient);
    setRefreshing(false);
  }, [queryClient, weekEnding, officeId]);

  const { pullIndicator } = usePullToRefresh(onRefresh);

  // Seven day keycaps must fit the daily card on a phone: scroll padding 12×2,
  // card padding 14×2, six 4px gaps — and the FAB gutter, so the seventh key is
  // never parked under the floating button. Capped so desktop widths don't balloon.
  const dayKeySize = Math.max(32, Math.min(48, Math.floor((windowWidth - 24 - 28 - 6 * 4 - FAB_GUTTER) / 7)));

  if (!canUse) {
    // Trainees land here — the same sentence, printed on an ink block instead
    // of floating bare on the field.
    return (
      <View style={[styles.container, { padding: 16, paddingTop: 24 }]}>
        <View style={styles.restricted}>
          <Text style={styles.restrictedText}>Bells is for Coaches and Admins.</Text>
        </View>
      </View>
    );
  }

  const entries: Entry[] = list.data?.entries || [];
  const officeTotals: any = list.data?.office_totals || { total_sales: 0, days_worked: 0, earnings: 0, piece_average: 0, average_earnings_per_day: 0 };
  const isCurrentWeek = weekEnding === currentWeekEndingISO();
  const pieceAverage = num(officeTotals.piece_average);
  const dailyTotals: number[] = officeTotals.daily_totals || [0, 0, 0, 0, 0, 0, 0];

  return (
    <View style={styles.container}>
      {pullIndicator}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ padding: 12, paddingBottom: 60 + tabBarClearance }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          <View style={styles.shell}>
          {/* Office switcher (super admins only — renders nothing otherwise) */}
          <OfficeToggle style={{ marginBottom: 10 }} />

          {/* Which week, Table or Team, and the Admin's two weekly tools. */}
          <View style={styles.bar}>
            <View style={styles.weekNav}>
              <TouchableOpacity style={styles.navBtn} onPress={() => setWeekEnding(isoAddDays(weekEnding, -7))} accessibilityLabel="Previous week">
                <Ionicons name="chevron-back" size={16} color={colors.text} />
              </TouchableOpacity>
              <View style={styles.weekPill}>
                <Ionicons name="calendar-outline" size={13} color={colors.primary} />
                <Text style={styles.weekText} numberOfLines={1}>{isCurrentWeek ? 'This week · ' : ''}{prettyWeekRange(weekEnding)}</Text>
              </View>
              <TouchableOpacity style={styles.navBtn} onPress={() => setWeekEnding(isoAddDays(weekEnding, 7))} accessibilityLabel="Next week">
                <Ionicons name="chevron-forward" size={16} color={colors.text} />
              </TouchableOpacity>
              {!isCurrentWeek && (
                <TouchableOpacity onPress={() => setWeekEnding(currentWeekEndingISO())} style={styles.ghostBtn}>
                  <Text style={styles.ghostBtnText}>This week</Text>
                </TouchableOpacity>
              )}
            </View>
            <PillTabs
              items={[{ key: 'table', label: 'Table' }, { key: 'team', label: 'Team' }]}
              value={viewMode}
              onChange={(k) => setViewMode(k as 'table' | 'team')}
            />
            <View style={{ flex: 1 }} />
            {user?.role === 'admin' && (
              <View style={styles.tools}>
                <TouchableOpacity style={styles.ghostBtn} onPress={() => router.push('/snapshot' as any)} testID="bells-snapshot-btn">
                  <Ionicons name="speedometer-outline" size={14} color={colors.text} />
                  <Text style={styles.ghostBtnText}>Weekly Snapshot</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.ghostBtn} onPress={() => router.push('/bulletin' as any)} testID="bells-bulletin-btn">
                  <Ionicons name="trophy-outline" size={14} color={colors.text} />
                  <Text style={styles.ghostBtnText}>Weekly Bulletin</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* The office's week at a glance. */}
          <View style={styles.kpis}>
            <View style={[styles.kpi, styles.kpiLead]}>
              <Text style={[styles.kpiLabel, { color: colors.onPrimary }]}>Sign-ups</Text>
              <Text style={[styles.kpiValue, { color: colors.onPrimary }]}>{num(officeTotals.total_sales)}</Text>
              <Text style={[styles.kpiSub, { color: colors.onPrimary }]} numberOfLines={1}>
                {num(officeTotals.total_over30) > 0 ? `${num(officeTotals.total_over30)} at ${TIER.over30.short} · ${num(officeTotals.total_under30)} at ${TIER.under30.short}` : `${list.data?.office_name || 'Office'}`}
              </Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiLabel}>Piece average</Text>
              <Text style={styles.kpiValue}>{pieceAverage.toFixed(statDecimals(pieceAverage))}</Text>
              <Text style={styles.kpiSub} numberOfLines={1}>Sign-ups per day in</Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiLabel}>Scoring</Text>
              <Text style={styles.kpiValue}>{num(officeTotals.scoring_pct)}%</Text>
              <Text style={styles.kpiSub} numberOfLines={1}>Days in with a sign-up</Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiLabel}>Green weeks</Text>
              <Text style={styles.kpiValue}>{num(officeTotals.green_pct)}%</Text>
              <Text style={styles.kpiSub} numberOfLines={1}>Of the people in</Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiLabel}>BA fees</Text>
              <Text style={styles.kpiValue}>{formatMoney(num(officeTotals.earnings))}</Text>
              <Text style={styles.kpiSub} numberOfLines={1}>Sign-up fees so far</Text>
            </View>
            {officeTotals.mc_fees != null && (
              <View style={styles.kpi}>
                <Text style={styles.kpiLabel}>MC fees</Text>
                <Text style={styles.kpiValue}>{formatMoney(num(officeTotals.mc_fees))}</Text>
                <Text style={styles.kpiSub} numberOfLines={1}>{formatMoney(num(officeTotals.fee_mc))} a sign-up · Admins only</Text>
              </View>
            )}
          </View>

          {/* My Week — your goal + your crew's goal, editable right here. */}
          <MyWeekGoals
            entries={entries}
            weekEnding={weekEnding}
            isCurrentWeek={isCurrentWeek}
            onUpdated={() => invalidateGoalQueries(queryClient)}
          />

          {/* Each day's sign-ups: tap a day for who brought them in. */}
          {entries.length > 0 && (
            <View style={styles.dayRow}>
              {dailyTotals.map((v: number, i: number) => (
                <TouchableOpacity key={i} style={[styles.dayChip, v > 0 && styles.dayChipOn]} onPress={() => setDayModal(i)}
                  accessibilityLabel={`${DAY_LONG[i]}: ${v} sign-up${v === 1 ? '' : 's'}. Tap for details`}>
                  <Text style={styles.dayChipLabel}>{DAY_LABELS[i]}</Text>
                  <Text style={[styles.dayChipValue, v === 0 && { color: colors.textMuted }]}>{v}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {(() => {
            // Days the hourly OwnerIQ sync filled: its sign-up count lands in
            // the £12 column because OwnerIQ has no £12/£15+ split.
            const filled = entries.reduce((n, e) => {
              const mine: Record<string, number> = (e as any).owneriq_days || {};
              return n + Object.entries(mine).filter(([i, v]) => {
                const d: any = (e as any).days?.[Number(i)] || {};
                return d.under30 === v && !d.over30;   // still OwnerIQ's number
              }).length;
            }, 0);
            return filled > 0 ? (
              <View style={[styles.oiqNote, { borderColor: colors.border }]}>
                <Text style={[styles.oiqNoteText, { color: colors.textMuted }]}>
                  {filled} day{filled === 1 ? '' : 's'} this week came from OwnerIQ as £12 sign-ups.
                  Change any £15+ ones: once a day is edited here, the sync leaves it alone.
                </Text>
              </View>
            ) : null;
          })()}

          {list.isLoading ? (
            <Skeleton.List count={5} kind="bells" />
          ) : viewMode === 'team' ? (
            <TeamView weekEnding={weekEnding} office={officeId} />
          ) : entries.length === 0 ? (
            <EmptyState
              emoji="🔔"
              title="No bells yet for this week"
              subtitle={user?.role === 'admin'
                ? 'Sign-ups fill in from OwnerIQ through the day. Add people in Admin → Users.'
                : 'Bells will appear here once sign-ups come through for the week.'}
            />
          ) : (
            <TableView entries={entries} weekEnding={weekEnding} onRefresh={onRefresh} miniGoal={list.data?.mini_team_goal ?? null} officeId={officeId} />
          )}
          </View>
        </ScrollView>

        {dayModal !== null && (
          <DayBreakdownModal
            dayIdx={dayModal}
            entries={entries}
            weekEnding={weekEnding}
            onClose={() => setDayModal(null)}
            onUpdated={() => invalidateGoalQueries(queryClient)}
          />
        )}

        {/* AI-generated end-of-day WhatsApp breakdown — replaces the old quick-log FAB */}
        <DailyBreakdownSheet
          visible={breakdownOpen}
          onClose={() => setBreakdownOpen(false)}
        />
        <FAB
          icon="sparkles"
          onPress={() => setBreakdownOpen(true)}
          testID="bells-daily-breakdown-fab"
        />
      </KeyboardAvoidingView>
    </View>
  );
}

// ── My Week — the caller's own goal + their crew's goal, right on top of
// the sheet. Sign-up planning should be front-and-centre: XP bars fill
// toward the goal and ring the bell at 100%. Tapping the pencil edits the
// goal in place (personal → own bells row; crew → team_weekly_goal on the
// leader's row, the same field the Weekly Planner writes).
function MyWeekGoals({ entries, weekEnding, isCurrentWeek, onUpdated }: {
  entries: Entry[]; weekEnding: string; isCurrentWeek: boolean; onUpdated: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useAuth();
  const [edit, setEdit] = useState<'personal' | 'team' | null>(null);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);

  const myEntry = entries.find((e) => e.user_id && e.user_id === user?.id);
  const teamEntries = entries.filter((e) => e.primary_team?.leader_id && e.primary_team.leader_id === user?.id);

  const personalGoal = myEntry?.weekly_goal ?? null;
  const personalSales = myEntry?.total_sales ?? 0;
  const teamGoal = myEntry?.team_weekly_goal ?? null;
  // Crew covers the whole TREE — me plus every descendant — not just my section.
  // Sections are exclusive: anyone sitting under a sub-leader who is themselves
  // a section leader lands in THAT section, so summing `teamEntries` silently
  // drops whole branches. `team_subtree_sales` is the recursive total the server
  // already computes, and it's the like-for-like partner for the crew goal,
  // which covers the same subtree (the basis Home's Team pulse uses too).
  const subtreeSales = myEntry?.team_subtree_sales ?? null;
  const teamSales = subtreeSales ?? teamEntries.reduce((s, e) => s + (e.total_sales || 0), 0);
  // A leader whose reports are all section leaders has an empty section but very
  // much still has a crew — key off the goal / a subtree bigger than just me.
  const hasTeam = teamEntries.length > 0
    || teamGoal != null
    || (subtreeSales != null && subtreeSales > personalSales);
  if (!myEntry && !hasTeam) return null;

  const openEdit = (which: 'personal' | 'team') => {
    setInput(which === 'personal'
      ? (personalGoal != null ? String(personalGoal) : '')
      : (teamGoal != null ? String(teamGoal) : ''));
    setEdit(which);
  };
  const save = async () => {
    const raw = input.replace(/[^\d]/g, '');
    const n = raw ? parseInt(raw, 10) : null;
    setSaving(true);
    try {
      if (edit === 'personal') {
        // Endpoint always targets the CURRENT bells week (goal edits for
        // past/future weeks go through the Weekly Planner).
        await apiService.setMyWeeklyGoal(n as any);
      } else {
        await apiService.setTeamWeeklyGoal({ team_weekly_goal: n, week_ending: weekEnding });
      }
      setEdit(null);
      onUpdated();
      toast.success('Goal saved');
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Could not save the goal');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.myWeek}>
      <View style={styles.myWeekHead}>
        <Kicker style={{ marginBottom: 0 }}>My week</Kicker>
        {!isCurrentWeek && <Text style={styles.myWeekPast}>week ending {prettyDate(weekEnding)}</Text>}
      </View>
      <View style={styles.goalPair}>
      {myEntry && (
        <GoalBar label="My goal" sales={personalSales} goal={personalGoal}
          canEdit={isCurrentWeek} onEdit={() => openEdit('personal')} />
      )}
      {hasTeam && (
        <GoalBar label="Team goal" sales={teamSales} goal={teamGoal}
          canEdit onEdit={() => openEdit('team')} />
      )}
      </View>

      {/* Goal editor */}
      {edit !== null && (
        <View style={styles.goalEditRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            style={styles.goalInput}
            keyboardType="number-pad"
            placeholder={edit === 'personal' ? 'Your sign-up goal' : 'Team sign-up goal'}
            placeholderTextColor={colors.textMuted}
            autoFocus
          />
          <TouchableOpacity style={styles.goalCancelBtn} onPress={() => setEdit(null)} disabled={saving}>
            <Text style={styles.goalCancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.goalSaveBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving}>
            <Text style={styles.goalSaveText}>{saving ? '…' : 'Save'}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// Module-level (not re-created per render) so the XP bar keeps its charge
// while the goal input re-renders the card on every keystroke.
function GoalBar({ label, sales, goal, canEdit, onEdit }: {
  label: string; sales: number; goal: number | null; canEdit: boolean; onEdit: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { effective } = useTheme();
  const hitColor = effective === 'dark' ? '#34d399' : '#16a34a';
  const pct = goal && goal > 0 ? Math.min(100, Math.round((sales / goal) * 100)) : null;
  const hit = pct != null && pct >= 100;
  return (
    <View style={styles.goalBlock}>
      <View style={styles.goalHead}>
        <Text style={styles.goalLabel}>{label}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[styles.goalValue, hit && { color: hitColor }]}>
            {goal != null ? `${sales} / ${goal}${hit ? ' ✓' : ''}` : `${sales} · no goal set`}
          </Text>
          {canEdit && (
            <TouchableOpacity onPress={onEdit} hitSlop={8} testID={`bells-goal-edit-${label}`}>
              <Ionicons name="pencil" size={13} color={colors.primary} />
            </TouchableOpacity>
          )}
        </View>
      </View>
      <View style={styles.goalTrack}>
        <View style={[styles.goalFill, { width: `${pct ?? 0}%` as any }, hit && { backgroundColor: hitColor }]} />
      </View>
      {pct != null && <Text style={[styles.goalPct, hit && { color: hitColor }]}>{pct}% of goal</Text>}
    </View>
  );
}

// ── Styles (screen-level only) ────────────────────────────────────────────
const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  oiqNote: { borderWidth: 1, borderRadius: 12, padding: 10, marginTop: 10 },
  oiqNoteText: { fontSize: 12, lineHeight: 17 },
  restricted: { padding: 20, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  restrictedText: { fontFamily: fonts.bodySemibold, fontSize: 15, color: colors.text },

  shell: { width: '100%', maxWidth: 1240, alignSelf: 'center' },
  // Week, view and tools: one row that wraps on a phone.
  bar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  weekNav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  weekPill: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 36, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  weekText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.text },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ghostBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  ghostBtnText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: colors.text },

  // Headline tiles: three to a row on a phone, all on one line on a wide screen.
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kpi: { flexGrow: 1, flexBasis: 150, minWidth: 104, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  kpiLead: { backgroundColor: colors.primary, borderColor: colors.primary },
  kpiLabel: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: colors.textMuted },
  kpiValue: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30, letterSpacing: -0.6, color: colors.text, marginTop: 3, fontVariant: ['tabular-nums'] as any },
  kpiSub: { fontFamily: fonts.body, fontSize: 10.5, color: colors.textMuted, marginTop: 1, opacity: 0.9 },

  // Each day's sign-ups (opens the day's breakdown)
  dayRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  dayChip: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  dayChipOn: { borderColor: colors.primary },
  dayChipLabel: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textMuted },
  dayChipValue: { fontFamily: fonts.display, fontSize: 16, color: colors.text, fontVariant: ['tabular-nums'] as any },

  // My week
  myWeek: { marginTop: 10, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  myWeekHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8 },
  myWeekPast: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.textMuted },
  goalPair: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, rowGap: 12 },
  goalBlock: { flexGrow: 1, flexBasis: 260, minWidth: 220 },
  goalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  goalLabel: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: colors.textSecondary },
  goalValue: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.text, fontVariant: ['tabular-nums'] as any },
  goalTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  goalFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  goalPct: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted, marginTop: 4, textAlign: 'right' },
  goalEditRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  goalInput: { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, color: colors.text },
  goalCancelBtn: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  goalCancelText: { fontSize: 12, fontFamily: fonts.bodyBold, color: colors.textMuted },
  goalSaveBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, backgroundColor: colors.primary },
  goalSaveText: { fontSize: 12, fontFamily: fonts.bodyBold, color: colors.onPrimary },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
