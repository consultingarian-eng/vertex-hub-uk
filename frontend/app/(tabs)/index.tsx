/**
 * Home — the role-aware landing dashboard.
 *
 * Everyone lands here after login. One glance answers "what's my day":
 *   Trainee → Start Here hub, journey progress, today's office schedule,
 *             learning quick-actions.
 *   Leader  → team pulse (statuses, who needs attention), today's schedule,
 *             leading quick-actions.
 *   Admin   → office pulse (actives, unassigned), today's schedule,
 *             office-management quick-actions.
 *
 * Data comes exclusively from existing endpoints (dashboard/stats,
 * new-hires, schedule, trainee/my-progress) — max three light queries per
 * role, so it stays fast on the small server.
 */
import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, Image,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useIsLandscape } from '../../src/hooks/useIsLandscape';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { useColors, useTheme, buildGetStatusColor, fonts } from '../../src/theme/ThemeContext';
import { APP_SHORT_NAME, GRADIENT, GRADIENT_TEXT } from '../../src/theme/brand';
import { api, apiService, NewHire } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import PressableScale from '../../src/components/ui/PressableScale';
import { usePullToRefresh } from '../../src/components/ui/PullRefresh';
import { AnimatedNumber } from '../../src/components/ui/AnimatedNumber';
import { Skeleton } from '../../src/components/ui/Skeleton';
import FieldAveragesCard from '../../src/components/home/FieldAveragesCard';
import FieldIqWeekCard from '../../src/components/home/FieldIqWeekCard';
import LiveOpsCard from '../../src/components/home/LiveOpsCard';
import PrimetimeCard from '../../src/components/home/PrimetimeCard';
import { Stagger } from '../../src/components/ui/Reveal';
import { StreakFlame } from '../../src/components/ui/StreakFlame';
import { useParallaxScroll } from '../../src/components/ui/Parallax';
import { DepthCard, CardStack } from '../../src/components/ui/DepthCard';
import { EditorialHero, useHeroCubeInset } from '../../src/components/ui/EditorialHero';
import { GradientText } from '../../src/components/ui/GradientText';
import { StatBlock } from '../../src/components/ui/StatBlock';
import { XPBar } from '../../src/components/ui/XPBar';
import { HexCoin, type HexCoinTint } from '../../src/components/ui/HexCoin';
import { OrbitRing, orbitRingInnerSize } from '../../src/components/ui/OrbitRing';
import { GlowButton } from '../../src/components/ui/GlowButton';
import { SectionHead } from '../../src/components/ui/SectionHead';
import { StatusRail } from '../../src/components/ui/StatusRail';
import { avatarColor } from '../../src/utils/avatarColor';
import { useBadgeWatcher } from '../../src/gamification/badges';
import { showAlert } from '../../src/utils/showAlert';
import { toast } from '../../src/utils/toast';
import { invalidateGoalQueries } from '../../src/utils/goalSync';
import { codStageShortName, furthestCodStage } from '../../src/components/cod/stageOrder';
import { roleTitle, heroRankTitle } from '../../src/utils/roleTitle';
import { APP_LOCALE } from '../../src/utils/appTime';

type QuickAction = {
  label: string;
  sub: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  route: string;
  tint?: 'primary' | 'green' | 'accent' | 'yellow';
  /** Stable testID suffix when the on-screen label has been reworded. */
  testKey?: string;
};

const ORIENT_DAYS = [1, 2];
const FIELD_DAYS = [3, 4, 5, 6, 7, 8];
const JOURNEY_TOTAL = ORIENT_DAYS.length + FIELD_DAYS.length;

// Amber, used only as a WELL FILL now (the Monthly Goal Planner's "not started
// yet" icon tile). The journey bars used to run it and painted a finished
// phase in the warning hue — see the journey card.
const ORIENT_GRADIENT = ['#f59e0b', '#fbbf24'] as const;
// Hero avatar: 56px OrbitRing (spec §3.16) → the photo fills the ring's inner circle.
const HERO_RING = 56;
const HERO_AVATAR = orbitRingInnerSize(HERO_RING);

// ── Hero cube geometry ──────────────────────────────────────────────────────
// The Vertex X renders BEHIND the header row, so it has to start below the
// avatar or it draws through someone's face. The header column is greeting
// (17 + 6) + the 44px name (lineHeight 50) + the date (14 + 6) ≈ 94 px, the
// block's own top padding is insets.top + 14 (EditorialHero `topEdge`), and
// VertexMark leaves 18 % of empty box above the X — so the box top that puts
// the X on the header's bottom edge is insets.top + 14 + 94 − 18 % of the size.
const HERO_CUBE_SIZE = 144;
// Bleeds a little off the right edge; the blades and the dense dots stay in frame.
const HERO_CUBE_RIGHT = -12;
const HERO_HEADER_H = 94;
const HERO_CUBE_BODY = Math.round(HERO_CUBE_SIZE * 0.18);
const heroCubeTop = (insetTop: number) => insetTop + 14 + HERO_HEADER_H - HERO_CUBE_BODY;
// …and the block has to be tall enough to hold the whole mark clear of the
// 18 px the NEXT card rides up over (EditorialHero `overlapNext`), plus air.
const HERO_CUBE_AIR = 30;
const heroMinHeight = (insetTop: number) =>
  heroCubeTop(insetTop) + HERO_CUBE_SIZE + HERO_CUBE_AIR;

// Success green as TEXT. brand green (#10B981) is a FILL colour: on a white
// card it measures 2.5:1, so every green numeral, tick label and "goal hit"
// line in the light theme runs this darker stop instead (5.0:1 on white,
// 4.6:1 on greenBg). Icons, dots and chip fills keep colors.green.
const GREEN_TEXT_LIGHT = '#047857';
const brandLime = '#b7df58';

// "This week" row wells — a 44px gradient tile per state (spec §4 Home 11:
// the flat glyph rows get the same lit icon well the Quick actions grid uses).
const WELL_GREEN = ['#10b981', '#34d399'] as const;
const WELL_AMBER = ORIENT_GRADIENT;
// The 24×2 brand bar that sits under every oversized Home numeral — StatBlock's
// accent, hand-placed here because these numerals keep their inline trend
// arrows / "/ goal" text and so can't be StatBlocks.
const accentStyles = StyleSheet.create({
  bar: { width: 24, height: 2, borderRadius: 1, marginTop: 6, marginBottom: 2 },
});
const StatAccent = () => (
  <LinearGradient
    colors={GRADIENT}
    start={{ x: 0, y: 0 }}
    end={{ x: 1, y: 0 }}
    style={accentStyles.bar}
  />
);

// Sales-level coin metal: 🌱 green · 🥉 bronze · 🥈 silver · 🥇🏅 gold · 🐐 purple
const levelTintFor = (level: number | null | undefined): HexCoinTint =>
  level == null ? 'purple'
    : level >= 6 ? 'purple'
    : level >= 4 ? 'gold'
    : level === 3 ? 'silver'
    : level === 2 ? 'bronze'
    : 'green';

/**
 * The hero's game row (coin · rank name · XP bar).
 *
 * Rendered INSIDE the EditorialHero so it can ask `useHeroCubeInset()` how
 * much of the content column the cube occupies and stop exactly at the cube's
 * drawn left edge (+10 px of air) — the number is derived from the cube's own
 * size/offset instead of being a hand-tuned constant that rots the moment the
 * cube changes.
 */
function CodMeter({ label, done, total, styles }: { label: string; done: number; total: number; styles: any }) {
  const full = total > 0 && done >= total;
  return (
    <View style={styles.codMeter} accessibilityLabel={`${label}: ${done} of ${total} marked off`}>
      <View style={styles.codMeterHead}>
        <Text style={styles.codMeterLabel}>{label}</Text>
        <Text style={[styles.codMeterValue, full && styles.codMeterDone]}>{full ? 'Marked off' : `${done}/${total}`}</Text>
      </View>
      <View style={styles.codTrack}>
        <View style={[styles.codFill, { width: `${total ? Math.min(100, (done / total) * 100) : 0}%` as any }]} />
      </View>
    </View>
  );
}

function HeroGameRow({ style, children }: { style?: any; children: React.ReactNode }) {
  const inset = useHeroCubeInset();
  return <View style={[style, { paddingRight: inset + 10 }]}>{children}</View>;
}

export default function HomeScreen() {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  // Green as TEXT (see GREEN_TEXT_LIGHT) — fills, dots and icons stay colors.green.
  const greenText = isDark ? colors.green : GREEN_TEXT_LIGHT;
  // Status-chip LABELS come from buildGetStatusColor, which hands back
  // colors.green for a "Green" row — 2.4:1 on the pale green chip in light.
  // Swap just that one text colour here; the chip fill and every icon keep it.
  // (The real fix is a greenText entry in the palette — ThemeContext isn't ours.)
  const statusText = (t: string) => (!isDark && t === colors.green ? GREEN_TEXT_LIGHT : t);
  const getStatusColor = useMemo(() => buildGetStatusColor(colors), [colors]);
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  // Two columns once the page is wide enough to hold them.
  const [shellW, setShellW] = useState(0);
  const wide = shellW >= 980;
  const isLandscape = useIsLandscape();
  const router = useRouter();
  const { scrollY, onScroll } = useParallaxScroll();
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();
  useBadgeWatcher();

  // Leader's CREW goal — the Team pulse shows the whole crew's sales, so the
  // number it's measured against is the crew goal (team_weekly_goal on the
  // leader's bells row — the same field the Weekly Planner's team-goal box
  // and the Bells team header edit). Personal goal lives on Bells/planner.
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [goalInput, setGoalInput] = useState('');
  // Admin Home: the weekly/daily leader-plan rosters are long, so they collapse.
  // Default collapsed — admins expand them on demand.
  const [startsOpen, setStartsOpen] = useState(false);
  const [weeklyPlansOpen, setWeeklyPlansOpen] = useState(false);
  const [dailyPlansOpen, setDailyPlansOpen] = useState(false);
  const setGoalMut = useMutation({
    mutationFn: (goal: number) => apiService.setTeamWeeklyGoal({ team_weekly_goal: goal }),
    onSuccess: () => {
      invalidateGoalQueries(queryClient);
      setShowGoalModal(false);
    },
    onError: (e: any) => showAlert('Error', e?.response?.data?.detail || 'Could not save your goal.'),
  });
  const saveGoal = () => {
    const n = parseInt(goalInput.replace(/[^\d]/g, ''), 10);
    if (!n || n <= 0) { showAlert('Enter a number', 'Your crew’s weekly goal should be a positive number of sign-ups.'); return; }
    setGoalMut.mutate(n);
  };

  // Admin one-tap: nudge the leader responsible for a lagging grading row.
  // The server throttles to one admin nudge per leader per 3h — a 429 comes
  // back with the retry time in `detail`, surfaced verbatim in the toast.
  const remindMut = useMutation({
    mutationFn: (leaderUserId: string) => apiService.remindLeader(leaderUserId),
    onSuccess: () => toast.success('Nudge sent'),
    onError: (e: any) => {
      const detail = e?.response?.data?.detail;
      if (e?.response?.status === 429) toast.warning('Already nudged', detail || 'Try again in a few hours.');
      else toast.error('Nudge failed', detail || 'Try again.');
    },
  });

  const role = (user?.role || '').toLowerCase();
  const isTrainee = role === 'trainee';
  const isAdmin = role === 'admin';
  const isLeader = role === 'leader';

  // Home stays anchored to the viewer's HOME office. Super admins oversee
  // several offices, but Home is their base (home office) — the office toggle on
  // Bells/Team/Spider is where they switch. Non-super users pass undefined
  // (the backend pins them to their own office anyway).
  const homeOffice = user?.is_super_admin ? (user?.office_id || undefined) : undefined;

  // ── Queries (role-gated so each role fires at most 3) ──────────────────
  const progressQ = useQuery({
    queryKey: ['trainee-progress'],
    queryFn: () => apiService.getTraineeProgress().then((r) => r.data),
    enabled: isTrainee,
  });
  // Sales Development Path — the front-door card, every role. Returns
  // {enabled:false} while the office is dark, so nothing renders.
  const salesPathQ = useQuery({
    queryKey: ['sales-path-me'],
    queryFn: () => apiService.getMySalesPath().then((r) => r.data),
  });
  // Day objectives — powers the "Up next … today's mission" line on the
  // journey card so trainees see WHAT the day is about, not just its number.
  const targetsQ = useQuery({
    queryKey: ['targets'],
    queryFn: () => apiService.getTargets().then((r) => r.data),
    enabled: isTrainee,
  });
  // COD stage — the hero's game layer for a viewer with no sales ladder (an
  // admin's /sales-path/me answers {enabled:false}, so without this their ink
  // block has no coin, no rank and no bar at all). Same query key the COD tab
  // uses, so it is usually a cache read; hidden silently if it fails.
  const stageStatusQ = useQuery({
    queryKey: ['stage-status'],
    queryFn: () => apiService.getStageStatus().then((r) => r.data),
    // Everyone: the hero shows the COD title alongside the sales level, so a
    // rep WITH a sales ladder needs this too. It used to fire only for a
    // viewer who turned out to have no ladder, which meant the COD title
    // could never appear for the people who have both (owner, 2026-09-14).
    // One cached request per 5 minutes.
    enabled: true,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const statsQ = useQuery({
    queryKey: ['dashboard-stats', homeOffice],
    queryFn: () => apiService.getDashboardStats(homeOffice).then((r) => r.data),
    enabled: !isTrainee,
  });
  const hiresQ = useQuery({
    queryKey: ['new-hires', homeOffice],
    queryFn: () => apiService.getNewHires(homeOffice).then((r) => r.data),
    enabled: !isTrainee,
  });
  const scheduleQ = useQuery({
    queryKey: ['schedule'],
    queryFn: () => apiService.listSchedule().then((r) => r.data),
  });
  const leaderTodayQ = useQuery({
    queryKey: ['leader-today', homeOffice],
    queryFn: () => apiService.getLeaderToday(homeOffice).then((r) => r.data),
    enabled: !isTrainee,
  });
  // Weekly/Daily Planner hero — has today's plan been filled in yet?
  // Trainees get the same day-page mechanism, just without the week review.
  const weeklyPlannerQ = useQuery({
    queryKey: ['weekly-planner-home'],
    queryFn: () => {
      const d = new Date();
      d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); // upcoming Sunday (local)
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return apiService.getWeeklyPlanner(iso).then((r) => r.data);
    },
    enabled: isLeader || isTrainee,
    staleTime: 60 * 1000,
    retry: false,
  });
  // Leader pulses — team + personal quality KPIs from the week just gone
  // (gold %, membership %, fails, closed 2nd/4th delivery rates).
  const leaderPulseQ = useQuery({
    queryKey: ['weekly-planner-pulse'],
    queryFn: () => {
      const d = new Date();
      const off = (7 - d.getDay()) % 7;
      d.setDate(d.getDate() + (off === 0 ? 7 : off)); // planning week's Sunday
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return apiService.weeklyPlannerStats(iso).then((r) => r.data);
    },
    enabled: isLeader,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  // Admin: which leaders have submitted this week's weekly plan
  const planRosterQ = useQuery({
    queryKey: ['weekly-planner-roster-home'],
    queryFn: () => apiService.weeklyPlannerTeamRoster().then((r) => r.data),
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  // Admin: who's written TODAY's daily plan — trainees + leaders + admins
  // alike. Only people who HAVE planned come back (nothing on Sundays).
  const dailyRosterQ = useQuery({
    queryKey: ['weekly-planner-daily-roster-home'],
    queryFn: () => apiService.weeklyPlannerDailyRoster().then((r) => r.data),
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  // Notification inbox badge — every role gets the bell. Polls each minute
  // while Home is mounted, plus a refetch whenever the screen regains focus.
  const unreadQ = useQuery({
    queryKey: ['notifications-unread-count'],
    queryFn: () => apiService.getUnreadNotificationCount().then((r) => r.data),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  const refetchUnread = unreadQ.refetch;
  useFocusEffect(
    React.useCallback(() => {
      refetchUnread();
    }, [refetchUnread]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      isTrainee
        ? progressQ.refetch()
        : Promise.all([statsQ.refetch(), hiresQ.refetch(), leaderTodayQ.refetch()]),
      scheduleQ.refetch(),
    ]);
    setRefreshing(false);
  };
  // Web pull-to-refresh (native RefreshControl is a no-op on react-native-web).
  const { pullIndicator } = usePullToRefresh(onRefresh);

  // ── Derived: greeting ───────────────────────────────────────────────────
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = (user?.name || '').split(/\s+/)[0];
  const dateLine = now.toLocaleDateString(APP_LOCALE, { weekday: 'long', month: 'long', day: 'numeric' });

  // ── Derived: today's schedule ───────────────────────────────────────────
  // Blocks use day_of_week 0=Mon…5=Sat; Sunday has no office schedule.
  const todayIdx = (now.getDay() + 6) % 7;
  const nowHHMM = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  // Marked absent (`ab`) on today's bells → today's schedule is blank for them.
  const absentToday = (scheduleQ.data?.absent_days || []).includes(todayIdx);
  const todayBlocks = useMemo(() => {
    const blocks: any[] = scheduleQ.data?.blocks || [];
    if (todayIdx > 5 || absentToday) return [];
    return blocks.filter((b) => b.day_of_week === todayIdx);
  }, [scheduleQ.data, todayIdx, absentToday]);
  const upcomingBlocks = todayBlocks.filter((b) => (b.end_time || '00:00') > nowHHMM).slice(0, 4);

  // ── Derived: trainee journey ────────────────────────────────────────────
  const assessments: any[] = progressQ.data?.assessments || [];
  const orientDone = assessments.filter((a) => ORIENT_DAYS.includes(a.day_number) && a.completed).length;
  const fieldDone = assessments.filter((a) => FIELD_DAYS.includes(a.day_number) && a.completed).length;
  const nextPending = assessments
    .filter((a) => !a.completed)
    .sort((a, b) => a.day_number - b.day_number)[0];
  const journeyCurrent: 'orient' | 'field' = orientDone < ORIENT_DAYS.length ? 'orient' : 'field';
  const journeyPct = assessments.length ? (orientDone + fieldDone) / JOURNEY_TOTAL : 0;

  // ── Derived: hero game layer (sales-level coin + XP bar + StatusRail) ────
  // Reads the Sales Path query that already feeds the Sales Path card — no
  // extra request. A trainee's bar is their Day 1–8 journey; everyone else's
  // is their live ramp week, else their 20-day form, else their ladder rung.
  const heroPath = salesPathQ.data?.enabled ? (salesPathQ.data.path ?? null) : null;
  const heroLevel = heroPath?.level ?? null;
  const heroTint = levelTintFor(heroLevel);
  const heroPct = (() => {
    if (isTrainee) return journeyPct;
    const ramp = heroPath?.ramp;
    const live = ramp?.phase === 'weeks' ? (ramp.weekly || []).find((w) => !w.completed && !w.paused) : null;
    if (live) return Math.min(1, live.sales / Math.max(1, live.target));
    const scoring = heroPath?.form?.scoring_pct_20d;
    if (scoring != null) return Math.min(1, scoring / 100);
    return heroLevel != null ? heroLevel / 6 : 0;
  })();
  // No ladder (admins, and leaders in an office where the path is dark): the
  // spec's role coin — purple, carrying the COD stage — with the stage name and
  // a bar of how much of the 5-stage COD is open. Without this the ink block
  // renders 215 px of empty hero beside the cube.
  const noLadder = !heroPath && !isTrainee;
  // The COD stage everyone sees on the hero — computed for EVERY viewer, not
  // only those without a sales ladder: a rep has BOTH a COD title and a sales
  // level, and the hero shows both (owner, 2026-09-14).
  //
  // `furthestCodStage`, never Math.max: SL is stored as 5 but sits between 3
  // and 4, so the old `reduce` reported "Sector/Site Leader" for anyone who
  // had already passed it and unlocked Team Builder.
  const codStage = (() => {
    const ss: any = stageStatusQ.data;
    if (!ss) return null;
    return furthestCodStage([2, 3, 4, 5].filter((n) => ss[`stage_${n}_unlocked`]), 1);
  })();
  const codPct = (() => {
    const ss: any = stageStatusQ.data;
    if (!ss) return 0;
    return ([2, 3, 4, 5].filter((n) => ss[`stage_${n}_unlocked`]).length + 1) / 5;
  })();
  // What the coin, the rank line and both bars (hero + StatusRail) run on.
  const gameLevel = noLadder ? codStage : heroLevel;  // coin still shows the ladder that owns this viewer
  const gameTint: HexCoinTint = noLadder ? 'purple' : heroTint;
  const gamePct = noLadder ? codPct : heroPct;
  // The big line: an explicit title (Owner, Team Leader) outranks the COD
  // stage, so an Owner reads "OWNER" rather than "TEAM BUILDER". Everyone
  // without an override keeps their COD stage name.
  const rankLine = heroRankTitle(user, codStage != null ? codStageShortName(codStage) : null);
  // Coaches and admins get a clean greeting: the coin and rank line are a
  // BA's own journey marker.
  const showGameRow = isTrainee;
  const openInbox = () => router.push('/notifications' as never);

  // ── Derived: leader/admin team pulse ────────────────────────────────────
  const stats = statsQ.data;
  const statusBreakdown: Record<string, number> = stats?.status_breakdown || {};
  const needsAttention = useMemo(() => {
    const hires: NewHire[] = hiresQ.data || [];
    return hires
      .filter((h) => h.active && ['Red', 'Yellow'].includes(h.current_status))
      .slice(0, 3);
  }, [hiresQ.data]);
  const unassignedCount = useMemo(() => {
    const hires: NewHire[] = hiresQ.data || [];
    return hires.filter((h) => h.leader === 'Unassigned' && h.active).length;
  }, [hiresQ.data]);

  // ── Quick actions per role ──────────────────────────────────────────────
  const quickActions: QuickAction[] = isTrainee
    ? [
        { label: 'Manual', sub: 'The playbook', icon: 'book-outline', route: '/(tabs)/manual', tint: 'primary' },
        { label: 'Earnings', sub: 'What a week is worth', icon: 'calculator-outline', route: '/(tabs)/pay', tint: 'green' },
        { label: 'My progress', sub: 'Scores & journey', icon: 'stats-chart-outline', route: '/(tabs)/progress', tint: 'accent' },
        { label: 'Campaign training', sub: 'Playbook + quiz', icon: 'school-outline', route: '/product-knowledge', tint: 'yellow' },
      ]
    : isLeader
    ? [
        { label: 'Add new starter', testKey: 'Add trainee', sub: 'Start their Day 1–8', icon: 'person-add-outline', route: '/add-hire', tint: 'primary' },
        { label: 'Goal planner', sub: 'Monthly targets', icon: 'bar-chart-outline', route: '/monthly-planner', tint: 'green' },
        { label: 'COD', sub: 'Coaching & development', icon: 'school-outline', route: '/coaching', tint: 'accent' },
        { label: 'Bells', sub: 'Weekly sign-ups board', icon: 'notifications-outline', route: '/(tabs)/hires?view=bells', tint: 'yellow' },
      ]
    : [
        { label: 'Bells', sub: 'Weekly sign-ups board', icon: 'notifications-outline', route: '/(tabs)/hires?view=bells', tint: 'primary' },
        { label: 'Bulletins', sub: 'Share last week', icon: 'megaphone-outline', route: '/weekly-share', tint: 'green' },
        { label: 'Add new starter', testKey: 'Add trainee', sub: 'Start their Day 1–8', icon: 'person-add-outline', route: '/add-hire', tint: 'accent' },
      ];

  const tintColor = (t?: QuickAction['tint']) =>
    t === 'green' ? colors.green : t === 'accent' ? colors.accent : t === 'yellow' ? '#f59e0b' : colors.primary;
  const tintBg = (t?: QuickAction['tint']) =>
    t === 'green' ? colors.greenBg : t === 'accent' ? colors.accent + '22' : t === 'yellow' ? '#f59e0b22' : colors.primary + '18';

  // The page in pieces, so a wide screen can set them in two columns and a
  // phone can run them one under the other.
  // A BA's own start, journey and sales path; a Coach's or Admin's new starts.
  const blockTop = (
    <>
      {/* ── Trainee: Start Here banner ── */}
      {isTrainee && (
        <GlowButton breathe onPress={() => router.push('/onboarding')} style={styles.startHereCard} testID="home-start-here">
          <View style={{ flex: 1 }}>
            <Text style={styles.startHereTitle}>Start Here</Text>
            <Text style={styles.startHereSub}>
              Your first weeks, how pay works, who to contact — all in one place.
            </Text>
          </View>
          <View style={styles.startHereArrow}>
            <Ionicons name="arrow-forward" size={18} color="#fff" />
          </View>
        </GlowButton>
      )}

      {/* ── Trainee: journey card ── */}
      {isTrainee && progressQ.isLoading && (
        <DepthCard style={styles.card}>
          <Skeleton width={110} height={16} />
          <View style={{ height: 12 }} />
          <Skeleton height={12} />
          <View style={{ height: 8 }} />
          <Skeleton width={'60%' as const} height={12} />
        </DepthCard>
      )}
      {isTrainee && progressQ.data && (
        <PressableScale onPress={() => router.push('/assessments' as any)} testID="home-journey">
        <DepthCard style={styles.card} sheen>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>My journey</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </View>
          {nextPending ? (
            <>
              <Text style={styles.cardLead}>
                Up next: <Text style={{ fontWeight: '800', color: colors.text }}>
                  {nextPending.day_number <= 2
                    ? `BA Academy Day ${nextPending.day_number}`
                    : `Field day ${nextPending.day_number - 2}`}
                </Text>
              </Text>
              {(() => {
                const obj = (targetsQ.data || []).find((t: any) => t.day_number === nextPending.day_number)?.day_objective;
                return obj ? (
                  <Text style={styles.cardObjective} numberOfLines={2}>{obj}</Text>
                ) : null;
              })()}
            </>
          ) : (
            <Text style={styles.cardLead}>Stage 1 complete — keep pushing into Stage 2! 🎉</Text>
          )}
          <View style={styles.journeyBars}>
            {/* Both phases run the SAME XP gradient. Orientation used to be
                painted amber — this app's warning hue (Yellow status chips,
                needs-attention dots) — so a COMPLETED phase was coloured like
                a problem while the half-finished one got the reward gradient
                (round-2 review). Completion is signalled the way the rest of
                the system signals it: a full bar plus a tick. */}
            <View style={{ flex: 1 }}>
              <View style={styles.journeyBarLabelRow}>
                <Text style={styles.journeyBarLabel}>BA Academy</Text>
                {orientDone >= ORIENT_DAYS.length && (
                  <Ionicons name="checkmark-circle" size={13} color={colors.green} />
                )}
                <Text style={styles.journeyBarPct}>{orientDone}/{ORIENT_DAYS.length}</Text>
              </View>
              {/* tip off on both journey bars: the hero bar owns the screen's
                  one pulsing tip, and the trainee Home is the role that would
                  otherwise sit at 7 continuous loops (budget 6, spec §5). */}
              <XPBar
                value={orientDone / ORIENT_DAYS.length}
                height={9}
                tip={false}
                glow={journeyCurrent === 'orient'}
              />
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.journeyBarLabelRow}>
                <Text style={styles.journeyBarLabel}>Field</Text>
                {fieldDone >= FIELD_DAYS.length && (
                  <Ionicons name="checkmark-circle" size={13} color={colors.green} />
                )}
                <Text style={styles.journeyBarPct}>{fieldDone}/{FIELD_DAYS.length}</Text>
              </View>
              <XPBar
                value={fieldDone / FIELD_DAYS.length}
                height={9}
                tip={false}
                glow={journeyCurrent === 'field'}
              />
            </View>
          </View>
        </DepthCard>
        </PressableScale>
      )}

      {/* ── Sales Path — the second ladder, front and center for every role.
          Ramping hires see their runway; everyone else sees their level and
          what earns the next one. "How the path works" → /sales-path-intro. ── */}
      {salesPathQ.data?.enabled && salesPathQ.data?.path && (() => {
        const sp = salesPathQ.data.path!;
        const spContent = salesPathQ.data.content;
        const ramp = sp.ramp;
        const emoji: Record<number, string> = { 1: '🌱', 2: '🥉', 3: '🥈', 4: '🥇', 5: '🏅', 6: '🐐' };
        const liveWeek = ramp?.phase === 'weeks'
          ? (ramp.weekly || []).find((w) => !w.completed && !w.paused)
          : null;
        const nextName = sp.level < 6
          ? (salesPathQ.data.meta?.level_names?.[sp.level + 1] || `Level ${sp.level + 1}`)
          : null;
        return (
          <PressableScale
            onPress={() => router.push('/(tabs)/progress' as any)}
            testID="home-sales-path"
          >
          <DepthCard style={styles.card} sheen>
            <LinearGradient
              colors={GRADIENT}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={styles.cardAccent}
            />
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardTitle}>Sales Path</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: colors.primary }}>
                  {emoji[sp.level]} {sp.level_name}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </View>
            </View>
            {ramp && ramp.status === 'not_started' ? (
              <Text style={styles.cardLead}>
                Your runway to a <Text style={{ fontWeight: '800', color: colors.text }}>Green Week</Text> starts the
                week you do — sign-ups count from day one.
                {(ramp.targets || []).length > 0 ? ` ${ramp.targets.join(', then ')}.` : ''}
              </Text>
            ) : ramp && ramp.status === 'complete' ? (
              <Text style={styles.cardLead}>
                Ramp complete — Green Week hit. 🟢 Now the ladder: next stop{' '}
                <Text style={{ fontWeight: '800', color: colors.text }}>{nextName}</Text>.
              </Text>
            ) : ramp && liveWeek ? (
              <>
                {/* The one figure that decides a rep's week. It was 17px bold
                    body copy buried mid-paragraph while the two loudest things
                    on their Home were their own first name and a level coin
                    (round-2 review). Same words, same order, same sentence —
                    the figure is just lifted onto its own line at 26px in the
                    title gradient. */}
                <Text style={styles.rampLead}>Ramp week {liveWeek.week} —</Text>
                <GradientText
                  colors={colors.titleGradient}
                  style={[styles.rampFigure, styles.rampFigureBox]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                >
                  {`${liveWeek.sales} of ${liveWeek.target} sign-ups`}
                </GradientText>
                <Text style={styles.cardLead}>
                  this week
                  {ramp.status === 'behind' ? ' · last week was short — your coach is on it with you' : ''}
                </Text>
                <XPBar
                  value={Math.min(1, liveWeek.sales / Math.max(1, liveWeek.target))}
                  height={10}
                  tip={false}
                  style={{ marginTop: 8 }}
                />
              </>
            ) : (
              <Text style={styles.cardLead}>
                {(sp.form?.days_in_window ?? 0) >= 20 && sp.form?.scoring_pct_20d != null
                  ? <>2+ sign-ups on <Text style={{ fontWeight: '800', color: colors.text }}>{Math.round((sp.form.scoring_pct_20d / 100) * 20)} of your last 20 days</Text>
                      {sp.form.piece_avg_20d != null ? <> · <Text style={{ fontWeight: '800', color: colors.text }}>{sp.form.piece_avg_20d}</Text> a day</> : null}
                      {nextName ? <> · next up: {nextName}</> : null}</>
                  : nextName
                    ? <>{spContent?.arc_line || 'Getting good takes weeks. Getting great takes months — and pays a lot more.'} Next up: <Text style={{ fontWeight: '800', color: colors.text }}>{nextName}</Text>.</>
                    : 'Top of the ladder. Keep setting the standard.'}
              </Text>
            )}
            <TouchableOpacity
              onPress={() => router.push('/sales-path-intro' as any)}
              hitSlop={{ top: 6, bottom: 6 }}
              style={{ marginTop: 8 }}
            >
              <Text style={{ fontSize: 12.5, fontWeight: '700', color: colors.primary }}>
                New here? How the path works →
              </Text>
            </TouchableOpacity>
          </DepthCard>
          </PressableScale>
        );
      })()}

      {/* ── Coach/Admin: every new starter, where they are in Days 1-8 and how
          much of COD 1 and COD 2 is marked off. Tap a person for their COD;
          "Grade" jumps straight to the day that's waiting. ── */}
      {!isTrainee && (() => {
        const starts = leaderTodayQ.data?.new_starts || [];
        const counts = leaderTodayQ.data?.counts;
        const waiting = new Map((leaderTodayQ.data?.grading || []).map((g) => [g.hire_id, g]));
        const LIMIT = 6;
        const shown = startsOpen ? starts : starts.slice(0, LIMIT);
        const dayLabel = (d: number) => (d <= 2 ? `BA Academy Day ${d}` : `Field day ${d - 2}`);
        return (
          <View style={styles.cardStack}>
          <DepthCard style={styles.cardInStack} sheen>
            <View style={styles.cardHeaderRow}>
              <View style={styles.hudTitle}>
                <View style={styles.hudTick} />
                <Text style={styles.cardTitle}>{APP_SHORT_NAME} New Starts</Text>
                {starts.length > 0 && <Text style={styles.hudCount}>{starts.length}</Text>}
              </View>
              {!!counts?.awaiting && (
                <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.awaitingChip}>
                  <Text style={styles.awaitingChipText}>{counts.awaiting} to grade</Text>
                </LinearGradient>
              )}
            </View>
            {leaderTodayQ.isLoading ? (
              <View>
                <Skeleton height={14} />
                <View style={{ height: 10 }} />
                <Skeleton width={'70%' as const} height={14} />
              </View>
            ) : starts.length === 0 ? (
              <View style={styles.caughtUpRow}>
                <Ionicons name="person-add-outline" size={20} color={colors.textMuted} />
                <Text style={styles.caughtUpText}>No new starters right now. Add one from Quick actions below.</Text>
              </View>
            ) : (
              <>
                {shown.map((n, i) => {
                  const g = waiting.get(n.hire_id);
                  return (
                    <TouchableOpacity
                      key={n.hire_id}
                      style={[styles.gradeRow, i > 0 && { borderTopWidth: 1, borderTopColor: colors.border }]}
                      // Not theirs to coach: their development page (COD and Days 1-8), nothing to grade.
                      disabled={n.mine === false && !n.trainee_user_id}
                      onPress={() => router.push((n.mine === false
                        ? `/person/${n.trainee_user_id}`
                        : n.trainee_user_id ? `/leader/trainee/${n.trainee_user_id}` : `/new-hire/${n.hire_id}`) as never)}
                      testID={`home-start-${n.hire_id}`}
                    >
                      <View style={[styles.gradeAvatar, { backgroundColor: avatarColor(n.name).bg }]}>
                        <Text style={[styles.gradeAvatarText, { color: avatarColor(n.name).fg }]}>
                          {n.name.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.attentionName} numberOfLines={1}>{n.name}</Text>
                        <Text style={styles.gradeSub} numberOfLines={1}>
                          {dayLabel(n.current_day)} · {n.days_done}/8 days graded{n.mine === false && n.coach ? ` · Coach: ${n.coach}` : ''}
                        </Text>
                        <View style={styles.codRow}>
                          <CodMeter label="COD 1" done={n.cod1.done} total={n.cod1.total} styles={styles} />
                          <CodMeter label="COD 2" done={n.cod2.done} total={n.cod2.total} styles={styles} />
                        </View>
                      </View>
                      {g && g.days_pending > 1 && (
                        <View style={styles.behindChip}>
                          <Text style={styles.behindChipText}>{g.days_pending} days behind</Text>
                        </View>
                      )}
                      {isAdmin && g && g.days_pending >= 2 && !!g.leader_user_id && (
                        <TouchableOpacity
                          style={[
                            styles.remindBtn,
                            remindMut.isPending && remindMut.variables === g.leader_user_id && { opacity: 0.5 },
                          ]}
                          onPress={() => remindMut.mutate(g.leader_user_id!)}
                          disabled={remindMut.isPending}
                          hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                          testID={`home-remind-${n.hire_id}`}
                        >
                          <Ionicons name="notifications-outline" size={11} color={colors.primary} />
                          <Text style={styles.remindBtnText}>Remind</Text>
                        </TouchableOpacity>
                      )}
                      {!!n.next_assessment_id && (
                        <TouchableOpacity
                          style={styles.gradeBtn}
                          onPress={() => router.push(`/assessment/${n.next_assessment_id}`)}
                          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                          accessibilityLabel={`Grade ${n.name}, ${dayLabel(n.next_day || 1)}`}
                          testID={`home-grade-${n.hire_id}`}
                        >
                          <Text style={styles.gradeBtnText}>Grade</Text>
                        </TouchableOpacity>
                      )}
                      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                    </TouchableOpacity>
                  );
                })}
                {starts.length > LIMIT && (
                  <TouchableOpacity onPress={() => setStartsOpen((v) => !v)} testID="home-starts-toggle">
                    <Text style={[styles.cardLink, { textAlign: 'center', paddingTop: 10 }]}>
                      {startsOpen ? 'Show fewer' : `Show all ${starts.length}`}
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </DepthCard>
          </View>
        );
      })()}
    </>
  );

  // The field today: sectors, the Field IQ week, law of averages, Primetime.
  const blockField = (
    <>
      {/* ── Live Operations — today's field teams (sectors) live from OwnerIQ,
          scoped to the caller server-side. Tap a team → live KPIs + per-BA door
          log. Self-hides when no teams are out. */}
      <LiveOpsCard />
      <FieldIqWeekCard />

      {/* ── Field KPIs LOA — admin office averages (Yesterday's LOA, expandable
          to per-BA with hide-from-average) + leader personal averages with a
          Today/Yesterday switcher. Self-gates by role (nothing for trainees). */}
      {(isAdmin || isLeader) && <FieldAveragesCard />}

      {/* ── Office Primetime — the WHOLE office's coaching plan for the next
          plannable day: who's teaching what, and who on my team still has
          nothing set. Tap through to the week grid to add my people to another
          team's session. Self-gates by role (leaders + admins only). */}
      <PrimetimeCard />
    </>
  );

  // Planning and the team: planner, bulletins, breakdown, plans, checklist, pulse.
  const blockRest = (
    <>
      {/* ── Leader/Trainee: Weekly/Daily Planner hero — contextual CTA for today ──
          Leaders get the full week (Sunday wraps up + plans ahead); trainees
          only have the day pages, so there's nothing to show on a Sunday. */}
      {(isLeader || isTrainee) && (() => {
        const todayIdx = (new Date().getDay() + 6) % 7; // Mon=0..Sun=6
        const isSunday = todayIdx === 6;
        if (isTrainee && isSunday) return null;
        const p = weeklyPlannerQ.data?.planner;
        const day = (p?.days || {})[String(todayIdx)] || {};
        const plannedKeys = isTrainee ? ['primetime', 'sector', 'networking'] : ['primetime', 'sector', 'networking', 'crew_plan'];
        const planned = plannedKeys.some((k) => ((day as any)[k] || '').trim());
        const dayName = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][todayIdx] || '';
        return (
          <GlowButton
            style={styles.plannerHero}
            onPress={() => router.push((isSunday && !isTrainee) ? '/weekly-planner' : (`/weekly-planner?day=${todayIdx}` as any))}
            testID="home-weekly-planner-hero"
          >
            <View style={styles.plannerHeroIcon}>
              <Ionicons name={planned && !isSunday ? 'checkmark-done' : 'calendar-number'} size={22} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.plannerHeroTitle}>
                {(isSunday && !isTrainee) ? 'Wrap the week + plan the next' : planned ? `${dayName}'s plan is set` : `Plan ${dayName} now`}
              </Text>
              <Text style={styles.plannerHeroSub}>
                {(isSunday && !isTrainee)
                  ? 'Fill your weekly report and share it with the group'
                  : planned
                    ? "See today's plan or take today's meeting notes"
                    : isTrainee
                      ? 'Declare your intention — Primetime · Sector · Networking'
                      : 'Declare your intention — Primetime · Sector · Networking · Crew'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.85)" />
          </GlowButton>
        );
      })()}

      {/* ── Leader: ready-to-go countrywide weekly bulletins ── */}
      {isLeader && (
        <GlowButton
          tone="green"
          sheen={false}
          style={styles.plannerHero}
          onPress={() => router.push('/weekly-share')}
          testID="home-countrywide-bulletins"
        >
          <View style={styles.plannerHeroIcon}>
            <Ionicons name="trophy" size={22} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.plannerHeroTitle}>Countrywide bulletins</Text>
            <Text style={styles.plannerHeroSub}>
              Last week’s sign-ups and top 5 Teams — ready to view or share
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.85)" />
        </GlowButton>
      )}

      {/* ── Leader: Breakdown — last week's sales + quality KPIs ── */}
      {isLeader && (leaderPulseQ.data?.quality?.source || leaderPulseQ.data?.personal_quality?.source) && (() => {
        const st: any = leaderPulseQ.data;
        const revDate = (() => {
          const [y, m, dd] = String(st.review_week_ending || '').split('-').map(Number);
          return y ? new Date(y, m - 1, dd).toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' }) : '';
        })();
        // Sales lives in the same chip row as the quality percentages.
        // Each tile carries its number separately from its tail so it can be
        // rendered as a StatBlock (34/26px Unbounded numeral + gradient accent
        // bar) instead of 13px mono text; `v` stays the exact same string for
        // the '—' tiles, which have no number to count up.
        const chips = (q: any, sales?: { total?: number | null; goal?: number | null }) => {
          const out: { l: string; v: string; n?: number; suffix?: string }[] = [];
          if (sales && sales.total != null) {
            const tail = sales.goal != null ? ` / ${sales.goal}` : '';
            out.push({ l: '💵 Sign-ups', v: `${sales.total}${tail}`, n: sales.total, suffix: tail });
          }
          if (q?.source) {
            out.push({ l: '£15+', v: q.gold_pct != null ? `${q.gold_pct}%` : '—', ...(q.gold_pct != null ? { n: q.gold_pct, suffix: '%' } : {}) });
            if (q.fails_pct != null) out.push({ l: 'Fails', v: `${q.fails_pct}%`, n: q.fails_pct, suffix: '%' });
            if (q.second_delivery?.pct != null) out.push({ l: '2nd deliv', v: `${q.second_delivery.pct}%`, n: q.second_delivery.pct, suffix: '%' });
            if (q.fourth_delivery?.pct != null) out.push({ l: '4th deliv', v: `${q.fourth_delivery.pct}%`, n: q.fourth_delivery.pct, suffix: '%' });
          }
          return out;
        };
        const team = chips(st.quality, { total: st.team?.total, goal: st.team?.goal });
        const personal = chips(st.personal_quality, { total: st.personal?.total, goal: st.personal?.goal });
        // A leader with nobody under them has identical team/personal numbers
        // — show the KPIs once, without the section split.
        const solo = ((st.crew || []).length <= 1);
        const rows = solo
          ? [{ label: null as string | null, chips: personal.length > 1 ? personal : team }]
          : [{ label: 'TEAM', chips: team }, { label: 'PERSONAL', chips: personal }];
        return (
          <TouchableOpacity onPress={() => router.push('/weekly-planner')} activeOpacity={0.8}>
          <DepthCard style={styles.card}>
            <Text style={[styles.cardTitle, { marginBottom: 2 }]}>Breakdown</Text>
            <Text style={styles.kpulseWhen}>Last week · Mon–Sat ending {revDate}</Text>
            {rows.map((row, ri) => row.chips.length > 0 && (
              <View key={ri}>
                {row.label && <Text style={[styles.kpulseLabel, ri > 0 && { marginTop: 8 }]}>{row.label}</Text>}
                <View style={styles.kpulseRow}>
                  {row.chips.map((c, i) => (
                    <View key={i} style={styles.kpulseChip}>
                      {c.n != null ? (
                        <StatBlock
                          value={c.n}
                          suffix={c.suffix || ''}
                          label={c.l}
                          size={26}
                        />
                      ) : (
                        <>
                          <Text style={styles.kpulseChipValue}>{c.v}</Text>
                          <Text style={styles.kpulseChipLabel}>{c.l}</Text>
                        </>
                      )}
                    </View>
                  ))}
                </View>
              </View>
            ))}
            {st.quality?.source === 'bells' && (
              <Text style={styles.kpulseNote}>From Bells</Text>
            )}
          </DepthCard>
          </TouchableOpacity>
        );
      })()}

      {/* ── Admin: weekly-plan completion — who's submitted, tap to read ── */}
      {isAdmin && (planRosterQ.data?.items || []).length > 0 && (() => {
        const roster: any[] = planRosterQ.data?.items || [];
        const doneN = roster.filter((u) => u.has_planner).length;
        const we = (() => {
          const [y, m, dd] = String(planRosterQ.data?.week_ending || '').split('-').map(Number);
          return y ? new Date(y, m - 1, dd).toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' }) : '';
        })();
        return (
          <DepthCard style={styles.card}>
            <TouchableOpacity
              style={styles.cardHeaderRow}
              onPress={() => setWeeklyPlansOpen((v) => !v)}
              activeOpacity={0.7}
              testID="home-plan-roster-toggle"
            >
              <Text style={styles.cardTitle}>Weekly plans · WE {we}</Text>
              <View style={styles.collapseHeaderRight}>
                {/* The fraction is also a bar — the design language everywhere
                    else on Home renders progress, not plain text. */}
                <XPBar
                  value={roster.length ? doneN / roster.length : 0}
                  height={7}
                  ticks={false}
                  tip={false}
                  glow={false}
                  style={styles.headerBar}
                />
                <Text style={styles.planRosterCount}>{doneN}/{roster.length}</Text>
                <Ionicons name={weeklyPlansOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
              </View>
            </TouchableOpacity>
            {weeklyPlansOpen && roster.map((u) => (
              <TouchableOpacity
                key={u.id}
                style={styles.planRosterRow}
                onPress={() => router.push(`/weekly-planner?user_id=${u.id}` as any)}
                testID={`home-plan-roster-${u.id}`}
              >
                <Ionicons
                  name={u.has_planner ? 'checkmark-circle' : u.steps_done > 0 ? 'ellipse-outline' : 'time-outline'}
                  size={18}
                  color={u.has_planner ? colors.green : '#f59e0b'}
                />
                <Text style={styles.planRosterName} numberOfLines={1}>{u.name}</Text>
                <Text style={styles.planRosterMeta}>
                  {u.has_planner
                    ? (u.updated_at ? new Date(u.updated_at).toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' }) : 'Filled in')
                    : u.steps_done > 0
                    ? `${u.steps_done}/${u.steps_total || 5} parts`
                    : 'Not started'}
                </Text>
                <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
              </TouchableOpacity>
            ))}
          </DepthCard>
        );
      })()}

      {/* ── Admin: today's daily-plan completions — only who's done one ── */}
      {isAdmin && dailyRosterQ.data?.is_plannable_day && (dailyRosterQ.data?.items || []).length > 0 && (() => {
        const items: any[] = dailyRosterQ.data?.items || [];
        const dayName = (() => {
          const [y, m, dd] = String(dailyRosterQ.data?.date || '').split('-').map(Number);
          return y ? new Date(y, m - 1, dd).toLocaleDateString(APP_LOCALE, { weekday: 'long' }) : 'Today';
        })();
        const dayIdx = dailyRosterQ.data?.day_index;
        return (
          <DepthCard style={styles.card}>
            <TouchableOpacity
              style={styles.cardHeaderRow}
              onPress={() => setDailyPlansOpen((v) => !v)}
              activeOpacity={0.7}
              testID="home-daily-roster-toggle"
            >
              <Text style={styles.cardTitle}>Daily plans · {dayName}</Text>
              <View style={styles.collapseHeaderRight}>
                <Text style={styles.planRosterCount}>{items.length}</Text>
                <Ionicons name={dailyPlansOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
              </View>
            </TouchableOpacity>
            {dailyPlansOpen && items.map((u) => (
              <TouchableOpacity
                key={u.id}
                style={styles.planRosterRow}
                onPress={() => router.push(`/weekly-planner?user_id=${u.id}${dayIdx != null ? `&day=${dayIdx}` : ''}` as any)}
                testID={`home-daily-roster-${u.id}`}
              >
                <Ionicons name="checkmark-circle" size={18} color={colors.green} />
                <Text style={styles.planRosterName} numberOfLines={1}>{u.name}</Text>
                <Text style={styles.planRosterMeta}>
                  {roleTitle(u)}
                </Text>
                <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
              </TouchableOpacity>
            ))}
          </DepthCard>
        );
      })()}

      {/* ── Leader/Admin: this week checklist ── */}
      {!isTrainee && leaderTodayQ.data && (() => {
        const planner = leaderTodayQ.data.planner;
        const monthName = new Date(`${planner.month}-02T00:00:00`).toLocaleDateString(APP_LOCALE, { month: 'long' });
        // Admins don't need the Monthly Goal Planner row here (that's a
        // leader's job), so for admins there's nothing to show.
        if (isAdmin) return null;
        return (
          <DepthCard style={styles.card}>
            <Text style={[styles.cardTitle, { marginBottom: 10 }]}>This week</Text>
            {!isAdmin && (
            <TouchableOpacity style={styles.checkRow} onPress={() => router.push('/monthly-planner')} testID="home-check-mgp">
              {/* 44px lit well — the same icon treatment the Quick actions
                  grid uses, so this row stops being a bare glyph on white. */}
              <LinearGradient
                colors={planner.exists ? WELL_GREEN : WELL_AMBER}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[styles.checkWell, styles.checkWellLit]}
              >
                <Ionicons
                  name={planner.exists ? 'checkmark-circle' : 'alert-circle'}
                  size={22}
                  color="#fff"
                />
              </LinearGradient>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkTitle}>
                  {planner.exists ? 'Monthly Goal Planner — on track' : `Start your ${monthName} Goal Planner`}
                </Text>
                <Text style={styles.checkSub}>
                  {planner.exists ? 'Keep it updated as the month moves' : 'Set targets before the month runs away'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
            )}
          </DepthCard>
        );
      })()}

      {/* ── Leader/Admin: team pulse ── */}
      {!isTrainee && (
        <PressableScale onPress={() => router.push('/(tabs)/hires')} testID="home-team-pulse">
        <DepthCard style={styles.card} sheen>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>{isAdmin ? 'Office pulse' : 'Team pulse'}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </View>
          <View style={styles.pulseRow}>
            <View style={styles.pulseStat}>
              {stats ? (
                <AnimatedNumber value={stats.total_active_hires} style={styles.pulseNumber} />
              ) : (
                <Text style={styles.pulseNumber}>—</Text>
              )}
              <StatAccent />
              <Text style={styles.pulseLabel}>Active new starters</Text>
            </View>
            <View style={styles.pulseStat}>
              {(() => {
                // Week-so-far once the backend provides it; today-only until then.
                const st = leaderTodayQ.data?.sales_today;
                const weekly = st?.week_units !== undefined;
                const value = weekly ? st!.week_units! : st?.units;
                const bells = weekly ? st?.week_bells : st?.bells;
                const goal = weekly ? st?.week_goal : null;
                const isCrewGoal = st?.week_goal_source === 'crew';
                const toGo = goal != null ? goal - (value ?? 0) : null;
                const openCrewGoal = (e: any) => { e?.stopPropagation?.(); setGoalInput(isCrewGoal && goal != null ? String(goal) : ''); setShowGoalModal(true); };
                return (
                  <>
                    <View style={styles.trendRow}>
                      {st ? (
                        <AnimatedNumber value={value ?? 0} style={[styles.pulseNumber, { color: greenText }]} />
                      ) : (
                        <Text style={[styles.pulseNumber, { color: greenText }]}>—</Text>
                      )}
                      {goal != null && (
                        isLeader ? (
                          <TouchableOpacity onPress={openCrewGoal} hitSlop={{ top: 6, bottom: 6, left: 4, right: 6 }}>
                            <Text style={styles.pulseGoal}>/ {goal}</Text>
                          </TouchableOpacity>
                        ) : (
                          <Text style={styles.pulseGoal}>/ {goal}</Text>
                        )
                      )}
                    </View>
                    <StatAccent />
                    <Text style={styles.pulseLabel}>
                      {weekly ? 'Sign-ups this week' : 'Sign-ups today'}
                      {bells ? ` · ${bells} 🔔` : ''}
                    </Text>
                    {toGo != null && (
                      <Text style={[styles.pulseWeek, toGo <= 0 && { color: greenText, fontWeight: '700' }]}>
                        {toGo <= 0 ? `${isCrewGoal ? 'crew goal hit' : 'goal hit'}${toGo < 0 ? ` · +${-toGo} over` : ''} ✅` : `${toGo} to go${isCrewGoal ? ' · crew goal' : ''}`}
                      </Text>
                    )}
                    {isLeader && goal == null && st && (
                      <TouchableOpacity onPress={openCrewGoal} hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}>
                        <Text style={[styles.pulseWeek, { color: colors.primary, fontWeight: '700' }]}>Set crew goal</Text>
                      </TouchableOpacity>
                    )}
                  </>
                );
              })()}
            </View>
            {isAdmin && (() => {
              // This week's live quality rates (units-based, from bells)
              const st = leaderTodayQ.data?.sales_today;
              if (!st || st.week_gold_pct == null) return null;
              return (
                <>
                  <View style={styles.pulseStat}>
                    <AnimatedNumber value={st.week_gold_pct} suffix="%" style={[styles.pulseNumber, { color: colors.primary }]} />
                    <StatAccent />
                    <Text style={styles.pulseLabel}>£15+ this week</Text>
                  </View>
                </>
              );
            })()}
            {/* Team traffic-light breakdown — leaders only (admins keep the
                office pulse focused on actives + sales/quality). */}
            {!isAdmin && (
              <View style={styles.statusChips}>
                {['S-GREEN', 'Green', 'Yellow', 'Red'].map((s) => {
                  const count = statusBreakdown[s] || 0;
                  if (!count) return null;
                  const sc = getStatusColor(s);
                  return (
                    <View key={s} style={[styles.statusChip, { backgroundColor: sc.bg }]}>
                      <Text style={[styles.statusChipText, { color: statusText(sc.text) }]}>{count} {s}</Text>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
          {needsAttention.length > 0 && (
            <View style={styles.attentionBlock}>
              <Text style={styles.attentionTitle}>Needs attention</Text>
              {needsAttention.map((h) => {
                const sc = getStatusColor(h.current_status);
                return (
                  <TouchableOpacity
                    key={h.id}
                    style={styles.attentionRow}
                    onPress={() =>
                      h.trainee_user_id
                        ? router.push(`/leader/trainee/${h.trainee_user_id}`)
                        : router.push(`/new-hire/${h.id}`)
                    }
                  >
                    <View style={[styles.attentionDot, { backgroundColor: sc.text }]} />
                    <Text style={styles.attentionName} numberOfLines={1}>{h.name}</Text>
                    <Text style={styles.attentionMeta}>Day {h.current_day}</Text>
                    <View style={[styles.statusChip, { backgroundColor: sc.bg }]}>
                      <Text style={[styles.statusChipText, { color: statusText(sc.text) }]}>{h.current_status}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          {/* Team-health flags — rendered only when something is wrong */}
          {(() => {
            const th = leaderTodayQ.data?.team_health;
            if (!th || (th.unassigned_aging.length === 0 && th.idle_leaders.length === 0)) return null;
            return (
              <View style={styles.attentionBlock}>
                {th.unassigned_aging.length > 0 && (
                  <View style={styles.healthRow}>
                    <Ionicons name="person-remove-outline" size={15} color="#f59e0b" />
                    <Text style={styles.healthText} numberOfLines={2}>
                      {th.unassigned_aging.length === 1
                        ? `${th.unassigned_aging[0].name} has had no coach for ${th.unassigned_aging[0].days} days`
                        : `${th.unassigned_aging.length} BAs without a coach for 2+ days: ${th.unassigned_aging.map((u) => u.name).join(', ')}`}
                    </Text>
                  </View>
                )}
                {th.idle_leaders.length > 0 && (
                  <View style={styles.healthRow}>
                    <Ionicons name="leaf-outline" size={15} color="#f59e0b" />
                    <Text style={styles.healthText} numberOfLines={2}>
                      {th.idle_leaders.length === 1
                        ? `${th.idle_leaders[0]} has no new starters — time to recruit?`
                        : `${th.idle_leaders.length} coaches with no new starters: ${th.idle_leaders.join(', ')}`}
                    </Text>
                  </View>
                )}
              </View>
            );
          })()}
        </DepthCard>
        </PressableScale>
      )}
    </>
  );

  // Today's timetable.
  const blockToday = (
    <>
      {/* ── Today at the office ── */}
      <DepthCard style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle}>Today at the office</Text>
          <TouchableOpacity onPress={() => router.push('/(tabs)/schedule')} testID="home-full-schedule">
            <Text style={styles.cardLink}>Full schedule</Text>
          </TouchableOpacity>
        </View>
        {todayIdx > 5 ? (
          <Text style={styles.scheduleEmpty}>It's Sunday — no office schedule. Recharge for the week. 🔋</Text>
        ) : upcomingBlocks.length === 0 ? (
          <Text style={styles.scheduleEmpty}>
            {absentToday
              ? "You're marked absent today, so nothing's on your schedule."
              : todayBlocks.length > 0 ? "That's a wrap for today — see you tomorrow." : 'No schedule published for today yet.'}
          </Text>
        ) : (
          upcomingBlocks.map((b, i) => (
            <View key={`${b.id || i}`} style={[styles.scheduleRow, i > 0 && { borderTopWidth: 1, borderTopColor: colors.border }]}>
              <View style={[styles.scheduleDot, { backgroundColor: b.color || colors.primary }]} />
              <Text style={styles.scheduleTime}>{b.start_time}–{b.end_time}</Text>
              <Text style={styles.scheduleTitle} numberOfLines={1}>{b.title}</Text>
            </View>
          ))
        )}
      </DepthCard>
    </>
  );

  return (
    <>
    <View style={{ flex: 1 }}>
    {pullIndicator}
    <ScrollView
      style={[
        styles.container,
        isLandscape && { paddingLeft: insets.left, paddingRight: insets.right, paddingTop: insets.top },
      ]}
      contentContainerStyle={[styles.content, { paddingBottom: 16 + tabBarClearance }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      <View style={styles.shell} onLayout={(e) => setShellW(e.nativeEvent.layout.width)}>
      {/* ── Greeting: a slim header. Who, when, and the way to your profile. ── */}
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <View style={styles.headerText}>
          <Text style={styles.greeting}>{greeting} · {dateLine}</Text>
          <Text style={styles.headerName} numberOfLines={1}>{firstName || 'there'}</Text>
        </View>
        <TouchableOpacity onPress={() => router.push('/(tabs)/profile')} testID="home-avatar" accessibilityLabel="Your profile">
          {user?.profile_image ? (
            <Image source={{ uri: user.profile_image }} style={styles.headerAvatar} />
          ) : (
            <View style={[styles.headerAvatar, styles.headerAvatarFallback]}>
              <Text style={styles.headerAvatarText}>{firstName?.charAt(0)?.toUpperCase() || '?'}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
      {/* Where a BA stands: their COD title, their sales level, and how far
          through it they are. A viewer with no ladder gets no bar. */}
      {showGameRow && (rankLine || heroPath) ? (
        <View style={styles.levelStrip}>
          {gameLevel != null && (
            <View style={styles.levelBadge}><Text style={styles.levelBadgeText}>{String(gameLevel)}</Text></View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={styles.levelMeta}>
              <Text style={styles.levelName} numberOfLines={1}>{rankLine || heroPath?.level_name}</Text>
              {rankLine && heroPath ? <Text style={styles.levelSub} numberOfLines={1}>{heroPath.level_name}</Text> : null}
              {isTrainee && <StreakFlame />}
            </View>
            {noLadder ? null : (
              <View style={styles.levelTrack}>
                <View style={[styles.levelFill, { width: `${Math.round(Math.min(1, Math.max(0, gamePct)) * 100)}%` as any }]} />
              </View>
            )}
          </View>
        </View>
      ) : null}

      {wide ? (
        <View style={styles.cols}>
          <View style={styles.colMain}>{blockTop}{blockRest}</View>
          <View style={styles.colSide}>{blockField}{blockToday}</View>
        </View>
      ) : (
        <>{blockTop}{blockField}{blockRest}{blockToday}</>
      )}

      {/* ── Quick actions ── */}
      <View style={styles.kickerRow}>
        <View style={styles.kickerBar} />
        <Text style={styles.kicker}>Quick actions</Text>
      </View>
      <View style={styles.actionsGrid}>
        {quickActions.map((a) => (
          <PressableScale
            key={a.label}
            style={styles.actionTile}
            scaleTo={0.97}
            onPress={() => router.push(a.route as never)}
            testID={`home-action-${a.testKey || a.label}`}
          >
            <View style={[styles.actionIcon, { backgroundColor: tintBg(a.tint) }]}>
              <Ionicons name={a.icon} size={17} color={tintColor(a.tint)} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.actionTitle} numberOfLines={1}>{a.label}</Text>
              <Text style={styles.actionSub} numberOfLines={1}>{a.sub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={15} color={colors.textMuted} />
          </PressableScale>
        ))}
      </View>

      {/* ── Non-trainee: onboarding hub shortcut ── */}
      {!isTrainee && (
        <TouchableOpacity style={styles.footerLink} onPress={() => router.push('/onboarding')} testID="home-onboarding-link">
          <Ionicons name="sparkles-outline" size={15} color={colors.primary} />
          <Text style={styles.footerLinkText}>
            {isAdmin ? 'Preview & edit the new-starter onboarding hub' : 'See the new-starter onboarding hub'}
          </Text>
          <Ionicons name="chevron-forward" size={14} color={colors.primary} />
        </TouchableOpacity>
      )}
      </View>
    </ScrollView>
    </View>

    <Modal visible={showGoalModal} transparent animationType="fade" onRequestClose={() => setShowGoalModal(false)}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.goalBackdrop}>
        <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={() => setShowGoalModal(false)} />
        <View style={styles.goalCard}>
          <Text style={styles.goalTitle}>Set your crew goal</Text>
          <Text style={styles.goalSub}>Total sign-ups your whole crew is aiming for this week. Synced everywhere — the Bells team bar, the live sheet and your Weekly Plan all show this number.</Text>
          <TextInput
            value={goalInput}
            onChangeText={setGoalInput}
            style={styles.goalInput}
            placeholder="e.g. 40"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            autoFocus
            maxLength={4}
            returnKeyType="done"
            onSubmitEditing={saveGoal}
          />
          <View style={styles.goalRowBtns}>
            <TouchableOpacity style={[styles.goalBtn, styles.goalBtnGhost]} onPress={() => setShowGoalModal(false)} disabled={setGoalMut.isPending}>
              <Text style={styles.goalBtnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.goalBtn, styles.goalBtnPrimary, setGoalMut.isPending && { opacity: 0.6 }]} onPress={saveGoal} disabled={setGoalMut.isPending}>
              <Text style={styles.goalBtnPrimaryText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
    </>
  );
}

const createStyles = (colors: any, isDark: boolean) => {
  // Success green reads as a FILL, not as text: #10B981 is 2.5:1 on a white
  // card. Light theme swaps every green *label* to the darker stop (5.0:1);
  // dark keeps colors.green (≈6.5:1 on the raised card).
  const greenText = isDark ? colors.green : GREEN_TEXT_LIGHT;
  return StyleSheet.create({
  container: { flex: 1 },
  // No top padding: the ink hero starts at the status bar (EditorialHero topEdge).
  content: { paddingHorizontal: 16, paddingTop: 0 },
  shell: { width: '100%', maxWidth: 1240, alignSelf: 'center' },
  cols: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  colMain: { flex: 1.45, minWidth: 0 },
  colSide: { flex: 1, minWidth: 0 },

  // Greeting hero — content laid on the ink EditorialHero (inkText / inkMuted only).
  // The real minHeight is computed per-inset at the call site (heroMinHeight):
  // it holds the whole cube so the block is never a slice of one.
  hero: {},
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  headerText: { flex: 1, minWidth: 0, paddingRight: 4 },
  greeting: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.4, textTransform: 'uppercase', color: colors.textMuted, marginBottom: 4 },
  headerName: { fontFamily: fonts.display, fontSize: 28, lineHeight: 34, letterSpacing: -0.6, color: colors.text },
  // The date sits where the dark nebula's bright lobe drifts, and 11.5px inkMuted
  // measured 4.1:1 there (spec §6.5 wants ≥4.5:1 on ink) — so it runs inkText at
  // 0.92, which keeps the muted voice under the name and stays ≥5:1 on the lobe.
  headerDate: { fontFamily: fonts.mono, fontSize: 11.5, color: colors.inkText, opacity: 0.92, marginTop: 6, letterSpacing: 0.6 },
  headerAvatar: { width: 42, height: 42, borderRadius: 21, borderWidth: 1.5, borderColor: colors.primary },
  headerAvatarFallback: { backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  headerAvatarText: { fontFamily: fonts.bodyBold, color: colors.primary, fontSize: 16 },
  // A BA's standing: stage number, title, sales level and a thin bar.
  levelStrip: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, marginBottom: 12 },
  levelBadge: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  levelBadgeText: { fontFamily: fonts.display, fontSize: 16, color: colors.onPrimary },
  levelMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  levelName: { fontFamily: fonts.bodySemibold, fontSize: 14, color: colors.text, flexShrink: 1 },
  levelSub: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted },
  levelTrack: { height: 5, borderRadius: 3, backgroundColor: colors.surfaceAlt, overflow: 'hidden', marginTop: 7 },
  levelFill: { height: 5, borderRadius: 3, backgroundColor: colors.primary },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, marginBottom: 10 },
  kickerBar: { width: 18, height: 3, borderRadius: 1.5, backgroundColor: colors.primary },
  kicker: { fontFamily: fonts.displayWide, fontSize: 12, letterSpacing: 1.8, textTransform: 'uppercase', color: colors.text },
  // Game layer: 72px level/role coin · rank name (+ learning-days chip) · XP bar.
  // The paddingRight that keeps the row clear of the cube is added by
  // HeroGameRow from useHeroCubeInset() — never hard-code it here.
  heroGameRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 18 },
  heroGameCol: { flex: 1, minWidth: 0 },
  heroGameMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 2, minWidth: 0 },
  // COD title — the bigger of the two.
  // Two lines at 18/20, NOT one line at 20: the column is only ~156px wide
  // (72px coin on the left, the 144px cube on the right), and 'ADVANCED'
  // on one line at 20 rendered as 'ADVANC…'. The longest real value,
  // 'SECTOR/SITE LEADER', wraps to two lines and still fits the row.
  heroCodName: { fontFamily: fonts.displayWide, fontSize: 18, lineHeight: 20, letterSpacing: 0.3, textTransform: 'uppercase', color: colors.inkText, flexShrink: 1 },
  // Sales level — the quieter line under it.
  heroLevelName: { fontFamily: fonts.displayWide, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.inkMuted, marginBottom: 10 },

  // Inbox bell — glass chip on the ink hero
  bellBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder,
  },
  bellBadge: {
    position: 'absolute', top: -3, right: -5, minWidth: 17, height: 17, borderRadius: 9,
    paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.red, borderWidth: 1.5, borderColor: colors.ink,
  },
  bellBadgeText: { color: '#fff', fontSize: 9.5, fontWeight: '800' },


  // Start Here banner (trainee) — a breathing GlowButton (gradient face, sheen, glow shadow)
  startHereCard: {
    justifyContent: 'flex-start', gap: 12,
    borderRadius: 18, paddingVertical: 18, paddingHorizontal: 18, marginBottom: 14,
  },
  startHereTitle: { fontFamily: fonts.display, color: '#fff', fontSize: 17, fontWeight: '800' },
  startHereSub: { color: 'rgba(255,255,255,0.9)', fontSize: 12.5, lineHeight: 18, marginTop: 3 },
  startHereArrow: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },

  // Generic card — a paper DepthCard (white face, hairline, layered plum shadow)
  card: { borderRadius: 16, padding: 14, marginBottom: 12 },
  // Deck: the margin lives on the CardStack so the ghosts line up with the face
  cardStack: { marginBottom: 12 },
  cardInStack: { borderRadius: 16, padding: 14 },
  // 3px brand-gradient accent down the left edge of a card (pointerEvents lives
  // in the style, not the deprecated prop rnw warns about on every render)
  cardAccent: { position: 'absolute', left: 0, top: 16, bottom: 16, width: 3, borderRadius: 2, pointerEvents: 'none' },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  cardTitle: { fontFamily: fonts.displayWide, fontSize: 12.5, letterSpacing: 0.9, textTransform: 'uppercase', color: colors.text },
  cardLink: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: colors.primary },
  cardLead: { fontFamily: fonts.body, fontSize: 13.5, lineHeight: 19, color: colors.textSecondary, marginBottom: 12 },
  // Ramp week: lead-in · the week's figure at 26px gradient · the tail.
  rampLead: { fontFamily: fonts.body, fontSize: 13.5, color: colors.textSecondary },
  rampFigure: {
    fontFamily: fonts.displayBlack, // Unbounded: never add fontWeight
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.9,
  },
  rampFigureBox: { marginTop: 2, marginBottom: 2, alignSelf: 'flex-start' },
  cardObjective: {
    fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: -6, marginBottom: 12,
    fontStyle: 'italic',
  },

  // Trainee journey
  journeyBars: { flexDirection: 'row', gap: 14 },
  // label · (tick when the phase is done) · count
  journeyBarLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 5 },
  journeyBarLabel: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textSecondary },
  journeyBarPct: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, marginLeft: 'auto' },

  // Team pulse
  pulseRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  pulseStat: { alignItems: 'flex-start' },
  // Oversized Unbounded numerals — no fontWeight on displayBlack (web faux-bold).
  // NO textShadow here: these render through AnimatedNumber, which is a
  // TextInput on web — the blur is clipped to the input box and shows up as a
  // hard-edged rectangle behind every number. The lift comes from the gradient
  // accent bar under the numeral instead (<StatAccent />).
  pulseNumber: {
    fontFamily: fonts.displayBlack, fontSize: 26, letterSpacing: -0.8, color: colors.primary,
  },
  pulseLabel: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 0.9, textTransform: 'uppercase', color: colors.textMuted, marginTop: 2 },
  pulseWeek: { fontFamily: fonts.mono, fontSize: 9, color: colors.textMuted, marginTop: 2, letterSpacing: 0.3 },
  pulseGoal: { fontFamily: fonts.mono, fontSize: 14, fontWeight: '700', color: colors.textMuted, marginBottom: 3 },
  goalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  goalCard: { width: '100%', maxWidth: 380, backgroundColor: colors.surface, borderRadius: 16, padding: 22, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 12 },
  goalTitle: { fontSize: 18, fontWeight: '800', color: colors.text, marginBottom: 6 },
  goalSub: { fontSize: 13, color: colors.textSecondary, lineHeight: 18, marginBottom: 16 },
  goalInput: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, color: colors.text, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, marginBottom: 18 },
  goalRowBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  goalBtn: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 10, minWidth: 88, alignItems: 'center', justifyContent: 'center' },
  goalBtnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  goalBtnGhostText: { color: colors.text, fontWeight: '700', fontSize: 15 },
  goalBtnPrimary: { backgroundColor: colors.primary },
  goalBtnPrimaryText: { color: colors.onPrimary, fontWeight: '800', fontSize: 15 },
  statusChips: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  statusChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusChipText: { fontFamily: fonts.bodySemibold, fontSize: 11 },

  // Grading queue
  // "N waiting" — brand-gradient pill with a red glow (urgency without a red fill)
  awaitingChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, boxShadow: '0 4px 12px rgba(220,38,38,0.45)' },
  awaitingChipText: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 0.6, textTransform: 'uppercase', color: '#fff' },
  caughtUpRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  caughtUpText: { flex: 1, fontFamily: fonts.body, fontSize: 13.5, color: colors.textSecondary, lineHeight: 19 },
  gradeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 },
  // Card title with a lit lime tick and a mono count, HUD style.
  hudTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  hudTick: { width: 4, height: 14, borderRadius: 2, backgroundColor: brandLime, boxShadow: '0 0 8px rgba(183,223,88,0.8)' },
  hudCount: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
  // COD 1 / COD 2: how much is marked off.
  codRow: { flexDirection: 'row', gap: 10, marginTop: 7 },
  codMeter: { flex: 1, maxWidth: 150 },
  codMeterHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 },
  codMeterLabel: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 0.8, color: colors.textMuted },
  codMeterValue: { fontFamily: fonts.mono, fontSize: 10, color: colors.textSecondary },
  codMeterDone: { color: greenText },
  codTrack: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  codFill: { height: 4, borderRadius: 2, backgroundColor: colors.primary },
  gradeBtn: { paddingHorizontal: 12, minHeight: 32, borderRadius: 999, justifyContent: 'center', backgroundColor: colors.ink },
  gradeBtnText: { fontFamily: fonts.bodyBold, fontSize: 12, color: colors.inkText },
  gradeAvatar: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primary + '22',
    alignItems: 'center', justifyContent: 'center',
  },
  gradeAvatarText: { fontFamily: fonts.bodyBold, fontSize: 14, color: colors.primary },
  gradeSub: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 0.2, color: colors.textMuted, marginTop: 2 },
  behindChip: { backgroundColor: colors.yellowBg, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5 },
  behindChipText: { fontFamily: fonts.bodyBold, fontSize: 10, color: colors.yellow },
  readChip: { backgroundColor: colors.greenBg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  // 'greenText', not colors.green: the tick LABEL is text on greenBg (4.6:1).
  readChipText: { fontSize: 10, fontWeight: '800', color: greenText },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.textMuted, opacity: 0.45 },
  remindBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7,
    borderWidth: 1, borderColor: colors.borderDark, backgroundColor: colors.surfaceAlt,
  },
  remindBtnText: { fontFamily: fonts.bodyBold, fontSize: 10, color: colors.primary },

  // This-week checklist — 44px gradient icon well + the row's copy
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  checkWell: {
    width: 44, height: 44, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  // The lit face — a gradient well throwing the brand drop shadow.
  checkWellLit: { boxShadow: '0 6px 14px -6px rgba(36,76,59,0.55)' },
  // The "nothing on today" face of the same well: a muted brand tint with a
  // primary glyph and no drop (quiet reads as unlit, not as heavy).
  checkWellQuiet: {
    backgroundColor: colors.primary + '18',
    borderWidth: 1,
    borderColor: colors.primary + '2E',
  },

  // Admin weekly-plan completion roster
  planRosterCount: { fontFamily: fonts.mono, fontSize: 13, fontWeight: '800', color: colors.primary },
  collapseHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerBar: { width: 64 },
  planRosterRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 8, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.04)' },
  planRosterName: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13.5, color: colors.text },
  planRosterMeta: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '700', color: colors.textMuted },

  // Leader Breakdown (Team / Personal quality + sales, last week)
  kpulseWhen: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.textMuted, marginBottom: 8 },
  kpulseLabel: { fontFamily: fonts.mono, fontSize: 9.5, color: colors.textMuted, letterSpacing: 1, marginBottom: 5 },
  kpulseRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  // Three per row: the tile is now a StatBlock well (26px Unbounded numeral +
  // gradient accent + mono caption), not a 13px mono pill.
  kpulseChip: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, paddingHorizontal: 8, borderRadius: 14,
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
    flexBasis: '30%', flexGrow: 1, minWidth: 96,
  },
  kpulseChipLabel: { fontSize: 8.5, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.3, textTransform: 'uppercase' },
  kpulseChipValue: { fontFamily: fonts.mono, fontSize: 13, fontWeight: '800', color: colors.text, marginTop: 1 },
  kpulseNote: { fontSize: 10, fontStyle: 'italic', color: colors.textMuted, marginTop: 7 },

  // Weekly Planner hero (leaders) — big branded CTA that reflects today's state
  // Planner / bulletin CTAs — GlowButtons (gradient face, sheen, glow shadow; green tone for bulletins)
  plannerHero: { justifyContent: 'flex-start', gap: 12, borderRadius: 18, paddingVertical: 16, paddingHorizontal: 16, marginBottom: 14 },
  plannerHeroIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  plannerHeroTitle: { fontFamily: fonts.display, fontSize: 16, fontWeight: '800', color: '#fff', letterSpacing: -0.2 },
  plannerHeroSub: { fontFamily: fonts.body, fontSize: 11.5, color: 'rgba(255,255,255,0.85)', marginTop: 2, lineHeight: 16 },
  checkTitle: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: colors.text },
  checkSub: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 1 },

  // Team-health flags & briefing stats
  healthRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  healthText: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, color: colors.textSecondary, lineHeight: 17 },
  trendRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  // Five stages across 358px: let each column share the row and wrap its label
  // instead of running off the card (the Unbounded numerals are wider than the
  // mono ones they replaced).

  attentionBlock: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  attentionTitle: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.textMuted, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8 },
  attentionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  attentionDot: { width: 8, height: 8, borderRadius: 4 },
  attentionName: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 14, color: colors.text },
  attentionMeta: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },

  // Schedule
  scheduleEmpty: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, lineHeight: 19 },
  scheduleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  scheduleDot: { width: 8, height: 8, borderRadius: 4 },
  scheduleTime: { fontFamily: fonts.mono, fontSize: 11.5, color: colors.textSecondary, width: 96 },
  scheduleTitle: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13.5, color: colors.text },

  // Quick actions — SectionHead + a grid of paper DepthCards
  sectionHead: { marginTop: 6, marginBottom: 12 },
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actionTile: { flexGrow: 1, flexBasis: 230, minWidth: 210, maxWidth: 420, flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 56, paddingHorizontal: 12, paddingVertical: 9,
    borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  actionIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  actionTitle: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: colors.text },
  actionSub: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 1 },

  // Footer link
  footerLink: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 14, marginTop: 8,
  },
  footerLinkText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.primary },
  });
};
