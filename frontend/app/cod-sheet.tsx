/**
 * COD Sheet — the printed sheet's tick-box grid, live.
 *
 * One screen per stage per person: every capability grouped by pillar with
 * the five proof-ladder boxes (K · D · D · T · S) exactly like the PDF's
 * front page. READ-ONLY by design — the mirror, not a second pen: all
 * ticking happens in the module page and the coach's check queue; this grid
 * renders the truth (green signed · amber in progress/awaiting check · grey
 * untouched).
 *
 * Open as:  /cod-sheet?stage=3            → your own sheet
 *           /cod-sheet?stage=2&user_id=…  → grading a delegate
 *
 * Visual system ("Ink & Cube", spec §4 P1): the sheet header is the ink
 * block — gradient Unbounded stage name, a turning Rubik cube cut off at the
 * right, the Deliver+ count as an XP bar — and each pillar is a white
 * DepthCard floating on the lavender field with the ladder boxes as real
 * keycaps. Loops: hero cube (1) + XP tip (1); everything else is static or
 * scroll-driven.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors, fonts, GRADIENT } from '../src/theme/ThemeContext';
import { apiService } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { ScrollReveal } from '../src/components/ui/ScrollFx';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { EditorialHero } from '../src/components/ui/EditorialHero';
import { DepthCard } from '../src/components/ui/DepthCard';
import { XPBar } from '../src/components/ui/XPBar';
import { Keycap } from '../src/components/ui/Keycap';

const STAGE_TITLE: Record<number, { name: string; sub: string }> = {
  1: { name: 'Stage 1 · Foundation', sub: 'Build Your Core Competencies' },
  2: { name: 'Stage 2 · Self Management', sub: 'Operate Like a Professional' },
  3: { name: 'Stage 3 · Leader', sub: 'Creating Success in Others' },
  4: { name: 'Stage 4 · Team Builder', sub: 'Embedding Systems & Creating Independence' },
  5: { name: 'Stage SL · Sector/Site Leader', sub: 'Performance Management' },
};
// The sheet's boxes. Second D is Deliver — same as the PDF. The ladder
// grows with the stage: 1-2 top out at Deliver, 3 adds Teach, 4/SL add
// Systemize.
const ALL_BOXES = [
  { rung: 1, letter: 'K', label: 'Know' },
  { rung: 2, letter: 'D', label: 'Do' },
  { rung: 3, letter: 'D', label: 'Deliver' },
  { rung: 4, letter: 'T', label: 'Teach' },
  { rung: 5, letter: 'S', label: 'Systemize' },
];
const boxesForStage = (stage: number) => ALL_BOXES.filter((b) => b.rung <= (stage <= 2 ? 3 : stage === 3 ? 4 : 5));
/** Ladder box size — the printed sheet's tick box, as a keycap. */
const BOX = 28;
/** The hero bleeds out to the screen edge past the scroll content's padding. */
const CONTENT_PAD = 14;

export default function CodSheetScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const tabBarClearance = useTabBarClearance();
  const { user } = useAuth();
  const { scrollY, onScroll } = useParallaxScroll();
  const params = useLocalSearchParams<{ stage?: string; user_id?: string; name?: string }>();
  const stage = Math.min(5, Math.max(1, parseInt(String(params.stage || '2'), 10) || 2)) as 1 | 2 | 3 | 4 | 5;
  const targetId = typeof params.user_id === 'string' && params.user_id ? params.user_id : undefined;

  const modulesQ = useQuery({
    queryKey: ['modules', stage],
    queryFn: () => apiService.listModules(stage).then((r) => r.data),
  });
  const progressQ = useQuery({
    queryKey: targetId ? ['trainee-module-progress', targetId, stage] : ['module-progress', stage],
    queryFn: () => targetId
      ? apiService.getTraineeModuleProgress(targetId, stage).then((r) => r.data.progress)
      : apiService.getMyModuleProgress(stage).then((r) => r.data.progress),
  });

  const modules = ((modulesQ.data?.modules || []) as any[]);
  const progressById: Record<string, any> = {};
  (progressQ.data || []).forEach((p: any) => { progressById[p.module_id] = p; });
  const ladderOf = (m: any) => progressById[m.id]?.ladder ?? 0;

  const byCategory: Record<string, any[]> = {};
  modules.forEach((m) => { (byCategory[m.category || 'Other'] = byCategory[m.category || 'Other'] || []).push(m); });

  const doneCount = modules.filter((m) => ladderOf(m) >= 3).length;

  // The sheet is the MIRROR, not a second pen: all ticking happens in the
  // module page / check queue; this grid just renders the truth. Red =
  // nothing yet · amber = ready for check · green boxes = signed rungs.

  if (modulesQ.isLoading || progressQ.isLoading) {
    return <View style={styles.loader}><BrandLoader size={56} /></View>;
  }

  const st = STAGE_TITLE[stage];
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'COD Sheet' }} />
      <ScrollView
        contentContainerStyle={{ padding: CONTENT_PAD, paddingBottom: 40 + tabBarClearance }}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* Sheet header — the ink block. Mirrors the PDF's BA / COACH / DATE strip. */}
        <EditorialHero
          variant="ink"
          scrollY={scrollY}
          bleed={CONTENT_PAD}
          title={st.name}
          titleSize={28}
          lede={st.sub}
          cube={{ size: 116, opacity: 0.85, right: -30, top: -14 }}
        >
          <View style={styles.headMetaRow}>
            <Text style={styles.headMeta}>
              {targetId ? `BA: ${params.name || 'delegate'}` : `BA: ${user?.name || 'me'}`}
            </Text>
            {targetId ? <Text style={styles.headMeta}>Coach: {user?.name}</Text> : null}
            <Text style={styles.headMetaStrong}>{doneCount}/{modules.length} at Deliver+</Text>
          </View>
          <XPBar
            value={modules.length ? doneCount / modules.length : 0}
            height={10}
            style={styles.headBar}
          />
          {/* Legend */}
          <View style={styles.legendRow}>
            {boxesForStage(stage).map((b) => (
              <View key={b.rung} style={styles.legendItem}>
                <View style={styles.legendKey}><Text style={styles.legendLetter}>{b.letter}</Text></View>
                <Text style={styles.legendLabel}>{b.label}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.selfNote}>
            The sheet mirrors the ladder — pass the questions for Know, tap "Ready for check" on a module for
            the rest, and your coach's sign-off fills the boxes here. 🟢 signed · 🟡 in progress · ⚪ not started.
          </Text>
        </EditorialHero>

        {Object.keys(byCategory).map((cat, ci) => (
          <ScrollReveal key={cat} scrollY={scrollY} tilt={0}>
          {/* ScrollReveal owns the entrance, so no DepthCard `index` stagger here. */}
          <DepthCard style={styles.pillarCard} sheen={ci === 0}>
            <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.pillarRule} />
            <Text style={styles.pillarTitle}>{cat.toUpperCase()}</Text>
            {byCategory[cat].map((m, i) => {
              const ladder = ladderOf(m);
              return (
                <View key={m.id} style={[styles.row, i > 0 && styles.rowDivider]}>
                  <TouchableOpacity
                    style={{ flex: 1, paddingRight: 8, flexDirection: 'row', alignItems: 'center', gap: 7 }}
                    activeOpacity={0.7}
                    onPress={() => router.push(targetId ? `/module/${m.id}?trainee_id=${targetId}` : `/module/${m.id}`)}
                  >
                    <View style={[styles.rag,
                      ladder >= 3 ? styles.ragGreen : (ladder > 0 || progressById[m.id]?.ready_for_check) ? styles.ragAmber : styles.ragRed]} />
                    <Text style={[styles.topic, { flex: 1 }]} numberOfLines={2}>{m.topic}</Text>
                  </TouchableOpacity>
                  <View style={styles.boxRow}>
                    {boxesForStage(stage).map((b) => {
                      const on = ladder >= b.rung;
                      const pending = !on && b.rung === ladder + 1 && !!progressById[m.id]?.ready_for_check;
                      return (
                        <Keycap
                          key={b.rung}
                          size={BOX}
                          radius={8}
                          tone={on ? 'gradient' : 'paper'}
                          style={pending ? styles.boxPending : undefined}
                        >
                          {on
                            ? <Ionicons name="checkmark" size={13} color="#fff" />
                            : pending
                              ? <Ionicons name="hourglass-outline" size={12} color={colors.yellow} />
                              : <Text style={styles.boxLetter}>{b.letter}</Text>}
                        </Keycap>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </DepthCard>
          </ScrollReveal>
        ))}

        <Text style={styles.footNote}>
          Read-only by design — sign-offs happen on the module page and in the coach's check
          queue; this sheet mirrors them. Tap a topic for the full page.
        </Text>
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Ink-block header content (children of EditorialHero): text on ink uses
  // inkText/inkMuted; chips use fixed white alphas so they read in both themes.
  headMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 14 },
  headMeta: { fontFamily: fonts.mono, fontSize: 11.5, color: colors.inkMuted, letterSpacing: 0.2 },
  headMetaStrong: { fontFamily: fonts.monoSemibold, fontSize: 11.5, color: colors.inkText, letterSpacing: 0.2 },
  headBar: { marginTop: 12 },
  legendRow: { flexDirection: 'row', gap: 12, marginTop: 16, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendKey: {
    width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
  },
  legendLetter: { fontFamily: fonts.displayWide, fontSize: 11, color: colors.inkText },
  legendLabel: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.inkMuted, textTransform: 'uppercase', letterSpacing: 1 },
  selfNote: { fontFamily: fonts.body, fontSize: 12, lineHeight: 18, color: colors.inkMuted, marginTop: 16 },

  // Pillar cards float on the field (white face + layered plum shadow).
  pillarCard: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 14, marginTop: 14 },
  pillarRule: { width: 28, height: 3, borderRadius: 2, marginBottom: 8 },
  // `primary`, not `primaryDark`: in dark primaryDark (#2f6a4b) on the raised
  // card measured 2.87:1 — every pillar name failed AA. `primary` is 5.6:1 in
  // dark (#7fa032) and 6.55:1 in light (#2f6a4b on the white face).
  pillarTitle: { fontFamily: fonts.displayWide, fontSize: 11, letterSpacing: 1.4, color: colors.primary, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  topic: { fontFamily: fonts.bodyMedium, fontSize: 13.5, lineHeight: 18.5, color: colors.text },
  boxRow: { flexDirection: 'row', gap: 6 },
  boxPending: { borderRadius: 8, boxShadow: '0 0 0 1.5px ' + colors.yellow },
  rag: { width: 10, height: 10, borderRadius: 5 },
  ragGreen: { backgroundColor: colors.green, boxShadow: '0 0 8px ' + colors.green },
  ragAmber: { backgroundColor: colors.yellow, boxShadow: '0 0 8px ' + colors.yellow },
  ragRed: { backgroundColor: colors.borderDark },
  boxLetter: { fontFamily: fonts.displayWide, fontSize: 11, color: colors.textMuted },
  footNote: { fontFamily: fonts.body, fontSize: 11.5, lineHeight: 17, color: colors.textSecondary, marginTop: 20, textAlign: 'center' },
});
