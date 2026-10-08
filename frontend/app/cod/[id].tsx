/**
 * COD Reader — one impact from the Cycle of Development, two ways to read it:
 *
 *   LEARN — the note re-chunked into step-through cards (PK-lesson style:
 *           progress dots, Continue, Reveal transitions), ending in a
 *           3-question Quick Check (pass = 2/3 → confetti + hub tick).
 *           No quiz available (404) → a completion card instead; the
 *           reader never depends on the quiz backend being up.
 *   NOTES — the full content, typeset for teaching off: headings, lists,
 *           comfortable paragraphs, takeaways + source as labeled callouts.
 *
 * The last-used mode persists (AsyncStorage) so people who live in one
 * mode always land back in it.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiService } from '../../src/api/client';
import { useColors, useTheme } from '../../src/theme/ThemeContext';
import { fonts, GRADIENT } from '../../src/theme/brand';
import { haptics } from '../../src/utils/haptics';
import { Reveal } from '../../src/components/ui/Reveal';
import { Skeleton } from '../../src/components/ui/Skeleton';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { Masthead } from '../../src/components/nav/Masthead';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { SlidingSegments } from '../../src/components/ui/SlidingSegments';
import { GlowButton } from '../../src/components/ui/GlowButton';
import { VertexMark } from '../../src/components/ui/VertexMark';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { recordLearningActivity } from '../../src/gamification/streak';
import { Impact, ImpactQuiz, CATEGORY_LABEL, LOCAL_PASSED_KEY, stageMeta } from '../../src/components/cod/types';
import { parseNotes, chunkForLearn, readMinutes } from '../../src/components/cod/parseNotes';
import { NotesBlocks } from '../../src/components/cod/NotesBlocks';
import { QuickCheck } from '../../src/components/cod/QuickCheck';

const MODE_KEY = 'cg1.cod.readerMode';

/** Reading modes as a sliding-tile segment rail (labels unchanged). */
const MODE_SEGMENTS = [
  { key: 'learn', label: 'Learn' },
  { key: 'notes', label: 'Notes' },
];

type Mode = 'learn' | 'notes';

export default function CodReaderScreen() {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const tabBarClearance = useTabBarClearance();
  const params = useLocalSearchParams<{ id: string }>();
  const impactId = String(params.id || '');
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [impact, setImpact] = useState<Impact | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('learn');
  const [modeLoaded, setModeLoaded] = useState(false);
  // undefined = still fetching, null = unavailable (404 → hide the quiz)
  const [quiz, setQuiz] = useState<ImpactQuiz | null | undefined>(undefined);
  const [passed, setPassed] = useState(false);
  const [step, setStep] = useState(0);

  // ── Load the impact (list endpoint — there is no single-impact GET) ──────
  useEffect(() => {
    let alive = true;
    apiService.coachingImpacts()
      .then(({ data }) => {
        if (!alive) return;
        const found = (data?.impacts || []).find((it: Impact) => it.id === impactId) || null;
        setImpact(found);
      })
      .catch(() => { if (alive) setImpact(null); });
    return () => { alive = false; };
  }, [impactId]);

  // ── Last-used reading mode ───────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY)
      .then((v) => {
        if (v === 'learn' || v === 'notes') setMode(v);
        setModeLoaded(true);
      })
      .catch(() => setModeLoaded(true));
  }, []);
  const switchMode = useCallback((m: Mode) => {
    haptics.light();
    setMode(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
  }, []);

  // ── Prefetch the quiz while the user reads (contract: 404 = no quiz) ─────
  useEffect(() => {
    if (!impact) return;
    let alive = true;
    apiService.coachingImpactQuiz(impact.id)
      .then(({ data }) => {
        if (!alive) return;
        setQuiz(data?.quiz_id && Array.isArray(data?.questions) && data.questions.length ? data : null);
      })
      .catch(() => { if (alive) setQuiz(null); });
    return () => { alive = false; };
  }, [impact?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Local passed tick (server quiz-state backs the hub; this is the
  //    in-session + offline-fallback mirror) ────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(LOCAL_PASSED_KEY)
      .then((raw) => {
        try {
          const arr: string[] = raw ? JSON.parse(raw) : [];
          if (arr.includes(impactId)) setPassed(true);
        } catch {}
      })
      .catch(() => {});
  }, [impactId]);

  const markPassed = useCallback(() => {
    setPassed(true);
    AsyncStorage.getItem(LOCAL_PASSED_KEY)
      .then((raw) => {
        let arr: string[] = [];
        try { arr = raw ? JSON.parse(raw) : []; } catch {}
        if (!arr.includes(impactId)) arr.push(impactId);
        return AsyncStorage.setItem(LOCAL_PASSED_KEY, JSON.stringify(arr));
      })
      .catch(() => {});
    recordLearningActivity().catch(() => {});
  }, [impactId]);

  // ── Parse once ───────────────────────────────────────────────────────────
  const blocks = useMemo(() => parseNotes(impact?.body || ''), [impact?.body]);
  const chunks = useMemo(() => chunkForLearn(blocks), [blocks]);
  const meta = stageMeta(impact?.stage || 1);
  const takeaways = impact?.key_takeaways || [];
  const hasTakeaways = takeaways.length > 0;

  // Learn steps: intro → chunks → takeaways recap → quick check / done
  const totalSteps = 1 + chunks.length + (hasTakeaways ? 1 : 0) + 1;
  const finalStep = totalSteps - 1;
  const takeawayStep = hasTakeaways ? finalStep - 1 : -1;
  const isFinal = step === finalStep;

  const goNext = () => { haptics.light(); setStep((s) => Math.min(finalStep, s + 1)); };
  const goBack = () => { haptics.light(); setStep((s) => Math.max(0, s - 1)); };

  // ── Frame states ─────────────────────────────────────────────────────────
  if (impact === undefined || !modeLoaded) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={{ padding: 16, gap: 12 }}>
          <Skeleton width={140} height={12} />
          <Skeleton width={'80%' as const} height={24} />
          <Skeleton width={'100%' as const} height={44} borderRadius={12} />
          <Skeleton width={'100%' as const} height={220} borderRadius={20} />
        </View>
      </SafeAreaView>
    );
  }
  if (!impact) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
        <Stack.Screen options={{ headerShown: false }} />
        <EmptyState
          icon="compass-outline"
          title="Not in the cycle"
          subtitle="This note may have been removed or isn’t visible to your role."
          actionLabel="Back to the hub"
          onAction={() => router.back()}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header — identity (editorial masthead: this route hides the
          navigator header, so it opts into the standalone one, spec §3.2) */}
      <Masthead standalone title={impact.title} onBack={() => router.back()} />

      {/* Meta strip — the cycle, the NOTE'S NAME, the stage, the read length.
          The title is printed here because the masthead renders it with
          numberOfLines={1} and `adjustsFontSizeToFit` is a no-op on
          react-native-web: long titles ellipsise up there ("Customer
          Service — Do…"), and outside Learn step 0 nothing else on the
          screen carries the name. numberOfLines={2} wraps, never clips. */}
      <View style={styles.header}>
        <Text style={styles.eyebrow}>COD — CYCLE OF DEVELOPMENT</Text>
        <Text style={styles.title} numberOfLines={2}>{impact.title}</Text>
        <View style={styles.metaRow}>
          <View style={[styles.stageChip, { borderColor: `${meta.color}66`, backgroundColor: `${meta.color}14` }]}>
            <View style={[styles.stageDot, { backgroundColor: meta.color }]} />
            <Text style={[styles.stageChipText, { color: meta.color }]}>{meta.label}</Text>
          </View>
          <Text style={styles.metaText}>{CATEGORY_LABEL[impact.category] || impact.category}</Text>
          <Text style={styles.metaText}>· ~{readMinutes(impact)} min</Text>
          {passed && (
            <View style={styles.passedChip}>
              <Ionicons name="checkmark-circle" size={12} color={colors.green} />
              <Text style={styles.passedChipText}>Passed</Text>
            </View>
          )}
        </View>
      </View>

      {/* Learn | Notes toggle — ink rail with one sliding tile (spec §3.13) */}
      <SlidingSegments
        style={styles.segWrap}
        value={mode}
        onChange={(k) => switchMode(k as Mode)}
        items={MODE_SEGMENTS}
      />

      {mode === 'notes' ? (
        // ─────────────────────────── NOTES ───────────────────────────────
        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 + tabBarClearance }}>
          <Reveal index={0}>
            {impact.summary ? <Text style={styles.lead}>{impact.summary}</Text> : null}
          </Reveal>

          {hasTakeaways && (
            <Reveal index={1}>
              {/* The takeaways are the printed block — ink, inkText children. */}
              <DepthCard variant="ink" style={styles.callout}>
                <Text style={styles.calloutLabel}>KEY TAKEAWAYS</Text>
                <View style={{ gap: 10 }}>
                  {takeaways.map((kt, i) => (
                    <View key={i} style={styles.takeawayRow}>
                      <View style={styles.takeawayDotInk} />
                      <Text style={styles.takeawayTextInk}>{kt}</Text>
                    </View>
                  ))}
                </View>
              </DepthCard>
            </Reveal>
          )}

          <Reveal index={2}>
            <View>
              {blocks.length > 0 && <Text style={styles.notesLabel}>FULL NOTES</Text>}
              <NotesBlocks blocks={blocks} accent={meta.color} />
            </View>
          </Reveal>

          {impact.source ? (
            <View style={styles.sourceRow}>
              <Ionicons name="book-outline" size={13} color={colors.textMuted} />
              <Text style={styles.sourceText}>Source · {impact.source}</Text>
            </View>
          ) : null}

          {!passed && (
            <GlowButton onPress={() => { switchMode('learn'); }} style={styles.learnCta}>
              <Ionicons name="school" size={18} color={colors.textLight} />
              <View style={{ flex: 1 }}>
                <Text style={styles.learnCtaTitle}>Take it in Learn mode</Text>
                <Text style={styles.learnCtaSub}>Step through the cards, then pass the quick check.</Text>
              </View>
              <Ionicons name="arrow-forward" size={18} color={colors.textLight} />
            </GlowButton>
          )}
        </ScrollView>
      ) : (
        // ─────────────────────────── LEARN ───────────────────────────────
        <View style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
            {/* Progress — dots up to 12 steps, thin bar beyond */}
            {totalSteps <= 12 ? (
              <View style={styles.dotRow}>
                {Array.from({ length: totalSteps }).map((_, i) => (
                  i <= step
                    ? <LinearGradient
                        key={i}
                        colors={GRADIENT}
                        start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                        style={[styles.dot, i === step && styles.dotActive]}
                      />
                    : <View key={i} style={styles.dot} />
                ))}
              </View>
            ) : (
              <View style={styles.progressBar}>
                <LinearGradient
                  colors={GRADIENT}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={[styles.progressFill, { width: `${((step + 1) / totalSteps) * 100}%` }]}
                />
              </View>
            )}

            {step === 0 && (
              <Reveal key="intro" index={0}>
                <DepthCard style={styles.learnCard} sheen>
                  <View pointerEvents="none" style={styles.introCube}>
                    <VertexMark
                      size={64}
                      color={isDark ? colors.primaryLight : colors.primary}
                      opacity={isDark ? 0.55 : 0.45}
                    />
                  </View>
                  <Text style={[styles.cardKicker, styles.introKicker, { color: meta.color }]}>{meta.label.toUpperCase()}</Text>
                  {/* The cube lives in this card's top-right corner: keep the
                      title clear of it so nothing reads as overlapped. */}
                  <Text style={[styles.cardTitle, styles.introTitle]}>{impact.title}</Text>
                  {impact.summary ? <Text style={styles.cardLead}>{impact.summary}</Text> : null}
                  <View style={styles.introMetaRow}>
                    <View style={styles.introMetaChip}>
                      <Ionicons name="albums-outline" size={12} color={colors.textMuted} />
                      <Text style={styles.introMetaText}>{Math.max(1, totalSteps - 2)} cards</Text>
                    </View>
                    <View style={styles.introMetaChip}>
                      <Ionicons name="time-outline" size={12} color={colors.textMuted} />
                      <Text style={styles.introMetaText}>~{readMinutes(impact)} min</Text>
                    </View>
                    {quiz !== null && (
                      <View style={styles.introMetaChip}>
                        <Ionicons name="help-circle-outline" size={12} color={colors.textMuted} />
                        <Text style={styles.introMetaText}>quick check</Text>
                      </View>
                    )}
                  </View>
                </DepthCard>
              </Reveal>
            )}

            {step > 0 && step <= chunks.length && (
              <Reveal key={`chunk-${step}`} index={0}>
                <DepthCard style={styles.learnCard}>
                  {chunks[step - 1].heading ? (
                    <>
                      <Text style={[styles.cardKicker, { color: meta.color }]}>PART {step} / {chunks.length}</Text>
                      <Text style={styles.cardTitle}>{chunks[step - 1].heading}</Text>
                    </>
                  ) : (
                    <Text style={[styles.cardKicker, { color: meta.color }]}>PART {step} / {chunks.length}</Text>
                  )}
                  <View style={{ marginTop: 12 }}>
                    <NotesBlocks blocks={chunks[step - 1].blocks} accent={meta.color} />
                  </View>
                </DepthCard>
              </Reveal>
            )}

            {step === takeawayStep && hasTakeaways && (
              <Reveal key="takeaways" index={0}>
                <DepthCard style={styles.learnCard}>
                  <Text style={[styles.cardKicker, { color: meta.color }]}>LOCK IT IN</Text>
                  <Text style={styles.cardTitle}>Key takeaways</Text>
                  <View style={{ gap: 12, marginTop: 14 }}>
                    {takeaways.map((kt, i) => (
                      <View key={i} style={styles.takeawayRow}>
                        <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.takeawayBadge}>
                          <Text style={styles.takeawayBadgeText}>{i + 1}</Text>
                        </LinearGradient>
                        <Text style={[styles.takeawayText, { fontSize: 14.5, lineHeight: 21 }]}>{kt}</Text>
                      </View>
                    ))}
                  </View>
                </DepthCard>
              </Reveal>
            )}

            {isFinal && (
              quiz === undefined ? (
                <DepthCard style={[styles.learnCard, { gap: 12 }]}>
                  <Text style={[styles.cardKicker, { color: meta.color }]}>QUICK CHECK</Text>
                  <Skeleton width={'70%' as const} height={18} />
                  <Skeleton width={'100%' as const} height={44} borderRadius={12} />
                  <Skeleton width={'100%' as const} height={44} borderRadius={12} />
                  <Text style={styles.quizWaitText}>Preparing your quick check…</Text>
                </DepthCard>
              ) : quiz === null ? (
                <Reveal key="done" index={0}>
                  <DepthCard style={[styles.learnCard, { alignItems: 'center', paddingVertical: 32 }]}>
                    <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.doneBadge}>
                      <Ionicons name="checkmark" size={34} color={colors.textLight} />
                    </LinearGradient>
                    <Text style={[styles.cardTitle, { textAlign: 'center', marginTop: 16 }]}>That’s the full note</Text>
                    <Text style={[styles.cardLead, { textAlign: 'center' }]}>
                      You’ve been through all of “{impact.title}”. Teach off it, or keep moving through the cycle.
                    </Text>
                    <GlowButton onPress={() => router.back()} style={styles.doneBtn}>
                      <Text style={styles.doneBtnText}>Back to the hub</Text>
                    </GlowButton>
                  </DepthCard>
                </Reveal>
              ) : (
                <Reveal key="quiz" index={0}>
                  <QuickCheck
                    impactId={impact.id}
                    quiz={quiz}
                    accent={meta.color}
                    onPassed={markPassed}
                    onDone={() => router.back()}
                    onReadNotes={() => switchMode('notes')}
                  />
                </Reveal>
              )
            )}
          </ScrollView>

          {/* Bottom nav */}
          <View style={[styles.nav, { paddingBottom: 8 + tabBarClearance }]}>
            <TouchableOpacity
              onPress={goBack}
              disabled={step === 0}
              style={[styles.navBtn, step === 0 && { opacity: 0.4 }]}
            >
              <Ionicons name="chevron-back" size={18} color={colors.text} />
              <Text style={styles.navBtnText}>Back</Text>
            </TouchableOpacity>
            {!isFinal ? (
              <GlowButton onPress={goNext} style={styles.navBtnGradient}>
                <Text style={styles.navBtnPrimaryText}>
                  {step === finalStep - 1 ? (quiz === null ? 'Finish' : 'Quick check') : 'Continue'}
                </Text>
                <Ionicons name="chevron-forward" size={18} color={colors.textLight} />
              </GlowButton>
            ) : (
              <View style={{ flex: 1 }} />
            )}
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  screen: { flex: 1 },
  // Meta strip under the masthead — no fill, the page field shows through.
  header: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 12 },
  eyebrow: { fontFamily: fonts.mono, fontSize: 9.5, color: colors.textSecondary, letterSpacing: 1.8 },
  // The note's name, in full (wraps). Unbounded-Black — never stack fontWeight.
  title: {
    fontFamily: fonts.displayBlack, fontSize: 20, lineHeight: 26,
    letterSpacing: -0.5, color: colors.text, marginTop: 5,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7, marginTop: 9 },
  stageChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  stageDot: { width: 6, height: 6, borderRadius: 3 },
  stageChipText: { fontFamily: fonts.displayWide, fontSize: 11, letterSpacing: 0.6 },
  metaText: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.textSecondary },
  passedChip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.greenBg },
  passedChipText: { fontFamily: fonts.bodyBold, fontSize: 10.5, color: colors.text },

  segWrap: { marginHorizontal: 16, marginBottom: 12 },

  // Notes mode
  lead: { fontFamily: fonts.bodyMedium, fontSize: 16.5, lineHeight: 26, color: colors.text, marginBottom: 18 },
  callout: { borderRadius: 20, padding: 18, marginBottom: 20 },
  calloutLabel: { fontFamily: fonts.displayWide, fontSize: 11, letterSpacing: 1.5, color: colors.inkMuted, marginBottom: 12 },
  takeawayRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  takeawayDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7.5 },
  takeawayDotInk: { width: 6, height: 6, borderRadius: 3, marginTop: 7.5, backgroundColor: colors.inkMuted },
  takeawayText: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 14, lineHeight: 20.5, color: colors.text },
  takeawayTextInk: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 14, lineHeight: 20.5, color: colors.inkText },
  takeawayBadge: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  takeawayBadgeText: { fontFamily: fonts.displayWide, fontSize: 12, color: colors.textLight },
  notesLabel: { fontFamily: fonts.displayWide, fontSize: 11, color: colors.textSecondary, letterSpacing: 1.5, marginBottom: 10 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border },
  sourceText: { fontFamily: fonts.mono, fontSize: 11, color: colors.textSecondary },
  learnCta: { marginTop: 22, borderRadius: 18, paddingVertical: 16, gap: 12 },
  learnCtaTitle: { fontFamily: fonts.display, fontSize: 15, color: colors.textLight },
  learnCtaSub: { fontFamily: fonts.body, fontSize: 12, color: colors.textLight, opacity: 0.9, marginTop: 2 },

  // Learn mode
  dotRow: { flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center', marginBottom: 18 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.trackBg },
  dotActive: { width: 24, borderRadius: 4 },
  progressBar: { height: 6, borderRadius: 3, backgroundColor: colors.trackBg, overflow: 'hidden', marginBottom: 16 },
  progressFill: { height: '100%' },
  learnCard: { borderRadius: 24, padding: 20, overflow: 'hidden' },
  // learnCard clips (DepthCard needs `overflow:'hidden'` for its radius/sheen),
  // so the cube sits fully INSIDE the box: at right/top -26/-22 the clip ate
  // the whole silhouette and left a flat 3x3 grid with razor edges.
  introCube: { position: 'absolute', right: 10, top: 10 },
  introKicker: { paddingRight: 72 },
  introTitle: { paddingRight: 72 },
  cardKicker: { fontFamily: fonts.displayWide, fontSize: 11, letterSpacing: 1.5 },
  // Unbounded-Black — never stack fontWeight on displayBlack.
  cardTitle: { fontFamily: fonts.displayBlack, fontSize: 22, color: colors.text, lineHeight: 28, letterSpacing: -0.6, marginTop: 8 },
  cardLead: { fontFamily: fonts.body, fontSize: 14.5, lineHeight: 22, color: colors.textSecondary, marginTop: 12 },
  introMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 18 },
  introMetaChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
  },
  introMetaText: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.textSecondary },
  quizWaitText: { fontFamily: fonts.body, fontSize: 12, color: colors.textSecondary, textAlign: 'center', marginTop: 4 },
  doneBadge: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center' },
  doneBtn: { alignSelf: 'stretch', marginTop: 22, borderRadius: 16 },
  doneBtnText: { fontFamily: fonts.bodyBold, color: colors.textLight, fontSize: 15 },

  // Sticky footer — MUST stay opaque (spec §2.5).
  nav: {
    flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface,
  },
  navBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 12, paddingHorizontal: 15,
    borderRadius: 14, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
  },
  navBtnText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.text },
  navBtnGradient: { flex: 1, borderRadius: 14, paddingVertical: 13, minHeight: 48 },
  navBtnPrimaryText: { fontFamily: fonts.bodyBold, color: colors.textLight, fontSize: 14.5 },
});
