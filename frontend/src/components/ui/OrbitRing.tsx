/**
 * OrbitRing — a rotating multi-colour gradient ring around an avatar
 * (spec §3.16).
 *
 *   <OrbitRing size={56}>
 *     <Image source={{ uri }} style={{ width: '100%', height: '100%', borderRadius: 999 }} />
 *   </OrbitRing>
 *
 * Two Svg rings, each six arcs with 8° gaps: the outer arcs are stroked with
 * the GRADIENT_FULL poster colours (plus bright purple to close the loop),
 * the inner counter-ring is thinner at 0.5 opacity. ONE phase value drives
 * both (outer = +rot, inner = −rot/2 → 18 s and 36 s per revolution), so the
 * component costs a single loop; seeded at 40° so a reduce-motion freeze is
 * the intended static composition. Paused via useLoopPause.
 *
 * Children are centred in a circle of `orbitRingInnerSize(size, stroke)` px;
 * size the avatar to fill it (100 %) or pass a fixed size ≤ that.
 */
import React, { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, {
  Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated';
import { GRADIENT_FULL, brand } from '../../theme/ThemeContext';
import { useLoopPause } from '../../theme/motion';

export type OrbitRingProps = {
  /** Outer diameter in px. */
  size: number;
  /** Outer ring stroke width (default 3). */
  stroke?: number;
  /** The avatar, centred inside the rings. */
  children: ReactNode;
  /** Container style (position, margins). */
  style?: StyleProp<ViewStyle>;
};

const ARCS = 6;
const GAP_DEG = 8;
const PERIOD_MS = 18000;            // outer: 360° / 18 s; inner counter-rotates at half speed
const SEED_DEG = 40;                // reduce-motion frozen angle
const INNER_GAP = 1;                // px between the two rings
const AVATAR_GAP = 1.5;             // px between the inner ring and the avatar
const ARC_COLORS: readonly string[] = [...GRADIENT_FULL, brand.lime];

/** Inner stroke: a thinner echo of the outer ring. */
function innerStroke(stroke: number) {
  return Math.max(1, stroke * 0.5);
}

/** Diameter of the avatar circle inside an OrbitRing of `size` / `stroke`. */
export function orbitRingInnerSize(size: number, stroke = 3) {
  const s2 = innerStroke(stroke);
  return Math.max(0, Math.round(size - 2 * (stroke + INNER_GAP + s2 + AVATAR_GAP)));
}

/** SVG arc from a0° to a1° (clockwise from 12 o'clock) at radius r about (c, c). */
function arcPath(c: number, r: number, a0: number, a1: number): string {
  const rad = (d: number) => ((d - 90) * Math.PI) / 180;
  const x0 = c + r * Math.cos(rad(a0));
  const y0 = c + r * Math.sin(rad(a0));
  const x1 = c + r * Math.cos(rad(a1));
  const y1 = c + r * Math.sin(rad(a1));
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function arcs(c: number, r: number, offsetDeg: number): string[] {
  const span = 360 / ARCS;
  const out: string[] = [];
  for (let i = 0; i < ARCS; i++) {
    const a0 = offsetDeg + i * span + GAP_DEG / 2;
    const a1 = offsetDeg + (i + 1) * span - GAP_DEG / 2;
    out.push(arcPath(c, r, a0, a1));
  }
  return out;
}

export function OrbitRing({ size, stroke = 3, children, style }: OrbitRingProps) {
  const c = size / 2;
  const s2 = innerStroke(stroke);
  const r1 = c - stroke / 2;                       // outer ring centre-line radius
  const r2 = r1 - stroke / 2 - INNER_GAP - s2 / 2; // inner ring centre-line radius
  const inner = orbitRingInnerSize(size, stroke);
  const outerArcs = useMemo(() => arcs(c, r1, 0), [c, r1]);
  const innerArcs = useMemo(() => arcs(c, r2, 30), [c, r2]); // interleaved with the outer gaps

  // ── The one loop: a linear ramp both rings read ───────────────────────────
  const rot = useSharedValue(SEED_DEG);
  const run = useCallback(() => {
    rot.value = SEED_DEG;
    rot.value = withRepeat(
      withTiming(SEED_DEG + 360, { duration: PERIOD_MS, easing: Easing.linear }),
      -1,
      false,
    );
  }, [rot]);
  useEffect(() => {
    run();
    return () => cancelAnimation(rot);
  }, [run, rot]);
  useLoopPause(rot, run, 'OrbitRing');

  const outerStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rot.value}deg` }],
  }));
  const innerStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${-rot.value / 2}deg` }],
  }));

  return (
    <View style={[{ width: size, height: size }, styles.center, style]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, outerStyle]}>
        <Svg width={size} height={size}>
          {outerArcs.map((d, i) => (
            <Path
              key={i}
              d={d}
              fill="none"
              stroke={ARC_COLORS[i % ARC_COLORS.length]}
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          ))}
        </Svg>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: 0.5 }, innerStyle]}>
        <Svg width={size} height={size}>
          {innerArcs.map((d, i) => (
            <Path
              key={i}
              d={d}
              fill="none"
              stroke={ARC_COLORS[(i + 3) % ARC_COLORS.length]}
              strokeWidth={s2}
              strokeLinecap="round"
            />
          ))}
        </Svg>
      </Animated.View>
      <View style={[{ width: inner, height: inner, borderRadius: inner / 2 }, styles.center]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default OrbitRing;
