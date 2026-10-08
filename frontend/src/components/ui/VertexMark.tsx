/**
 * VertexMark — the Vertex X as the app's live brand object (masthead, heroes,
 * login). Two solid blades plus the halftone dot field from the logo, with a
 * slow ripple running out through the dots and a small "pop" on tab changes.
 *
 * Drawn with react-native-svg from vertexGeometry.ts (the same numbers as the
 * static icons). The dots are split into BANDS rings by distance from the
 * centre; each ring is its own layer with an animated opacity, so the ripple
 * costs one shared value and BANDS style worklets — no per-frame re-renders.
 *
 *   <VertexMark size={44} kick={pageMarkKick} />
 *   <VertexMark size={220} glow />
 *   <VertexMark size={150} color="rgba(36,76,59,0.62)" />
 *
 * The mark sits centred in a size × size box (so it drops into the square
 * slots the old brand object used), about 86 % of the box wide.
 */
import React, { useCallback, useEffect, useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Path, Polygon } from 'react-native-svg';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useColors, useTheme } from '../../theme/ThemeContext';
import { useLoopPause } from '../../theme/motion';
import { GlowOrb } from './Decor';
import { X_BLADES, X_DOTS, X_H, X_W, dotBands } from './vertexGeometry';

export interface VertexMarkProps {
  /** Box width and height in px. */
  size: number;
  /** Mark colour (default `colors.markColor`: lime on dark, forest on light). */
  color?: string;
  /** Soft brand glow behind the mark. */
  glow?: boolean;
  /** Whole-mark opacity. */
  opacity?: number;
  /** Seconds per ripple (default 3.2). `0` = static. */
  ripple?: number;
  /** Tab-change counter — every change gives the mark a small pop. */
  kick?: SharedValue<number>;
}

const BANDS = 5;
const BAND_LAYERS = dotBands(BANDS);
const MARK_WIDTH = 0.86; // of the box

function RippleBand({
  band, t, width, height, color,
}: { band: number; t: SharedValue<number>; width: number; height: number; color: string }) {
  const style = useAnimatedStyle(() => {
    // A cosine wave travelling outwards: inner rings brighten first.
    const phase = t.value - band / BANDS * 0.55;
    const w = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
    return { opacity: 0.5 + 0.5 * w };
  });
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0 }, style]}>
      <Svg width={width} height={height} viewBox={`0 0 ${X_W} ${X_H}`}>
        <G fill={color}>
          {BAND_LAYERS[band].map((d, i) => <Circle key={i} cx={d.x} cy={d.y} r={d.r} />)}
        </G>
      </Svg>
    </Animated.View>
  );
}

export function VertexMark({ size, color, glow = false, opacity = 1, ripple = 3.2, kick }: VertexMarkProps) {
  const colors = useColors();
  const { effective } = useTheme();
  const fill = color ?? colors.markColor;
  const width = size * MARK_WIDTH;
  const height = width * (X_H / X_W);

  // ── Ripple loop (paused in the background, frozen under reduce motion) ─────
  const t = useSharedValue(0);
  const run = useCallback(() => {
    if (!ripple) return;
    t.value = 0;
    t.value = withRepeat(withTiming(1, { duration: ripple * 1000, easing: Easing.linear }), -1, false);
  }, [ripple, t]);
  useEffect(() => {
    run();
    return () => cancelAnimation(t);
  }, [run, t]);
  useLoopPause(t, run, 'VertexMark');

  // ── Tab kick: a quick scale pop ────────────────────────────────────────────
  const pop = useSharedValue(1);
  useAnimatedReaction(
    () => (kick ? kick.value : 0),
    (v, prev) => {
      if (prev !== null && v !== prev) {
        pop.value = withSequence(withTiming(1.08, { duration: 140 }), withTiming(1, { duration: 260 }));
      }
    },
  );
  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

  const blades = useMemo(
    () => (
      <Svg width={width} height={height} viewBox={`0 0 ${X_W} ${X_H}`}>
        <G fill={fill}>{X_BLADES.map((p) => <Polygon key={p} points={p} />)}</G>
      </Svg>
    ),
    [width, height, fill],
  );

  return (
    <View pointerEvents="none" style={{ width: size, height: size, opacity }}>
      {glow ? (
        <GlowOrb
          size={size * 1.6}
          color={colors.primary}
          opacity={effective === 'dark' ? 0.5 : 0.36}
          style={{ top: -size * 0.3, left: -size * 0.3 }}
        />
      ) : null}
      <Animated.View
        style={[{
          position: 'absolute', width, height,
          left: (size - width) / 2, top: (size - height) / 2,
        }, popStyle]}
      >
        {blades}
        {BAND_LAYERS.map((_, b) => (
          <RippleBand key={b} band={b} t={t} width={width} height={height} color={fill} />
        ))}
      </Animated.View>
    </View>
  );
}

export default VertexMark;

// ── Full logo: the "verte" wordmark + the X (static) ─────────────────────────
// Stroked centre-lines in the logo's own coordinate space (see
// scripts/brand_assets.py); the X sits at X_ORIGIN beside the wordmark.
const WORDMARK_E = (dx: number) =>
  `M${530 + dx} 443 H${655 + dx} C${655 + dx} 413 ${635 + dx} 395 ${604 + dx} 395 H${582 + dx} ` +
  `C${551 + dx} 395 ${530 + dx} 414 ${530 + dx} 443 C${530 + dx} 473 ${551 + dx} 492 ${582 + dx} 492 ` +
  `H${618 + dx} C${637 + dx} 492 ${649 + dx} 486 ${655 + dx} 476`;
const WORDMARK_D = [
  'M377 395 L436 490 L495 395',
  WORDMARK_E(0),
  'M695 492 V395 M695 438 C695 411 717 395 757 395',
  'M812 350 V458 C812 480 824 492 846 492 M789 395 H845',
  WORDMARK_E(348),
].join(' ');
const LOGO_BOX = { x: 360, y: 250, w: 1060, h: 390 };
const X_ORIGIN = { x: 928, y: 265 };

/** The Vertex logo lockup, `width` px wide (height follows at 390/1060). */
export function VertexLogo({ width, color }: { width: number; color?: string }) {
  const colors = useColors();
  const fill = color ?? colors.markColor;
  const height = width * (LOGO_BOX.h / LOGO_BOX.w);
  return (
    <Svg
      width={width}
      height={height}
      viewBox={`${LOGO_BOX.x} ${LOGO_BOX.y} ${LOGO_BOX.w} ${LOGO_BOX.h}`}
      accessibilityLabel="Vertex"
    >
      <Path d={WORDMARK_D} fill="none" stroke={fill} strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" />
      <G fill={fill} transform={`translate(${X_ORIGIN.x} ${X_ORIGIN.y})`}>
        {X_BLADES.map((p) => <Polygon key={p} points={p} />)}
        {X_DOTS.map((d, i) => <Circle key={i} cx={d.x} cy={d.y} r={d.r} />)}
      </G>
    </Svg>
  );
}
