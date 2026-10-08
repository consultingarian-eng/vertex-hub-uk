/**
 * Aurora — softly drifting, breathing gradient blobs behind hero cards.
 * Each blob is an SVG radial gradient (solid centre → transparent edge), so
 * the soft falloff is IDENTICAL on iOS, Android and the PWA — no CSS
 * filter, no shadow hacks, no platform surprises.
 *
 * Drop inside any overflow-hidden container as the first child:
 *   <Aurora />          // full presence (dark/gradient surfaces)
 *   <Aurora dim />      // lighter touch (×0.6) for light cards
 *   <Aurora intense />  // the nebula: ×1.4 opacity, blobs ×1.5 — inside ink heroes in dark mode
 *
 * Motion (spec §5): ONE loop per instance. A single linear phase runs on the
 * UI thread and each blob reads sin(freq·phase + offset) for its drift, scale
 * and opacity (transform + opacity only). The three frequencies are rationals
 * (1, 3/4, 2/3 → 5.2 / 6.9 / 7.8 s, the spec's 5.2 / 6.8 / 7.6 s to within a
 * tenth), chosen so each blob completes a whole number of cycles inside the
 * repeat span (12 / 9 / 8) and the wrap is seamless.
 *
 * Why one and not three: Aurora sits inside every EditorialHero, so on a hero
 * screen three blob loops plus the PageField plus the masthead cube already
 * exceeded the ≤6-loops-per-screen budget (spec §5) before the screen added an
 * XP tip or a coin. One shared phase makes an Aurora cost 1.
 *
 * The phase is seeded at 0, i.e. MID-phase (sin 0 = 0 → t = 0.5), so a
 * reduce-motion freeze shows the settled composition, and the loop pauses when
 * the app is backgrounded / the tab hidden (useLoopPause), resuming from the
 * phase it was cancelled at.
 */
import React, { useCallback, useEffect, useId, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import Animated, {
  Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useLoopPause } from '../../theme/motion';

type BlobSpec = {
  size: number; color: string; baseOpacity: number;
  top?: number; bottom?: number; left?: number | string; right?: number;
  /** Cycles per base cycle; SPAN_CYCLES·freq must be a whole number. */
  driftX: number; driftY: number; freq: number;
};

export type AuroraProps = {
  /** Lighter touch for light cards (×0.6 opacity). */
  dim?: boolean;
  /** The nebula: ×1.4 opacity and ×1.5 blob size (ink heroes in dark mode). Stacks with `dim`. */
  intense?: boolean;
};

const TWO_PI = Math.PI * 2;
const DIM_MULT = 0.6;
const INTENSE_OPACITY = 1.4;
const INTENSE_SIZE = 1.5;
/** Base period of the shared phase (the violet blob's own period). */
const BASE_MS = 5200;
/** Repeat span in base cycles — 12·1, 12·3/4 and 12·2/3 are all whole. */
const SPAN_CYCLES = 12;
const SPAN = TWO_PI * SPAN_CYCLES;
const SPAN_MS = BASE_MS * SPAN_CYCLES;

function Blob({ spec, dim, intense, id, phase }: {
  spec: BlobSpec; dim?: boolean; intense?: boolean; id: string; phase: SharedValue<number>;
}) {
  const size = spec.size * (intense ? INTENSE_SIZE : 1);
  const opacityMult = (dim ? DIM_MULT : 1) * (intense ? INTENSE_OPACITY : 1);

  // t = 0.5 + 0.5·sin(freq·phase) is this blob's 0–1 breath.
  const style = useAnimatedStyle(() => {
    const t = 0.5 + 0.5 * Math.sin(spec.freq * phase.value);
    return {
      transform: [
        { translateX: (t - 0.5) * spec.driftX },
        { translateY: (t - 0.5) * spec.driftY },
        { scale: 0.9 + t * 0.24 },
      ],
      opacity: Math.min(1, opacityMult * spec.baseOpacity * (0.7 + t * 0.6)),
    };
  }, [opacityMult, spec.baseOpacity, spec.driftX, spec.driftY, spec.freq]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[{
        position: 'absolute',
        width: size, height: size,
        top: spec.top, bottom: spec.bottom, left: spec.left as any, right: spec.right,
      }, style]}
    >
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={spec.color} stopOpacity={1} />
            <Stop offset="55%" stopColor={spec.color} stopOpacity={0.55} />
            <Stop offset="100%" stopColor={spec.color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

export function Aurora({ dim, intense }: AuroraProps) {
  // Unique gradient ids per instance (several Auroras share a web document).
  const rawId = useId();
  const uid = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ''), [rawId]);
  const blobs = useMemo<BlobSpec[]>(() => [
    { size: 230, color: '#8caf38', baseOpacity: 0.60, top: -90, right: -60, driftX: 34, driftY: 24, freq: 1 },       // 5.2 s
    { size: 180, color: '#e7b65c', baseOpacity: 0.38, bottom: -80, left: -50, driftX: 30, driftY: -18, freq: 3 / 4 }, // 6.9 s
    { size: 150, color: '#3a7a56', baseOpacity: 0.32, top: 0, left: '36%', driftX: -26, driftY: 26, freq: 2 / 3 },    // 7.8 s
  ], []);

  // ONE loop for all three blobs (see the header).
  const phase = useSharedValue(0);
  const run = useCallback(() => {
    // Continue from where it was cancelled, modulo the FULL span so the blobs'
    // relative phases survive a background/visibility pause.
    const from = phase.value % SPAN;
    phase.value = from;
    phase.value = withRepeat(
      withTiming(from + SPAN, { duration: SPAN_MS, easing: Easing.linear }),
      -1,
      false,
    );
  }, [phase]);
  useEffect(() => {
    run();
    return () => cancelAnimation(phase);
  }, [run, phase]);
  useLoopPause(phase, run, 'Aurora');

  return (
    <Animated.View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {blobs.map((b, i) => (
        <Blob key={i} spec={b} dim={dim} intense={intense} id={`aurora-${uid}-${i}`} phase={phase} />
      ))}
    </Animated.View>
  );
}

export default Aurora;
