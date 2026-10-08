/**
 * XPBar — the gamified progress bar (spec §3.9).
 *
 *   <XPBar value={0.63} />                                   // hero / stage bar
 *   <XPBar value={pct} tip={false} glow={false} height={6} /> // list rows: zero loops
 *   <XPBar value={0.4} label={<Text>Week 2</Text>} />
 *   <XPBar value={pct} tone="ink" />                          // on an ink DepthCard / the ink rail
 *
 * A bar inside an EditorialHero needs no `tone`: it reads the block's surface
 * from the hero (useHeroSurface) and cuts a dark groove on ink and pop.
 *
 * Anatomy (bottom → top):
 *  - track: colors.trackBg with a hairline border and an INSET box-shadow so
 *    the bar reads as a groove cut into the card, not a stripe painted on it.
 *  - fill: an Animated.View whose `width%` charges with withTiming (900 ms
 *    ease-out) inside a clipped, rounded box holding the XP gradient and a
 *    ShineSweep; the outer wrapper carries the purple glow (boxShadow) so it
 *    spills past the clip.
 *  - ticks: three 1 px hairlines at 25/50/75 % drawn over the fill (segments).
 *  - tip: an 8 px cyan dot riding the fill's end, pulsing 1 ↔ 1.4 on a sine
 *    (one loop — the ONLY loop this component owns; it is mounted only when
 *    `tip` is true, so rows with tip={false} register nothing).
 *
 * Charge on enter: the bar measures its window position once (onLayout →
 * measureInWindow) and stores its CONTENT-space y (window y + pageScrollY at
 * that moment). A useAnimatedReaction on `pageScrollY` starts the charge the
 * first time the bar's y is within 90 % of the window height — the bar
 * charges as it scrolls into view, on the UI thread, with no re-render.
 * Unmeasured or above-the-fold bars charge immediately. A 4 s safety net
 * charges bars on screens that don't feed pageScrollY so nothing stays empty.
 *
 * Budget: ≤2 XPBars with `tip` per screen; list rows pass tip={false}
 * glow={false} (glow also gates the ShineSweep so a row costs no loop).
 *
 * Reduce motion: withTiming jumps, the tip's sine is seeded at scale 1.2.
 */
import React, { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  cancelAnimation,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { GRADIENT_XP, useColors } from '../../theme/ThemeContext';
import { MOTION, useLoopPause } from '../../theme/motion';
import { pageScrollY } from '../../theme/pageScroll';
import { useHeroSurface } from './EditorialHero';
import { ShineSweep } from './ShineSweep';

export type XPBarProps = {
  /** Progress 0–1 (clamped). */
  value: number;
  /** Track height in px (default 12). */
  height?: number;
  /** Three hairline segment ticks at 25/50/75 % (default true). */
  ticks?: boolean;
  /** Pulsing cyan dot at the fill's end — one loop; ≤2 per screen (default true). */
  tip?: boolean;
  /** Purple glow under the fill + the ShineSweep gleam (default true; off for list rows). */
  glow?: boolean;
  /** Fill gradient stops, left → right (default GRADIENT_XP). */
  gradient?: readonly string[];
  /** Charge from 0 when the bar scrolls into view (default true). false = start at `value`. */
  animateOnEnter?: boolean;
  /** Optional label row rendered above the track (caller-styled node). */
  label?: ReactNode;
  /** Container style (width, margins). */
  style?: StyleProp<ViewStyle>;
  /**
   * Which surface the bar sits on.
   *
   * 'auto' (default) asks the enclosing EditorialHero: an ink block or a pop
   * hero gives 'ink', a paper block or no hero at all gives 'paper'. So a bar
   * dropped into a hero is right without the screen saying anything, and a bar
   * on a card is unchanged.
   *
   * Why it matters: `trackBg` is a LIGHT-theme pale lilac (#DCE5D2), which on a
   * dark block reads as the FILLED portion — an empty bar looked 100 % charged
   * next to "0/6 lessons" on the Product Knowledge hero and "0/60 checks" on
   * the coaching hero. 'ink' cuts a dark groove instead, and works in BOTH
   * themes because `ink` is a deliberate cross-theme constant (spec §7).
   *
   * Pass 'paper' or 'ink' explicitly for a surface the hero can't know about
   * (an ink DepthCard, the ink StatusRail, a gradient tile).
   */
  tone?: 'paper' | 'ink' | 'auto';
};

const TIP_SIZE = 8;
const TIP_COLOR = '#b7df58';
const TIP_PERIOD_MS = 2400;                  // 1 → 1.4 → 1 (1200 ms each way)
const CHARGE = { duration: MOTION.dur.charge, easing: MOTION.easeOut } as const;
const VIEW_FRACTION = 0.9;                   // start when y < scroll + 90 % of the window
const SAFETY_MS = 4000;                      // screens that don't feed pageScrollY

/** expo-linear-gradient wants a ≥2-stop tuple; tolerate a 1-stop array. */
function toStops(stops: readonly string[]): readonly [string, string, ...string[]] {
  if (stops.length >= 2) return stops as unknown as readonly [string, string, ...string[]];
  const c = stops[0] ?? '#8caf38';
  return [c, c];
}

export function XPBar({
  value,
  height = 12,
  ticks = true,
  tip = true,
  glow = true,
  gradient = GRADIENT_XP,
  animateOnEnter = true,
  label,
  style,
  tone = 'auto',
}: XPBarProps) {
  const colors = useColors();
  const heroSurface = useHeroSurface();
  const { height: winH } = useWindowDimensions();
  const pct = (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0) * 100;

  // ── Charge state (UI thread) ──────────────────────────────────────────────
  const progress = useSharedValue(animateOnEnter ? 0 : pct); // 0–100 (width %)
  const target = useSharedValue(pct);                          // latest value, read by the charge
  const started = useSharedValue(animateOnEnter ? 0 : 1);      // 1 once the first charge has run
  const anchorY = useSharedValue(-1);                          // content-space y; −1 = unmeasured
  const measuredRef = useRef(false);
  const trackRef = useRef<View>(null);

  /** The first charge: runs once, on the UI thread, toward the latest target. */
  const charge = useCallback(() => {
    'worklet';
    if (started.value) return;
    started.value = 1;
    progress.value = withTiming(target.value, CHARGE);
  }, [started, progress, target]);

  // Value changes after the first charge animate to the new value; before it,
  // they only retarget (the charge reads `target` when it fires).
  useEffect(() => {
    target.value = pct;
    if (started.value) progress.value = withTiming(pct, CHARGE);
  }, [pct, target, started, progress]);

  // In-view gate: fires whenever the page scrolls or the anchor is measured.
  useAnimatedReaction(
    () => ({ sy: pageScrollY.value, ay: anchorY.value }),
    ({ sy, ay }) => {
      if (started.value || ay < 0) return;
      if (ay - sy < winH * VIEW_FRACTION) charge();
    },
    [winH, charge],
  );

  // Measure once. Window y + the current page offset = content-space y, so
  // the gate above stays correct however deep the bar is nested.
  const onLayout = useCallback(() => {
    if (!animateOnEnter || measuredRef.current) return;
    measuredRef.current = true;
    const node = trackRef.current;
    if (!node || typeof node.measureInWindow !== 'function') { runOnUI(charge)(); return; }
    node.measureInWindow((_x, y) => {
      // Unmeasured (0) or already above the fold → charge now.
      if (!Number.isFinite(y) || y <= 0) { runOnUI(charge)(); return; }
      anchorY.value = y + pageScrollY.value;
    });
  }, [animateOnEnter, charge, anchorY]);

  // Safety net for screens whose outer ScrollView doesn't feed pageScrollY:
  // a bar below the fold must never stay empty.
  useEffect(() => {
    if (!animateOnEnter) return;
    const id = setTimeout(() => runOnUI(charge)(), SAFETY_MS);
    return () => clearTimeout(id);
  }, [animateOnEnter, charge]);

  // ── Styles ────────────────────────────────────────────────────────────────
  const innerH = Math.max(2, height - 2);        // inside the 1 px track border
  const innerR = innerH / 2;
  const fillStyle = useAnimatedStyle(() => ({
    width: `${progress.value}%`,
    // A 0-width box would still cast its glow as a smudge at the left edge.
    opacity: progress.value > 0.3 ? 1 : 0,
  }));

  const glowShadow = glow ? '0 0 10px ' + colors.glow : undefined;

  // On ink, the light-theme track token would read as the fill. Cut a dark groove instead.
  // 'auto' inherits the enclosing hero block's surface (ink/pop → groove).
  const onInk = tone === 'ink'
    || (tone === 'auto' && (heroSurface === 'ink' || heroSurface === 'pop'));
  // Round-2 review, finding 2: the sunk groove (black 0.38 with a 16 %-white
  // rim) measured 1.45:1 on `colors.ink`, so an EMPTY ink-hosted bar was not
  // there at all — the COD admin stage hero read as three numerals and a gap.
  // That was finding 27's fix (the old light lilac track read as "100 % full"
  // on ink) overshooting past invisible. A LIFTED groove clears 3:1 on ink in
  // both themes and still cannot be mistaken for the magenta→cyan fill.
  const trackBg = onInk ? 'rgba(255,255,255,0.10)' : colors.trackBg;
  const trackBorder = onInk ? 'rgba(255,255,255,0.30)' : colors.border;
  const tickColor = onInk ? 'rgba(255,255,255,0.28)' : colors.borderDark;

  return (
    <View style={style}>
      {label ? <View style={styles.label}>{label}</View> : null}
      <View
        ref={trackRef}
        onLayout={onLayout}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
        style={{
          height,
          borderRadius: height / 2,
          borderWidth: 1,
          borderColor: trackBorder,
          backgroundColor: trackBg,
          boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.22)',
        }}
      >
        {/* Fill — width% on the UI thread. Glow on the wrapper (unclipped), gradient + sweep in the clip box. */}
        <Animated.View
          pointerEvents="none"
          style={[styles.fill, { borderRadius: innerR, boxShadow: glowShadow }, fillStyle]}
        >
          <View style={[StyleSheet.absoluteFill, { borderRadius: innerR, overflow: 'hidden' }]}>
            <LinearGradient
              colors={toStops(gradient)}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={StyleSheet.absoluteFill}
            />
            {glow ? <ShineSweep periodMs={6000} /> : null}
          </View>
          {tip ? (
            <TipDot progress={progress} top={(innerH - TIP_SIZE) / 2} />
          ) : null}
        </Animated.View>

        {/* Segment ticks — drawn over the fill so the bar reads in quarters. */}
        {ticks ? [25, 50, 75].map((p) => (
          <View
            key={p}
            pointerEvents="none"
            style={[styles.tick, { left: `${p}%`, backgroundColor: tickColor }]}
          />
        )) : null}
      </View>
    </View>
  );
}

/**
 * The glowing tip. Its own component so the pulse loop (and its loop-registry
 * entry) only exists when `tip` is on. Scale = 1.2 + 0.2·sin(p): a true sine,
 * seeded at p = 0 (scale 1.2, mid-phase) so a reduce-motion freeze sits
 * between the extremes.
 */
function TipDot({ progress, top }: { progress: SharedValue<number>; top: number }) {
  const p = useSharedValue(0);
  const run = useCallback(() => {
    p.value = 0;
    p.value = withRepeat(
      withTiming(Math.PI * 2, { duration: TIP_PERIOD_MS, easing: Easing.linear }),
      -1,
      false,
    );
  }, [p]);
  useEffect(() => {
    run();
    return () => cancelAnimation(p);
  }, [run, p]);
  useLoopPause(p, run, 'XPBar.tip');

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 1.2 + 0.2 * Math.sin(p.value) }],
    opacity: progress.value > 0.5 ? 1 : 0,
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.tip, { top }, style]}
    />
  );
}

const styles = StyleSheet.create({
  label: { marginBottom: 6 },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
  },
  tick: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    opacity: 0.55,
  },
  tip: {
    position: 'absolute',
    right: -TIP_SIZE / 2,
    width: TIP_SIZE,
    height: TIP_SIZE,
    borderRadius: TIP_SIZE / 2,
    backgroundColor: TIP_COLOR,
    boxShadow: '0 0 8px rgba(183,223,88,0.6)',
  },
});

export default XPBar;
