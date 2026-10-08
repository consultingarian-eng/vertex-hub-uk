import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Alert, Modal, TextInput, KeyboardAvoidingView, LayoutChangeEvent, useWindowDimensions } from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import { apiService } from '../../api/client';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme/colors';
import { lightColors } from '../../theme/ThemeContext';
import { useColors, useTheme, fonts } from '../../theme/ThemeContext';
import { useAuth } from '../../auth/AuthContext';
import { teamColor, NO_TEAM_TINT } from '../../utils/teamColors';
import { toast } from '../../utils/toast';
import { Day, Entry, MIN_AB_REASON, TIER, isInDay, dayTotal } from './types';
import { APP_LOCALE, APP_TZ, formatMoney } from '../../utils/appTime';
import { centerNotice } from '../../utils/centerNotice';
import { APP_SHORT_NAME } from '../../theme/brand';
import { SUPER_GREEN_WEEK_MIN, GREEN_WEEK_MIN, AMBER_WEEK_MIN, RED_WEEK_MAX } from '../../utils/weekBands';

// ─────────────────────────────────────────────────────────────────────
// The weekly Bells sheet, laid out like the office's own spreadsheet.
//
//   NAME · COACH · STAGE · GOAL · LW · B/E · MON…SUN · TOTAL · DAYS · P/A ·
//   BA FEES · MC FEES (Admins only)
//
// One section per team, under a band in the team's colour:
//   • its people (the team's Coach first, starred)
//   • a Total row: the TEAM GOAL (tap to set it), last week, each day's
//     sign-ups, the week's total, days in, piece average and fees
//   • three slim rows: BAs in, Scoring BAs and Scoring ratio, day by day
// and at the foot, the same for the whole office, plus the office piece
// average per day. Each band also says what share of the office's sign-ups
// the team has brought in.
//
// A day cell is tinted the way the sheet colours it: 2 or more green, 1 amber,
// 0 red; a day off is a dash. Tap a day to edit it, a Goal or B/E to change
// it, a team's goal to set it.
//
// On a phone there is no table to scroll sideways: PhoneSheet shows the same
// sections as a list, one card per person (name, goal, total, the seven days
// as tappable pills, and a line of the rest), then the team's totals.
// ─────────────────────────────────────────────────────────────────────

/** The team for people who aren't in a named team yet (the Owner's own). */
const MINI_TEAM = `Mini ${APP_SHORT_NAME}`;
const MINI_KEY = '__no_team__';
const firstName = (n?: string | null) => (n || '').trim().split(/\s+/)[0] || '';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Column widths at 100% zoom.
// Name is wide enough for most full names on one line (a long one wraps to
// two); Coach holds a first name.
const W = { name: 176, coach: 100, stage: 42, goal: 48, lw: 44, be: 44, day: 46, tot: 52, days: 48, pa: 50, money: 80 };
const tableWidth = (showMc: boolean) =>
  W.name + W.coach + W.stage + W.goal + W.lw + W.be + W.day * 7 + W.tot + W.days + W.pa + W.money * (showMc ? 2 : 1);

// Traffic light: a dot beside the name, from last week's sign-ups.
// Applies to everyone with ≥4 prior weeks on bells.
// The owner's weekly tiers (src/utils/weekBands.ts): Red 5 and under,
// Amber 6-7, Green 8-9, Super Green 10+.
// Deep red = red last week AND red the week before.
function trafficLight(e: Entry): { color: string; label: string } | undefined {
  // Admins run the office — they aren't measured by the rep traffic light.
  if ((e as any).role === 'admin') return undefined;
  const priorWeeks = (e as any).prior_weeks ?? 0;
  if (priorWeeks < 4) return undefined; // not enough history yet
  const lw = e.last_week_total;
  if (lw == null) return undefined;
  const ppw = e.prev_prev_week_total ?? null;
  if (lw >= SUPER_GREEN_WEEK_MIN) return { color: '#16a34a', label: 'Super Green last week' };
  if (lw >= GREEN_WEEK_MIN) return { color: '#4ade80', label: 'Green last week' };
  if (lw >= AMBER_WEEK_MIN) return { color: '#f59e0b', label: 'Amber last week' };
  const alsoRedPrev = ppw != null && ppw <= RED_WEEK_MAX;
  return alsoRedPrev ? { color: '#991b1b', label: 'Red two weeks running' } : { color: '#ef4444', label: 'Red last week' };
}

/** A team's (or the office's) week, summed from its rows. */
type Tally = {
  sales: number[]; ins: number[]; scoring: number[];
  total: number; daysIn: number; daysScoring: number; peopleIn: number; peopleScoring: number;
  lastWeek: number | null; fees: number; mc: number;
};
function tally(rows: Entry[]): Tally {
  const t: Tally = { sales: Array(7).fill(0), ins: Array(7).fill(0), scoring: Array(7).fill(0),
    total: 0, daysIn: 0, daysScoring: 0, peopleIn: 0, peopleScoring: 0, lastWeek: null, fees: 0, mc: 0 };
  for (const e of rows) {
    let anyIn = false; let anyScore = false;
    (e.days || []).slice(0, 7).forEach((d, i) => {
      if (!isInDay(d)) return;
      const n = dayTotal(d);
      t.ins[i] += 1; t.daysIn += 1; anyIn = true; t.sales[i] += n;
      if (n > 0) { t.scoring[i] += 1; t.daysScoring += 1; anyScore = true; }
    });
    if (anyIn) t.peopleIn += 1;
    if (anyScore) t.peopleScoring += 1;
    t.total += e.total_sales || 0;
    t.fees += e.earnings || 0;
    t.mc += e.mc_fees || 0;
    if (e.last_week_total != null) t.lastWeek = (t.lastWeek ?? 0) + e.last_week_total;
  }
  return t;
}
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–');
const one = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

type Group = {
  key: string;            // leader_id or '__no_team__'
  team_name: string;      // e.g. the leader's team name, or "Unassigned"
  leader_id: string | null;
  leader_name: string | null;
  members: Entry[];       // ordered: leader first, then trainees
  total_sales: number;
  total_earnings: number;
  crew_goal: number | null; // team_weekly_goal from the section leader's row
  // The leader's WHOLE downline's sales. A section only holds members whose
  // nearest section-leader ancestor is this leader, so a leader whose reports
  // are themselves section leaders sits alone in their section and
  // total_sales is just their personal number. The crew goal covers the whole
  // downline, so it's compared against this instead.
  crew_sales: number | null;
};

function buildGroups(entries: Entry[], miniGoal?: number | null): Group[] {
  const map = new Map<string, Group>();
  for (const e of entries) {
    const pt = e.primary_team || null;
    const key = pt?.leader_id ? pt.leader_id : '__no_team__';
    // People with no team section of their own are Mini Vertex: a team like
    // any other on the sheet, at the top, where the office's sheet has it.
    const name = pt?.team_name || MINI_TEAM;
    if (!map.has(key)) {
      map.set(key, {
        key,
        team_name: name,
        leader_id: pt?.leader_id || null,
        leader_name: pt?.leader_name || null,
        members: [],
        total_sales: 0,
        total_earnings: 0,
        crew_goal: null,
        crew_sales: null,
      });
    }
    const g = map.get(key)!;
    g.members.push(e);
    g.total_sales += e.total_sales || 0;
    g.total_earnings += e.earnings || 0;
    if (e.user_id && e.user_id === g.leader_id) {
      if (e.team_weekly_goal != null) g.crew_goal = e.team_weekly_goal;
      if (e.team_subtree_sales != null) g.crew_sales = e.team_subtree_sales;
    }
  }
  // NOTE: Within-section order is now produced by the server's hierarchical
  // sort (leader → leaves newest-first → branches with their sub-trees inline).
  // We intentionally DO NOT re-sort `members` here. Doing so would clobber
  // that intentional ordering.
  // SECTION order also comes from the server (admin-led teams pinned first,
  // then descending sales) — a client-side sales re-sort here would clobber
  // the admin pinning, so only lift the office's own block to the top, where
  // the office's sheet has it (stable sort keeps the server's encounter order
  // for everything else).
  // Mini Vertex has no Coach's row to carry its goal: the office keeps it.
  const mini = map.get(MINI_KEY);
  if (mini) {
    mini.crew_goal = miniGoal ?? null;
    // Admins with nothing on the sheet this week sit at the foot of the team,
    // under the people who are out working (a stable sort: the rest keep the
    // server's order).
    const idle = (e: Entry) => (e.role === 'admin' && !e.total_sales && !e.days_worked ? 1 : 0);
    mini.members = [...mini.members].sort((x, y) => idle(x) - idle(y));
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.key === '__no_team__' && b.key !== '__no_team__') return -1;
    if (b.key === '__no_team__' && a.key !== '__no_team__') return 1;
    return 0;
  });
}

/** "12 Jul, 15:04" (UK time) — when an absence was signed off. */
function absDateTime(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return '';
  return t.toLocaleDateString(APP_LOCALE, { day: 'numeric', month: 'short', timeZone: APP_TZ })
    + ', ' + t.toLocaleTimeString(APP_LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: APP_TZ });
}

// A day cell the way the sheet colours it: in with 2+ sign-ups green, 1 amber,
// 0 red; off is a dash; the absence codes keep their letters.
type DayLook = { text: string; fg: string; bg?: string };
function cellForDay(d: Day, c: typeof colors, dark: boolean): DayLook {
  const red = dark ? '#fca5a5' : '#b91c1c';
  const amber = dark ? '#fcd34d' : '#b45309';
  const green = dark ? '#86efac' : '#166534';
  if (d.status === 'off') return { text: '–', fg: c.textMuted };
  if (d.status === 'ab') return { text: 'AB', fg: red };
  if (d.status === 'nc') return { text: 'NC', fg: c.textMuted };
  if (d.status === 'pc') return { text: 'PC', fg: dark ? '#67e8f9' : '#0e7490' };
  const tot = (d.over30 || 0) + (d.under30 || 0);
  if (d.status === 'rt') return { text: tot > 0 ? `RT ${tot}` : 'RT', fg: amber };
  if (tot >= 2) return { text: String(tot), fg: green, bg: dark ? 'rgba(34,197,94,0.20)' : 'rgba(34,197,94,0.18)' };
  if (tot === 1) return { text: '1', fg: amber, bg: dark ? 'rgba(245,158,11,0.20)' : 'rgba(245,158,11,0.20)' };
  return { text: '0', fg: red, bg: dark ? 'rgba(239,68,68,0.18)' : 'rgba(239,68,68,0.14)' };
}

export default function TableView({ entries, weekEnding, onRefresh, miniGoal, officeId }: {
  entries: Entry[]; weekEnding?: string; onRefresh?: () => void;
  /** Mini Vertex's goal for the week (it has no Coach's row to live on). */
  miniGoal?: number | null;
  officeId?: string;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const { user } = useAuth();

  // Crew goal — whole-team weekly target on the section header. Editable by
  // the section leader themself and by admins; synced with the Weekly
  // Planner's team-goal box (same team_weekly_goal field on the leader's row).
  const canEditCrewGoal = (g: Group) =>
    g.key === MINI_KEY
      ? user?.role === 'admin'
      : !!g.leader_id && (user?.role === 'admin' || !!(user as any)?.is_super_admin || user?.id === g.leader_id);
  const [goalEdit, setGoalEdit] = useState<{ leader_id: string; team_name: string } | null>(null);
  const [goalInput, setGoalInput] = useState('');
  const [goalSaving, setGoalSaving] = useState(false);
  const openGoalEdit = (g: Group) => {
    if (!g.leader_id && g.key !== MINI_KEY) return;
    setGoalInput(g.crew_goal != null ? String(g.crew_goal) : '');
    setGoalEdit({ leader_id: g.leader_id || MINI_KEY, team_name: g.team_name });
  };
  const saveCrewGoal = async () => {
    if (!goalEdit) return;
    const raw = goalInput.replace(/[^\d]/g, '');
    const n = raw ? parseInt(raw, 10) : null;
    setGoalSaving(true);
    try {
      if (goalEdit.leader_id === MINI_KEY) await apiService.setMiniTeamGoal({ goal: n, week_ending: weekEnding, office: officeId });
      else await apiService.setTeamWeeklyGoal({ team_weekly_goal: n, user_id: goalEdit.leader_id, week_ending: weekEnding });
      setGoalEdit(null);
      onRefresh?.();
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.detail || 'Could not save the crew goal.');
    } finally {
      setGoalSaving(false);
    }
  };

  // A person's own weekly goal and break-even: tap either cell on their row.
  // A goal set here sticks: the OwnerIQ sync only fills a goal nobody has
  // typed in the app.
  const [rowEdit, setRowEdit] = useState<Entry | null>(null);
  const [rowGoal, setRowGoal] = useState('');
  const [rowBe, setRowBe] = useState('');
  const [rowSaving, setRowSaving] = useState(false);
  const openRowEdit = (e: Entry) => {
    if (!weekEnding) return;
    setRowGoal(e.weekly_goal != null ? String(e.weekly_goal) : '');
    setRowBe(e.break_even != null ? String(e.break_even) : '');
    setRowEdit(e);
  };
  const saveRow = async () => {
    if (!rowEdit || !weekEnding) return;
    const n = (v: string) => { const raw = v.replace(/[^\d]/g, ''); return raw ? parseInt(raw, 10) : null; };
    const days = (rowEdit.days && rowEdit.days.length === 7 ? rowEdit.days : Array.from({ length: 7 }, () => ({ over30: null, under30: null, memberships: null, status: 'off' })));
    setRowSaving(true);
    try {
      await apiService.upsertBell({
        week_ending: weekEnding, user_name: rowEdit.user_name, user_id: rowEdit.user_id, office_id: rowEdit.office_id,
        stage: null, break_even: n(rowBe), weekly_goal: n(rowGoal), days,
      });
      setRowEdit(null);
      toast.success('Saved');
      onRefresh?.();
    } catch (e: any) {
      Alert.alert('Could not save', e?.response?.data?.detail || 'Try again');
    } finally {
      setRowSaving(false);
    }
  };

  // ── Tap-a-cell editing — the table is the sheet, so it edits like one.
  // Opens a small editor for that person+day: sign-up numbers + status.
  // Absences stay owner-gated: non-admins get a "Request AB" button that
  // fires the approval flow instead of writing to the sheet.
  const isAdminUser = user?.role === 'admin';
  const [cellEdit, setCellEdit] = useState<{ entry: Entry; dayIdx: number } | null>(null);
  const [cellO30, setCellO30] = useState('');
  const [cellU30, setCellU30] = useState('');
  // Not used by Vertex and never shown — carried so a save passes the row's
  // existing value straight back instead of wiping or inventing one.
  const [cellMem, setCellMem] = useState('');
  const [cellStatus, setCellStatus] = useState('off');
  const [cellSaving, setCellSaving] = useState(false);
  // AB request sub-step: reason box shown after tapping "Request AB", so
  // the owner always gets the why alongside the who/when.
  const [cellAbMode, setCellAbMode] = useState(false);
  const [cellAbReason, setCellAbReason] = useState('');
  // A reason is mandatory — the owner decides off the back of it.
  const cellAbReasonOk = cellAbReason.trim().length >= MIN_AB_REASON;
  // Approved-absence context for the day being viewed, if any.
  const abDetail = cellEdit ? cellEdit.entry.absence_details?.[String(cellEdit.dayIdx)] : undefined;
  const openCellEdit = (entry: Entry, dayIdx: number) => {
    if (!weekEnding) return;
    const d = entry.days?.[dayIdx] || { over30: null, under30: null, memberships: null, status: 'off' };
    setCellO30(d.over30 != null ? String(d.over30) : '');
    setCellU30(d.under30 != null ? String(d.under30) : '');
    setCellMem(d.memberships != null ? String(d.memberships) : '');
    setCellStatus(d.status || 'off');
    setCellAbMode(false);
    setCellAbReason('');
    setCellEdit({ entry, dayIdx });
  };
  const saveCell = async () => {
    if (!cellEdit || !weekEnding) return;
    const { entry, dayIdx } = cellEdit;
    const num = (s: string) => (s.trim() === '' ? null : Math.max(0, parseInt(s, 10) || 0));
    const clearing = ['off', 'nc', 'ab', 'pc'].includes(cellStatus);
    const nextDay: Day = {
      over30: clearing ? null : num(cellO30),
      under30: clearing ? null : num(cellU30),
      memberships: clearing ? null : num(cellMem),
      status: cellStatus,
    };
    // Typing numbers on an untouched day means they worked it.
    if ((nextDay.over30 || nextDay.under30) && (cellStatus === 'off' || !cellStatus)) {
      nextDay.status = 'in';
    }
    const days = (entry.days && entry.days.length === 7 ? [...entry.days] : Array.from({ length: 7 }, () => ({ over30: null, under30: null, memberships: null, status: 'off' })));
    days[dayIdx] = nextDay;
    setCellSaving(true);
    try {
      const res = await apiService.upsertBell({
        week_ending: weekEnding,
        user_name: entry.user_name,
        user_id: entry.user_id,
        office_id: entry.office_id,
        stage: null,
        break_even: entry.break_even,
        weekly_goal: entry.weekly_goal,
        days,
      });
      if ((res.data as any)?.absence_changes_blocked) {
        toast.error('Absence changes need the owner’s approval — use Request AB instead');
      } else {
        toast.success('Saved');
      }
      setCellEdit(null);
      onRefresh?.();
    } catch (e: any) {
      Alert.alert('Could not save', e?.response?.data?.detail || 'Try again');
    } finally {
      setCellSaving(false);
    }
  };
  const sendAbRequestFromCell = async () => {
    if (!cellEdit || !weekEnding || !cellEdit.entry.user_id) return;
    if (!cellAbReasonOk) return;
    const { entry, dayIdx } = cellEdit;
    setCellSaving(true);
    try {
      await apiService.createAbsenceRequest({
        target_user_id: entry.user_id!,
        week_ending: weekEnding,
        day_indices: [dayIdx],
        reason: cellAbReason.trim(),
      });
      setCellEdit(null);
      centerNotice.success('Absence requested', 'The office owner has been notified and will approve or deny it.');
    } catch (e: any) {
      Alert.alert('Could not request', e?.response?.data?.detail || 'Try again');
    } finally {
      setCellSaving(false);
    }
  };

  const handleClearDay = (dayIndex: number, dayName: string) => {
    if (!weekEnding) return;
    Alert.alert(
      `Clear ${dayName}?`,
      `This will mark everyone as off for ${dayName} and remove all sign-ups entered for that day. Use this if the paste was applied to the wrong date.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear day',
          style: 'destructive',
          onPress: async () => {
            try {
              await apiService.clearBellsDay(weekEnding, dayIndex);
              onRefresh?.();
            } catch { /* ignore */ }
          },
        },
      ],
    );
  };

  // ── Zoom — continuous 0.35x→2x, multiplying cell widths + font sizes
  // (real relayout, so text stays crisp at every level). "Fit" snaps the
  // whole sheet into the viewport width — the page-fill view, like the
  // schedule tab's fit-to-width. On native you can also pinch: live scale
  // feedback during the gesture, committed as a relayout when you let go.
  const MIN_Z = 0.35;
  const MAX_Z = 2;
  const clampZ = (v: number) => Math.max(MIN_Z, Math.min(MAX_Z, v));
  const [z, setZ] = useState(1);
  const [vw, setVw] = useState(0);
  const { height: winH, width: winW } = useWindowDimensions();
  // A phone gets the list (PhoneSheet); anything wider gets the sheet.
  const phone = winW < 720;
  const onWrapLayout = (e: LayoutChangeEvent) => setVw(e.nativeEvent.layout.width);
  // MC fees is the office's own figure: the server only sends it to Admins.
  const showMc = entries.some((e) => e.mc_fees != null);
  const fullTableW = tableWidth(showMc);
  const fitZ = vw > 0 ? clampZ((vw - 2) / fullTableW) : MIN_Z;
  const isFit = Math.abs(z - fitZ) < 0.02;
  const isWeb = Platform.OS === 'web';

  // Native pinch → live transform while pinching, commit on release.
  const pinchLive = useSharedValue(1);
  const zRef = React.useRef(z);
  zRef.current = z;
  const commitPinch = (scaleFactor: number) => {
    setZ(clampZ(zRef.current * scaleFactor));
  };
  const pinchGesture = useMemo(() => Gesture.Pinch()
    .onUpdate((e) => { pinchLive.value = e.scale; })
    .onEnd((e) => {
      runOnJS(commitPinch)(e.scale);
      pinchLive.value = 1;
    }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const pinchStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pinchLive.value }] as any,
    transformOrigin: 'top left' as any,
  }));

  // Sticky positioning (web only — RN native ignores 'sticky' position)
  const HEAD_H = 34 * z;
  const stickyHeader: any = isWeb ? { position: 'sticky', top: 0, zIndex: 30, backgroundColor: colors.surface } : {};
  const stickyTeam: any = isWeb ? { position: 'sticky', top: HEAD_H, zIndex: 20 } : {};
  const stickyNameCol: any = isWeb ? { position: 'sticky', left: 0, zIndex: 25, borderRightWidth: 1, borderRightColor: colors.border } : {};
  const stickyNameColHeader: any = isWeb ? { position: 'sticky', left: 0, top: 0, zIndex: 35, backgroundColor: colors.surface, borderRightWidth: 1, borderRightColor: colors.border } : {};
  // Every width follows the zoom. At 100% on a screen wider than the sheet,
  // the columns stretch to fill it (the type stays the same size).
  const stretch = z === 1 && vw > fullTableW + 2 ? Math.min(1.35, (vw - 2) / fullTableW) : 1;
  const w = useMemo(() => Object.fromEntries(Object.entries(W).map(([k, v]) => [k, v * z * stretch])) as typeof W, [z, stretch]);
  const totalW = fullTableW * z * stretch;
  const cellFont = 13 * z;
  const headerFont = 10 * z;

  const groups = useMemo(() => buildGroups(entries, miniGoal), [entries, miniGoal]);
  const office = useMemo(() => tally(entries), [entries]);

  const head = (label: string, width: number, extra?: any) => (
    <View style={[styles.headerCell, { width, height: HEAD_H }, extra]}>
      <Text style={[styles.headerText, { fontSize: headerFont }]} numberOfLines={1}>{label}</Text>
    </View>
  );
  const Header = (sticky: boolean) => (
    <View style={[styles.headerRow, sticky && stickyHeader, { width: totalW }]}>
      <View style={[styles.headerCell, styles.nameCell, sticky && stickyNameColHeader, { width: w.name, height: HEAD_H }]}>
        <Text style={[styles.headerText, { fontSize: headerFont }]}>Name</Text>
      </View>
      {head('Coach', w.coach, { alignItems: 'flex-start', paddingHorizontal: 8 * z })}
      {head('Stage', w.stage)}
      {head('Goal', w.goal)}
      {head('LW', w.lw)}
      {head('B/E', w.be)}
      {DAYS.map((d, i) => (
        <TouchableOpacity key={i} style={[styles.headerCell, { width: w.day, height: HEAD_H }]} onLongPress={() => handleClearDay(i, d)} delayLongPress={600}>
          <Text style={[styles.headerText, { fontSize: headerFont }]}>{d}</Text>
        </TouchableOpacity>
      ))}
      {head('Total', w.tot)}
      {head('Days', w.days)}
      {head('P/A', w.pa)}
      {head('BA fees', w.money)}
      {showMc ? head('MC fees', w.money) : null}
    </View>
  );
  const body = (sticky: boolean) => (
    <BodyContent
      groups={groups} office={office} colors={colors} isDark={isDark} styles={styles} z={z} w={w} totalW={totalW} showMc={showMc}
      cellFont={cellFont} stickyNameCol={sticky ? stickyNameCol : {}} stickyTeam={sticky ? stickyTeam : {}} entries={entries}
      canEditGoal={canEditCrewGoal} onEditGoal={openGoalEdit} onCellPress={openCellEdit} onRowPress={openRowEdit}
    />
  );

  return (
    <View style={phone ? styles.phoneWrap : styles.wrap} onLayout={onWrapLayout}>
      {phone ? (
        <PhoneSheet
          groups={groups} office={office} entries={entries} colors={colors} isDark={isDark} styles={styles} showMc={showMc}
          canEditGoal={canEditCrewGoal} onEditGoal={openGoalEdit} onCellPress={openCellEdit} onRowPress={openRowEdit}
        />
      ) : (
      <>
      {/* Toolbar: what a tap does, and the zoom. */}
      <View style={styles.zoomBar}>
        <Text style={styles.zoomHint} numberOfLines={2}>
          Tap a day to edit it · tap a Goal to change it{isWeb ? '' : ' · pinch to zoom'}
        </Text>
        <View style={styles.zoomBtns}>
          <TouchableOpacity
            style={[styles.zoomBtn, z <= MIN_Z && styles.zoomBtnDisabled]}
            onPress={() => setZ((v) => clampZ(v / 1.15))}
            disabled={z <= MIN_Z}
            accessibilityLabel="Zoom out"
          >
            <Ionicons name="remove" size={15} color={z <= MIN_Z ? colors.textMuted : colors.text} />
          </TouchableOpacity>
          <Text style={styles.zoomLabel}>{Math.round(z * 100)}%</Text>
          <TouchableOpacity
            style={[styles.zoomBtn, z >= MAX_Z && styles.zoomBtnDisabled]}
            onPress={() => setZ((v) => clampZ(v * 1.15))}
            disabled={z >= MAX_Z}
            accessibilityLabel="Zoom in"
          >
            <Ionicons name="add" size={15} color={z >= MAX_Z ? colors.textMuted : colors.text} />
          </TouchableOpacity>
          {/* Page-fill: the whole sheet snapped into the screen width */}
          <TouchableOpacity
            style={[styles.fitBtn, isFit && styles.fitBtnActive]}
            onPress={() => setZ(isFit ? 1 : fitZ)}
            accessibilityLabel="Fit whole sheet to screen"
          >
            <Ionicons name={isFit ? 'expand' : 'contract'} size={12} color={isFit ? colors.onPrimary : colors.text} />
            <Text style={[styles.fitBtnText, isFit && { color: colors.onPrimary }]}>{isFit ? '100%' : 'Fit'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Scrollable table region. On web we use a single overflow:auto box so
          position:sticky works for both axes. On native, fall back to a
          horizontal ScrollView (sticky won't work but row scrolling will). */}
      {isWeb ? (
        <View style={[styles.webScroll, { maxHeight: Math.max(440, winH - 190) }] as any}>
          {Header(true)}
          {body(true)}
        </View>
      ) : (
        <GestureDetector gesture={pinchGesture}>
        <Animated.View style={pinchStyle}>
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View>
            {Header(false)}
            {body(false)}
          </View>
        </ScrollView>
        </Animated.View>
        </GestureDetector>
      )}
      </>
      )}

      {/* A person's goal and break-even */}
      <Modal visible={!!rowEdit} transparent animationType="fade" onRequestClose={() => setRowEdit(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.cgBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setRowEdit(null)} />
          <View style={styles.cgCard}>
            <Text style={styles.cgTitle}>{rowEdit?.user_name}</Text>
            <Text style={styles.cgSub}>Their own target for this week, and their break-even. Leave a box empty to clear it.</Text>
            <View style={styles.ceNumRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.ceNumLabel}>Weekly goal (sign-ups)</Text>
                <TextInput value={rowGoal} onChangeText={setRowGoal} style={styles.ceNumInput} keyboardType="number-pad"
                  placeholder="–" placeholderTextColor={colors.textMuted} autoFocus accessibilityLabel="Weekly goal" testID="bells-row-goal" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.ceNumLabel}>Break-even (B/E)</Text>
                <TextInput value={rowBe} onChangeText={setRowBe} style={styles.ceNumInput} keyboardType="number-pad"
                  placeholder="–" placeholderTextColor={colors.textMuted} accessibilityLabel="Break-even" />
              </View>
            </View>
            <View style={styles.cgRowBtns}>
              <TouchableOpacity style={[styles.cgBtn, styles.cgBtnGhost]} onPress={() => setRowEdit(null)} disabled={rowSaving}>
                <Text style={styles.cgBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.cgBtn, styles.cgBtnPrimary, rowSaving && { opacity: 0.6 }]} onPress={saveRow} disabled={rowSaving} testID="bells-row-save">
                <Text style={[styles.cgBtnPrimaryText, { color: colors.onPrimary }]}>{rowSaving ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Day-cell editor — tap any day cell in the table to edit it */}
      <Modal visible={!!cellEdit} transparent animationType="fade" onRequestClose={() => setCellEdit(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.cgBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setCellEdit(null)} />
          <View style={styles.cgCard}>
            <Text style={styles.cgTitle}>{cellEdit?.entry.user_name} — {cellEdit ? DAYS[cellEdit.dayIdx] : ''}</Text>

            {/* Why this AB was granted + when the owner signed it off. Shown
                to admins and leaders alike so the sheet explains itself. */}
            {cellEdit && cellStatus === 'ab' && !!abDetail && (
              <View style={styles.abDetailBox}>
                <View style={styles.abDetailHead}>
                  <Ionicons name="calendar-outline" size={13} color="#b45309" />
                  <Text style={styles.abDetailHeadText}>Approved absence</Text>
                </View>
                {!!abDetail.reason && <Text style={styles.abDetailReason}>“{abDetail.reason}”</Text>}
                <Text style={styles.abDetailMeta}>
                  {abDetail.decided_by_name ? `Approved by ${abDetail.decided_by_name}` : 'Approved'}
                  {abDetail.decided_at ? ` · ${absDateTime(abDetail.decided_at)}` : ''}
                </Text>
                {!!abDetail.requested_by && (
                  <Text style={styles.abDetailMeta}>Requested by {abDetail.requested_by}</Text>
                )}
                {!!abDetail.decision_note && (
                  <Text style={styles.abDetailMeta}>Note — “{abDetail.decision_note}”</Text>
                )}
              </View>
            )}

            {cellEdit && cellStatus === 'ab' && !isAdminUser ? (
              <Text style={styles.cgSub}>
                Approved absence — only the office owner can change this day. Everything else on the row stays editable.
              </Text>
            ) : (
              <>
                <View style={styles.ceNumRow}>
                  {([
                    { label: TIER.over30.long, short: TIER.over30.short, value: cellO30, set: setCellO30 },
                    { label: TIER.under30.long, short: TIER.under30.short, value: cellU30, set: setCellU30 },
                  ] as const).map((f) => (
                    <View key={f.label} style={{ flex: 1 }}>
                      <Text style={styles.ceNumLabel}>{f.label}</Text>
                      <TextInput
                        value={f.value}
                        onChangeText={f.set}
                        accessibilityLabel={`${cellEdit ? DAYS_LONG[cellEdit.dayIdx] : ''} ${f.short} sign-ups`}
                        style={styles.ceNumInput}
                        keyboardType="number-pad"
                        placeholder="—"
                        placeholderTextColor={colors.textMuted}
                        editable={!['off', 'nc', 'ab', 'pc'].includes(cellStatus)}
                      />
                    </View>
                  ))}
                </View>
                <View style={styles.ceStatusRow}>
                  {(['in', 'off', 'rt', 'nc', 'pc', ...(isAdminUser ? ['ab'] : [])] as string[]).map((s) => (
                    <TouchableOpacity
                      key={s}
                      style={[styles.ceStatusChip, cellStatus === s && styles.ceStatusChipActive]}
                      onPress={() => setCellStatus(s)}
                    >
                      <Text style={[styles.ceStatusChipText, cellStatus === s && { color: colors.onPrimary }]}>{s.toUpperCase()}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {/* Non-admins request absences instead of writing them —
                    with a reason box so the owner gets the why. */}
                {!isAdminUser && cellEdit && cellEdit.dayIdx <= 5 && !!cellEdit.entry.user_id && (
                  !cellAbMode ? (
                    <TouchableOpacity style={styles.ceAbBtn} onPress={() => setCellAbMode(true)}>
                      <Ionicons name="hourglass-outline" size={14} color="#b45309" />
                      <Text style={styles.ceAbBtnText}>Request AB — owner approves</Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={styles.ceAbBox}>
                      <Text style={styles.ceNumLabel}>Reason for absence — required, the owner sees this</Text>
                      <TextInput
                        value={cellAbReason}
                        onChangeText={setCellAbReason}
                        style={styles.ceAbReasonInput}
                        placeholder="e.g. Doctor's appointment"
                        placeholderTextColor={colors.textMuted}
                        multiline
                        autoFocus
                      />
                      {!cellAbReasonOk && (
                        <Text style={styles.ceAbHint}>Add a reason before sending — the owner needs it to decide.</Text>
                      )}
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <TouchableOpacity style={[styles.cgBtn, styles.cgBtnGhost, { flex: 1, minWidth: 0 }]} onPress={() => setCellAbMode(false)} disabled={cellSaving}>
                          <Text style={styles.cgBtnGhostText}>Back</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.cgBtn, { flex: 2, minWidth: 0, backgroundColor: '#b45309' }, (cellSaving || !cellAbReasonOk) && { opacity: 0.5 }]}
                          onPress={sendAbRequestFromCell}
                          disabled={cellSaving || !cellAbReasonOk}
                        >
                          <Text style={styles.cgBtnPrimaryText}>{cellSaving ? 'Sending…' : 'Send AB request'}</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )
                )}
              </>
            )}
            <View style={styles.cgRowBtns}>
              <TouchableOpacity style={[styles.cgBtn, styles.cgBtnGhost]} onPress={() => setCellEdit(null)} disabled={cellSaving}>
                <Text style={styles.cgBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              {!(cellStatus === 'ab' && !isAdminUser) && (
                <TouchableOpacity style={[styles.cgBtn, styles.cgBtnPrimary, cellSaving && { opacity: 0.6 }]} onPress={saveCell} disabled={cellSaving}>
                  <Text style={[styles.cgBtnPrimaryText, { color: colors.onPrimary }]}>{cellSaving ? 'Saving…' : 'Save'}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Crew goal editor — same field the Weekly Planner's team-goal box edits */}
      <Modal visible={!!goalEdit} transparent animationType="fade" onRequestClose={() => setGoalEdit(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.cgBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setGoalEdit(null)} />
          <View style={styles.cgCard}>
            <Text style={styles.cgTitle}>Team goal — {goalEdit?.team_name}</Text>
            <Text style={styles.cgSub}>
              {goalEdit?.leader_id === MINI_KEY
                ? "The sign-up target this week for the people who aren't in a named team yet. It shows on the team's band and Total row. Leave empty to clear."
                : "The team's sign-up target for this week. It shows on the team's band and Total row here, on the Coach's Home and in their Weekly Plan. Leave empty to clear."}
            </Text>
            <TextInput
              value={goalInput}
              onChangeText={setGoalInput}
              style={styles.cgInput}
              keyboardType="number-pad"
              placeholder="e.g. 40"
              placeholderTextColor={colors.textMuted}
              autoFocus
            />
            <View style={styles.cgRowBtns}>
              <TouchableOpacity style={[styles.cgBtn, styles.cgBtnGhost]} onPress={() => setGoalEdit(null)} disabled={goalSaving}>
                <Text style={styles.cgBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.cgBtn, styles.cgBtnPrimary, goalSaving && { opacity: 0.6 }]} onPress={saveCrewGoal} disabled={goalSaving}>
                <Text style={[styles.cgBtnPrimaryText, { color: colors.onPrimary }]}>{goalSaving ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// Pulled out so the same body markup serves both the web (sticky) and the
// native (horizontal-scroll) paths above.
function BodyContent({ groups, office, colors, isDark, styles, z, w, totalW, showMc, cellFont, stickyNameCol, stickyTeam, entries, canEditGoal, onEditGoal, onCellPress, onRowPress }: any) {
  const rowH = 38 * z;
  const slimH = 26 * z;
  const small = 11 * z;
  const num = (text: string | number, width: number, style?: any) => (
    <View style={[styles.cell, { width, height: rowH }]}>
      <Text style={[styles.cellText, { fontSize: cellFont }, style]} numberOfLines={1}>{text}</Text>
    </View>
  );
  // The three slim rows under a Total row: who was in, who scored, and the ratio.
  const slim = (label: string, days: (string | number)[], tot: string | number, daysCell: string | number, key: string, pa?: string) => (
    <View key={key} style={[styles.slimRow, { width: totalW, height: slimH }]}>
      <View style={[styles.cell, styles.nameCell, stickyNameCol, { width: w.name, height: slimH, backgroundColor: colors.surface }]}>
        <Text style={[styles.slimLabel, { fontSize: small }]} numberOfLines={1}>{label}</Text>
      </View>
      <View style={{ width: w.coach + w.stage + w.goal + w.lw + w.be }} />
      {days.map((v, i) => (
        <View key={i} style={[styles.cell, { width: w.day, height: slimH }]}><Text style={[styles.slimText, { fontSize: small }]}>{v}</Text></View>
      ))}
      <View style={[styles.cell, { width: w.tot, height: slimH }]}><Text style={[styles.slimText, { fontSize: small }]}>{tot}</Text></View>
      <View style={[styles.cell, { width: w.days, height: slimH }]}><Text style={[styles.slimText, { fontSize: small }]}>{daysCell}</Text></View>
      <View style={[styles.cell, { width: w.pa, height: slimH }]}><Text style={[styles.slimText, { fontSize: small }]}>{pa ?? ''}</Text></View>
    </View>
  );
  const totalRow = (label: string, t: Tally, goal: React.ReactNode, key: string) => (
    <View key={key} style={[styles.totalRow, { width: totalW }]}>
      <View style={[styles.cell, styles.nameCell, stickyNameCol, { width: w.name, height: rowH, backgroundColor: colors.surfaceAlt }]}>
        <Text style={[styles.totalLabel, { fontSize: cellFont }]} numberOfLines={1}>{label}</Text>
      </View>
      <View style={{ width: w.coach + w.stage }} />
      <View style={[styles.cell, { width: w.goal, height: rowH }]}>{goal}</View>
      {num(t.lastWeek ?? '–', w.lw, styles.totalText)}
      <View style={{ width: w.be }} />
      {t.sales.map((v, i) => <React.Fragment key={i}>{num(v, w.day, styles.totalText)}</React.Fragment>)}
      {num(t.total, w.tot, styles.totalBig)}
      {num(t.daysIn, w.days, styles.totalText)}
      {num(t.daysIn > 0 ? one(t.total / t.daysIn) : '–', w.pa, styles.totalText)}
      {num(formatMoney(t.fees), w.money, styles.totalText)}
      {showMc ? num(formatMoney(t.mc), w.money, styles.totalText) : null}
    </View>
  );
  return (
    <>
          {groups.map((g: Group) => {
            const tint = g.key === '__no_team__' ? NO_TEAM_TINT : teamColor(g.leader_id || g.team_name);
            // Dark theme: the pastel pill would read as a paper island floating on
            // the ink sheet, so the band becomes a tinted ink bar and the pale tone
            // moves to the type (both are 6-digit hex from teamColors — safe to
            // concat alpha onto; never onto a theme token).
            const bandBg = isDark ? tint.border + '26' : tint.pill;
            const bandText = isDark ? tint.pill : tint.text;
            const t = tally(g.members);
            // The goal covers the Coach's whole downline, so it is measured
            // against that when the server sends it.
            const hit = g.crew_sales ?? g.total_sales;
            const canGoal = !!canEditGoal?.(g);
            return (
              <View key={g.key}>
                {/* Team band — sticky under the header on web */}
                <View style={[styles.teamHeader, stickyTeam, { backgroundColor: bandBg, borderLeftColor: tint.border, width: totalW }]}>
                  <View style={[styles.teamHeaderLeft, isWebSticky(stickyNameCol) && ({ position: 'sticky', left: 10 } as any)]}>
                    <Text style={[styles.teamHeaderText, { color: bandText, fontSize: 12.5 * z }]} numberOfLines={1}>{g.team_name}</Text>
                    {g.leader_name ? (
                      <Text style={[styles.teamHeaderLeader, { color: bandText, fontSize: 11 * z }]} numberOfLines={1}>led by {firstName(g.leader_name)}</Text>
                    ) : null}
                    <View style={[styles.bandChip, { borderColor: bandText }]}>
                      <Text style={[styles.bandChipText, { color: bandText, fontSize: 10.5 * z }]}>
                        {g.crew_goal != null ? `${hit} / ${g.crew_goal} goal${hit >= g.crew_goal ? ' ✓' : ''}` : `${g.total_sales} sign-up${g.total_sales === 1 ? '' : 's'}`}
                      </Text>
                    </View>
                    <View style={[styles.bandChip, { borderColor: bandText }]}>
                      <Text style={[styles.bandChipText, { color: bandText, fontSize: 10.5 * z }]}>{pct(g.total_sales, office.total)} of office</Text>
                    </View>
                  </View>
                </View>

                {/* People */}
                {g.members.map((e: Entry, idx: number) => {
                  const isLeader = e.user_id === g.leader_id;
                  const light = trafficLight(e);
                  return (
                    <View key={e.user_id || idx} style={[styles.bodyRow, { width: totalW }]}>
                      {/* The frozen name cell is OPAQUE, always, or the scrolling
                          day columns show through it. */}
                      <View style={[styles.cell, styles.nameCell, stickyNameCol, { width: w.name, height: rowH, backgroundColor: colors.background }]}>
                        {light ? <View style={[styles.lightDot, { backgroundColor: light.color }]} accessibilityLabel={light.label} /> : <View style={styles.lightDot} />}
                        {isLeader && <Ionicons name="star" size={10 * z} color={colors.primary} style={{ marginRight: 4 }} />}
                        {/* The whole name, always: a long one takes a second line. */}
                        <Text style={[styles.nameText, { fontSize: cellFont, lineHeight: 15.5 * z, fontFamily: isLeader ? fonts.bodyBold : fonts.bodySemibold }]} numberOfLines={2}>{e.user_name}</Text>
                      </View>
                      <View style={[styles.cell, { width: w.coach, height: rowH, alignItems: 'flex-start', paddingHorizontal: 8 * z }]}>
                        <Text style={[styles.softText, { fontSize: 12 * z }]} numberOfLines={1}>{firstName(e.coach_name) || '–'}</Text>
                      </View>
                      {num(e.stage_label || '–', w.stage, styles.softText)}
                      <TouchableOpacity style={[styles.cell, { width: w.goal, height: rowH }]} onPress={() => onRowPress?.(e)} activeOpacity={0.6}
                        accessibilityLabel={`${e.user_name}'s goal: ${e.weekly_goal ?? 'not set'}. Tap to change`} testID={`bells-goal-${e.user_id || idx}`}>
                        <Text style={[styles.cellText, { fontSize: cellFont }, e.weekly_goal == null && styles.softText]}>{e.weekly_goal != null ? String(e.weekly_goal) : '–'}</Text>
                      </TouchableOpacity>
                      {num(e.last_week_total != null ? String(e.last_week_total) : '–', w.lw, styles.softText)}
                      <TouchableOpacity style={[styles.cell, { width: w.be, height: rowH }]} onPress={() => onRowPress?.(e)} activeOpacity={0.6}
                        accessibilityLabel={`${e.user_name}'s break-even: ${e.break_even ?? 'not set'}. Tap to change`}>
                        <Text style={[styles.cellText, styles.softText, { fontSize: cellFont }]}>{e.break_even != null ? String(e.break_even) : '–'}</Text>
                      </TouchableOpacity>
                      {(e.days || []).slice(0, 7).map((d: Day, i: number) => {
                        const look = cellForDay(d, colors, !!isDark);
                        return (
                          <TouchableOpacity key={i} style={[styles.cell, { width: w.day, height: rowH }]} onPress={() => onCellPress?.(e, i)} activeOpacity={0.6}>
                            <View style={[styles.dayPill, { minWidth: 30 * z, height: 24 * z, borderRadius: 7 * z }, look.bg ? { backgroundColor: look.bg } : null]}>
                              <Text style={[styles.dayText, { fontSize: look.bg ? cellFont : 11.5 * z, color: look.fg }]}>{look.text}</Text>
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                      {num(e.total_sales, w.tot, styles.strongText)}
                      {num(e.days_worked, w.days)}
                      {num(e.piece_average.toFixed(1), w.pa)}
                      {num(formatMoney(e.earnings || 0), w.money)}
                      {showMc ? num(formatMoney(e.mc_fees || 0), w.money, styles.softText) : null}
                    </View>
                  );
                })}

                {/* The team's Total row, with its goal */}
                {totalRow('Total', t, (
                  <TouchableOpacity disabled={!canGoal} onPress={() => onEditGoal?.(g)} style={styles.goalBtn} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                    accessibilityLabel={`Team goal for ${g.team_name}: ${g.crew_goal ?? 'not set'}${canGoal ? '. Tap to set' : ''}`} testID={`bells-team-goal-${g.key}`}>
                    <Text style={[styles.totalText, { fontSize: cellFont }, g.crew_goal == null && { color: colors.primary }]}>{g.crew_goal != null ? String(g.crew_goal) : canGoal ? 'Set' : '–'}</Text>
                    {canGoal && g.crew_goal != null ? <Ionicons name="pencil" size={9 * z} color={colors.primary} /> : null}
                  </TouchableOpacity>
                ), `total-${g.key}`)}
                {slim("BAs in", t.ins, t.peopleIn, t.daysIn, `in-${g.key}`)}
                {slim('Scoring BAs', t.scoring, t.peopleScoring, t.daysScoring, `sc-${g.key}`)}
                {slim('Scoring ratio', t.ins.map((n: number, i: number) => pct(t.scoring[i], n)), pct(t.daysScoring, t.daysIn), '', `ratio-${g.key}`)}
              </View>
            );
          })}

          {/* The whole office */}
          {entries.length > 0 && (
            <View>
              <View style={[styles.teamHeader, stickyTeam, styles.officeBand, { width: totalW }]}>
                <View style={[styles.teamHeaderLeft, isWebSticky(stickyNameCol) && ({ position: 'sticky', left: 10 } as any)]}>
                  <Text style={[styles.teamHeaderText, { color: colors.onPrimary, fontSize: 12.5 * z }]}>Office</Text>
                  <Text style={[styles.teamHeaderLeader, { color: colors.onPrimary, fontSize: 11 * z }]}>{entries.length} people on the sheet</Text>
                </View>
              </View>
              {totalRow('Office total', office, <Text style={[styles.softText, { fontSize: cellFont }]}>–</Text>, 'total-office')}
              {slim('BAs in', office.ins, office.peopleIn, office.daysIn, 'in-office')}
              {slim('Scoring BAs', office.scoring, office.peopleScoring, office.daysScoring, 'sc-office')}
              {slim('Scoring ratio', office.ins.map((n: number, i: number) => pct(office.scoring[i], n)), pct(office.daysScoring, office.daysIn), '', 'ratio-office')}
              {slim('Piece average', office.ins.map((n: number, i: number) => (n > 0 ? one(office.sales[i] / n) : '–')), '', '', 'pa-office', office.daysIn > 0 ? one(office.total / office.daysIn) : '–')}
            </View>
          )}
          {entries.length === 0 && (
            <View style={styles.emptyRow}>
              <Text style={styles.emptyText}>No entries this week.</Text>
            </View>
          )}
    </>
  );
}
const isWebSticky = (sticky: any) => !!sticky && sticky.position === 'sticky';

// ── The phone's Bells: the same sections as a list ───────────────────────────
function PhoneSheet({ groups, office, entries, colors, isDark, styles, showMc, canEditGoal, onEditGoal, onCellPress, onRowPress }: any) {
  // A label and seven cells, lined up under the day letters.
  const statRow = (label: string, vals: (string | number)[], strong?: boolean) => (
    <View style={styles.pStatRow}>
      <Text style={styles.pStatLabel} numberOfLines={1}>{label}</Text>
      {vals.map((v, i) => <Text key={i} style={[styles.pStat, strong && styles.pStatStrong]}>{v}</Text>)}
    </View>
  );
  const summary = (label: string, t: Tally, goal: React.ReactNode, extra?: React.ReactNode) => (
    <View style={styles.pTotal}>
      <View style={styles.pHead}>
        <Text style={styles.pTotalLabel}>{label}</Text>
        {goal}
        <View style={{ flex: 1 }} />
        <Text style={styles.pTotalNum}>{t.total}</Text>
        <Text style={styles.pTotalUnit}>sign-ups</Text>
      </View>
      {statRow('', DAYS.map((d) => d.charAt(0)))}
      {statRow('Sign-ups', t.sales, true)}
      {statRow('BAs in', t.ins)}
      {statRow('Scoring BAs', t.scoring)}
      {statRow('Scoring ratio', t.ins.map((n: number, i: number) => pct(t.scoring[i], n)))}
      {extra}
      <Text style={styles.pMeta}>
        {[`Days in ${t.daysIn}`, `P/A ${t.daysIn > 0 ? one(t.total / t.daysIn) : '–'}`, t.lastWeek != null ? `Last week ${t.lastWeek}` : null,
          `BA fees ${formatMoney(t.fees)}`, showMc ? `MC fees ${formatMoney(t.mc)}` : null].filter(Boolean).join('  ·  ')}
      </Text>
    </View>
  );
  return (
    <View>
      <Text style={styles.pHint}>Tap a day to edit it. Tap Goal to change someone's goal.</Text>
      {groups.map((g: Group) => {
        const tint = g.key === '__no_team__' ? NO_TEAM_TINT : teamColor(g.leader_id || g.team_name);
        const bandBg = isDark ? tint.border + '26' : tint.pill;
        const bandText = isDark ? tint.pill : tint.text;
        const t = tally(g.members);
        const hit = g.crew_sales ?? g.total_sales;
        const canGoal = !!canEditGoal?.(g);
        return (
          <View key={g.key} style={styles.pSection}>
            <View style={[styles.pBand, { backgroundColor: bandBg, borderLeftColor: tint.border }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.teamHeaderText, { color: bandText, fontSize: 12.5 }]} numberOfLines={1}>{g.team_name}</Text>
                {g.leader_name ? <Text style={[styles.teamHeaderLeader, { color: bandText, fontSize: 11 }]} numberOfLines={1}>led by {firstName(g.leader_name)}</Text> : null}
              </View>
              <View style={[styles.bandChip, { borderColor: bandText }]}>
                <Text style={[styles.bandChipText, { color: bandText, fontSize: 11 }]}>
                  {g.crew_goal != null ? `${hit} / ${g.crew_goal}${hit >= g.crew_goal ? ' ✓' : ''}` : `${g.total_sales}`}
                </Text>
              </View>
              <View style={[styles.bandChip, { borderColor: bandText }]}>
                <Text style={[styles.bandChipText, { color: bandText, fontSize: 11 }]}>{pct(g.total_sales, office.total)}</Text>
              </View>
            </View>

            {g.members.map((e: Entry, idx: number) => {
              const isLeader = e.user_id === g.leader_id;
              const light = trafficLight(e);
              return (
                <View key={e.user_id || idx} style={styles.pCard}>
                  <View style={styles.pHead}>
                    {light ? <View style={[styles.lightDot, { backgroundColor: light.color }]} accessibilityLabel={light.label} /> : null}
                    {isLeader && <Ionicons name="star" size={11} color={colors.primary} style={{ marginRight: 4 }} />}
                    <Text style={[styles.pName, { fontFamily: isLeader ? fonts.bodyBold : fonts.bodySemibold }]} numberOfLines={2}>{e.user_name}</Text>
                    <TouchableOpacity onPress={() => onRowPress?.(e)} style={styles.pGoal} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                      accessibilityLabel={`${e.user_name}'s goal: ${e.weekly_goal ?? 'not set'}. Tap to change`} testID={`bells-goal-${e.user_id || idx}`}>
                      <Text style={styles.pGoalText}>{e.weekly_goal != null ? `Goal ${e.weekly_goal}` : 'Set goal'}</Text>
                    </TouchableOpacity>
                    <Text style={styles.pTot}>{e.total_sales}</Text>
                  </View>
                  <View style={styles.pPills}>
                    {(e.days || []).slice(0, 7).map((d: Day, i: number) => {
                      const look = cellForDay(d, colors, !!isDark);
                      return (
                        <TouchableOpacity key={i} style={[styles.pPill, look.bg ? { backgroundColor: look.bg, borderColor: 'transparent' } : null]} onPress={() => onCellPress?.(e, i)} activeOpacity={0.6}
                          accessibilityLabel={`${DAYS_LONG[i]}: ${look.text}. Tap to edit`}>
                          <Text style={styles.pPillDay}>{DAYS[i].charAt(0)}</Text>
                          <Text style={[styles.pPillNum, { color: look.fg }]}>{look.text}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <Text style={styles.pMeta} numberOfLines={2}>
                    {[e.coach_name ? `Coach ${firstName(e.coach_name)}` : null, e.stage_label ? `Stage ${e.stage_label}` : null,
                      e.last_week_total != null ? `LW ${e.last_week_total}` : null, e.break_even != null ? `B/E ${e.break_even}` : null,
                      `P/A ${e.piece_average.toFixed(1)}`, `BA fees ${formatMoney(e.earnings || 0)}`,
                      showMc ? `MC ${formatMoney(e.mc_fees || 0)}` : null].filter(Boolean).join('  ·  ')}
                  </Text>
                </View>
              );
            })}

            {summary('Team total', t, (
              <TouchableOpacity disabled={!canGoal} onPress={() => onEditGoal?.(g)} style={styles.pGoal} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                accessibilityLabel={`Team goal for ${g.team_name}: ${g.crew_goal ?? 'not set'}${canGoal ? '. Tap to set' : ''}`} testID={`bells-team-goal-${g.key}`}>
                <Text style={styles.pGoalText}>{g.crew_goal != null ? `Team goal ${g.crew_goal}` : canGoal ? 'Set team goal' : 'No team goal'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        );
      })}
      {entries.length > 0 ? (
        <View style={styles.pSection}>
          <View style={[styles.pBand, styles.officeBand]}>
            <Text style={[styles.teamHeaderText, { color: colors.onPrimary, fontSize: 12.5, flex: 1 }]}>Office</Text>
            <Text style={[styles.teamHeaderLeader, { color: colors.onPrimary, fontSize: 11 }]}>{entries.length} people</Text>
          </View>
          {summary('Office total', office, null,
            statRow('Piece average', office.ins.map((n: number, i: number) => (n > 0 ? one(office.sales[i] / n) : '–'))))}
        </View>
      ) : (
        <View style={styles.emptyRow}><Text style={styles.emptyText}>No entries this week.</Text></View>
      )}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  // The sheet wrapper keeps its opaque `surface` fill + overflow clip (the
  // sticky header/name column scroll inside it), so it is NOT a DepthCard;
  // on web it borrows the depth shadow string directly (a CSS box-shadow is
  // not clipped by the element's own overflow).
  wrap: {
    marginTop: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    overflow: 'hidden',
  },
  webScroll: ({ overflow: 'auto', WebkitOverflowScrolling: 'touch' } as any),
  zoomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 7, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8 },
  zoomHint: { flex: 1, fontSize: 11.5, color: colors.textMuted, fontFamily: fonts.body },
  zoomBtns: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 4, paddingVertical: 2 },
  zoomBtn: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  zoomBtnDisabled: { opacity: 0.4 },
  zoomLabel: { fontSize: 11, fontFamily: fonts.bodySemibold, color: colors.text, minWidth: 36, textAlign: 'center', fontVariant: ['tabular-nums'] as any },
  fitBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 26, borderRadius: 8, borderWidth: 1, borderColor: colors.border, marginLeft: 2 },
  fitBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  fitBtnText: { fontSize: 10.5, fontFamily: fonts.bodyBold, color: colors.text },
  // Day-cell editor
  ceNumRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  ceNumLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.3, marginBottom: 3 },
  ceNumInput: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, color: colors.text, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10, fontSize: 16, textAlign: 'center', fontVariant: ['tabular-nums'] as any },
  ceStatusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  ceStatusChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  ceStatusChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  ceStatusChipText: { fontSize: 11, fontWeight: '800', color: colors.textSecondary },
  ceAbBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: '#fde68a', backgroundColor: '#fef3c7', marginBottom: 4 },
  ceAbBtnText: { fontSize: 12, fontWeight: '800', color: '#92400e' },
  ceAbBox: { borderRadius: 10, borderWidth: 1, borderColor: '#fde68a', backgroundColor: '#fffbeb', padding: 10, marginBottom: 4, gap: 8 },
  ceAbReasonInput: { borderWidth: 1, borderColor: '#fde68a', backgroundColor: '#fff', color: '#0A0610', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, minHeight: 44, textAlignVertical: 'top' },
  ceAbHint: { fontSize: 11, color: '#b45309', marginTop: 6, marginBottom: 2, fontWeight: '600' },
  abDetailBox: { backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fde68a', borderRadius: 10, padding: 10, marginTop: 10, marginBottom: 2, gap: 3 },
  abDetailHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  abDetailHeadText: { fontSize: 10, fontWeight: '900', color: '#b45309', letterSpacing: 0.4, textTransform: 'uppercase' },
  abDetailReason: { fontSize: 13, color: '#0A0610', lineHeight: 18, marginTop: 2 },
  abDetailMeta: { fontSize: 11, color: '#92400e', lineHeight: 15 },
  headerRow: { flexDirection: 'row', backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerCell: { justifyContent: 'center', alignItems: 'center' },
  headerText: { color: colors.textMuted, fontFamily: fonts.mono, letterSpacing: 0.8, textTransform: 'uppercase' },
  // A cell: no vertical rules, so the sheet reads as rows.
  cell: { justifyContent: 'center', alignItems: 'center' },
  nameCell: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: 10, paddingRight: 6 },
  bodyRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.background },
  nameText: { flex: 1, color: colors.text },
  lightDot: { width: 7, height: 7, borderRadius: 4, marginRight: 7 },
  cellText: { fontFamily: fonts.body, color: colors.text, fontVariant: ['tabular-nums'] as any },
  softText: { fontFamily: fonts.body, color: colors.textMuted, fontVariant: ['tabular-nums'] as any },
  strongText: { fontFamily: fonts.bodyBold, color: colors.text },
  dayPill: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  dayText: { fontFamily: fonts.bodyBold, fontVariant: ['tabular-nums'] as any },

  // Team band
  teamHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 32, paddingHorizontal: 10, paddingVertical: 5, borderLeftWidth: 4, borderLeftColor: 'transparent' },
  teamHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  teamHeaderText: { fontFamily: fonts.displayWide, letterSpacing: 0.6, textTransform: 'uppercase' },
  teamHeaderLeader: { fontFamily: fonts.body, opacity: 0.85, flexShrink: 1 },
  bandChip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1, opacity: 0.9 },
  bandChipText: { fontFamily: fonts.bodySemibold, fontVariant: ['tabular-nums'] as any },
  officeBand: { backgroundColor: colors.primary, borderLeftColor: colors.primary },

  // ── Phone list ──
  phoneWrap: { marginTop: 10 },
  pHint: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginBottom: 8, marginLeft: 2 },
  pSection: { marginBottom: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, overflow: 'hidden' },
  pBand: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, paddingVertical: 7, borderLeftWidth: 4, borderLeftColor: 'transparent' },
  pCard: { paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  pHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pName: { flex: 1, fontSize: 14.5, color: colors.text },
  pGoal: { minHeight: 26, paddingHorizontal: 9, borderRadius: 13, justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  pGoalText: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: colors.primary },
  pTot: { minWidth: 30, textAlign: 'right', fontFamily: fonts.display, fontSize: 19, color: colors.text, fontVariant: ['tabular-nums'] as any },
  pPills: { flexDirection: 'row', gap: 5, marginTop: 8 },
  // 44px tall: a comfortable thumb target.
  pPill: { flex: 1, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  pPillDay: { fontFamily: fonts.mono, fontSize: 9, color: colors.textMuted },
  pPillNum: { fontFamily: fonts.bodyBold, fontSize: 14, marginTop: 1, fontVariant: ['tabular-nums'] as any },
  pMeta: { fontFamily: fonts.body, fontSize: 11.5, lineHeight: 16, color: colors.textMuted, marginTop: 7 },
  pTotal: { paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surfaceAlt },
  pTotalLabel: { fontFamily: fonts.bodyBold, fontSize: 13.5, color: colors.text, marginRight: 4 },
  pTotalNum: { fontFamily: fonts.display, fontSize: 20, color: colors.text, fontVariant: ['tabular-nums'] as any },
  pTotalUnit: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted },
  pStatRow: { flexDirection: 'row', alignItems: 'center', minHeight: 22, marginTop: 2 },
  pStatLabel: { width: 86, fontFamily: fonts.body, fontSize: 11, color: colors.textMuted },
  pStat: { flex: 1, textAlign: 'center', fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, fontVariant: ['tabular-nums'] as any },
  pStatStrong: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.text },

  // Total row + the three slim rows under it
  totalRow: { flexDirection: 'row', backgroundColor: colors.surfaceAlt, borderBottomWidth: 1, borderBottomColor: colors.border },
  totalLabel: { fontFamily: fonts.bodyBold, color: colors.text, marginLeft: 14 },
  totalText: { fontFamily: fonts.bodyBold, color: colors.text, fontVariant: ['tabular-nums'] as any },
  totalBig: { fontFamily: fonts.display, color: colors.text },
  goalBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  slimRow: { flexDirection: 'row', backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  slimLabel: { fontFamily: fonts.body, color: colors.textMuted, marginLeft: 14 },
  slimText: { fontFamily: fonts.body, color: colors.textMuted, fontVariant: ['tabular-nums'] as any },
  // Crew goal editor modal
  cgBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  cgCard: { width: '100%', maxWidth: 380, backgroundColor: colors.surface, borderRadius: 16, padding: 22, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 12 },
  cgTitle: { fontSize: 18, fontFamily: fonts.display, color: colors.text, marginBottom: 6 },
  cgSub: { fontSize: 13, color: colors.textSecondary, lineHeight: 18, marginBottom: 16 },
  cgInput: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, color: colors.text, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, marginBottom: 18 },
  cgRowBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  cgBtn: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 10, minWidth: 88, alignItems: 'center', justifyContent: 'center' },
  cgBtnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  cgBtnGhostText: { color: colors.text, fontWeight: '700', fontSize: 15 },
  cgBtnPrimary: { backgroundColor: colors.primary },
  cgBtnPrimaryText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  emptyRow: { paddingVertical: 30, alignItems: 'center' },
  emptyText: { color: colors.textMuted, fontSize: 12 },

  hint: { fontSize: 10, color: colors.textMuted, textAlign: 'center', paddingVertical: 6, fontStyle: 'italic', backgroundColor: colors.surface },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
