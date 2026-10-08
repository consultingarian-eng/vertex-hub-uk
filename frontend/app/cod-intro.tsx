/**
 * Cycle of Development — intro page (COD 2026).
 *
 * The "how this all works" front page from the Final Cycle of Development
 * document: the Proof Ladder (Know → Do → Deliver → Teach → Systemize),
 * the weekly rhythm, the 4 Pillars, and the stage map from Foundation to
 * Sector/Site Leader. Static content — the source of truth is the COD
 * document; update both together.
 *
 * Visual system ("Ink & Cube"): a full-bleed pop hero with a 130px Rubik
 * cube, gradient section heads, depth cards, hex-coin ladder rungs, keycap
 * pillar icons, ribbon stage tags and an ink footer block. Copy unchanged.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { StageVideo, useCodVideos } from '../src/components/cod/StageVideo';
import { sortByCodStage } from '../src/components/cod/stageOrder';
import { ScrollReveal } from '../src/components/ui/ScrollFx';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { EditorialHero } from '../src/components/ui/EditorialHero';
import { DepthCard } from '../src/components/ui/DepthCard';
import { SectionHead } from '../src/components/ui/SectionHead';
import { HexCoin } from '../src/components/ui/HexCoin';
import { Keycap } from '../src/components/ui/Keycap';
import { RankRibbon } from '../src/components/ui/RankRibbon';

const LADDER = [
  { key: 'K', name: 'Know', desc: 'Can explain it simply.' },
  { key: 'D', name: 'Do', desc: 'Can execute it effectively in the office.' },
  { key: 'D2', name: 'Deliver', desc: 'Hits the standard under pressure in the field.' },
  { key: 'T', name: 'Teach', desc: 'Can transfer it to others. Enters the ladder at Stage 3 — leading means teaching.' },
  { key: 'S', name: 'Systemize', desc: 'Follows proven systems to create independent examples of what good looks like. Enters at Stage 4 — builders make it run without them.' },
];

const RHYTHM = [
  'Choose the next stage and agree on the outcomes and proof required.',
  'Coach on the 4 Pillars.',
  'Review weekly: numbers, behaviour, evidence, decisions.',
  'Drive results that are specific, owned, and evidenced.',
  'Progress only happens when evidence is shown and standards are consistently met.',
  'Implement what good looks like (WGLL).',
];

const PILLARS = [
  {
    name: 'Commercial Craft', icon: 'briefcase' as const, color: '#0ea5e9',
    desc: 'The technical skills of the role. How you execute the sign-up process, engage supporters, handle questions, close confidently, and maintain quality under pressure. This is the foundation of performance.',
  },
  {
    name: 'Self Leadership', icon: 'person' as const, color: '#f59e0b',
    desc: "How you manage yourself. Your reliability, planning, resilience, emotional regulation, and ownership of your own results and development. No one can build this for you.",
  },
  {
    name: 'People Leadership', icon: 'people-circle' as const, color: '#10b981',
    desc: 'How you show up for and influence others. From following and enforcing standards as a BA, to coaching, developing, and holding a team accountable as a Leader.',
  },
  {
    name: 'Digital & Data', icon: 'stats-chart' as const, color: '#ef4444',
    desc: 'How you use numbers and systems. Accurate data submission, using KPIs to self-coach, tracking team performance, and making decisions driven by evidence — not feelings.',
  },
];

// Written in stored-stage order; rendered in COD display order (SL sits
// between Stage 3 and Stage 4 — see stageOrder.ts). `stage` is the STORED
// number, so SL stays 5.
const STAGES = sortByCodStage([
  { stage: 1, tag: 'STAGE 1', name: 'Foundation', sub: 'Build your core competencies' },
  { stage: 2, tag: 'STAGE 2', name: 'Self Management', sub: 'Operate like a professional' },
  { stage: 3, tag: 'STAGE 3', name: 'Leader', sub: 'Creating success in others' },
  { stage: 4, tag: 'STAGE 4', name: 'Team Builder', sub: 'Embedding systems, standards & creating independence' },
  { stage: 5, tag: 'STAGE SL', name: 'Sector/Site Leader', sub: 'Performance management — for leaders running sectors' },
], (s) => s.stage);

export default function CodIntroScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tabBarClearance = useTabBarClearance();
  const codVideosQ = useCodVideos();
  const { scrollY, onScroll } = useParallaxScroll();

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Cycle of Development' }} />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 + tabBarClearance }}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* Pop hero — the identity block. The cube is the one loop this
            screen adds (the pop variant's aurora rides inside the hero). */}
        <EditorialHero
          variant="pop"
          scrollY={scrollY}
          cube={{ size: 130 }}
          kicker="CYCLE OF DEVELOPMENT"
          title="How the COD works"
          titleSize={34}
          lede="The COD is the one system behind every advancement here: what you're building, what proof it takes, and what happens next. You progress by showing evidence — never by time served, and never by being liked."
          overlapNext={0}
        />

        {!!codVideosQ.data?.intro && (
          <View style={{ marginHorizontal: -12, marginBottom: 8, marginTop: 4 }}>
            <StageVideo url={codVideosQ.data.intro} title="Cycle of Development — Introduction" />
          </View>
        )}

        <SectionHead style={styles.sectionHead}>The Proof Ladder</SectionHead>
        <Text style={styles.sectionSub}>
          Every capability, at every stage, climbs the same five rungs. You haven't mastered something until you
          can teach it — and it isn't finished until it runs as a system without you.
        </Text>
        <ScrollReveal scrollY={scrollY}>
        <DepthCard style={styles.card}>
          {LADDER.map((r, i) => (
            <View key={r.key} style={[styles.ladderRow, i < LADDER.length - 1 && styles.rowDivider]}>
              <HexCoin size={38} tint="purple" animate={false}>{r.name[0]}</HexCoin>
              <View style={{ flex: 1 }}>
                <Text style={styles.ladderName}>{r.name}</Text>
                <Text style={styles.ladderDesc}>{r.desc}</Text>
              </View>
            </View>
          ))}
        </DepthCard>
        </ScrollReveal>

        <SectionHead style={styles.sectionHead}>The Weekly Rhythm</SectionHead>
        <ScrollReveal scrollY={scrollY}>
        <DepthCard style={styles.card}>
          {RHYTHM.map((r, i) => (
            <View key={i} style={[styles.rhythmRow, i < RHYTHM.length - 1 && styles.rowDivider]}>
              <Ionicons name="checkmark-circle" size={16} color={colors.primary} style={{ marginTop: 2 }} />
              <Text style={styles.rhythmText}>{r}</Text>
            </View>
          ))}
        </DepthCard>
        </ScrollReveal>

        <SectionHead style={styles.sectionHead}>The 4 Pillars</SectionHead>
        <Text style={styles.sectionSub}>Every stage develops the same four pillars — the level just keeps rising.</Text>
        {PILLARS.map((p) => (
          <ScrollReveal key={p.name} scrollY={scrollY}>
          <DepthCard style={styles.pillarCard}>
            <View pointerEvents="none" style={[styles.pillarAccent, { backgroundColor: p.color }]} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Keycap size={36} radius={11}>
                <Ionicons name={p.icon} size={18} color={p.color} />
              </Keycap>
              <Text style={styles.pillarName}>{p.name}</Text>
            </View>
            <Text style={styles.pillarDesc}>{p.desc}</Text>
          </DepthCard>
          </ScrollReveal>
        ))}

        <SectionHead style={styles.sectionHead}>The Stages</SectionHead>
        <ScrollReveal scrollY={scrollY}>
        <DepthCard style={styles.card}>
          {STAGES.map((s, i) => (
            <View key={s.tag} style={[styles.stageRow, i < STAGES.length - 1 && styles.rowDivider]}>
              <View style={styles.stageTagWrap}>
                <RankRibbon tint="purple" size="sm">{s.tag}</RankRibbon>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.stageName}>{s.name}</Text>
                <Text style={styles.stageSub}>{s.sub}</Text>
              </View>
            </View>
          ))}
        </DepthCard>
        </ScrollReveal>

        <ScrollReveal scrollY={scrollY}>
        <DepthCard variant="ink" style={styles.footerCard}>
          <Ionicons name="shield-checkmark" size={18} color={colors.inkText} />
          <Text style={styles.footerText}>
            Standards are non-negotiable at every stage: attendance, professionalism, honesty, data submission.
            Missed standards mean immediate coaching and a same-day retrain plan — repeated misses pause progression.
          </Text>
        </DepthCard>
        </ScrollReveal>
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  sectionHead: { marginTop: 24, marginBottom: 8 },
  sectionSub: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: colors.textMuted, marginBottom: 12 },
  card: { borderRadius: 20, paddingHorizontal: 14, marginBottom: 4 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  ladderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12 },
  ladderName: { fontFamily: fonts.display, fontSize: 15, color: colors.text },
  ladderDesc: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: colors.textSecondary, marginTop: 2 },
  rhythmRow: { flexDirection: 'row', gap: 10, paddingVertical: 10 },
  rhythmText: { flex: 1, fontFamily: fonts.body, fontSize: 13.5, lineHeight: 20, color: colors.text },
  pillarCard: { borderRadius: 18, padding: 14, paddingLeft: 18, marginBottom: 10 },
  pillarAccent: { position: 'absolute', left: 0, top: 14, bottom: 14, width: 4, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  pillarName: { fontFamily: fonts.display, fontSize: 15, color: colors.text },
  pillarDesc: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19.5, color: colors.textSecondary, marginTop: 8 },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  stageTagWrap: { width: 104, alignItems: 'flex-start' },
  stageName: { fontFamily: fonts.display, fontSize: 15, color: colors.text },
  stageSub: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18, color: colors.textMuted, marginTop: 1 },
  footerCard: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderRadius: 18, padding: 16, marginTop: 22 },
  footerText: { flex: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 19.5, color: colors.inkText },
});
