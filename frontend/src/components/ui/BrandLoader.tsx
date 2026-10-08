/**
 * BrandLoader — the loading state: a trail of the logo's halftone dots,
 * shrinking left to right, with a brightness wave running along it (one
 * shared value, one style worklet per dot, paused in the background). An
 * optional mono label sits underneath.
 *
 * Usage:
 *   <BrandLoader />                        // inline, 64px wide-ish
 *   <BrandLoader size={40} />              // compact
 *   <FullScreenLoader label="Loading…" />  // centred flex:1 takeover on the page field
 */
import React, { useCallback, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useColors } from '../../theme/ThemeContext';
import { fonts } from '../../theme/brand';
import { useLoopPause } from '../../theme/motion';

const DOTS = 7;
const PERIOD_MS = 1100;

function TrailDot({ i, t, d, color }: { i: number; t: SharedValue<number>; d: number; color: string }) {
  const style = useAnimatedStyle(() => {
    const phase = t.value - i / DOTS;
    const w = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
    return { opacity: 0.25 + 0.75 * w, transform: [{ scale: 0.85 + 0.15 * w }] };
  });
  return (
    <Animated.View style={[{ width: d, height: d, borderRadius: d / 2, backgroundColor: color }, style]} />
  );
}

export function BrandLoader({ size = 64, label }: { size?: number; label?: string }) {
  const colors = useColors();
  const t = useSharedValue(0);
  const run = useCallback(() => {
    t.value = 0;
    t.value = withRepeat(withTiming(1, { duration: PERIOD_MS, easing: Easing.linear }), -1, false);
  }, [t]);
  useEffect(() => {
    run();
    return () => cancelAnimation(t);
  }, [run, t]);
  useLoopPause(t, run, 'BrandLoader');

  // Dot diameters step down from ~22 % of `size`; the gap stays constant.
  const big = Math.max(6, size * 0.22);
  const gap = Math.max(3, size * 0.07);
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={label || 'Loading'}
        style={{ flexDirection: 'row', alignItems: 'center', gap, height: big }}
      >
        {Array.from({ length: DOTS }, (_, i) => (
          <TrailDot key={i} i={i} t={t} d={Math.max(2, big * (1 - i / (DOTS + 1)))} color={colors.markColor} />
        ))}
      </View>
      {label ? (
        <Text style={{
          marginTop: 14, fontFamily: fonts.mono, fontSize: 11, fontWeight: '700',
          color: colors.textMuted, letterSpacing: 1.5, textTransform: 'uppercase',
        }}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

export function FullScreenLoader({ label }: { label?: string }) {
  const colors = useColors();
  return (
    <View style={[StyleSheet.absoluteFill, { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.page }]}>
      <BrandLoader size={72} label={label} />
    </View>
  );
}

export default BrandLoader;
