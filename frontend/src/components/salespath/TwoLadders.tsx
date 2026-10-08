/**
 * TwoLadders — the "Two ladders. One person." slide as a live card: the
 * development ladder (COD stages) and the sales ladder (proficiency levels)
 * side by side, each ending in a tappable NEXT UP box so there is always a
 * visible next thing — the next accolade to chase on the sales side, the
 * next thing to learn on the development side.
 *
 * Pure presentation: the screens assemble both columns and the next-up
 * actions from data they already fetch.
 *
 * Visual system ("Ink & Cube", spec §4 COD): an ink EditorialHero with a
 * nebula, each ladder drawn as a skill tree — smoked-glass chips beside a lit
 * GRADIENT_XP rail, the current step a 28px HexCoin with a pulsing halo (ONE
 * shared loop for both columns) next to the one bright chip in the column,
 * NEXT UP as DepthCards with a gradient rim. `scrollY` is the screen's
 * parallax feed (progress.tsx); callers that
 * don't scroll-wire pass nothing and get a static block. `bleed` = 16 for a
 * full-bleed block inside a 16px-padded ScrollView, 0 for an inset card.
 */
import React, { useCallback, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { useColors, useTheme, fonts } from '../../theme/ThemeContext';
import { GRADIENT, GRADIENT_TEXT, GRADIENT_XP } from '../../theme/brand';
import { useLoopPause } from '../../theme/motion';
import { SalesPathDoc, SalesPathMeta } from '../../api/client';
import { LEVEL_EMOJI, LEVEL_SHORT } from './SalesPathJourney';
import { EditorialHero } from '../ui/EditorialHero';
import { DepthCard } from '../ui/DepthCard';
import { HexCoin, type HexCoinTint } from '../ui/HexCoin';
import { GradientText } from '../ui/GradientText';
import { GREEN_WEEK_MIN } from '../../utils/weekBands';

export type LadderStep = {
  key: string;
  label: string;
  emoji?: string;
  state: 'done' | 'current' | 'upcoming' | 'locked';
  /** Coin metal for the node when this step is current (sales levels carry their own). */
  tint?: HexCoinTint;
};

export type NextUp = {
  title: string;
  sub?: string;
  onPress?: () => void;
};

type Props = {
  devSteps: LadderStep[];
  salesSteps: LadderStep[];
  devNext?: NextUp;
  salesNext?: NextUp;
  /** The screen's scroll offset (useParallaxScroll). Omit for a static block. */
  scrollY?: SharedValue<number>;
  /** Horizontal bleed past the parent's padding (16 = full-bleed in a 16px-padded scroll). Default 0. */
  bleed?: number;
};

/** Coin metal per sales level — shared with SalesPathPanel so one level is one colour everywhere. */
export const LEVEL_TINT: Record<number, HexCoinTint> = {
  1: 'green', 2: 'bronze', 3: 'silver', 4: 'gold', 5: 'purple', 6: 'purple',
};

/** The six sales levels as ladder steps — shared by every screen. */
export function salesStepsFrom(path: SalesPathDoc, meta: SalesPathMeta): LadderStep[] {
  const level = path.level || 1;
  return [1, 2, 3, 4, 5, 6].map((n) => ({
    key: `s${n}`,
    label: meta.level_names?.[n] || `Level ${n}`,
    emoji: LEVEL_EMOJI[n],
    state: n < level ? 'done' : n === level ? 'current' : 'upcoming',
    tint: LEVEL_TINT[n],
  }));
}

/** The next sales accolade — ramp target, pending sign-off, or next level. */
export function salesNextFrom(path: SalesPathDoc, meta: SalesPathMeta, onPress?: () => void): NextUp {
  const level = path.level || 1;
  const ramp = path.ramp;
  if (ramp && ramp.status === 'not_started') {
    return { title: `Green Week 🟢 — ${GREEN_WEEK_MIN}+ sign-ups in one week`, sub: 'Your ramp starts the week you do — sign-ups count from day one.', onPress };
  }
  if (ramp && ['on_track', 'behind', 'overdue'].includes(ramp.status || '')) {
    const live = (ramp.weekly || []).find((w) => !w.paused && !w.completed);
    return {
      title: `Green Week 🟢 — ${GREEN_WEEK_MIN}+ sign-ups in one week`,
      sub: live ? `This week: build to ${live.target} (${live.sales} so far).` : 'Finish your ramp — it lands whenever your Green Week does.',
      onPress,
    };
  }
  if (path.expert_ready_for_check) {
    return { title: 'Expert 🏅 — waiting on sign-off', sub: 'Your claim is with your coach.', onPress };
  }
  if (level === 4 && path.expert_data_eligible) {
    return { title: 'Expert 🏅 — your numbers qualify', sub: 'Ask for the sign-off from your Sales Path panel.', onPress };
  }
  if (level < 6) {
    const n = level + 1;
    return { title: `${meta.level_names?.[n] || `Level ${n}`} ${LEVEL_EMOJI[n]}`, sub: LEVEL_SHORT[n], onPress };
  }
  return { title: 'Top of the ladder 🐐', sub: 'Keep setting the standard.', onPress };
}

// ── Geometry ─────────────────────────────────────────────────────────────────
const ROW_H = 34;      // one ladder row (chip + node), fixed so the rail math is exact
const GUTTER = 26;     // the node/rail column left of the chips
const COIN = 28;       // current-step HexCoin
// The coin is 2 px WIDER than the gutter it is centred in, so without a gap it
// lands on the chip's rounded left border and the border reads as passing
// behind a sticker. Every chip is pushed the same 6 px clear of the gutter
// (5 px of air past the coin's right edge) — indenting only the current row
// would jog the one chip the eye tracks down the column.
const CHIP_GAP = 6;
const HALO_MS = 1600;

/**
 * Column accents. The block is ink in BOTH themes, so:
 *  • `ink`  — type sitting directly on the ink block (headings, current-step
 *             rim and label, unlit node rims) — same value in both themes
 *  • `paper`— type on the NEXT UP DepthCard, which DOES flip with the theme
 * (There used to be a `deep` tone for a near-solid white current chip; the
 * chip is bright glass now, so the current label rides `ink` like the rest.)
 */
type Accent = { ink: string; paper: string; glow: string; tint: HexCoinTint };

function Column({ icon, heading, steps, next, accent, halo }: {
  icon: any; heading: string; steps: LadderStep[]; next?: NextUp; accent: Accent; halo: SharedValue<number>;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Top-down so the summit sits on top — you climb toward the top of the card.
  const rows = useMemo(() => [...steps].reverse(), [steps]);
  const doneCount = steps.filter((s) => s.state === 'done').length;
  const hasCurrent = steps.some((s) => s.state === 'current');
  // The rail runs node-centre to node-centre; the lit part climbs from the
  // bottom through every done step up to the current node.
  const railLen = Math.max(0, (rows.length - 1) * ROW_H);
  // A new hire has doneCount 0, and `0 * ROW_H` drew NOTHING: the whole gutter
  // was a dead grey hairline with hollow dots for the exact user who lives on
  // this screen, while a leader's ladder read as a lit game board (round-2
  // review). The lit segment therefore has a floor of half a row, so the
  // current node always sits on a lit stub climbing out from under it.
  const litLen = Math.min(
    railLen,
    Math.max(ROW_H * 0.6, (hasCurrent ? doneCount : Math.max(0, doneCount - 1)) * ROW_H),
  );

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.55 * (1 - halo.value),
    transform: [{ scale: 1 + 0.75 * halo.value }],
  }));

  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={styles.colHead}>
        <Ionicons name={icon} size={13} color={accent.ink} />
        <Text style={[styles.colHeadText, { color: accent.ink }]}>{heading}</Text>
      </View>

      <View style={styles.tree}>
        {/* The rail + its lit segment sit behind the nodes in the gutter. The
            unlit part is the XP gradient at low alpha rather than flat grey,
            so even a ladder with nothing banked reads as a track that lights
            up rather than as a bullet list beside a hairline. */}
        <LinearGradient
          pointerEvents="none"
          colors={GRADIENT_XP}
          start={{ x: 0, y: 1 }} end={{ x: 0, y: 0 }}
          style={[styles.rail, { height: railLen }]}
        />
        {litLen > 0 && (
          <LinearGradient
            pointerEvents="none"
            colors={GRADIENT_XP}
            start={{ x: 0, y: 1 }} end={{ x: 0, y: 0 }}
            style={[styles.railLit, { height: litLen, bottom: ROW_H / 2, boxShadow: '0 0 8px ' + colors.glow }]}
          />
        )}
        {rows.map((s) => {
          const current = s.state === 'current';
          const done = s.state === 'done';
          const locked = s.state === 'locked';
          return (
            <View key={s.key} style={styles.row}>
              <View style={styles.node}>
                {current ? (
                  <>
                    <Animated.View style={[styles.halo, { backgroundColor: accent.glow }, haloStyle]} />
                    <HexCoin size={COIN} tint={s.tint || accent.tint} animate={false} glow>
                      {s.emoji ? <Text style={styles.coinEmoji}>{s.emoji}</Text> : null}
                    </HexCoin>
                  </>
                ) : done ? (
                  <LinearGradient colors={GRADIENT_XP} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.dotDone} />
                ) : (
                  <View
                    style={[
                      styles.dotUpcoming,
                      // Tinted with the column's own accent (a local literal,
                      // not a theme token) so an unbanked rung still belongs
                      // to its ladder instead of reading as generic grey.
                      { borderColor: accent.ink + (locked ? '40' : '80') },
                    ]}
                  />
                )}
              </View>
              <View
                style={[
                  styles.chip,
                  done && styles.chipDone,
                  locked && styles.chipLocked,
                  current && [styles.chipCurrent, { borderColor: accent.ink }],
                ]}
              >
                {s.emoji && !current ? <Text style={styles.stepEmoji}>{s.emoji}</Text> : null}
                <Text
                  style={[
                    styles.stepText,
                    done && styles.stepTextDone,
                    current && { color: accent.ink, fontFamily: fonts.bodyBold },
                  ]}
                  numberOfLines={1}
                >
                  {s.label}
                </Text>
                {done && <Ionicons name="checkmark" size={11} color="#4ade80" />}
                {/* The 0.55 the locked state is drawn at lives on the chip and
                    this glyph — never on the label (see stepText). */}
                {locked && (
                  <View style={styles.lockGlyph}>
                    <Ionicons name="lock-closed" size={10} color={colors.inkMuted} />
                  </View>
                )}
              </View>
            </View>
          );
        })}
      </View>

      {next && (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={next.onPress}
          disabled={!next.onPress}
          style={styles.nextTouch}
        >
          <DepthCard variant="paper" edge="gradient" style={styles.nextBox}>
            <Text style={[styles.nextKick, { color: accent.paper }]}>NEXT UP</Text>
            <Text style={styles.nextTitle} numberOfLines={2}>{next.title}</Text>
            {/* 3, not 2: at this column width "Stage 1 · pass its questions,
                then Ready for check" lost "Ready for check" — the actual
                instruction — to the ellipsis. The card has the room. */}
            {next.sub ? <Text style={styles.nextSub} numberOfLines={3}>{next.sub}</Text> : null}
            {next.onPress && (
              <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.goChip}>
                <Text style={styles.nextGo}>Go</Text>
                <Ionicons name="arrow-forward" size={11} color="#fff" />
              </LinearGradient>
            )}
          </DepthCard>
        </TouchableOpacity>
      )}
    </View>
  );
}

export function TwoLadders({ devSteps, salesSteps, devNext, salesNext, scrollY, bleed = 0 }: Props) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Static fallback for callers that don't feed a scroll offset (leadership hub).
  const still = useSharedValue(0);
  const sy = scrollY ?? still;

  // One halo loop shared by both current nodes (the tree's single loop).
  const halo = useSharedValue(0);
  const run = useCallback(() => {
    halo.value = 0;
    halo.value = withRepeat(withTiming(1, { duration: HALO_MS, easing: Easing.out(Easing.cubic) }), -1, false);
  }, [halo]);
  useEffect(() => {
    run();
    return () => cancelAnimation(halo);
  }, [run, halo]);
  useLoopPause(halo, run, 'TwoLadders.halo');

  // NEXT UP rides a DepthCard, which is white in light mode and a raised plum
  // card in dark — so its accent has to flip; the ink block's never does.
  const dev: Accent = { ink: '#67e8f9', paper: isDark ? '#67e8f9' : '#0E7490', glow: '#22d3ee', tint: 'teal' };
  const sales: Accent = { ink: '#d5e9a6', paper: isDark ? '#d5e9a6' : colors.primary, glow: '#8caf38', tint: 'purple' };

  return (
    <EditorialHero
      variant="ink"
      nebula
      scrollY={sy}
      bleed={bleed}
      overlapNext={0}
      style={styles.block}
      title={(
        <GradientText
          colors={GRADIENT_TEXT}
          style={styles.title}
          numberOfLines={2}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          Two ladders. One person.
        </GradientText>
      )}
      lede={<Text style={styles.sub}>Leadership can move fast. Sales mastery compounds. Climb both.</Text>}
    >
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
        <Column icon="briefcase" heading="DEVELOPMENT" steps={devSteps} next={devNext} accent={dev} halo={halo} />
        <View style={styles.divider} />
        <Column icon="trending-up" heading="SALES" steps={salesSteps} next={salesNext} accent={sales} halo={halo} />
      </View>
    </EditorialHero>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  block: { marginBottom: 14 },
  // Editorial scale: 30px, the size spec §4 asks for. The sentence cannot sit
  // on one 390px line at that size, so the title is capped narrow enough that
  // it breaks at the full stop — "Two ladders." / "One person." — instead of
  // after "One": 280 holds "Two ladders." (~245px) but not "Two ladders. One"
  // (~310px). adjustsFontSizeToFit + minimumFontScale are the native safety net.
  title: { fontFamily: fonts.displayBlack, fontSize: 30, lineHeight: 35, letterSpacing: -0.8, maxWidth: 280 },
  sub: { fontSize: 12, color: colors.inkMuted, marginTop: 4, lineHeight: 17 },
  divider: { width: 1, backgroundColor: 'rgba(255,255,255,0.12)' },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 },
  colHeadText: { fontFamily: fonts.displayWide, fontSize: 9.5, letterSpacing: 1 },

  // Skill tree: gutter (rail + nodes) | chips
  tree: { position: 'relative' },
  rail: {
    position: 'absolute', left: GUTTER / 2 - 1, top: ROW_H / 2, width: 2, borderRadius: 1,
    opacity: 0.28,
  },
  railLit: { position: 'absolute', left: GUTTER / 2 - 1.5, width: 3, borderRadius: 1.5 },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center' },
  node: { width: GUTTER, height: ROW_H, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: COIN, height: COIN, borderRadius: COIN / 2 },
  coinEmoji: { fontSize: 12 },
  dotDone: { width: 10, height: 10, borderRadius: 5, boxShadow: '0 0 6px rgba(140,175,56,0.7)' },
  dotUpcoming: {
    width: 8, height: 8, borderRadius: 4, borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.35)', backgroundColor: 'transparent',
  },

  // Frosted chips ON the ink block. The block is ink in both themes, so the
  // chips are the same smoked glass in both and carry inkText/inkMuted —
  // `colors.glass` is deliberately NOT used here: its light value (66% white)
  // turned the done-state rows into 1.3:1 grey-on-grey. The one bright chip
  // in each column is where you are now.
  chip: {
    flex: 1, minWidth: 0, height: ROW_H - 4, marginLeft: CHIP_GAP,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 7, borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  chipDone: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.11)',
  },
  // Locked rungs are dimmed by the CHIP, not by the row: 0.55 × the base
  // fill/border alphas (0.10 → 0.055, 0.18 → 0.10). Dimming the whole row
  // instead dropped the label to ~#577D64 on the composited chip — 2.98:1
  // light / 2.81:1 dark, under the 4.5 floor — and this is the half of the
  // ladder that shows a rep what is still ahead of them.
  chipLocked: {
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderColor: 'rgba(255,255,255,0.10)',
  },
  // "You are here" is marked by the 28px HexCoin, its halo and the 1.5px
  // accent rim — NOT by a near-solid white fill. At 0.94 the two current
  // chips plus the two white NEXT UP cards covered most of the ink block's
  // lower half, so the hero read as an ink strip with four white cards stuck
  // to it (round-2 review). 0.20 is bright glass: clearly the brightest chip
  // in its column, still ink. The label moves to `accent.ink` to match (see
  // the Accent doc comment) — `accent.deep` was chosen for a white chip.
  chipCurrent: { borderWidth: 1.5, backgroundColor: 'rgba(255,255,255,0.20)' },
  stepEmoji: { fontSize: 12 },
  lockGlyph: { opacity: 0.55 },
  // Banked rungs read as banked: the rail, the green tick AND the label all
  // say "earned", so the base (upcoming/locked) state is the quiet one — the
  // opposite would make rungs you haven't started look more important than
  // the ones you already own. Locked labels stay at FULL inkMuted (7.2:1 on
  // the dimmed light chip, 6.5:1 on the dark one); the lock glyph and the
  // fainter chip carry the locked state instead.
  stepText: { flex: 1, fontSize: 10.5, fontFamily: fonts.bodySemibold, color: colors.inkMuted },
  stepTextDone: { color: colors.inkText, opacity: 0.9 },

  nextTouch: { marginTop: 8 },
  nextBox: { borderRadius: 14, padding: 9 },
  nextKick: { fontFamily: fonts.displayWide, fontSize: 8.5, letterSpacing: 1 },
  nextTitle: { fontSize: 12, fontFamily: fonts.bodyBold, color: colors.text, marginTop: 3, lineHeight: 16 },
  nextSub: { fontSize: 10.5, color: colors.textSecondary, marginTop: 2, lineHeight: 14.5 },
  goChip: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 3,
    marginTop: 6, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999,
    boxShadow: '0 4px 10px rgba(58,122,86,0.35)',
  },
  nextGo: { fontSize: 11, fontFamily: fonts.bodyBold, color: '#fff' },
});
