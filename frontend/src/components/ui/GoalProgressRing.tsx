/**
 * GoalProgressRing — animated SVG donut showing % to a goal (spec §3.18).
 *
 * Usage (unchanged public props):
 *   <GoalProgressRing
 *     value={12}
 *     target={50}
 *     label="Sales"
 *     unit=""
 *     accent="#2F6A4B"     // centre numeral colour (the arc is always the XP gradient)
 *     size={82} stroke={9} // callers passing a size keep it; default 104
 *     hapticTicks
 *   />
 *
 * Anatomy (bottom → top, all inside one SVG that is padded past `size` so
 * the halo and bezel ticks are not clipped — the layout box stays `size`):
 *  - 12 bezel ticks at 30° just outside the track (colors.border)
 *  - track circle in colors.trackBg
 *  - halo: the arc again at 2.2× stroke in colors.glow at 35 % — shares the
 *    arc's animatedProps so it charges in lock-step
 *  - arc: stroke = GRADIENT_XP via an SVG LinearGradient in user space
 *    (magenta at top-left → cyan at bottom-right, fixed to the ring, not the
 *    dash), unique id per instance
 *  - centre: the % numeral in fonts.displayBlack with a glow text-shadow
 *    (never a fontWeight on Unbounded), value/target beneath, label below.
 *
 * Charge on enter: like XPBar, the ring measures its window position once
 * and a useAnimatedReaction on `pageScrollY` starts the 1100 ms ease-out
 * charge the first time the ring is within 90 % of the window height — on
 * the UI thread, no re-render. Unmeasured or above-the-fold rings charge
 * immediately; a 4 s safety net charges rings on screens that don't feed
 * pageScrollY. The centre count-up and the haptic ticks wait for the same
 * moment so everything lands together.
 *
 * Not a loop. Reduce motion: withTiming jumps to the value.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient as SvgLinearGradient, Stop } from 'react-native-svg';
import Animated, {
  runOnJS, runOnUI, useAnimatedProps, useAnimatedReaction, useSharedValue, withTiming,
} from 'react-native-reanimated';
import { useColors, type ColorPalette } from '../../theme/ThemeContext';
import { GRADIENT_XP, fonts } from '../../theme/brand';
import { MOTION } from '../../theme/motion';
import { pageScrollY } from '../../theme/pageScroll';
import { AnimatedNumber } from './AnimatedNumber';
import { haptics } from '../../utils/haptics';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  value: number;
  target: number;
  label: string;
  unit?: string;
  /** Centre numeral colour (defaults to theme primary). The arc itself is the XP gradient. */
  accent?: string;
  /** Outer diameter in px (default 104) */
  size?: number;
  /** Stroke width in px (default 11) */
  stroke?: number;
  /** Tick the haptics at 25/50/75/100% while the arc charges up. */
  hapticTicks?: boolean;
};

const RING_MS = MOTION.dur.ring;                       // 1100
const CHARGE = { duration: RING_MS, easing: MOTION.easeOut } as const;
const HALO_MULT = 2.2;
const HALO_OPACITY = 0.35;
const TICKS = 12;
const TICK_GAP = 2;                                    // px outside the track
const TICK_LEN = 3;
const VIEW_FRACTION = 0.9;                             // charge when y < scroll + 90 % of the window
const SAFETY_MS = 4000;

export function GoalProgressRing({
  value, target, label, unit = '', accent, size = 104, stroke = 11, hapticTicks = false,
}: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { height: winH } = useWindowDimensions();

  const safeTarget = Math.max(target || 0, 0);
  const pct = safeTarget > 0 ? Math.max(0, Math.min(1, value / safeTarget)) : 0;
  const numeralColor = accent || colors.primary;

  // ── Geometry ──────────────────────────────────────────────────────────────
  // The SVG is padded so the halo (0.6 × stroke past the track) and the bezel
  // ticks draw outside `size` without being clipped; the layout box is `size`.
  const pad = Math.ceil(Math.max(stroke * (HALO_MULT - 1) / 2, TICK_GAP + TICK_LEN)) + 1;
  const svgSize = size + pad * 2;
  const c = svgSize / 2;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const rOut = size / 2;                               // track's outer edge
  const pctSize = Math.max(14, Math.min(20, Math.round(size * 0.19)));

  // useId() may contain ':' or '«»' — keep the id URL-safe for `url(#…)`.
  const rawId = useId();
  const gradId = useMemo(() => `gpr-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`, [rawId]);

  const ticks = useMemo(() => {
    const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let i = 0; i < TICKS; i += 1) {
      const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      out.push({
        x1: c + (rOut + TICK_GAP) * cos,
        y1: c + (rOut + TICK_GAP) * sin,
        x2: c + (rOut + TICK_GAP + TICK_LEN) * cos,
        y2: c + (rOut + TICK_GAP + TICK_LEN) * sin,
      });
    }
    return out;
  }, [c, rOut]);

  // ── Charge state (UI thread) ──────────────────────────────────────────────
  const progress = useSharedValue(0);                  // 0–1 (arc fraction)
  const targetSv = useSharedValue(pct);                // latest value, read by the charge
  const started = useSharedValue(0);                   // 1 once the first charge has run
  const anchorY = useSharedValue(-1);                  // content-space y; −1 = unmeasured
  const measuredRef = useRef(false);
  const wrapRef = useRef<View>(null);
  const [charged, setCharged] = useState(false);       // JS mirror: gates the numeral + haptics

  /** The first charge: runs once, on the UI thread, toward the latest target. */
  const charge = useCallback(() => {
    'worklet';
    if (started.value) return;
    started.value = 1;
    progress.value = withTiming(targetSv.value, CHARGE);
    runOnJS(setCharged)(true);
  }, [started, progress, targetSv]);

  // Value changes after the first charge animate to the new value; before it,
  // they only retarget (the charge reads `targetSv` when it fires).
  useEffect(() => {
    targetSv.value = pct;
    if (started.value) progress.value = withTiming(pct, CHARGE);
  }, [pct, targetSv, started, progress]);

  // In-view gate: fires whenever the page scrolls or the anchor is measured.
  useAnimatedReaction(
    () => ({ sy: pageScrollY.value, ay: anchorY.value }),
    ({ sy, ay }) => {
      if (started.value || ay < 0) return;
      if (ay - sy < winH * VIEW_FRACTION) charge();
    },
    [winH, charge],
  );

  // Measure once. Window y + the current page offset = content-space y.
  const onLayout = useCallback(() => {
    if (measuredRef.current) return;
    measuredRef.current = true;
    const node = wrapRef.current;
    if (!node || typeof node.measureInWindow !== 'function') { runOnUI(charge)(); return; }
    node.measureInWindow((_x, y) => {
      // Unmeasured (0) or already above the fold → charge now.
      if (!Number.isFinite(y) || y <= 0) { runOnUI(charge)(); return; }
      anchorY.value = y + pageScrollY.value;
    });
  }, [charge, anchorY]);

  // Safety net for screens whose outer ScrollView doesn't feed pageScrollY.
  useEffect(() => {
    const id = setTimeout(() => runOnUI(charge)(), SAFETY_MS);
    return () => clearTimeout(id);
  }, [charge]);

  // "Charge-up" ticks — a light haptic as the arc crosses each quarter, a
  // success buzz when it lands full. Timed against the ease-out curve
  // (t = 1 - (1 - m)^(1/3)) so the tick lands when the arc visually crosses.
  // Waits for the in-view charge so the buzz never fires for an unseen ring.
  useEffect(() => {
    if (!hapticTicks || !charged || pct <= 0) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    [0.25, 0.5, 0.75, 1].forEach((m) => {
      if (pct >= m - 1e-6) {
        const frac = m / pct;
        const t = RING_MS * (1 - Math.pow(1 - Math.min(frac, 1), 1 / 3));
        timers.push(setTimeout(() => (m === 1 ? haptics.success() : haptics.light()), t));
      }
    });
    return () => timers.forEach(clearTimeout);
  }, [hapticTicks, charged, pct]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: circ * (1 - progress.value),
  }));

  return (
    <View style={styles.wrap}>
      <View ref={wrapRef} onLayout={onLayout} style={{ width: size, height: size }}>
        <Svg
          width={svgSize}
          height={svgSize}
          style={{ position: 'absolute', left: -pad, top: -pad }}
        >
          <Defs>
            {/* User-space gradient: fixed to the ring's box, so the colours don't rotate with the dash. */}
            <SvgLinearGradient id={gradId} gradientUnits="userSpaceOnUse" x1={pad} y1={pad} x2={pad + size} y2={pad + size}>
              {GRADIENT_XP.map((stop, i) => (
                <Stop key={stop} offset={`${(i / (GRADIENT_XP.length - 1)) * 100}%`} stopColor={stop} />
              ))}
            </SvgLinearGradient>
          </Defs>

          {/* Bezel ticks — 12 at 30°, just outside the track */}
          {ticks.map((t, i) => (
            <Line
              key={i}
              x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
              stroke={colors.border}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          ))}

          {/* Track */}
          <Circle cx={c} cy={c} r={r} stroke={colors.trackBg} strokeWidth={stroke} fill="none" />

          {/* Halo + arc — rotated -90deg so they start at the top.
              An SVG transform STRING, not rotation + originX/originY: on web
              react-native-svg forwards those origin props to the DOM node as
              `transform-origin`, which React rejects ("Invalid DOM property
              `transform-origin`") on every dev render. The string is parsed by
              rnsvg into the same matrix on all three platforms. */}
          <G transform={`rotate(-90 ${c} ${c})`}>
            <AnimatedCircle
              cx={c}
              cy={c}
              r={r}
              stroke={colors.glow}
              strokeOpacity={HALO_OPACITY}
              strokeWidth={stroke * HALO_MULT}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={`${circ} ${circ}`}
              animatedProps={animatedProps}
            />
            <AnimatedCircle
              cx={c}
              cy={c}
              r={r}
              stroke={`url(#${gradId})`}
              strokeWidth={stroke}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={`${circ} ${circ}`}
              animatedProps={animatedProps}
            />
          </G>
        </Svg>

        <View style={[styles.center, { width: size, height: size }]} pointerEvents="none">
          <AnimatedNumber
            value={charged ? Math.round(pct * 100) : 0}
            suffix="%"
            duration={RING_MS}
            style={[styles.pct, { fontSize: pctSize, color: numeralColor, textShadowColor: colors.glow }]}
          />
          <Text style={styles.subValue} numberOfLines={1}>
            {value}{unit ? unit : ''} / {target}{unit ? unit : ''}
          </Text>
        </View>
      </View>
      <Text style={styles.label} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const createStyles = (colors: ColorPalette) => StyleSheet.create({
  wrap: { alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  center: { position: 'absolute', top: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  // Unbounded Black: no fontWeight (faux-bold on web). Glow via text shadow.
  pct: {
    fontFamily: fonts.displayBlack,
    letterSpacing: -0.4,
    textAlign: 'center',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  subValue: { fontSize: 9, fontWeight: '700', color: colors.textMuted, marginTop: 2, fontVariant: ['tabular-nums'] as any },
  label: {
    fontFamily: fonts.displayWide,
    fontSize: 11,
    color: colors.text,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 2,
  },
});
