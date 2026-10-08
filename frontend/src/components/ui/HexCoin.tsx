/**
 * HexCoin — the rank/level medallion (spec §3.10), SVG on every platform.
 *
 *   <HexCoin size={72} tint="gold" animate glow>3</HexCoin>     // hero level coin
 *   <HexCoin size={28} tint="purple" animate={false}>🎯</HexCoin> // static tree node
 *
 * Layers inside a size×size box (bottom → top):
 *  (e) GlowOrb halo in the metal's hue (when `glow`).
 *  (a) edge hex — the darker metal of the coin's side, turned with the face
 *      and pushed along the turned x axis (+ a hair down) so thickness shows.
 *  (b) face hex — Svg LinearGradient metal + a RadialGradient highlight + a
 *      lighter rim polygon and a faint inner shadow ring; `perspective` +
 *      `rotateY` on the wrapping Animated.View (CSS on rnw, native on the new
 *      arch — the Medal3D pattern).
 *  (c) specular band — a Rect clipped by a hex ClipPath inside a −18° skew,
 *      its `x` driven by useAnimatedProps in the SAME phase as the turn, so
 *      the light slides across as the coin rotates (Path/Rect native props
 *      animate via setNativeProps — the BrandLoader mechanism).
 *  (d) children overlay — UN-rotated, so a glyph, number or emoji never skews.
 *
 * Motion: one phase value `p` ramps linearly 0 → 2π every 4800 ms and the
 * worklets derive θ = 28°·sin(p) — a perfect sine ±28° (2400 ms each way)
 * with continuous velocity. Seeded at p₀ = asin(8/28) so a reduce-motion
 * freeze shows the 8° tilt from the spec. Paused via useLoopPause; the loop
 * (and its registry entry) exists only when `animate` is true — static coins
 * mount no loop at all. Budget: ≤2 animated coins per screen.
 *
 * Contrast: numerals are plum ink on gold/silver/bronze/teal/green (≥6:1 on
 * every mid stop) and white on purple (6.5:1).
 */
import React, { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Svg, {
  ClipPath, Defs, G, LinearGradient, Polygon, RadialGradient, Rect, Stop,
} from 'react-native-svg';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import {
  GRADIENT, GRADIENT_BRONZE, GRADIENT_GOLD, GRADIENT_STEEL, fonts, useTheme,
} from '../../theme/ThemeContext';
import { useLoopPause } from '../../theme/motion';
import { GlowOrb } from './Decor';

// ── Public API ───────────────────────────────────────────────────────────────
export type HexCoinTint = 'gold' | 'silver' | 'bronze' | 'purple' | 'teal' | 'green';

export type HexCoinProps = {
  /** Rendered width and height in px. */
  size: number;
  tint: HexCoinTint;
  /** Turn + specular loop (default: size > 32). Static coins mount no loop. */
  animate?: boolean;
  /** Soft halo behind the coin in the metal's hue. */
  glow?: boolean;
  /** Emoji / number / node, rendered on an un-rotated overlay. Strings get the coin's numeral style. */
  children?: ReactNode;
  /** Container style (position, margins). */
  style?: StyleProp<ViewStyle>;
};

// ── Geometry ─────────────────────────────────────────────────────────────────
/** Pointy-top hexagon as an SVG `points` string, radius r about (cx, cy). */
export function hexPoints(cx: number, cy: number, r: number): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (-90 + i * 60);
    out += (i ? ' ' : '') + (cx + r * Math.cos(a)).toFixed(2) + ',' + (cy + r * Math.sin(a)).toFixed(2);
  }
  return out;
}

// ── Motion constants ─────────────────────────────────────────────────────────
const MAX_DEG = 28;                                  // rotateY amplitude
const SEED_DEG = 8;                                  // reduce-motion frozen tilt
const P0 = Math.asin(SEED_DEG / MAX_DEG);            // phase that yields 8°
const PERIOD_MS = 4800;                              // 2400 ms each way
const PERSPECTIVE = 600;
const SPEC_SKEW = -18;                               // specular band slant (deg)
const INK = '#0b211c';

type Metal = {
  face: readonly string[];  // face gradient, top-left → bottom-right
  edge: string;             // side-of-coin colour
  rim: string;              // lighter rim stroke
  glow: string;             // halo + glyph glow hue
  text: string;             // numeral colour
};

const METALS: Record<HexCoinTint, Metal> = {
  gold:   { face: GRADIENT_GOLD,   edge: '#8a6508', rim: '#fff7d1', glow: '#f0c53d', text: INK },
  silver: { face: GRADIENT_STEEL,  edge: '#4b4b5e', rim: '#ffffff', glow: '#c7c7dc', text: INK },
  bronze: { face: GRADIENT_BRONZE, edge: '#5e3210', rim: '#fbe3cc', glow: '#cd7f32', text: INK },
  purple: { face: GRADIENT,        edge: '#0b211c', rim: '#e6f4c4', glow: '#8caf38', text: '#ffffff' },
  teal:   { face: ['#a5f3fc', '#22d3ee', '#0e7490'], edge: '#0b4f63', rim: '#e0fbff', glow: '#22d3ee', text: INK },
  green:  { face: ['#a7f3d0', '#10b981', '#047857'], edge: '#03533c', rim: '#d7fbe9', glow: '#10b981', text: INK },
};

const AnimatedRect = Animated.createAnimatedComponent(Rect);

// ── Component ────────────────────────────────────────────────────────────────
export function HexCoin(props: HexCoinProps) {
  const animate = props.animate ?? props.size > 32;
  // Two hosts so the loop hooks (and the DEV loop registry) only exist when animating.
  return animate ? <LiveCoin {...props} /> : <StaticCoin {...props} />;
}

function LiveCoin(props: HexCoinProps) {
  const p = useSharedValue(P0);
  const run = useCallback(() => {
    p.value = P0;
    p.value = withRepeat(
      withTiming(P0 + Math.PI * 2, { duration: PERIOD_MS, easing: Easing.linear }),
      -1,
      false,
    );
  }, [p]);
  useEffect(() => {
    run();
    return () => cancelAnimation(p);
  }, [run, p]);
  useLoopPause(p, run, 'HexCoin');
  return <CoinLayers {...props} phase={p} />;
}

function StaticCoin(props: HexCoinProps) {
  // p = 0 → θ = 0: flat, crisp rim and glyph; the specular band rests at the centre.
  const p = useSharedValue(0);
  return <CoinLayers {...props} phase={p} />;
}

function CoinLayers({ size, tint, glow = false, children, style, phase }: HexCoinProps & { phase: SharedValue<number> }) {
  const { effective } = useTheme();
  const metal = METALS[tint];
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const ids = useMemo(() => ({
    face: `hcF${uid}`, hi: `hcH${uid}`, spec: `hcS${uid}`, clip: `hcC${uid}`,
  }), [uid]);

  const c = size / 2;
  const R = size * 0.47;                 // face radius (3 % breathing room for the turn)
  const rimW = Math.max(1.2, size * 0.035);
  const rimR = R - rimW * 0.9;
  const bandW = size * 0.22;
  const hex = useMemo(() => hexPoints(c, c, R), [c, R]);
  const rimHex = useMemo(() => hexPoints(c, c, rimR), [c, rimR]);
  const innerHex = useMemo(() => hexPoints(c, c, rimR - rimW * 1.6), [c, rimR, rimW]);

  // ── Worklets: θ from the phase; edge offset along the turned axis ────────
  const faceStyle = useAnimatedStyle(() => {
    const deg = MAX_DEG * Math.sin(phase.value);
    return { transform: [{ perspective: PERSPECTIVE }, { rotateY: `${deg}deg` }] };
  });
  const edgeStyle = useAnimatedStyle(() => {
    const deg = MAX_DEG * Math.sin(phase.value);
    const rad = (deg * Math.PI) / 180;
    return {
      transform: [
        { perspective: PERSPECTIVE },
        { rotateY: `${deg}deg` },
        { translateX: Math.sin(rad) * size * 0.12 },
        { translateY: size * 0.025 },
      ],
    };
  });
  // Specular band slides with the turn (same phase), centred at θ = 0.
  const specProps = useAnimatedProps(() => ({
    x: c - bandW / 2 + Math.sin(phase.value) * size * 0.55,
  }));

  const faceStops = metal.face;
  const n = faceStops.length;

  // Strings/numbers get the numeral style; nodes render as given.
  const content = (typeof children === 'string' || typeof children === 'number') ? (
    <Text
      numberOfLines={1}
      adjustsFontSizeToFit
      style={{
        fontFamily: fonts.displayBlack, // never add fontWeight to Unbounded
        fontSize: size * 0.42,
        color: metal.text,
        textAlign: 'center',
        includeFontPadding: false,
        textShadowColor: metal.glow,
        textShadowRadius: size * 0.14,
        textShadowOffset: { width: 0, height: 0 },
      }}
    >
      {String(children)}
    </Text>
  ) : children;

  return (
    <View pointerEvents="none" style={[{ width: size, height: size }, style]}>
      {/* (e) halo */}
      {glow ? (
        <GlowOrb
          size={size * 1.7}
          color={metal.glow}
          opacity={effective === 'dark' ? 0.6 : 0.45}
          style={{ top: -size * 0.35, left: -size * 0.35 }}
        />
      ) : null}

      {/* (a) edge — the coin's darker side, turned with the face */}
      <Animated.View style={[StyleSheet.absoluteFill, edgeStyle]}>
        <Svg width={size} height={size}>
          <Polygon points={hex} fill={metal.edge} />
        </Svg>
      </Animated.View>

      {/* (b) face + (c) specular — turned together */}
      <Animated.View style={[StyleSheet.absoluteFill, faceStyle]}>
        <Svg width={size} height={size}>
          <Defs>
            <LinearGradient id={ids.face} x1={0} y1={0} x2={1} y2={1}>
              {faceStops.map((col, i) => (
                <Stop key={i} offset={`${n > 1 ? Math.round((i / (n - 1)) * 100) : 0}%`} stopColor={col} />
              ))}
            </LinearGradient>
            <RadialGradient id={ids.hi} cx="35%" cy="28%" r="60%">
              <Stop offset="0%" stopColor="#ffffff" stopOpacity={0.55} />
              <Stop offset="45%" stopColor="#ffffff" stopOpacity={0.14} />
              <Stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
            </RadialGradient>
            <LinearGradient id={ids.spec} x1={0} y1={0} x2={1} y2={0}>
              <Stop offset="0%" stopColor="#ffffff" stopOpacity={0} />
              <Stop offset="50%" stopColor="#ffffff" stopOpacity={0.7} />
              <Stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
            </LinearGradient>
            <ClipPath id={ids.clip}>
              <Polygon points={hex} />
            </ClipPath>
          </Defs>
          <Polygon points={hex} fill={`url(#${ids.face})`} />
          <Polygon points={hex} fill={`url(#${ids.hi})`} />
          {/* specular band: hex-clipped, slanted, x animated */}
          <G clipPath={`url(#${ids.clip})`}>
            <G transform={`translate(${c} ${c}) skewX(${SPEC_SKEW}) translate(${-c} ${-c})`}>
              <AnimatedRect
                animatedProps={specProps}
                y={-size * 0.2}
                width={bandW}
                height={size * 1.4}
                fill={`url(#${ids.spec})`}
              />
            </G>
          </G>
          {/* inner shadow ring + lighter rim */}
          <Polygon points={innerHex} fill="none" stroke="#000000" strokeOpacity={0.14} strokeWidth={Math.max(1, size * 0.02)} strokeLinejoin="round" />
          <Polygon points={rimHex} fill="none" stroke={metal.rim} strokeOpacity={0.9} strokeWidth={rimW} strokeLinejoin="round" />
        </Svg>
      </Animated.View>

      {/* (d) children — never rotated, so glyphs stay true */}
      <View style={[StyleSheet.absoluteFill, styles.center]}>{content}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default HexCoin;
