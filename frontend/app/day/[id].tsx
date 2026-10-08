/**
 * Day detail — the trainee's view of one of their first 8 days.
 *
 * Answers three questions a new hire actually has:
 *   1. What will I learn today?  → the day's topics + "what good looks like"
 *   2. What's expected of me?    → day objective, confidence badges, targets
 *   3. How did I do?             → scores, grades, and the leader's Win/Focus
 *
 * Read-only by design (grading stays with the leader in /assessment/[id]).
 * Data comes entirely from existing endpoints: GET /assessment/{id},
 * GET /checklist/{id} (enriched with expected_outcome), GET /targets.
 *
 * Visual system ("Ink & Cube", spec §4 P1): this route is headerShown:false,
 * so it opts into the standalone <Masthead> (gradient Unbounded day label,
 * glass back chip, turning cube); the status pill moved into the results card
 * header so the gradient title never has to shrink. The mission is a full-bleed ink
 * EditorialHero with a Rubik cube behind the copy; scores are XP bars; "why it
 * matters" is an ink block. Loops: hero cube (1) + the GlowButton sheen (1) —
 * the score bars run tip/glow off, so they cost none.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColors, useTheme, buildGetStatusColor, fonts } from '../../src/theme/ThemeContext';
import { apiService, DeliveryChecklist } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { Stagger } from '../../src/components/ui/Reveal';
import { BrandLoader } from '../../src/components/ui/BrandLoader';
import { AnimatedNumber } from '../../src/components/ui/AnimatedNumber';
import { useParallaxScroll } from '../../src/components/ui/Parallax';
import { Masthead } from '../../src/components/nav/Masthead';
import { EditorialHero } from '../../src/components/ui/EditorialHero';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { XPBar } from '../../src/components/ui/XPBar';
import { SectionHead } from '../../src/components/ui/SectionHead';
import { GlowButton } from '../../src/components/ui/GlowButton';
import { DayTopicsList } from '../../src/components/assessment/DayGuideSheet';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';

/**
 * Traffic-light stops for the score numeral. Same semantics in both themes
 * (green ≥9 · amber ≥7 · red below) but the light stops are the darker twins:
 * the numeral is now 15.5px Space Grotesk Bold on a white DepthCard, where the
 * bright stops fail AA badly (#f59e0b 2.15:1, #ef4444 3.76:1). The darker
 * twins measure 5.48 / 5.02 / 6.47:1 on white; dark keeps the bright stops
 * (7.08 / 8.36 / 4.77:1 on the raised card).
 */
const SCORE_TONES = {
  light: { good: '#047857', mid: '#B45309', bad: '#B91C1C' },
  dark: { good: '#10b981', mid: '#f59e0b', bad: '#ef4444' },
} as const;
type ScoreTones = (typeof SCORE_TONES)[keyof typeof SCORE_TONES];

/**
 * The coaching labels ("TODAY'S WIN" / "FOCUS FOR TOMORROW") are 9.5px mono
 * uppercase on the results DepthCard, so they need the same light/dark twins
 * as the score numerals: `primaryDark` (#2f6a4b) on the dark #102D25 card
 * measured 2.74:1 and read as dimmed-out placeholder text. These measure
 * 8.6:1 (light, on white) and 8.9:1 (dark, on the raised card).
 */
const COACH_LABEL_TONE = { light: '#244c3b', dark: '#c5e37f' } as const;

/** One graded dimension as an XP bar: label + count-up numeral over the track. */
function ScoreBar({ label, value, colors, tones }: { label: string; value: number | null | undefined; colors: any; tones: ScoreTones }) {
  const pct = Math.max(0, Math.min(1, (value ?? 0) / 10));
  if (value === null || value === undefined) return null;
  const tone = value >= 9 ? tones.good : value >= 7 ? tones.mid : tones.bad;
  return (
    <XPBar
      value={pct}
      height={9}
      // List-row bar: no pulsing tip, no sweep — zero continuous loops.
      tip={false}
      glow={false}
      style={{ marginBottom: 12 }}
      label={
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <Text style={{ fontFamily: fonts.displayWide, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textSecondary }}>{label}</Text>
          <AnimatedNumber
            value={value}
            decimals={1}
            duration={900}
            style={{ fontFamily: fonts.display, fontSize: 15.5, letterSpacing: -0.3, color: tone }}
          />
        </View>
      }
    />
  );
}

export default function DayDetailScreen() {
  const colors = useColors();
  const { effective } = useTheme();
  const tones = effective === 'dark' ? SCORE_TONES.dark : SCORE_TONES.light;
  const coachTone = effective === 'dark' ? COACH_LABEL_TONE.dark : COACH_LABEL_TONE.light;
  const styles = useMemo(() => createStyles(colors), [colors]);
  const getStatusColor = useMemo(() => buildGetStatusColor(colors), [colors]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const isTrainee = (user?.role || '').toLowerCase() === 'trainee';
  const queryClient = useQueryClient();

  const { data: assessment, isLoading } = useQuery({
    queryKey: ['assessment', id],
    queryFn: () => apiService.getAssessment(id!).then((r) => r.data),
    enabled: !!id,
  });

  // "I've read my feedback" — trainee-owner acknowledgement of a graded day.
  // Gated to trainees: for leaders/admins the same endpoint is a real
  // pass-off, which this screen must never trigger.
  const ackMutation = useMutation({
    mutationFn: () => apiService.acknowledgeDailyAssessment(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assessment', id] });
      queryClient.invalidateQueries({ queryKey: ['trainee-progress'] });
    },
  });
  const { data: checklist } = useQuery<(DeliveryChecklist & { what_good_looks_like?: string | null; expected_outcome?: string | null })[]>({
    queryKey: ['checklist', id],
    queryFn: () => apiService.getChecklist(id!).then((r) => r.data),
    enabled: !!id,
  });
  const { data: targets } = useQuery({
    queryKey: ['targets'],
    queryFn: () => apiService.getTargets().then((r) => r.data),
  });
  const { scrollY, onScroll } = useParallaxScroll();
  const tabBarClearance = useTabBarClearance();

  if (isLoading || !assessment) {
    return (
      <SafeAreaView style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <BrandLoader size={60} label="Loading your day" />
      </SafeAreaView>
    );
  }

  const day = assessment.day_number;
  const isField = day >= 3;
  const dayLabel = isField ? `Field Day ${day - 2}` : `BA Academy Day ${day}`;
  const dayTarget = (targets || []).find((t: any) => t.day_number === day);
  const completed = !!assessment.completed;
  const statusColor = completed ? getStatusColor(assessment.status) : null;
  // Either the trainee's own ack or a leader pass-off counts as acknowledged.
  const acknowledged = !!((assessment as any).acknowledged || (assessment as any).passed_off);

  const kpiTargets: Array<[string, number | undefined]> = isField
    ? [
        // The owner's Field IQ names (introductions = Spoken, etc.).
        ['spoken', dayTarget?.target_introductions],
        ['presented', dayTarget?.target_presentations],
        ['sign-ups', dayTarget?.target_sales],
      ]
    : [];

  // Trainee-facing list: hide the coach-only "what to teach" so the trainee
  // sees outcomes, not the teaching script.
  const traineeItems = (checklist || []).map((c) => ({
    id: c.id,
    topic: c.topic,
    category: c.category,
    expected_outcome: c.expected_outcome || undefined,
    confidence_expected: c.confidence_expected || undefined,
    grade: completed ? c.grade : null,
  }));

  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right']}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Editorial header — this route hides the navigator header, so it opts
          into the standalone masthead (spec §3.2). */}
      <Masthead standalone title={dayLabel} onBack={() => router.back()} />

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: tabBarClearance + 24 }} onScroll={onScroll} scrollEventThrottle={16}>
        <Stagger>
        {/* Hero — the day's mission, as the ink block */}
        <EditorialHero
          variant="ink"
          scrollY={scrollY}
          /* The overlap exists so the opaque results DepthCard rides up over
             the block's rounded bottom — and that card only renders when the
             day is graded. On an UNGRADED day the next sibling is the bare
             "What you'll learn" SectionHead, whose gradient rule and glyph
             tops would sit INSIDE the ink (unreadable in light: the first
             titleGradient stop #0b211c on ink #102d25 is 1.02:1). */
          overlapNext={completed ? 18 : 0}
          cube={{ size: 104, opacity: 0.5, right: -32, top: -16 }}
          kicker={
            <View style={styles.heroKickerRow}>
              <Text style={styles.heroKicker}>TODAY'S MISSION</Text>
              <View style={styles.heroKickerChip}>
                <Text style={styles.heroKickerChipText}>{isField ? 'In-field training' : 'In-house training'}</Text>
              </View>
            </View>
          }
          title={
            <Text style={styles.heroObjective}>
              {dayTarget?.day_objective || (isField ? 'Build your field skills, one door at a time.' : 'Learn the foundations of the business.')}
            </Text>
          }
        >
          {kpiTargets.some(([, v]) => v) ? (
            <View style={styles.targetRow}>
              {kpiTargets.filter(([, v]) => v).map(([label, v]) => (
                <View key={label} style={styles.targetChip}>
                  <AnimatedNumber value={Number(v)} duration={900} style={styles.targetNum} />
                  <Text style={styles.targetLabel}>{label}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </EditorialHero>

        {/* Results (after grading) */}
        {completed && (
          <DepthCard style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="podium" size={16} color={colors.primary} />
              <Text style={styles.cardTitle}>How you did</Text>
              {statusColor && (
                <View style={[styles.statusPill, { backgroundColor: statusColor.bg }]}>
                  <Text style={[styles.statusPillText, { color: statusColor.text }]}>{assessment.status}</Text>
                </View>
              )}
              {assessment.overall_score != null && (
                <AnimatedNumber
                  value={assessment.overall_score}
                  decimals={1}
                  suffix="/10"
                  duration={900}
                  style={[styles.overall, { color: statusColor?.text || colors.text }]}
                />
              )}
            </View>
            <ScoreBar label="Behaviours" value={assessment.behaviour_score} colors={colors} tones={tones} />
            {day >= 2 && <ScoreBar label="Skills" value={assessment.skill_score} colors={colors} tones={tones} />}
            {day >= 3 && <ScoreBar label="KPIs" value={assessment.kpi_score} colors={colors} tones={tones} />}
            {(assessment.coaching_actions || assessment.focus_tomorrow) ? (
              <View style={styles.coachBox}>
                {assessment.coaching_actions ? (
                  <View style={styles.coachRow}>
                    <Text style={styles.coachEmoji}>🏆</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.coachLabel, { color: coachTone }]}>TODAY'S WIN</Text>
                      <Text style={styles.coachText}>{assessment.coaching_actions}</Text>
                    </View>
                  </View>
                ) : null}
                {assessment.focus_tomorrow ? (
                  <View style={styles.coachRow}>
                    <Text style={styles.coachEmoji}>🎯</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.coachLabel, { color: coachTone }]}>FOCUS FOR TOMORROW</Text>
                      <Text style={styles.coachText}>{assessment.focus_tomorrow}</Text>
                    </View>
                  </View>
                ) : null}
              </View>
            ) : null}
            {/* Close the loop: the trainee confirms they've read their feedback. */}
            {acknowledged ? (
              <View style={styles.ackPill}>
                <Ionicons name="checkmark-circle" size={14} color={colors.green} />
                <Text style={styles.ackPillText}>Feedback acknowledged</Text>
              </View>
            ) : isTrainee ? (
              <GlowButton
                style={styles.ackBtn}
                onPress={() => ackMutation.mutate()}
                disabled={ackMutation.isPending}
                testID="ack-feedback-btn"
              >
                <Ionicons name="checkmark-done" size={16} color="#fff" />
                <Text style={styles.ackBtnText}>
                  {ackMutation.isPending ? 'Saving…' : "I've read my feedback ✓"}
                </Text>
              </GlowButton>
            ) : null}
          </DepthCard>
        )}

        {/* What you'll learn */}
        <View style={completed ? undefined : styles.topicsBlockAfterHero}>
          <View style={styles.sectionHead}>
            <SectionHead style={{ flex: 1 }}>{completed ? 'What you covered' : "What you'll learn"}</SectionHead>
            <Text style={styles.sectionCount}>{traineeItems.length} topics</Text>
          </View>
          {traineeItems.length > 0 ? (
            <DayTopicsList items={traineeItems} mode="trainee" />
          ) : (
            <Text style={styles.emptyText}>Topics for this day will appear here.</Text>
          )}
        </View>

        {/* Why it matters */}
        {!completed && (
          <DepthCard variant="ink" style={styles.whyBox}>
            <View style={styles.whyRow}>
              <Ionicons name="sparkles" size={16} color={colors.primaryLight} />
              <Text style={styles.whyText}>
                Your coach grades this day at the end of it — green days build your track record
                towards Stage 2. Ask about anything on this list before the day ends.
              </Text>
            </View>
          </DepthCard>
        )}
        </Stagger>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  screen: { flex: 1 },
  statusPill: { paddingHorizontal: 9, paddingVertical: 3.5, borderRadius: 999 },
  // 10px: below the >=11px Unbounded floor (spec §2.4) — mono, like the other meta.
  statusPillText: { fontFamily: fonts.monoSemibold, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },

  // Ink hero content — text on ink uses inkText / inkMuted.
  heroKickerRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  heroKicker: { fontFamily: fonts.mono, fontSize: 11, color: colors.inkMuted, letterSpacing: 1.6 },
  heroKickerChip: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
  },
  heroKickerChipText: { fontFamily: fonts.mono, fontSize: 9.5, color: colors.inkText, letterSpacing: 1, textTransform: 'uppercase' },
  heroObjective: { fontFamily: fonts.display, fontSize: 20, color: colors.inkText, lineHeight: 27, paddingRight: 6 },
  targetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
  targetChip: {
    alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.20)',
  },
  targetNum: { fontFamily: fonts.displayBlack, fontSize: 20, letterSpacing: -0.8, color: colors.inkText },
  targetLabel: {
    fontFamily: fonts.mono, fontSize: 9.5, color: colors.inkMuted,
    textTransform: 'uppercase', letterSpacing: 1.2, marginTop: 3,
  },

  card: { borderRadius: 22, padding: 16, marginBottom: 18 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 14 },
  cardTitle: { flex: 1, fontFamily: fonts.display, fontSize: 16, color: colors.text },
  // 20px: the documented floor for Unbounded-Black display roles (spec 2.4).
  overall: { fontFamily: fonts.displayBlack, fontSize: 20, letterSpacing: -0.6 },
  coachBox: { marginTop: 8, gap: 12 },
  coachRow: { flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  coachEmoji: { fontSize: 16 },
  // Colour comes from COACH_LABEL_TONE per theme (see the const) — the token
  // `primaryDark` failed AA on the dark card.
  coachLabel: { fontFamily: fonts.monoSemibold, fontSize: 9.5, letterSpacing: 1.2 },
  coachText: { fontFamily: fonts.body, fontSize: 13.5, color: colors.text, lineHeight: 19.5, marginTop: 3 },
  ackBtn: { marginTop: 16, borderRadius: 14 },
  ackBtnText: { color: '#fff', fontFamily: fonts.bodyBold, fontSize: 14 },
  ackPill: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    alignSelf: 'flex-start', marginTop: 14, paddingHorizontal: 11, paddingVertical: 6,
    borderRadius: 999, backgroundColor: colors.greenBg,
  },
  // greenBg is a pale tint in light and a translucent wash in dark, so the
  // label rides on `text` (readable on both) with the tick carrying the green.
  ackPillText: { fontFamily: fonts.bodyBold, fontSize: 11.5, color: colors.text },

  sectionHead: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginBottom: 12 },
  // Ungraded day: the hero's overlap is off (no results card to ride it), so
  // the section head needs its own air under the ink block.
  topicsBlockAfterHero: { marginTop: 20 },
  sectionCount: { fontFamily: fonts.mono, fontSize: 11, color: colors.textSecondary, letterSpacing: 0.6, paddingBottom: 3 },
  emptyText: { fontFamily: fonts.body, fontSize: 13, color: colors.textSecondary },

  whyBox: { borderRadius: 20, padding: 16, marginTop: 18 },
  whyRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  whyText: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.inkText, lineHeight: 19, opacity: 0.92 },
});
