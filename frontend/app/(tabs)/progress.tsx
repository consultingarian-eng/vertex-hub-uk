import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useIsLandscape } from '../../src/hooks/useIsLandscape';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { useColors, useTheme, lightColors, fonts } from '../../src/theme/ThemeContext';
import { GRADIENT } from '../../src/theme/brand';
import { pageMarkKick } from '../../src/theme/pageScroll';
import { StageVideo, useCodVideos } from '../../src/components/cod/StageVideo';
import { sortByCodStage } from '../../src/components/cod/stageOrder';
import { apiService } from '../../src/api/client';
import { usePullToRefresh } from '../../src/components/ui/PullRefresh';
import { useAuth } from '../../src/auth/AuthContext';
import { GoalProgressRing } from '../../src/components/ui/GoalProgressRing';
import { BrandLoader } from '../../src/components/ui/BrandLoader';
import { useParallaxScroll } from '../../src/components/ui/Parallax';
import { EditorialHero, ParallaxLayer, HERO_DEPTH } from '../../src/components/ui/EditorialHero';
import { VertexMark } from '../../src/components/ui/VertexMark';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { SlidingSegments, type SegmentItem } from '../../src/components/ui/SlidingSegments';
import { StatBlock } from '../../src/components/ui/StatBlock';
import { XPBar } from '../../src/components/ui/XPBar';
import { GradientText } from '../../src/components/ui/GradientText';
import { Keycap } from '../../src/components/ui/Keycap';
import { CodTopicList } from '../../src/components/cod/CodTopicList';
import { SalesPathPanel } from '../../src/components/salespath/SalesPathPanel';
import { TwoLadders, salesNextFrom, salesStepsFrom, LadderStep } from '../../src/components/salespath/TwoLadders';
// Leader/admin variant of the COD tab reuses the existing leadership hub
// (stage toggle + module list + My Trainees CTA + lock banners). When the
// user isn't a trainee, we hand the entire screen off to it so the
// bottom-tab UX mirrors what trainees see at the same slot.
import LeadershipScreen from '../leadership';

// ── Stage hero ───────────────────────────────────────────────────────────────
// The "Ink & Cube" stage header (spec §4 COD): a paper EditorialHero with a
// 72px glass cube in its top-right, the signed-off count as a 56px gradient
// StatBlock, the gradient neon ring, an XP bar under the objective and the
// deep links as gradient icon wells. Copy is unchanged — the title string is
// split into the numeral and its tail so it still reads "10 of 16 signed off".
//
// The Vertex X is rendered here rather than through EditorialHero's `cube`
// slot so it can sit fully INBOARD of the block's 22px top-right corner arc
// (the slot clips to the block) and take the theme's mark colour.
//
// The block sits mid-page, so its parallax is anchored to its own position:
// the layers rest until the block's top reaches the viewport top, then lag as
// it scrolls out (never negative → no overscroll stretch mid-page). The lag is
// damped and capped (PARALLAX_*) — EditorialHero's full 0→300 px range is
// built for a hero pinned at the top edge; on a mid-page block it drifts the
// text stack ~45 px down out of its own padding and drops the cube on top of
// the ring.
const PARALLAX_RATE = 0.4;   // how much of the local scroll the layers feel
const PARALLAX_MAX = 32;     // → text lags ≤5 px, the cube ≤26 px (stays clear of the ring)

// Stage-hero mark. 72px, seated 10px in from the card's top-right corner so
// the corner radius never cuts it.
const HERO_CUBE = 72;
const HERO_CUBE_INSET = 10;
// EditorialHero's own padding at bleed 0 / topEdge false — the cube is placed
// against the BLOCK's edges, so it has to cancel the content padding out.
const HERO_PAD_TOP = 24;
const HERO_PAD_SIDE = 16;

type StageLink = { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void };

function StageHero({ kicker, done, total, complete, completeTitle, objective, links, scrollY, overlapNext }: {
  kicker: string;
  done: number;
  total: number;
  complete: boolean;
  completeTitle: string;
  objective: string;
  links?: StageLink[];
  scrollY: SharedValue<number>;
  overlapNext: number;
}) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const styles = useMemo(() => createStyles(colors), [colors]);
  const pct = total > 0 ? Math.min(1, done / total) : 0;
  const anchorY = useSharedValue(0);
  const localScroll = useDerivedValue(() =>
    Math.min(PARALLAX_MAX, Math.max(0, (scrollY.value - anchorY.value) * PARALLAX_RATE)));
  return (
    <View onLayout={(e) => { anchorY.value = e.nativeEvent.layout.y; }}>
      <EditorialHero
        variant="paper"
        scrollY={localScroll}
        bleed={0}
        overlapNext={overlapNext}
        style={[styles.heroBlock, overlapNext === 0 && { marginBottom: 12 }]}
        kicker={<Text style={styles.heroKicker}>{kicker}</Text>}
      >
        {/* The Vertex X, top-right and fully inboard of the corner radius:
            brand green on the light paper card, lime at night. First child →
            it paints UNDER the type stack. */}
        <ParallaxLayer
          depth={HERO_DEPTH.cube}
          scrollY={localScroll}
          style={{
            position: 'absolute',
            top: HERO_CUBE_INSET - HERO_PAD_TOP,
            right: HERO_CUBE_INSET - HERO_PAD_SIDE,
            // Decoration only — it sits over the card's empty top-right.
            pointerEvents: 'none',
          }}
        >
          <VertexMark
            size={HERO_CUBE}
            opacity={isDark ? 0.9 : 1}
            color={colors.markColor}
            kick={pageMarkKick}
          />
        </ParallaxLayer>
        {complete ? (
          <GradientText colors={colors.titleGradient} style={styles.heroTitle} numberOfLines={2}>
            {completeTitle}
          </GradientText>
        ) : (
          <View style={styles.heroCountRow}>
            <StatBlock value={done} label="" accent={false} size={56} gradient align="left" />
            <Text style={styles.heroTitleTail}>of {total} signed off</Text>
          </View>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.heroObjective}>{objective}</Text>
            {/* Motion budget (spec §5, ≤6 loops/screen): the hero already
                carries the neon GoalProgressRing and the 56px StatBlock of
                the SAME number, so this bar runs quiet — tip={false} costs no
                loop and glow={false} also drops its ShineSweep. */}
            <XPBar value={pct} height={10} tip={false} glow={false} style={styles.heroBar} />
            {links?.map((l) => (
              <TouchableOpacity key={l.label} onPress={l.onPress} style={styles.heroLink} activeOpacity={0.75}>
                <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.heroLinkWell}>
                  <Ionicons name={l.icon} size={13} color="#fff" />
                </LinearGradient>
                <Text style={styles.heroLinkText}>{l.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {/* 96, not 82: GoalProgressRing derives its centre numeral from the
              diameter (size × 0.19, capped at 20) while the label under it is
              a fixed 11 px, so at 82 the "DONE" caption out-shouted the
              "63%" it captions (round-2 review). 96 puts the numeral at 18 px
              — the biggest thing in the ring, as it should be. */}
          <GoalProgressRing value={done} target={Math.max(1, total)} label="done" size={96} stroke={10} hapticTicks />
        </View>
      </EditorialHero>
    </View>
  );
}

export default function TraineeProgressScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const isLandscape = useIsLandscape();
  const { user } = useAuth();
  const router = useRouter();
  const { tab: tabParam } = useLocalSearchParams<{ tab?: string }>();
  const [refreshing, setRefreshing] = React.useState(false);
  // Outer ScrollView feeds the hero parallax + the app-wide pageScrollY.
  const { scrollY, onScroll } = useParallaxScroll();
  // The COD tab is stages only — the day-by-day "My First 8 Days" journey
  // moved to the trainee's My Progress tab (/assessments). Stage 1 here
  // mirrors what leaders see: the Foundation sheet's PDF-style capability
  // modules with the K·D·D proof ladder.
  const [tab, setTab] = useState<'stage1' | 'stage2' | 'stage3'>('stage1');

  // Deep-link support (e.g. My Progress's Stage 2 trophy node lands here
  // with ?tab=stage2).
  useEffect(() => {
    if (tabParam === 'stage1' || tabParam === 'stage2' || tabParam === 'stage3') setTab(tabParam);
  }, [tabParam]);

  // Role check is captured here but the early-return happens AFTER all hooks
  // are unconditionally called below — Rules-of-Hooks compliance.
  const role = (user?.role || '').toLowerCase();
  const isLeaderOrAdmin = !!role && role !== 'trainee';

  // Stage-1-complete celebrations come from the achievement engine's
  // "Stage 1 Graduate" badge (backend/core/achievements.py) — account-bound
  // server-side, celebration gated off while previewing (useBadgeWatcher).

  // ── Stage wiring ───────────────────────────────────────────────────────
  // Stage status drives the locked overlays; modules + progress are loaded
  // lazily per selected stage tab. Stage 1 is never locked — it IS the
  // trainee's own stage.
  const codVideosQ = useCodVideos();
  const stageStatusQ = useQuery({
    queryKey: ['stage-status'],
    queryFn: () => apiService.getStageStatus().then(r => r.data),
    enabled: !isLeaderOrAdmin,
  });
  // The trainee's CURRENT dev stage (2 once unlocked, else 1) — the Two
  // Ladders card needs its modules loaded whichever tab is open.
  const devStage: 1 | 2 = stageStatusQ.data?.stage_2_unlocked ? 2 : 1;
  const stage1Q = useQuery({
    queryKey: ['modules', 1],
    queryFn: () => apiService.listModules(1).then(r => r.data),
    enabled: !isLeaderOrAdmin && (tab === 'stage1' || devStage === 1),
  });
  const stage1ProgressQ = useQuery({
    queryKey: ['module-progress', 1],
    queryFn: () => apiService.getMyModuleProgress(1).then(r => r.data.progress),
    enabled: !isLeaderOrAdmin && (tab === 'stage1' || devStage === 1),
  });
  const stage2Q = useQuery({
    queryKey: ['modules', 2],
    queryFn: () => apiService.listModules(2).then(r => r.data),
    enabled: !isLeaderOrAdmin && (tab === 'stage2' || devStage === 2) && !!stageStatusQ.data?.stage_2_unlocked,
  });
  const stage2ProgressQ = useQuery({
    queryKey: ['module-progress', 2],
    queryFn: () => apiService.getMyModuleProgress(2).then(r => r.data.progress),
    enabled: !isLeaderOrAdmin && (tab === 'stage2' || devStage === 2) && !!stageStatusQ.data?.stage_2_unlocked,
  });
  // Sales Development Path — the parallel ladder card. {enabled:false} while
  // the office is dark, so the card simply doesn't render.
  const salesPathQ = useQuery({
    queryKey: ['sales-path-me'],
    queryFn: () => apiService.getMySalesPath().then(r => r.data),
    enabled: !isLeaderOrAdmin && !!stageStatusQ.data?.sales_path_enabled,
  });

  // The real Stage 2 gate: graded days. Lifted out of the JSX so the locked
  // teaser can draw the same numbers as an XP bar as well as the count line.
  const gradedDays: number = (stageStatusQ.data as any)?.stage_1_days_completed?.length || 0;
  const totalDays: number = stageStatusQ.data?.stage_1_total_days || 8;

  const onRefresh = async () => {
    setRefreshing(true);
    // Refetch the ACTIVE tab's queries — refetch() ignores enabled:false in
    // TanStack v5, so refetching the other stage's queries would force-fetch
    // hidden data while skipping what the user is actually looking at.
    const active = tab === 'stage2'
      ? (stageStatusQ.data?.stage_2_unlocked ? [stage2Q.refetch(), stage2ProgressQ.refetch()] : [])
      : tab === 'stage1' ? [stage1Q.refetch(), stage1ProgressQ.refetch()] : [];
    await Promise.all([stageStatusQ.refetch(), ...active]);
    setRefreshing(false);
  };

  // Web pull-to-refresh (react-native-web's RefreshControl is a no-op).
  const { pullIndicator } = usePullToRefresh(onRefresh);

  // Stage tab switcher items — the same keys/labels/testIDs the old pill
  // tabs carried; the label text still owns its 🔒 (SlidingSegments only
  // dims a locked item, it stays selectable so the teaser panels show).
  const stageItems = useMemo<SegmentItem[]>(() => {
    const items: SegmentItem[] = [
      { key: 'stage1', label: 'Stage 1', testID: 'tab-stage1' },
      {
        key: 'stage2',
        label: stageStatusQ.data?.stage_2_unlocked ? 'Stage 2' : '🔒 Stage 2',
        locked: !stageStatusQ.data?.stage_2_unlocked,
        testID: 'tab-stage2',
      },
    ];
    // Stage 3 — always shown as a soft-locked teaser for trainees so they
    // can "see what's next". It never unlocks until promoted to leader.
    if (stageStatusQ.data?.stage_3_visible) {
      items.push({
        key: 'stage3',
        label: stageStatusQ.data?.stage_3_unlocked ? 'Stage 3' : '🔒 Stage 3',
        locked: !stageStatusQ.data?.stage_3_unlocked,
        testID: 'tab-stage3',
      });
    }
    // Laid out through the shared COD display order (stageOrder.ts) rather
    // than push order, so this rail follows the same sequence as every other
    // stage rail. Only stages 1-3 appear here today.
    return sortByCodStage(items, (it) => Number(it.key.replace('stage', '')));
  }, [stageStatusQ.data?.stage_2_unlocked, stageStatusQ.data?.stage_3_visible, stageStatusQ.data?.stage_3_unlocked]);

  if (isLeaderOrAdmin) {
    // Leaders and admins land on the leadership hub, kept in the SAME
    // bottom-tab slot so the navigation experience mirrors what trainees
    // see at the bottom of the screen.
    return <LeadershipScreen />;
  }

  return (
    <View style={{ flex: 1 }}>
    {pullIndicator}
    <ScrollView
      style={[
        styles.container,
        isLandscape && { paddingLeft: insets.left, paddingRight: insets.right, paddingTop: insets.top },
      ]}
      contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 20 }]}
      onScroll={onScroll}
      scrollEventThrottle={16}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />}
    >
      {/* ── Two ladders, side by side — always a next thing on each ── */}
      {salesPathQ.data?.enabled && salesPathQ.data?.path && salesPathQ.data?.meta && (() => {
        const curQ = devStage === 2 ? stage2Q : stage1Q;
        const curP = devStage === 2 ? stage2ProgressQ : stage1ProgressQ;
        const mods = (curQ.data?.modules || []) as any[];
        const doneIds = new Set(((curP.data || []) as any[]).filter((x) => x.completed).map((x) => x.module_id));
        const nextMod = mods.find((m) => !doneIds.has(m.id));
        // Written in stored-stage order; rendered in COD display order — SL
        // (stored stage 5) sits between Stage 3 and Stage 4. See stageOrder.ts.
        const devSteps: LadderStep[] = sortByCodStage<LadderStep & { stage: number }>([
          { stage: 1, key: 'd1', label: 'Foundation', state: devStage > 1 ? 'done' : 'current' },
          { stage: 2, key: 'd2', label: 'Self Management', state: devStage === 2 ? 'current' : 'upcoming' },
          { stage: 3, key: 'd3', label: 'Leader', state: 'locked' },
          { stage: 4, key: 'd4', label: 'Team Builder', state: 'locked' },
          { stage: 5, key: 'd5', label: 'Sector Leader', state: 'locked' },
        ], (d) => d.stage);
        const devNext = nextMod
          ? {
              title: nextMod.topic,
              sub: `Stage ${devStage} · pass its questions, then Ready for check`,
              onPress: () => router.push(`/module/${nextMod.id}`),
            }
          : mods.length > 0
            ? {
                title: devStage === 1 && stageStatusQ.data?.stage_2_unlocked
                  ? 'Stage 1 signed off — Stage 2 is calling'
                  : `Stage ${devStage} complete 🎉`,
                sub: devStage === 1 ? 'Your next capabilities are waiting.' : 'Advancement territory — talk to your coach.',
                onPress: devStage === 1 ? () => setTab('stage2') : undefined,
              }
            : undefined;
        return (
          <TwoLadders
            devSteps={devSteps}
            salesSteps={salesStepsFrom(salesPathQ.data.path, salesPathQ.data.meta)}
            devNext={devNext}
            salesNext={salesNextFrom(salesPathQ.data.path, salesPathQ.data.meta,
              () => router.push('/sales-path-intro' as any))}
            scrollY={scrollY}
            // Full-bleed ink block (spec §1): 16 cancels the ScrollView's
            // content padding so the block runs edge to edge. The leadership
            // hub keeps the inset default.
            bleed={16}
          />
        );
      })()}

      {/* Stage tab switcher — the COD is stages; the day-by-day journey
          lives on the My Progress tab. Ink rail with a sliding white tile. */}
      <SlidingSegments
        items={stageItems}
        value={tab}
        onChange={(k) => setTab(k as 'stage1' | 'stage2' | 'stage3')}
        style={styles.stageRail}
        // The old stage pill tabs buzzed nothing; keep switching silent.
        haptic={false}
        testID="stage-tabs"
      />

      {/* Stage 3 body — pure soft-locked teaser. Trainees can never enter
          Stage 3 (it unlocks only on promotion to leader), but seeing the
          locked tile mimics chasing the next stage. */}
      {tab === 'stage3' && (
        <DepthCard style={styles.daysCard}>
          <View style={styles.lockBody}>
            <Keycap size={64} radius={20} tone="gradient">
              <Ionicons name="lock-closed" size={28} color="#fff" />
            </Keycap>
            <GradientText colors={colors.titleGradient} style={styles.lockTitle} numberOfLines={2}>
              Stage 3 — Leadership
            </GradientText>
            <Text style={styles.lockText}>
              Stage 3 unlocks when you advance to coach. Self-motivation, accountability, recruiting, coaching new starters — all the skills you'll need when you have a team of your own.
            </Text>
            <Text style={styles.lockHint}>
              Keep climbing — your next stage is right around the corner.
            </Text>
          </View>
        </DepthCard>
      )}

      {/* Stage 2 body — modules grouped by category, locked overlay until 8 days submitted. */}
      {tab === 'stage2' && stageStatusQ.data?.stage_2_unlocked && (
        <StageVideo url={codVideosQ.data?.stage2} title="Stage 2 — Self Management Briefing" />
      )}
      {tab === 'stage2' && (
        !stageStatusQ.data?.stage_2_unlocked ? (
          <DepthCard style={styles.daysCard}>
            <View style={styles.lockBody}>
              <Keycap size={64} radius={20} tone="gradient">
                <Ionicons name="lock-closed" size={28} color="#fff" />
              </Keycap>
              <GradientText colors={colors.titleGradient} style={styles.lockTitle} numberOfLines={2}>
                Stage 2 Locked
              </GradientText>
              <Text style={styles.lockText}>
                Get all 8 days (BA Academy + Field) <Text style={{ fontFamily: fonts.bodyBold }}>graded</Text> by your coach to unlock Stage 2 — Independence.
              </Text>
              {/* The real gate is COMPLETED (graded) days — modules.py
                  _is_stage_unlocked — not the formal pass-off list, which
                  most leaders never use (it sat at 0/8 forever). */}
              <XPBar
                value={totalDays > 0 ? gradedDays / totalDays : 0}
                height={10}
                tip={false}
                style={styles.lockBar}
              />
              <Text style={styles.lockCount}>
                {gradedDays} of {totalDays} days graded
              </Text>
            </View>
          </DepthCard>
        ) : stage2Q.isLoading ? (
          <View style={{ padding: 24, alignItems: 'center' }}><BrandLoader size={44} /></View>
        ) : (() => {
          // The PDF's list, live — unnumbered: Stage 2 topics can be worked
          // in any order (only the Stage 1 days are a sequence).
          const mods = (stage2Q.data?.modules || []) as any[];
          const progressById: Record<string, any> = {};
          (stage2ProgressQ.data || []).forEach((p: any) => { progressById[p.module_id] = p; });
          const doneCount2 = mods.filter((m: any) => progressById[m.id]?.completed).length;
          return (
            <>
              <StageHero
                kicker="STAGE 2 — SELF MANAGEMENT"
                done={doneCount2}
                total={mods.length}
                complete={doneCount2 >= mods.length && mods.length > 0}
                completeTitle="Stage 2 complete! 🎉"
                objective='Learn a topic, pass its questions to tick Know, then tap "Ready for check" — your coach signs the rest.'
                scrollY={scrollY}
                overlapNext={0}
              />
              <CodTopicList
                modules={mods}
                progressById={progressById}
                onPress={(m: any) => router.push(`/module/${m.id}`)}
              />
            </>
          );
        })()
      )}

      {/* ── Stage 1 body — the Foundation sheet, exactly as leaders see it:
          PDF-style capability modules across the 4 Pillars with the K·D·D
          proof ladder. The day-by-day assessment journey lives on the
          My Progress tab. ── */}
      {tab === 'stage1' && (
        <>
          {/* Stage 1 briefing video (Cloudinary) — expectations for the stage */}
          <StageVideo url={codVideosQ.data?.stage1} title="Stage 1 — Foundation Briefing" />
          {stage1Q.isLoading || stage1ProgressQ.isLoading ? (
            <View style={{ padding: 32, alignItems: 'center' }}><BrandLoader size={52} /></View>
          ) : (() => {
            const mods = (stage1Q.data?.modules || []) as any[];
            const progressById: Record<string, any> = {};
            (stage1ProgressQ.data || []).forEach((p: any) => { progressById[p.module_id] = p; });
            const doneCount1 = mods.filter((m: any) => progressById[m.id]?.completed).length;
            return (
              <>
                <StageHero
                  kicker="STAGE 1 — FOUNDATION"
                  done={doneCount1}
                  total={mods.length}
                  complete={doneCount1 >= mods.length && mods.length > 0}
                  completeTitle="Stage 1 signed off! 🎉"
                  objective='Build your core competencies. Learn a capability, pass its questions to tick Know, then tap "Ready for check" — your coach signs the rest.'
                  links={[
                    { icon: 'information-circle-outline', label: 'How the COD works', onPress: () => router.push('/cod-intro' as any) },
                    { icon: 'grid-outline', label: 'My sheet — the K·D·D grid', onPress: () => router.push('/cod-sheet?stage=1' as any) },
                  ]}
                  scrollY={scrollY}
                  overlapNext={18}
                />

                {/* Day-by-day journey pointer — assessments have their own tab.
                    Rides 18px up over the hero's bottom edge (index 0). */}
                <TouchableOpacity
                  style={styles.journeyTouch}
                  activeOpacity={0.85}
                  onPress={() => router.push('/assessments' as any)}
                  testID="stage1-my-progress-link"
                >
                  <DepthCard style={styles.journeyPointer} index={0}>
                    <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.journeyPointerIcon}>
                      <Ionicons name="footsteps" size={18} color="#fff" />
                    </LinearGradient>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.journeyPointerTitle}>My Progress — my first 8 days</Text>
                      <Text style={styles.journeyPointerSub}>Your day-by-day path and assessments live on the My Progress tab</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                  </DepthCard>
                </TouchableOpacity>

                {/* The PDF's list, live — pillar headers + capability rows
                    with the K·D·D boxes, same as the leaders' view. */}
                <CodTopicList
                  modules={mods}
                  progressById={progressById}
                  onPress={(m: any) => router.push(`/module/${m.id}`)}
                />
              </>
            );
          })()}
        </>
      )}

      {/* ── The second ladder — Sales Proficiency, beside the COD stages.
          "Two ladders, one person": leadership can move fast; sales mastery
          compounds over time. Hidden while the office is dark. ── */}
      {salesPathQ.data?.enabled && salesPathQ.data?.path && salesPathQ.data?.meta && (
        // The 12px inset is applied HERE, not inside SalesPathPanel: the panel
        // is also mounted by the leadership hub and the trainee detail screen,
        // which pad their own content differently. This keeps the panel on the
        // one left edge the rest of this screen's stack uses.
        <View style={{ marginHorizontal: 12 }}>
          <SalesPathPanel path={salesPathQ.data.path} meta={salesPathQ.data.meta}
            content={salesPathQ.data.content} canEdit={!!salesPathQ.data.can_edit}
            onChanged={() => salesPathQ.refetch()} />
        </View>
      )}
    </ScrollView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // ── One left edge ──
  // The card hosts on this screen sit 12 px inside the scroll's 16 px content
  // padding (StageVideo's `wrap` and CodTopicList's list host both carry
  // marginHorizontal/paddingHorizontal 12, and neither is ours to move), so
  // everything this file lays out takes the same 12 px. Before, the rail and
  // the stage hero sat at 16 and the cards at 28, and the page had a visible
  // stair-stepped left edge (round-2 review). The Two Ladders ink block is
  // the one deliberate exception — it is full-bleed by design (spec §1).

  // Stage rail (SlidingSegments)
  stageRail: { marginBottom: 14, marginHorizontal: 12 },

  // Pointer card from Stage 1 to the My Progress (day-by-day) tab
  journeyTouch: { marginBottom: 4, marginHorizontal: 12 },
  journeyPointer: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 18, padding: 12,
  },
  journeyPointerIcon: {
    width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 6px 14px -4px rgba(58,122,86,0.55)',
  },
  journeyPointerTitle: { fontFamily: fonts.display, fontSize: 14.5, color: colors.text, letterSpacing: -0.2 },
  journeyPointerSub: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 2, lineHeight: 15 },

  // Locked stage teasers (Stage 2 until graded, Stage 3 until promoted)
  daysCard: { borderRadius: 20, marginBottom: 16, marginHorizontal: 12 },
  lockBody: { padding: 28, alignItems: 'center' },
  // Unbounded Black gradient title (never add fontWeight to displayBlack)
  lockTitle: { fontFamily: fonts.displayBlack, fontSize: 20, marginTop: 16, letterSpacing: -0.5, textAlign: 'center' },
  lockText: { fontFamily: fonts.body, color: colors.textSecondary, fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 19 },
  lockHint: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 12, marginTop: 14, fontStyle: 'italic', textAlign: 'center' },
  lockBar: { marginTop: 14, alignSelf: 'stretch' },
  lockCount: { fontFamily: fonts.mono, color: colors.textMuted, fontSize: 12, marginTop: 8, letterSpacing: 0.4 },

  // ── Stage hero (paper EditorialHero) ──
  heroBlock: { marginTop: 12, marginHorizontal: 12 },
  // Unbounded SemiBold for the kicker (never add fontWeight to displayWide)
  heroKicker: {
    fontFamily: fonts.displayWide, fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase',
    color: colors.primary, marginBottom: 6,
  },
  heroCountRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: -6 },
  // Space Grotesk Bold tail of "10 of 16 signed off" — padded up to the numeral's baseline
  heroTitleTail: { fontFamily: fonts.display, fontSize: 20, color: colors.text, letterSpacing: -0.3, paddingBottom: 18, flexShrink: 1 },
  heroTitle: { fontFamily: fonts.displayBlack, fontSize: 24, letterSpacing: -0.6, lineHeight: 30 },
  heroObjective: { fontFamily: fonts.body, fontSize: 12.5, color: colors.textSecondary, lineHeight: 18, marginTop: 4 },
  heroBar: { marginTop: 12, marginBottom: 4 },
  heroLink: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  heroLinkWell: {
    width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 4px 10px -3px rgba(58,122,86,0.55)',
  },
  heroLinkText: { fontFamily: fonts.bodyBold, color: colors.primary, fontSize: 12.5, flexShrink: 1 },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
