/**
 * Start Here — the all-in-one onboarding hub for new starters.
 *
 * One screen a trainee can live in during their first weeks:
 *   1. A welcome word from the company (admin-editable per office)
 *   2. "Your journey" — what the first weeks look like, with live progress
 *   3. How pay works (admin-editable) + link to the Pay calculator
 *   4. People to know — their leader + office contacts (admin-editable)
 *   5. Learning tools — Manual, Campaign Knowledge, Schedule
 *
 * Admins see a pencil button that opens an inline editor for everything
 * office-specific. Content persists via /api/onboarding/content.
 *
 * Visual system ("Ink & Cube" §4 Start Here): a full-bleed pop EditorialHero
 * with a 140px Rubik cube, gradient SectionHeads, DepthCards, and a journey
 * rail that is lit (GRADIENT_XP) up to the current phase with HexCoin nodes —
 * the current node turns, pulses a halo and wears a YOU ARE HERE ribbon.
 * Link-row and tool-tile icons sit on raised Keycaps (static, 9 per screen).
 * Same data, handlers, navigation and copy as before; only the paint changed.
 *
 * R2 review — the three cards BELOW the journey used to be consecutive white
 * slabs of body copy, so each now carries one editorial device of its own:
 *   · COD    — the page's one INK block, with the proof ladder lifted out of
 *              the paragraph onto glass chips strung on a lit GRADIENT_XP rail.
 *   · Pay    — money set in the display face inside the frozen paragraphs, on
 *              38px Keycaps, inside a gradient-rimmed card.
 *   · People — HexFrame avatars (lit hex stroke + halo on the leader).
 * And the journey ladder itself is drawn as a SPECTRUM map when nobody is
 * standing on it (admin/leader), instead of six silver coins on a dead rail.
 *
 * Loop budget (spec §5): the pop hero already spends its Aurora + cube, so this
 * screen animates exactly ONE journey node (the first active phase — coin turn
 * + halo) and keeps the in-card XPBar sweep-free; every other coin is static.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Modal, TextInput, KeyboardAvoidingView, Platform, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated';
import { useColors, useTheme, fonts, GRADIENT, GRADIENT_XP } from '../src/theme/ThemeContext';
import { MOTION, useLoopPause } from '../src/theme/motion';
import PressableScale from '../src/components/ui/PressableScale';
import { apiService, OnboardingContact, OnboardingContent } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { showAlert } from '../src/utils/showAlert';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { StageVideo, useCodVideos } from '../src/components/cod/StageVideo';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { EditorialHero } from '../src/components/ui/EditorialHero';
import { DepthCard } from '../src/components/ui/DepthCard';
import { SectionHead } from '../src/components/ui/SectionHead';
import { HexCoin, type HexCoinTint } from '../src/components/ui/HexCoin';
import { HexFrame } from '../src/components/ui/HexFrame';
import { RankRibbon } from '../src/components/ui/RankRibbon';
import { XPBar } from '../src/components/ui/XPBar';
import { GlowButton } from '../src/components/ui/GlowButton';
import { Keycap } from '../src/components/ui/Keycap';
import { GREEN_WEEK_MIN } from '../src/utils/weekBands';

// ── Journey definition ────────────────────────────────────────────────────
// The four phases every starter moves through. Structure is product logic
// (fixed); the office-specific flavour text comes from the API content.
const JOURNEY = [
  {
    key: 'orientation',
    title: 'Days 1–2 · BA Academy',
    icon: 'school-outline' as const,
    body: 'Meet the office, learn the campaign and the pitch. Two days in-house with the coaches — no field work yet.',
  },
  {
    key: 'field',
    title: 'Days 3–8 · In-Field Training',
    icon: 'walk-outline' as const,
    body: "You're in the field with your coach, learning live at the doors. After each day you review and grade the day together.",
  },
  {
    // Shown only when the Sales Development Path is live for this office
    // (filtered below) — sets the ramp expectation before the first field day.
    key: 'ramp',
    title: 'Days 9–30 · Sales Ramp-Up',
    icon: 'trending-up-outline' as const,
    body: `Nobody starts at full speed — that's why there's a ramp-up. Over your first three weeks you build up to a Green Week: ${GREEN_WEEK_MIN}+ sign-ups in one week, with your coach alongside you the whole way. Those weekly targets are a floor, not a ceiling — plenty of people smash past them and get there quicker. Hit Green Weeks regularly and you're making steady money — and the top earners kept training for months and earn a lot more. Don't judge yourself on your first days.`,
  },
  {
    key: 'stage2',
    title: 'Stage 2 · Independence',
    icon: 'rocket-outline' as const,
    body: 'All 8 days passed off unlocks Stage 2 — running your own days, building consistency, and mastering the skill modules.',
  },
  {
    key: 'stage3',
    title: 'Stage 3 · Leadership',
    icon: 'trophy-outline' as const,
    body: 'Advancing to Stage 3 unlocks recruiting, coaching your own new starters, and building a team.',
  },
];

type PhaseState = 'done' | 'active' | 'upcoming';
type IconName = React.ComponentProps<typeof Ionicons>['name'];

/**
 * The five rungs of the COD proof ladder, lifted OUT of the explainer
 * paragraph and onto glass chips (R2 review: three consecutive white slabs of
 * body copy). Layout only — the words, their order and the "→" between them
 * are exactly the characters that used to run inside the sentence, down to the
 * full stop that closes it.
 */
const PROOF_LADDER = ['Know', 'Do', 'Deliver', 'Teach', 'Systemize.'] as const;

/**
 * Reference spectrum for the journey rail. An admin or leader opening Start
 * Here has no trainee progress, so every phase resolves to 'upcoming' — which
 * used to paint six silver coins on a dead grey rail (R2 review: "the screen
 * the owner opens shows six grey hexagons"). With no live progress the ladder
 * is drawn as the office's journey MAP instead: the coins climb a metal
 * spectrum and the whole rail is lit at reduced opacity. Purely what tint/lit
 * resolve to — no data, copy or state change.
 */
const SPECTRUM = ['bronze', 'teal', 'green', 'gold', 'purple'] as const satisfies readonly HexCoinTint[];
function spectrumTint(i: number, n: number): HexCoinTint {
  if (n <= 1) return SPECTRUM[SPECTRUM.length - 1];
  return SPECTRUM[Math.round((i * (SPECTRUM.length - 1)) / (n - 1))];
}

/** Money figures set in the display face inside a paragraph (pay card). */
const MONEY_RE = /(£[\d,]+(?:\.\d{1,2})?)/g;

// ── Journey rail nodes ────────────────────────────────────────────────────
/** Coin diameter on the rail (spec §4: HexCoin 28). */
const NODE = 28;
/** Plum ink for glyphs on the green (done) and silver (upcoming) metals. */
const NODE_INK = '#0b211c';
/** Halo loop (spec §5 "skill-tree halo / current journey node"). */
const HALO_MS = 1600;

/**
 * The pulsing halo behind the current node: scale 1→1.6, opacity .5→0 on an
 * ease-out, looping — the one continuous loop the journey card owns per
 * active node. Paused with the app (useLoopPause); a reduce-motion freeze
 * leaves a soft 50% disc under the coin, which still reads as "lit".
 */
function NodeHalo({ size, color }: { size: number; color: string }) {
  const p = useSharedValue(0);
  const run = useCallback(() => {
    p.value = 0;
    p.value = withRepeat(withTiming(1, { duration: HALO_MS, easing: MOTION.easeOut }), -1, false);
  }, [p]);
  useEffect(() => {
    run();
    return () => cancelAnimation(p);
  }, [run, p]);
  useLoopPause(p, run, 'JourneyHalo');
  const anim = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - p.value),
    transform: [{ scale: 1 + 0.6 * p.value }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color }, anim]}
    />
  );
}

/**
 * One node on the rail: a HexCoin (green = done, purple = current, silver =
 * upcoming). `live` marks THE current node — the only one that turns and
 * pulses a halo (one coin + one halo loop per screen); a second active phase
 * (e.g. the ramp running alongside orientation) keeps its purple coin and
 * ribbon but stays static.
 */
function JourneyNode({
  state, icon, live, tint: tintOverride,
}: { state: PhaseState; icon: IconName; live: boolean; tint?: HexCoinTint }) {
  const colors = useColors();
  // `tintOverride` is the reference spectrum (no live trainee progress): the
  // node keeps its own icon, takes its metal from the ladder's position and is
  // never dimmed — an admin's copy of the journey is a map, not a dead list.
  const tint: HexCoinTint = tintOverride ?? (state === 'done' ? 'green' : state === 'active' ? 'purple' : 'silver');
  const glyph: IconName = state === 'done' ? 'checkmark' : icon;
  const glyphColor = tint === 'purple' ? '#ffffff' : NODE_INK;
  return (
    <View style={[styles.railNode, state === 'upcoming' && !tintOverride ? styles.railNodeUpcoming : null]}>
      {live ? <NodeHalo size={NODE} color={colors.primary} /> : null}
      <HexCoin size={NODE} tint={tint} animate={live}>
        <Ionicons name={glyph} size={13} color={glyphColor} />
      </HexCoin>
    </View>
  );
}

/**
 * A money figure inside a frozen paragraph, set in the display face at 17px —
 * the pay card's editorial device (R2 review). The string is untouched: the
 * paragraph is split on its own "£…" tokens and re-assembled, so every
 * character still renders in its original order.
 */
function money(text: string | undefined | null, moneyStyle: any): React.ReactNode {
  if (!text) return text ?? null;
  const parts = text.split(MONEY_RE);
  if (parts.length === 1) return text;
  return parts.map((p, i) => (
    i % 2 === 1 ? <Text key={i} style={moneyStyle}>{p}</Text> : <Text key={i}>{p}</Text>
  ));
}

export default function OnboardingScreen() {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tabBarClearance = useTabBarClearance();
  const router = useRouter();
  const codVideosQ = useCodVideos();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isTrainee = (user?.role || '').toLowerCase() === 'trainee';
  // Outer ScrollView only — feeds the hero parallax and the app-wide pageScrollY.
  const { scrollY, onScroll } = useParallaxScroll();

  const [editorOpen, setEditorOpen] = useState(false);

  const onboardingQ = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => apiService.getOnboarding().then((r) => r.data),
  });

  // Live journey progress + the sales-path office flag. All roles — admins
  // and leaders preview Start Here, and the ramp phase must show for them
  // too (it was invisible outside trainee accounts, which is how the whole
  // path ended up feeling buried).
  const stageQ = useQuery({
    queryKey: ['stage-status'],
    queryFn: () => apiService.getStageStatus().then((r) => r.data),
  });
  // Day-1 hires may not have a sales_path doc yet (stage-status reads stored
  // docs only) — /sales-path/me recomputes and mints it, so the ramp phase
  // shows on the very screen meant to set the expectation before day 1.
  // Also carries the admin-edited ramp copy for the journey card.
  const salesPathFallbackQ = useQuery({
    queryKey: ['sales-path-me'],
    queryFn: () => apiService.getMySalesPath().then((r) => r.data),
    enabled: isTrainee && !!stageQ.data?.sales_path_enabled,
  });

  if (onboardingQ.isLoading) {
    return (
      <View style={styles.loader}>
        <BrandLoader size={56} />
      </View>
    );
  }

  const content = onboardingQ.data?.content;
  const leader = onboardingQ.data?.leader;
  const office = onboardingQ.data?.office;
  const canEdit = !!onboardingQ.data?.can_edit;

  // Which journey phase is the trainee currently in?
  const passedOff = stageQ.data?.stage_1_days_passed_off?.length || 0;
  const stage1Total = stageQ.data?.stage_1_total_days || 8;
  const stage2Unlocked = !!stageQ.data?.stage_2_unlocked;
  const stage3Unlocked = !!stageQ.data?.stage_3_unlocked;
  const rampStatus = stageQ.data?.sales_path_enabled
    ? (stageQ.data?.ramp_status ?? salesPathFallbackQ.data?.path?.ramp?.status ?? null)
    : null;
  const phaseState = (key: string): PhaseState => {
    if (!isTrainee) return 'upcoming';
    if (key === 'orientation') return passedOff >= 2 ? 'done' : 'active';
    if (key === 'field') return stage2Unlocked ? 'done' : passedOff >= 2 ? 'active' : 'upcoming';
    if (key === 'ramp') {
      if (rampStatus === 'complete') return 'done';
      return ['on_track', 'behind', 'overdue'].includes(rampStatus || '') ? 'active' : 'upcoming';
    }
    if (key === 'stage2') return stage3Unlocked ? 'done' : stage2Unlocked ? 'active' : 'upcoming';
    return stage3Unlocked ? 'active' : 'upcoming';
  };
  // The ramp phase shows for EVERYONE where the Sales Development Path is
  // live (upcoming state for non-trainees) — only dark offices hide it.
  const journeyPhases = JOURNEY.filter((p) => p.key !== 'ramp' || !!stageQ.data?.sales_path_enabled);
  // The one node that turns + pulses: the earliest phase the trainee is in
  // right now (loop budget — see the file header).
  const liveKey = journeyPhases.find((p) => phaseState(p.key) === 'active')?.key ?? null;
  // Nobody is standing on this ladder (admin/leader preview) — draw it as the
  // office's journey map: spectrum coins on a rail lit at reduced opacity.
  const reference = !isTrainee;

  const contacts: OnboardingContact[] = content?.contacts || [];

  const openPhone = (phone: string) => {
    if (phone) Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() => {});
  };
  const openEmail = (email: string) => {
    if (email) Linking.openURL(`mailto:${email}`).catch(() => {});
  };

  const tools = [
    { label: 'Training Manual', sub: 'The playbook, step by step', icon: 'book-outline' as const, route: '/(tabs)/manual' },
    { label: 'Campaign training', sub: 'The campaign playbook, quiz & exam', icon: 'school-outline' as const, route: '/product-knowledge' },
    { label: 'Office Schedule', sub: 'Meetings, trainings, field times', icon: 'calendar-outline' as const, route: '/(tabs)/schedule' },
    ...(stageQ.data?.sales_path_enabled
      ? [{ label: 'The Sales Path', sub: 'Your 30-day ramp & how earnings grow', icon: 'trending-up-outline' as const, route: '/sales-path-intro' }]
      : []),
  ];

  // Glass chips on the pop hero: plum text on the light theme's near-white
  // glass, white on the dark theme's SMOKED glass. The hero gradient is bright
  // in BOTH themes, so dark mode's near-invisible glass token is replaced here
  // with a dark plate (a literal rgba — never a concat onto colors.glass):
  // lightening it instead put white 11px text on a ~#e7b65c plate (4.5:1, on
  // the AA floor); darkening the plate takes white back to ~8:1.
  const onGlass = isDark ? '#ffffff' : colors.text;
  const popChip = isDark
    ? { backgroundColor: 'rgba(8,20,14,0.34)', borderColor: 'rgba(255,255,255,0.36)' }
    : null;
  // Proof-ladder chips sit on the INK card, so they use the glass recipe: the
  // light theme's near-white glass takes plum text, the dark theme's 6%-white
  // glass is too faint to read as a chip on ink, so it is lifted to a literal
  // 10% plate (never a concat onto colors.glass) and takes white.
  const ladderChip = isDark
    ? { backgroundColor: 'rgba(255,255,255,0.10)', borderColor: 'rgba(255,255,255,0.24)' }
    : { backgroundColor: colors.glass, borderColor: colors.glassBorder };
  // The hero's top row is packed LEFT — chip then pencil — so the admin control
  // never lands in the 140px cube's x-band (the cube sits in the right ~105px
  // of the block). No spacer, no space-between: an edit button planted in the
  // middle of the wireframe reads as a punched-out disc, not a control.
  const heroTopRow = (canEdit || !!office?.name) ? (
    <View style={styles.heroTopRow}>
      {office?.name ? (
        <View style={[styles.officeChip, popChip]}>
          <Ionicons name="business-outline" size={12} color={onGlass} />
          <Text style={[styles.officeChipText, { color: onGlass }]}>{office.name}</Text>
        </View>
      ) : null}
      {canEdit && (
        <TouchableOpacity style={[styles.editBtn, popChip]} onPress={() => setEditorOpen(true)} testID="onboarding-edit">
          <Ionicons name="pencil" size={16} color={onGlass} />
        </TouchableOpacity>
      )}
    </View>
  ) : undefined;

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ padding: 16, paddingBottom: tabBarClearance + 24 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* ── Welcome hero — full-bleed pop block, Rubik cube cut off at the right ── */}
        <EditorialHero
          variant="pop"
          scrollY={scrollY}
          cube={{ size: 140 }}
          overlapNext={0}
          style={styles.hero}
          kicker={heroTopRow}
          title={content?.welcome_title ? <Text style={styles.heroTitle}>{content.welcome_title}</Text> : undefined}
          lede={content?.welcome_message ? <Text style={styles.heroBody}>{content.welcome_message}</Text> : undefined}
        >
          {isTrainee && (
            <View style={styles.heroFooter}>
              <Ionicons name="hand-left-outline" size={14} color="rgba(255,255,255,0.9)" />
              <Text style={styles.heroFooterText}>
                {user?.name ? `You've got this, ${user.name.split(/\s+/)[0]}.` : "You've got this."}
              </Text>
            </View>
          )}
        </EditorialHero>

        {/* ── Your journey ── */}
        <SectionHead size={26} style={styles.sectionHead}>Your journey</SectionHead>
        <DepthCard style={styles.card} sheen>
          {!!content?.week_one_note && (
            <View style={styles.noteRow}>
              <Ionicons name="information-circle-outline" size={16} color={colors.primary} />
              <Text style={styles.noteText}>{content.week_one_note}</Text>
            </View>
          )}
          {journeyPhases.map((phase, idx) => {
            const state = phaseState(phase.key);
            const last = idx === journeyPhases.length - 1;
            // The rail is lit from the start up to the current phase: the
            // segment leaving a done node glows, everything after stays dark.
            const lit = state === 'done';
            return (
              <View key={phase.key} style={styles.phaseRow}>
                {/* timeline rail */}
                <View style={styles.railCol}>
                  <JourneyNode
                    state={state}
                    icon={phase.icon}
                    live={phase.key === liveKey}
                    tint={reference ? spectrumTint(idx, journeyPhases.length) : undefined}
                  />
                  {!last && (
                    reference ? (
                      // No live progress (admin / leader reading the office's
                      // reference copy): the ladder is lit end to end at half
                      // strength — a map of the journey, not a stalled one.
                      <LinearGradient
                        colors={GRADIENT_XP}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 0, y: 1 }}
                        style={[styles.railLine, styles.railLineRef]}
                      />
                    ) : lit ? (
                      <LinearGradient
                        colors={GRADIENT_XP}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 0, y: 1 }}
                        style={[styles.railLine, { boxShadow: `0 0 8px ${colors.glow}` }]}
                      />
                    ) : phase.key === liveKey ? (
                      // The ONE node you are on (same node the coin animates and
                      // the ribbon marks): the rail is lit for its first stretch
                      // and dark beyond — the trail is still being built. Gated
                      // on liveKey, not on `active`: a day-1 sales-path starter
                      // has orientation AND the ramp active, and a second lit
                      // stub under a dead grey segment reads as a glitch.
                      <View style={[styles.railLine, styles.railLineDark]}>
                        <LinearGradient
                          colors={GRADIENT_XP}
                          start={{ x: 0, y: 0 }}
                          end={{ x: 0, y: 1 }}
                          style={[styles.railLit, { boxShadow: `0 0 8px ${colors.glow}` }]}
                        />
                      </View>
                    ) : (
                      <View style={[styles.railLine, styles.railLineDark]} />
                    )
                  )}
                </View>
                <View style={[styles.phaseBody, !last && { paddingBottom: 18 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Text style={[styles.phaseTitle, state === 'active' && { color: colors.primary }]}>
                      {phase.title}
                    </Text>
                    {/* ONE node, ONE ribbon, ONE lit stub: gated on liveKey,
                        exactly like the rail above. A day-1 sales-path starter
                        has orientation AND the ramp 'active', and a rep cannot
                        be in two places on their own journey (R2 review). */}
                    {phase.key === liveKey && isTrainee && (
                      <RankRibbon tint="purple" size="sm">YOU ARE HERE</RankRibbon>
                    )}
                  </View>
                  <Text style={styles.phaseText}>
                    {phase.key === 'ramp'
                      ? (salesPathFallbackQ.data?.content?.journey_ramp_body || phase.body)
                      : phase.body}
                  </Text>
                  {phase.key === 'field' && isTrainee && (
                    <>
                      <Text style={styles.phaseProgress}>
                        {passedOff} of {stage1Total} days passed off
                      </Text>
                      <XPBar
                        value={stage1Total > 0 ? passedOff / stage1Total : 0}
                        height={8}
                        tip={false}
                        glow={false}
                        style={styles.phaseBar}
                      />
                    </>
                  )}
                </View>
              </View>
            );
          })}
        </DepthCard>

        {/* ── The Cycle of Development ── */}
        <SectionHead size={22} style={styles.sectionHead}>The Cycle of Development</SectionHead>
        {!!codVideosQ.data?.intro && (
          <View style={{ marginHorizontal: -12, marginBottom: 4 }}>
            <StageVideo url={codVideosQ.data.intro} title="Cycle of Development — Introduction" />
          </View>
        )}
        {/* The one INK block on the page: the COD explainer used to be the
            middle white slab of three, twelve lines of body copy on paper.
            Same words, now printed on the dark block with the proof ladder
            lifted onto glass chips strung on a lit GRADIENT_XP rail. */}
        <DepthCard variant="ink" style={styles.card} sheen>
          <View style={styles.noteRow}>
            <Ionicons name="sync-outline" size={16} color={colors.primaryLight} />
            <Text style={[styles.noteText, styles.noteTextInk]}>
              The COD is the one system behind every advancement here — five stages from Foundation to
              Team Builder, each built on the same 4 Pillars. Every capability climbs the proof
              ladder:
            </Text>
          </View>
          {/* Proof ladder: the chips and the "→" between them are the exact
              characters that ran inside the sentence above. */}
          <View style={styles.ladder}>
            {PROOF_LADDER.map((rung, i) => (
              <React.Fragment key={rung}>
                {i > 0 && (
                  <View style={styles.ladderLink}>
                    <LinearGradient
                      colors={GRADIENT_XP}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={styles.ladderLinkBar}
                    />
                    <Text style={styles.ladderArrow}>→</Text>
                  </View>
                )}
                <View style={[styles.ladderChip, ladderChip]}>
                  <Text style={[styles.ladderChipText, { color: onGlass }]}>{rung}</Text>
                </View>
              </React.Fragment>
            ))}
          </View>
          <Text style={[styles.noteText, styles.noteTextInk, styles.ladderTail]}>
            You move up by showing evidence — your coach reviews weekly, signs off each rung with a
            date, and ticks off "what good looks like" as you hit it. Never time served, never
            favourites: proof.
          </Text>
          <TouchableOpacity style={[styles.linkRow, styles.linkRowInk]} onPress={() => router.push('/cod-intro')} testID="onboarding-cod-link">
            {/* Gradient keycap: a paper one disappears on the white card face. */}
            <Keycap size={38} radius={11} tone="gradient">
              <Ionicons name="trending-up-outline" size={18} color="#ffffff" />
            </Keycap>
            <View style={{ flex: 1 }}>
              <Text style={[styles.linkTitle, { color: colors.inkText }]}>How the COD works</Text>
              <Text style={[styles.linkSub, { color: colors.inkMuted }]}>Proof ladder · the 4 Pillars · the stage map</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.inkMuted} />
          </TouchableOpacity>
        </DepthCard>

        {/* ── How pay works ── */}
        <SectionHead size={22} style={styles.sectionHead}>{content?.pay_title || 'How pay works'}</SectionHead>
        {/* Money card: the figures are set in the display face (17px
            Unbounded Black, brand purple) so the card leads with what it is
            about, and the two rows ride raised Keycaps instead of 16px line
            icons. Gradient rim marks it out from the paper cards around it.
            Every character of the copy is unchanged — see money(). */}
        <DepthCard style={styles.card} edge="gradient" sheen>
          <View style={styles.payRow}>
            <Keycap size={38} radius={11} tone="green">
              <Ionicons name="cash-outline" size={18} color="#ffffff" />
            </Keycap>
            <Text style={styles.payText}>{money(content?.pay_notes, styles.money)}</Text>
          </View>
          {/* The pay rules themselves are the office's own copy (pay_notes,
              from the onboarding content) — no figures are hard-coded here. */}
          <TouchableOpacity style={styles.linkRow} onPress={() => router.push('/(tabs)/pay')} testID="onboarding-pay-link">
            <Keycap size={38} radius={11} tone="green">
              <Ionicons name="calculator-outline" size={18} color="#ffffff" />
            </Keycap>
            <View style={{ flex: 1 }}>
              <Text style={styles.linkTitle}>Open the Pay calculator</Text>
              <Text style={styles.linkSub}>See what a week in the field is worth</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </DepthCard>

        {/* ── People to know ── */}
        <SectionHead size={22} style={styles.sectionHead}>People to know</SectionHead>
        <DepthCard style={styles.card} sheen>
          {leader ? (
            <View style={styles.contactRow}>
              {/* The leader's hex wears the halo; office contacts don't — one
                  glow, so the row the new starter needs first leads the card. */}
              <HexFrame size={46} style={styles.contactHex}>
                <Text style={styles.contactAvatarText}>{leader.name?.charAt(0)?.toUpperCase() || '?'}</Text>
              </HexFrame>
              <View style={{ flex: 1 }}>
                <Text style={styles.contactName}>{leader.name}</Text>
                <Text style={styles.contactRole}>Your coach</Text>
              </View>
              {!!leader.phone && (
                <TouchableOpacity style={styles.contactAction} onPress={() => openPhone(leader.phone)}>
                  <Ionicons name="call-outline" size={18} color={colors.primary} />
                </TouchableOpacity>
              )}
              {!!leader.email && (
                <TouchableOpacity style={styles.contactAction} onPress={() => openEmail(leader.email)}>
                  <Ionicons name="mail-outline" size={18} color={colors.primary} />
                </TouchableOpacity>
              )}
            </View>
          ) : isTrainee ? (
            <View style={styles.noteRow}>
              <Ionicons name="person-outline" size={16} color={colors.textMuted} />
              <Text style={styles.noteText}>Your coach will be assigned before Day 3 — check back here for their contact details.</Text>
            </View>
          ) : null}
          {contacts.map((c, i) => (
            <View key={`${c.name}-${i}`} style={[styles.contactRow, (leader || i > 0) ? styles.contactRowBorder : null]}>
              <HexFrame size={46} glow={false} style={styles.contactHex}>
                <Text style={styles.contactAvatarText}>{c.name?.charAt(0)?.toUpperCase() || '?'}</Text>
              </HexFrame>
              <View style={{ flex: 1 }}>
                <Text style={styles.contactName}>{c.name}</Text>
                {!!c.role && <Text style={styles.contactRole}>{c.role}</Text>}
              </View>
              {!!c.phone && (
                <TouchableOpacity style={styles.contactAction} onPress={() => openPhone(c.phone)}>
                  <Ionicons name="call-outline" size={18} color={colors.primary} />
                </TouchableOpacity>
              )}
              {!!c.email && (
                <TouchableOpacity style={styles.contactAction} onPress={() => openEmail(c.email)}>
                  <Ionicons name="mail-outline" size={18} color={colors.primary} />
                </TouchableOpacity>
              )}
            </View>
          ))}
          {!leader && contacts.length === 0 && !isTrainee && (
            <View style={styles.noteRow}>
              <Ionicons name="people-outline" size={16} color={colors.textMuted} />
              <Text style={styles.noteText}>
                No office contacts yet.{canEdit ? ' Tap the pencil on the welcome card to add the people new starters should know.' : ''}
              </Text>
            </View>
          )}
        </DepthCard>

        {/* ── Learning tools ── */}
        <SectionHead size={22} style={styles.sectionHead}>Learning tools</SectionHead>
        <View style={styles.toolsGrid}>
          {tools.map((t, i) => (
            <PressableScale
              key={t.label}
              style={styles.toolCell}
              scaleTo={0.95}
              onPress={() => router.push(t.route as never)}
              testID={`onboarding-tool-${t.label}`}
            >
              <DepthCard style={styles.toolCard} index={i}>
                <Keycap size={40} radius={12} tone="gradient" style={styles.toolIcon}>
                  <Ionicons name={t.icon} size={20} color="#ffffff" />
                </Keycap>
                <Text style={styles.toolTitle} numberOfLines={1}>{t.label}</Text>
                <Text style={styles.toolSub} numberOfLines={2}>{t.sub}</Text>
              </DepthCard>
            </PressableScale>
          ))}
        </View>
      </ScrollView>

      {canEdit && (
        <OnboardingEditor
          visible={editorOpen}
          onClose={() => setEditorOpen(false)}
          content={content}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['onboarding'] })}
        />
      )}
    </>
  );
}

// ── Admin editor ──────────────────────────────────────────────────────────
function OnboardingEditor({
  visible, onClose, content, onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  content?: OnboardingContent;
  onSaved: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const [welcomeTitle, setWelcomeTitle] = useState('');
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [weekOneNote, setWeekOneNote] = useState('');
  const [contacts, setContacts] = useState<OnboardingContact[]>([]);

  // Re-seed the form each time the editor opens with the latest content.
  React.useEffect(() => {
    if (!visible) return;
    setWelcomeTitle(content?.welcome_title || '');
    setWelcomeMessage(content?.welcome_message || '');
    setPayNotes(content?.pay_notes || '');
    setWeekOneNote(content?.week_one_note || '');
    setContacts(content?.contacts || []);
  }, [visible, content]);

  const saveMut = useMutation({
    mutationFn: () =>
      apiService.saveOnboardingContent({
        welcome_title: welcomeTitle,
        welcome_message: welcomeMessage,
        pay_notes: payNotes,
        week_one_note: weekOneNote,
        contacts: contacts.filter((c) => c.name.trim()),
      }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e: any) => showAlert('Save failed', e?.response?.data?.detail || 'Please try again.'),
  });

  const setContact = (i: number, field: keyof OnboardingContact, val: string) => {
    setContacts((prev) => prev.map((c, idx) => (idx === i ? { ...c, [field]: val } : c)));
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.editorBackdrop}
      >
        <View style={[styles.editorSheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {/* House grab handle — the sheet stays opaque (colors.background). */}
          <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.sheetHandle} />
          <View style={styles.editorHeader}>
            <Text style={styles.editorTitle}>Edit onboarding</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
            <Text style={styles.fieldLabel}>Welcome title</Text>
            <TextInput style={styles.input} value={welcomeTitle} onChangeText={setWelcomeTitle} placeholder="Welcome to the team!" placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>Welcome message (a word from the company)</Text>
            <TextInput style={[styles.input, styles.inputMulti]} value={welcomeMessage} onChangeText={setWelcomeMessage} multiline placeholder="A few warm sentences from the office…" placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>First-weeks note</Text>
            <TextInput style={[styles.input, styles.inputMulti]} value={weekOneNote} onChangeText={setWeekOneNote} multiline placeholder="What happens in the first weeks…" placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>How pay works</Text>
            <TextInput style={[styles.input, styles.inputMulti]} value={payNotes} onChangeText={setPayNotes} multiline placeholder="Commission, incentives, pay day…" placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>Office contacts</Text>
            {contacts.map((c, i) => (
              <View key={i} style={styles.contactEditCard}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput style={[styles.input, { flex: 1, marginBottom: 8 }]} value={c.name} onChangeText={(v) => setContact(i, 'name', v)} placeholder="Name" placeholderTextColor={colors.textMuted} />
                  <TouchableOpacity
                    style={styles.contactRemove}
                    onPress={() => setContacts((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Ionicons name="trash-outline" size={17} color={colors.red} />
                  </TouchableOpacity>
                </View>
                <TextInput style={[styles.input, { marginBottom: 8 }]} value={c.role} onChangeText={(v) => setContact(i, 'role', v)} placeholder="Role (e.g. Office Admin)" placeholderTextColor={colors.textMuted} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput style={[styles.input, { flex: 1 }]} value={c.phone} onChangeText={(v) => setContact(i, 'phone', v)} placeholder="Phone (07123 456789)" keyboardType="phone-pad" placeholderTextColor={colors.textMuted} />
                  <TextInput style={[styles.input, { flex: 1.4 }]} value={c.email} onChangeText={(v) => setContact(i, 'email', v)} placeholder="Email" keyboardType="email-address" autoCapitalize="none" placeholderTextColor={colors.textMuted} />
                </View>
              </View>
            ))}
            <TouchableOpacity
              style={styles.addContactBtn}
              onPress={() => setContacts((prev) => [...prev, { name: '', role: '', phone: '', email: '' }])}
            >
              <Ionicons name="add" size={16} color={colors.primary} />
              <Text style={styles.addContactText}>Add contact</Text>
            </TouchableOpacity>
          </ScrollView>
          {/* The sheet's one CTA — same handler and testID, now the house glow button. */}
          <GlowButton
            onPress={() => saveMut.mutate()}
            disabled={saveMut.isPending}
            testID="onboarding-save"
            style={styles.saveBtn}
          >
            {saveMut.isPending
              ? <ActivityIndicator size="small" color="#fff" />
              : 'Save'}
          </GlowButton>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Theme-independent layout for the rail nodes (used by JourneyNode above).
const styles = StyleSheet.create({
  railNode: { width: NODE, height: NODE, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  railNodeUpcoming: { opacity: 0.55 },
});

const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  // Root container: the page colour comes from the mount-once PageField.
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Hero (EditorialHero owns the bleed, gradient, aurora, cube and radii)
  hero: { marginBottom: 22 },
  // Left-packed: chip then pencil, both clear of the cube's right-hand band.
  heroTopRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start',
    gap: 10, marginBottom: 14,
  },
  editBtn: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder,
    // Sits beside the office chip at the flat left end of the gradient — the
    // depth shadow is what makes it read as a raised control there.
    boxShadow: colors.depthShadow,
  },
  officeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
  },
  // Unbounded stays >= 11px (spec §2.4/§7 — it smears below that).
  officeChipText: { fontFamily: fonts.displayWide, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  // Unbounded-Black: never add fontWeight (faux-bold on web).
  heroTitle: { fontFamily: fonts.displayBlack, fontSize: 34, lineHeight: 38, letterSpacing: -1, color: '#fff' },
  heroBody: { color: 'rgba(255,255,255,0.92)', fontSize: 14.5, lineHeight: 22, marginTop: 10 },
  heroFooter: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 },
  heroFooterText: { color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: '600', fontStyle: 'italic' },

  sectionHead: { marginBottom: 12, marginLeft: 2 },
  // DepthCard paints the face, border and depth shadow.
  card: { borderRadius: 20, padding: 16, marginBottom: 22 },

  noteRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  noteText: { flex: 1, fontSize: 13.5, lineHeight: 20, color: colors.textSecondary },
  // Body copy on the ink block (8.6:1 on ink in both themes).
  noteTextInk: { color: colors.inkMuted },

  // Proof ladder — glass chips strung on a lit GRADIENT_XP rail. Wrapping is
  // the safety net: at 11.5px the five rungs fit one line at 390px, and if a
  // narrower device breaks the row each connector still carries its own lit
  // segment, so it reads as a ladder either way.
  ladder: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 8, marginBottom: 14 },
  ladderChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 5 },
  ladderChipText: { fontFamily: fonts.display, fontSize: 11.5, letterSpacing: -0.1 },
  // The rail between two rungs: a 2px lit wire with the sentence's own arrow on it.
  ladderLink: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  ladderLinkBar: { position: 'absolute', left: -1, right: -1, height: 2, borderRadius: 1 },
  ladderArrow: { fontSize: 11, lineHeight: 16, color: colors.inkText },
  ladderTail: { marginBottom: 14 },

  // Pay card — 38px Keycaps replace the 16px line icons, money set big.
  payRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginBottom: 14 },
  payText: { flex: 1, fontSize: 13.5, lineHeight: 22, color: colors.textSecondary },
  // Inline money: Unbounded Black never takes a fontWeight. No lineHeight —
  // the paragraph's fixed leading keeps every line on the same rhythm.
  money: { fontFamily: fonts.displayBlack, fontSize: 17, letterSpacing: -0.6, color: colors.primary },

  // Journey timeline
  phaseRow: { flexDirection: 'row' },
  railCol: { width: 34, alignItems: 'center' },
  railLine: { flex: 1, width: 3, borderRadius: 1.5, marginVertical: 3 },
  // Unlit segments: surfaceAlt reads on the card in BOTH themes (trackBg is darker than the dark card and vanished).
  railLineDark: { backgroundColor: colors.surfaceAlt },
  // Reference ladder (no live progress): lit end to end, at half strength so
  // it never claims the phases are done.
  railLineRef: { opacity: 0.5 },
  // The lit head of the segment leaving the phase in progress.
  railLit: { position: 'absolute', left: 0, right: 0, top: 0, height: '42%', borderRadius: 1.5 },
  phaseBody: { flex: 1, paddingLeft: 10 },
  phaseTitle: { fontFamily: fonts.display, fontSize: 16, lineHeight: 21, color: colors.text },
  phaseText: { fontSize: 13, lineHeight: 19, color: colors.textSecondary, marginTop: 3 },
  phaseProgress: { fontSize: 12, fontWeight: '700', color: colors.primary, marginTop: 5 },
  phaseBar: { marginTop: 8, marginRight: 8 },

  // Link rows
  linkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14,
  },
  linkTitle: { fontSize: 14.5, fontWeight: '700', color: colors.text },
  linkSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  // The same row on the ink block: a lit hairline instead of the paper border.
  linkRowInk: { borderTopColor: colors.glassBorder },

  // Contacts
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  contactRowBorder: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 8, paddingTop: 14 },
  // HexFrame owns the hexagon, the XP-gradient stroke and the halo; this is
  // placement only. The initial is plum/cream ink on the frame's surfaceAlt
  // fill (15:1 light, 12:1 dark) — the old per-person avatar hues measured
  // 2.6:1 there, so identity moved to the lit stroke.
  contactHex: { marginVertical: 2 },
  contactAvatarText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  contactName: { fontSize: 15, fontWeight: '700', color: colors.text },
  contactRole: { fontSize: 12.5, color: colors.textMuted, marginTop: 1 },
  contactAction: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
  },

  // Tools grid — each tile is a DepthCard (gradient Keycap icon) inside its pressable cell
  toolsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  toolCell: { flexBasis: '47%', flexGrow: 1, borderRadius: 20 },
  toolCard: { borderRadius: 20, padding: 14 },
  // Keycap owns the tile; this is placement only.
  toolIcon: { marginBottom: 10 },
  toolTitle: { fontFamily: fonts.display, fontSize: 14, color: colors.text },
  toolSub: { fontSize: 11.5, color: colors.textMuted, marginTop: 2, lineHeight: 15 },

  // Editor (a sheet — stays opaque)
  editorBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  editorSheet: {
    backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingTop: 14, maxHeight: '88%',
  },
  sheetHandle: { alignSelf: 'center', width: 46, height: 4, borderRadius: 2, marginBottom: 12 },
  editorHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  // fonts.display (Space Grotesk Bold) is the house face at <=18px — no fontWeight.
  editorTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.text },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginBottom: 6, marginTop: 12, letterSpacing: 0.3, textTransform: 'uppercase' },
  input: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text,
  },
  inputMulti: { minHeight: 88, textAlignVertical: 'top' },
  contactEditCard: {
    backgroundColor: colors.surface, borderRadius: 12, padding: 10, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  contactRemove: {
    width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.redBg,
  },
  addContactBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1.5, borderColor: colors.primary, borderStyle: 'dashed', borderRadius: 10,
    paddingVertical: 10, marginTop: 2,
  },
  addContactText: { color: colors.primary, fontSize: 13.5, fontWeight: '700' },
  saveBtn: { marginTop: 10 },
});
