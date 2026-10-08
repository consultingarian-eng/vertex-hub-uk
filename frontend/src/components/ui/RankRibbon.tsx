/**
 * RankRibbon — a folded banner label for ranks, stages and "YOU ARE HERE"
 * (spec §3.11).
 *
 *   <RankRibbon tint="purple">You are here</RankRibbon>
 *   <RankRibbon tint="gold" size="sm">Level 4 · Closer</RankRibbon>
 *
 * The text (fonts.displayWide, uppercase via textTransform — copy unchanged)
 * sits in normal flow with 14 px side padding, so the container hugs it;
 * one onLayout captures the container width and an absolutely-positioned Svg
 * draws the banner to that width: a swallowtail Path (notched ends), two
 * darker fold polygons where the tails turn under, a satin highlight along
 * the top and a shade line along the bottom. Static — no loops, no shadows
 * (≤10 per screen, list rows keep plain chips).
 *
 * Contrast: plum ink on gold/amber (≥5.8:1 on the darkest stop), white on
 * purple/green/cyan (≥4.7:1 on the lightest stop) — all tints AA at 10–11 px.
 */
import React, { useCallback, useState } from 'react';
import { LayoutChangeEvent, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Polygon, Stop } from 'react-native-svg';
import { GRADIENT_GOLD, fonts } from '../../theme/ThemeContext';

export type RankRibbonTint = 'purple' | 'gold' | 'green' | 'amber' | 'cyan';

export type RankRibbonProps = {
  tint: RankRibbonTint;
  /** 'sm' = 22 px tall / 10 px type, 'md' (default) = 26 px / 11 px. */
  size?: 'sm' | 'md';
  /** Label — rendered uppercase via textTransform, string unchanged. */
  children: string;
  /** Container style (margins, alignSelf). */
  style?: StyleProp<ViewStyle>;
};

const INK = '#0b211c';
const PAD_X = 14;                       // 28 px total = the spec's "width + 28"
const SIZES = { sm: { h: 22, font: 10 }, md: { h: 26, font: 11 } } as const;

const TINTS: Record<RankRibbonTint, { stops: readonly string[]; text: string }> = {
  purple: { stops: ['#3a7a56', '#2f6a4b', '#244c3b'], text: '#ffffff' }, // white 5.1 / 6.6 / 9.0
  gold:   { stops: GRADIENT_GOLD,                     text: INK },       // ink 16.7 / 11.6 / 5.9
  green:  { stops: ['#0b8457', '#047857', '#065f46'], text: '#ffffff' }, // white 4.7 / 5.5 / 7.7
  amber:  { stops: ['#fcd34d', '#f59e0b', '#d97706'], text: INK },       // ink 13.2 / 8.9 / 6.0
  cyan:   { stops: ['#107a94', '#0e7490', '#0d6a86'], text: '#ffffff' }, // white 5.0 / 5.4 / 6.1
};

export function RankRibbon({ tint, size = 'md', children, style }: RankRibbonProps) {
  const { h: H, font } = SIZES[size];
  const { stops, text } = TINTS[tint];
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradId = `rr${uid}`;

  // Measure once per width — the text defines the box, the Svg follows it.
  const [W, setW] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setW((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
  }, []);

  // Banner geometry: notch depth n, fold crease c.
  const n = H * 0.32;
  const c = H * 0.18;
  const mid = H / 2;
  const banner = W > 0
    ? `M0 0 H${W} L${(W - n).toFixed(2)} ${mid} L${W} ${H} H0 L${n.toFixed(2)} ${mid} Z`
    : '';
  const leftFold = `0,0 ${(n + c).toFixed(2)},0 ${(n + c).toFixed(2)},${H} 0,${H} ${n.toFixed(2)},${mid}`;
  const rightFold = `${W},0 ${(W - n - c).toFixed(2)},0 ${(W - n - c).toFixed(2)},${H} ${W},${H} ${(W - n).toFixed(2)},${mid}`;
  const stopCount = stops.length;

  return (
    <View
      onLayout={onLayout}
      accessibilityRole="text"
      style={[styles.wrap, { height: H, paddingHorizontal: PAD_X }, style]}
    >
      {W > 0 ? (
        <Svg pointerEvents="none" width={W} height={H} style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={gradId} x1={0} y1={0} x2={1} y2={0}>
              {stops.map((col, i) => (
                <Stop key={i} offset={`${Math.round((i / (stopCount - 1)) * 100)}%`} stopColor={col} />
              ))}
            </LinearGradient>
          </Defs>
          <Path d={banner} fill={`url(#${gradId})`} />
          {/* Folded tails: 60 % darkness where the ribbon turns under. */}
          <Polygon points={leftFold} fill="#000000" fillOpacity={0.4} />
          <Polygon points={rightFold} fill="#000000" fillOpacity={0.4} />
          {/* Satin highlight along the top of the body, shade along the bottom. */}
          <Path d={`M${(n + c).toFixed(2)} 0.75 H${(W - n - c).toFixed(2)}`} stroke="#ffffff" strokeOpacity={0.35} strokeWidth={1} />
          <Path d={`M${(n + c).toFixed(2)} ${H - 0.75} H${(W - n - c).toFixed(2)}`} stroke="#000000" strokeOpacity={0.22} strokeWidth={1} />
        </Svg>
      ) : null}
      <Text
        numberOfLines={1}
        style={{
          fontFamily: fonts.displayWide, // never add fontWeight to Unbounded
          fontSize: font,
          letterSpacing: 1.4,
          textTransform: 'uppercase',
          color: text,
          includeFontPadding: false,
          textAlign: 'center',
        }}
      >
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default RankRibbon;
