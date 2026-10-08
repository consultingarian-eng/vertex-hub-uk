/**
 * My Progress — the trainee's personal journey, on its own tab.
 *
 * The profile card + "My First 8 Days" day-by-day ladder (the Duolingo-style
 * JourneyPath) live here: orientation days → product training → field days →
 * the Stage 2 trophy, each day tappable into its /day/[id] assessment detail.
 *
 * This layout moved here FROM the COD tab so the COD tab can be what it is
 * for leaders — the capability/proof-ladder view per stage — while this tab
 * stays the personal day-by-day record.
 *
 * Trainee-only by design — leaders/admins grade assessments from My Team.
 *
 * Visual system ("Ink & Cube", 2026-09-12): the profile header is the
 * screen's one ink block (hex-framed avatar, gradient name), the journey
 * hero is a paper EditorialHero riding up over it (gradient title, XP-gradient
 * ring + a tipless XP bar), and the long-game card is a DepthCard with a scroll
 * sheen that tilts in as it scrolls into view. Copy, queries, handlers and
 * the JourneyPath node model are unchanged.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, useWindowDimensions } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { useIsLandscape } from '../src/hooks/useIsLandscape';
import { useColors, useTheme, fonts } from '../src/theme/ThemeContext';
import { GRADIENT_TEXT } from '../src/theme/brand';
import { getStatusColor } from '../src/theme/colors';
import { apiService } from '../src/api/client';
import { queryClient } from '../src/api/queryClient';
import { useAuth } from '../src/auth/AuthContext';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { GoalProgressRing } from '../src/components/ui/GoalProgressRing';
import { GlowOrb, DotField } from '../src/components/ui/Decor';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { EditorialHero } from '../src/components/ui/EditorialHero';
import { DepthCard } from '../src/components/ui/DepthCard';
import { GradientText } from '../src/components/ui/GradientText';
import { HexFrame } from '../src/components/ui/HexFrame';
import { XPBar } from '../src/components/ui/XPBar';
import { Keycap } from '../src/components/ui/Keycap';
import { ScrollReveal } from '../src/components/ui/ScrollFx';
import { JourneyPath, JourneyNode } from '../src/components/journey/JourneyPath';
import { LESSONS } from '../src/pk/lessons';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { GREEN_WEEK_MIN } from '../src/utils/weekBands';

const ORIENT_DAYS = [1, 2];
const FIELD_DAYS = [3, 4, 5, 6, 7, 8];
/** How much forward scroll the journey hero's parallax layers ride. */
const HERO_PARALLAX_RUN = 100;
/** How much pull-down the hero's overscroll stretch rides (see journeyScroll). */
const HERO_PULL_RUN = 60;

export default function MyProgressScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const tabBarClearance = useTabBarClearance();
  const insets = useSafeAreaInsets();
  const isLandscape = useIsLandscape();
  const winH = useWindowDimensions().height;
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const isTrainee = (user?.role || '').toLowerCase() === 'trainee';

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['trainee-progress'],
    queryFn: () => apiService.getTraineeProgress().then((r) => r.data),
    enabled: isTrainee,
  });

  // Day objectives + topic counts feed the journey timeline ("what you'll
  // learn today") — both endpoints are trainee-readable.
  const targetsQ = useQuery({
    queryKey: ['targets'],
    queryFn: () => apiService.getTargets().then((r) => r.data),
    enabled: isTrainee,
  });
  const manualQ = useQuery({
    queryKey: ['training-manual'],
    queryFn: () => apiService.getTrainingManual().then((r) => r.data),
    enabled: isTrainee,
  });

  // Sales Development Path — the 30-day ramp that continues the path after
  // the Stage 2 trophy. {enabled:false} while the office is dark, so this
  // renders nothing quietly.
  const salesPathQ = useQuery({
    queryKey: ['sales-path-me'],
    queryFn: () => apiService.getMySalesPath().then((r) => r.data),
    enabled: isTrainee,
  });

  // Product-training progress feeds the PK milestone node on the path.
  // Stored locally by the PK screen — re-read it whenever this tab refocuses
  // so finishing a lesson updates the node without a pull-to-refresh.
  const pkProgressQ = useQuery({
    queryKey: ['pk-lesson-progress'],
    queryFn: async () => {
      try {
        const raw = await AsyncStorage.getItem('cg1.pk.lessonProgress');
        return raw ? JSON.parse(raw) : {};
      } catch { return {}; }
    },
    enabled: isTrainee,
  });
  useFocusEffect(useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['pk-lesson-progress'] });
    queryClient.invalidateQueries({ queryKey: ['streak'] });
  }, []));

  // Feeds the app-wide pageScrollY too (masthead condense, sheens, XP charge).
  const { scrollY, onScroll } = useParallaxScroll();

  // The journey hero is a mid-page block, so its parallax runs off its OWN
  // layout y. Two things it must get right:
  //
  //  - START WHEN IT ENTERS, not when it leaves. Anchoring on `anchorY` alone
  //    kept the value at 0 for the whole time the block sat on the first
  //    screen and only began moving once its top hit the viewport top — i.e.
  //    as it left. The anchor is the moment the block crosses 75% of the
  //    viewport height; max(0, …) means a block that is ALREADY on the first
  //    screen (this one is, right under the profile ink block) simply rides
  //    page scroll from rest.
  //  - STAY CAPPED FORWARD, AND KEEP NEGATIVES. The hero's text layer drifts
  //    down by 0.15 × this value (ParallaxLayer depth .85 over a 300 px run)
  //    and the block has only 24 px of bottom padding — so forward scroll is
  //    capped at 100 px (~15 px of drift, inside it) or the XP bar slides out
  //    of the block's foot. Pull-down is kept, not clamped to 0, because
  //    EditorialHero's overscroll scaleY stretch reads the same value; −60 px
  //    lifts the text layer 17 px, inside the block's 24 px of top padding.
  const journeyAnchorY = useSharedValue(0);
  const journeyScroll = useDerivedValue(() => {
    const entry = Math.max(0, journeyAnchorY.value - winH * 0.75);
    return Math.min(
      HERO_PARALLAX_RUN,
      Math.max(-HERO_PULL_RUN, scrollY.value - entry),
    );
  }, [winH]);

  const { pullIndicator } = usePullToRefresh(async () => {
    await Promise.all([refetch(), targetsQ.refetch(), manualQ.refetch(), salesPathQ.refetch()]);
  });

  if (!isTrainee) {
    return (
      <View style={styles.gate}>
        <Stack.Screen options={{ title: 'My Progress' }} />
        <DepthCard style={styles.gateCard}>
          <Keycap size={62} radius={20}>
            <Ionicons name="footsteps-outline" size={28} color={colors.primary} />
          </Keycap>
          <Text style={styles.gateTitle}>My Progress</Text>
          <Text style={styles.gateBody}>
            This is each new BA's own 8-day journey. To grade someone's assessments, open them from the My Team tab.
          </Text>
        </DepthCard>
      </View>
    );
  }

  if (isLoading) {
    return <View style={styles.loader}><BrandLoader size={68} label="Loading" /></View>;
  }

  const hire = data?.hire;
  const assessments: any[] = data?.assessments || [];
  const orientAsmts = assessments.filter((a: any) => ORIENT_DAYS.includes(a.day_number)).sort((a, b) => a.day_number - b.day_number);
  const fieldAsmts = assessments.filter((a: any) => FIELD_DAYS.includes(a.day_number)).sort((a, b) => a.day_number - b.day_number);
  const doneCount = assessments.filter((a: any) => a.completed).length;

  // "Today" = the first day that hasn't been completed yet.
  const nextPendingAsmt = [...assessments].sort((a: any, b: any) => a.day_number - b.day_number).find((a: any) => !a.completed);
  const todayNum: number | null = nextPendingAsmt?.day_number ?? null;

  const targetByDay: Record<number, any> = {};
  (targetsQ.data || []).forEach((t: any) => { targetByDay[t.day_number] = t; });
  const topicCountByDay: Record<number, number> = {};
  (manualQ.data || []).forEach((m: any) => {
    topicCountByDay[m.day_number] = (topicCountByDay[m.day_number] || 0) + 1;
  });

  const getScoreColor = (score: number | null) => {
    if (score === null || score === undefined) return colors.textMuted;
    if (score >= 10) return colors.sgreen;
    if (score >= 9) return colors.green;
    if (score >= 7) return colors.yellow;
    return colors.red;
  };

  function dayNode(a: any, section?: string): JourneyNode {
    const isOrient = a.day_number <= 2;
    const localDay = isOrient ? a.day_number : a.day_number - 2;
    const isToday = a.day_number === todayNum;
    const topics = topicCountByDay[a.day_number];
    const sc = a.completed ? getStatusColor(a.status) : null;
    return {
      key: `day-${a.day_number}`,
      kind: 'day',
      state: a.completed ? 'done' : isToday ? 'today' : 'upcoming',
      title: isOrient ? `Day ${localDay}` : `Field Day ${localDay}`,
      subtitle: targetByDay[a.day_number]?.day_objective || undefined,
      meta: a.completed
        ? undefined
        : `${topics ? `${topics} topics · ` : ''}${a.status === 'In Progress' ? 'in progress…' : 'tap to preview'}`,
      badge: String(localDay),
      section,
      score: a.completed && a.overall_score != null ? a.overall_score.toFixed(1) : undefined,
      scoreColor: getScoreColor(a.overall_score),
      statusLabel: sc ? a.status : undefined,
      statusBg: sc?.bg,
      statusColor: sc?.text,
      onPress: () => router.push(`/day/${a.id}`),
    };
  }

  function buildJourneyNodes(): JourneyNode[] {
    const nodes: JourneyNode[] = [];
    orientAsmts.forEach((a: any, i: number) =>
      nodes.push(dayNode(a, i === 0 ? 'BA ACADEMY' : undefined)));

    // Product-training milestone — never locked, sits between the classroom
    // days and the field so it reads as "do this before you knock doors".
    const pkDone = LESSONS.filter((l) => (pkProgressQ.data || {})[l.id]?.done).length;
    const hasLessons = LESSONS.length > 0;
    nodes.push({
      key: 'pk',
      kind: 'pk',
      state: hasLessons && pkDone >= LESSONS.length ? 'done' : 'upcoming',
      title: 'Campaign Training',
      subtitle: hasLessons ? 'Short lessons + quick quizzes — do them anytime.' : 'Campaign facts + the campaign exam — do them anytime.',
      meta: hasLessons ? `${pkDone}/${LESSONS.length} lessons` : 'Reference + exam',
      section: 'CAMPAIGN TRAINING · ANYTIME',
      onPress: () => router.push('/product-knowledge'),
    });

    fieldAsmts.forEach((a: any, i: number) =>
      nodes.push(dayNode(a, i === 0 ? 'IN-FIELD TRAINING' : undefined)));

    // Aspirational end node — where the path leads (the COD tab's Stage 2).
    nodes.push({
      key: 'stage2',
      kind: 'trophy',
      state: doneCount >= 8 ? 'done' : 'upcoming',
      title: 'Stage 2 — Independence',
      subtitle: doneCount >= 8
        ? 'Unlocked — your next chapter starts here.'
        : 'Complete all 8 days to unlock your next stage.',
      section: 'WHERE THIS LEADS',
      onPress: () => router.replace('/(tabs)/progress?tab=stage2' as never),
    });

    // ── MY FIRST 30 DAYS — the sales ramp runway ─────────────────────────
    // Visible from day 1 so a new starter knows there IS a ramp: nobody is
    // expected at a Green Week immediately; everybody is expected to build to it.
    // Server-driven (core/sales_path.py); hidden while the office is dark.
    const ramp = salesPathQ.data?.enabled ? salesPathQ.data?.path?.ramp : null;
    if (ramp) {
      const targets: number[] = ramp.targets || [7, 10, 12, 15];
      const graded = ramp.weekly || [];
      targets.forEach((target, i) => {
        // Paused/excused rows carry week: null server-side; the filter is
        // belt-and-braces so a stale doc can't pin a node to an excused row.
        const row = graded.find((w) => !w.paused && w.week === i + 1);
        const isCurrent = ramp.status !== 'complete' && row && !row.completed;
        nodes.push({
          key: `ramp-${i + 1}`,
          kind: 'day',
          state: row?.met || (ramp.status === 'complete' && row?.completed) ? 'done'
            : isCurrent ? 'today' : 'upcoming',
          title: `Ramp Week ${i + 1}`,
          subtitle: i === 0
            ? `Build to ${target} sign-ups — the ramp exists because nobody starts at full speed.`
            : `Build to ${target} sign-ups this week.`,
          meta: row
            ? row.paused ? 'paused — excused week'
              : row.completed ? `${row.sales} sign-up${row.sales === 1 ? '' : 's'}${row.met ? ' ✓' : ''}`
              : `${row.sales} so far`
            : 'starts after your 8 training days',
          badge: String(i + 1),
          section: i === 0 ? 'MY FIRST 30 DAYS' : undefined,
        });
      });
      nodes.push({
        key: 'green-week',
        kind: 'trophy',
        state: ramp.status === 'complete' ? 'done' : 'upcoming',
        title: 'Green Week',
        subtitle: ramp.status === 'complete'
          ? `Done — ${GREEN_WEEK_MIN}+ sign-ups in one week. See what it paid in the Earnings Calculator.`
          : `${GREEN_WEEK_MIN}+ sign-ups in one week — the minimum to build to (see the Earnings Calculator).`,
        onPress: () => router.push('/(tabs)/pay' as never),
      });
    }
    return nodes;
  }

  const displayName = hire?.name || user?.name || '';
  const initial = user?.name?.charAt(0)?.toUpperCase() || '';
  const statusColor = hire ? getStatusColor(hire.current_status) : null;
  const heroTitle = doneCount >= 8 ? 'Stage 1 complete! 🎉' : todayNum ? `Day ${todayNum} of 8` : 'Getting started';

  return (
    <View style={{ flex: 1 }}>
      {pullIndicator}
      <Stack.Screen options={{ title: 'My Progress' }} />
      <ScrollView
        style={[
          { flex: 1 },
          isLandscape && { paddingLeft: insets.left, paddingRight: insets.right, paddingTop: insets.top },
        ]}
        contentContainerStyle={{ padding: 16, paddingTop: 12, paddingBottom: tabBarClearance + 20 }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary} colors={[colors.primary]}
          onRefresh={async () => {
            setRefreshing(true);
            await Promise.all([refetch(), targetsQ.refetch(), manualQ.refetch(), salesPathQ.refetch()]);
            setRefreshing(false);
          }} />}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* Profile header — the screen's ink block. Bleeds edge-to-edge,
            stretches on overscroll, and the journey hero rides up over its
            bottom edge. Decoration is static (no loops): a glow + line cube. */}
        <EditorialHero variant="ink" scrollY={scrollY} overlapNext={22}>
          <GlowOrb size={170} color="#8caf38" opacity={isDark ? 0.5 : 0.4} style={{ top: -30, right: -18 }} />
          <DotField size={120} color="#b7df58" opacity={isDark ? 0.3 : 0.22} corner="top-right" style={{ right: 0, top: 0 }} />
          <View style={styles.profileRow}>
            <HexFrame size={76}>
              <Text style={styles.avatarText}>{initial}</Text>
            </HexFrame>
            <View style={{ flex: 1, minWidth: 0 }}>
              <GradientText colors={GRADIENT_TEXT} style={styles.name} numberOfLines={2}>
                {displayName}
              </GradientText>
              <Text style={styles.leader}>Coach: {(hire?.leader || 'Unassigned').split(/\s+/)[0]}</Text>
              <View style={styles.badgeRow}>
                {hire && statusColor && (
                  <View style={[styles.statusBadge, { backgroundColor: statusColor.bg }]}>
                    <Text style={[styles.statusText, { color: statusColor.text }]}>
                      {/* Friendlier trainee-facing label; the underlying value stays
                          the same (other screens key off the exact string). */}
                      {hire.current_status === 'Awaiting Outcome' ? 'Training Complete 🎉' : hire.current_status}
                    </Text>
                  </View>
                )}
                {hire?.final_outcome && (
                  <View style={[styles.outcomeBadge, {
                    backgroundColor: hire.final_outcome === 'Ready' ? colors.greenBg : colors.yellowBg
                  }]}>
                    <Ionicons
                      name={hire.final_outcome === 'Ready' ? 'checkmark-circle' : 'time'}
                      size={16}
                      color={hire.final_outcome === 'Ready' ? colors.green : colors.yellow}
                    />
                    <Text style={[styles.outcomeText, {
                      color: hire.final_outcome === 'Ready' ? colors.green : colors.yellow
                    }]}>
                      {hire.final_outcome}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </EditorialHero>

        {/* Journey hero — where you are on the 8-day path. A paper block that
            rides the ink block's overlap: gradient title, XP-gradient ring
            and an XP bar. The bar runs tipless: the GoalProgressRing 18 px to
            its right already carries the animated progress signal, and the
            tip's pulse loop pushed this route to 7 continuous loops (budget 6
            — PageField 2-3 + masthead cube 1 + the journey's animated coins).
            Measured with the __DEV__ loop registry, not estimated. */}
        {hire && (
          <View
            style={styles.heroLift}
            onLayout={(e) => { journeyAnchorY.value = e.nativeEvent.layout.y; }}
          >
            <EditorialHero variant="paper" scrollY={journeyScroll} bleed={0} overlapNext={0} kicker="MY FIRST 8 DAYS">
              <View style={styles.heroRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  {doneCount >= 8 ? (
                    // Emoji can't take a gradient fill — keep the celebration solid.
                    <Text style={[styles.heroTitle, { color: colors.text }]}>{heroTitle}</Text>
                  ) : (
                    <GradientText colors={colors.titleGradient} style={styles.heroTitle} numberOfLines={2}>
                      {heroTitle}
                    </GradientText>
                  )}
                  {todayNum && targetByDay[todayNum]?.day_objective ? (
                    <Text style={styles.heroObjective} numberOfLines={3}>
                      {targetByDay[todayNum].day_objective}
                    </Text>
                  ) : doneCount >= 8 ? (
                    <Text style={styles.heroObjective}>All 8 days graded — Stage 2 is calling.</Text>
                  ) : null}
                </View>
                <GoalProgressRing value={doneCount} target={8} label="days" size={82} stroke={9} hapticTicks />
              </View>
              <XPBar value={doneCount / 8} tip={false} style={styles.heroBar} />
            </EditorialHero>
          </View>
        )}

        {/* The 8-day path — orientation → product training → field → Stage 2 */}
        <JourneyPath nodes={buildJourneyNodes()} />

        {/* The long game — the honest arc, so a rough first week reads as a
            data point, not a verdict. Numbers stay soft; the Pay tab is the
            only place money is promised. */}
        {salesPathQ.data?.enabled && (
          <ScrollReveal scrollY={scrollY}>
            <DepthCard style={styles.longGameCard} sheen>
              <Text style={styles.longGameKicker}>THE LONG GAME</Text>
              <Text style={styles.longGameTitle}>
                {salesPathQ.data?.content?.long_game_title || 'Good takes weeks. Great takes months.'}
              </Text>
              <Text style={styles.longGameBody}>
                {salesPathQ.data?.content?.long_game_body ||
                  "Nobody is good at this in week one — that's why you get a 30-day ramp-up. Stay consistent and you'll be earning steady money. Keep training after that and it goes a lot higher. One bad day or week means nothing. Keep going."}
              </Text>
              <Text style={styles.longGameLink} onPress={() => router.push('/sales-path-intro' as never)}>
                How the Sales Path works →
              </Text>
              <Text style={styles.longGameLink} onPress={() => router.replace('/(tabs)/progress' as never)}>
                See your Sales Proficiency ladder on the COD tab →
              </Text>
            </DepthCard>
          </ScrollReveal>
        )}

        {assessments.length === 0 && (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>
              Your 8-day plan will appear here once your coach sets you up.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  // Screen roots stay transparent — the mount-once PageField paints the page.
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  gateCard: { borderRadius: 22, padding: 28, alignItems: 'center', alignSelf: 'stretch' },
  // Unbounded-Black: never add fontWeight (web faux-bold).
  gateTitle: { fontFamily: fonts.displayBlack, fontSize: 20, letterSpacing: -0.5, color: colors.text, marginTop: 14 },
  gateBody: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: colors.textSecondary, textAlign: 'center', marginTop: 6 },

  // ── Profile (ink block) ──
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  avatarText: { fontFamily: fonts.displayBlack, fontSize: 28, color: colors.text },
  // Unbounded-Black: never add fontWeight (web faux-bold).
  name: { fontFamily: fonts.displayBlack, fontSize: 24, lineHeight: 29, letterSpacing: -0.6 },
  leader: { fontFamily: fonts.body, fontSize: 14, color: colors.inkMuted, marginTop: 4 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 },
  statusBadge: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
  statusText: { fontFamily: fonts.bodyBold, fontSize: 12.5 },
  outcomeBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
  outcomeText: { fontFamily: fonts.bodyBold, fontSize: 12.5 },

  // ── Journey hero (paper block riding the ink overlap) ──
  heroLift: { zIndex: 2 },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  heroTitle: { fontFamily: fonts.displayBlack, fontSize: 28, lineHeight: 33, letterSpacing: -0.8 },
  heroObjective: { fontFamily: fonts.body, fontSize: 13, color: colors.textSecondary, lineHeight: 18.5, marginTop: 8 },
  // marginBottom keeps the bar clear of the block's 28 px bottom radius even
  // at the end of the parallax run (the text layer drifts down as you scroll).
  heroBar: { marginTop: 16, marginBottom: 12 },

  // ── The long game (depth card) ──
  longGameCard: { borderRadius: 20, padding: 18, marginTop: 18 },
  longGameKicker: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.primary, letterSpacing: 2 },
  longGameTitle: { fontFamily: fonts.display, fontSize: 17, color: colors.text, marginTop: 6 },
  longGameBody: { fontFamily: fonts.body, fontSize: 12.5, color: colors.textSecondary, lineHeight: 19, marginTop: 6 },
  longGameLink: { fontFamily: fonts.bodyBold, fontSize: 12.5, color: colors.primary, marginTop: 10 },
});
