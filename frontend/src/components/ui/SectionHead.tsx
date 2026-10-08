/**
 * SectionHead — the heading over a group of cards.
 *
 *   <SectionHead size={22}>Quick access</SectionHead>
 *   <SectionHead size={26}>Your first 30 days — the runway</SectionHead>
 *   <SectionHead tone="ink">Sectors</SectionHead>   // on a dark block
 *
 * (Oct 2026: this was a gradient-filled Unbounded-Black headline under a
 * brand rule. The Owner asked for a cleaner, simpler app, so it is now a
 * short brand rule beside a plain heading, and every screen changed at once.
 * The props are unchanged.)
 *
 * A short label (three words or fewer) or `caps` reads as a tracked kicker,
 * the same as <Kicker>; a longer heading is a plain sentence-case title, so a
 * full sentence is never set in spaced capitals. The string itself is never
 * rewritten (caps are `textTransform` only).
 */
import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useColors, fonts } from '../../theme/ThemeContext';

export type SectionHeadProps = {
  children: string;
  /** 22 (default) for a group label; 26 for the page's main heading. */
  size?: 22 | 26;
  /** paper (default) = on page/cards; ink = on a dark block. */
  tone?: 'paper' | 'ink';
  /** Container style (margins). */
  style?: StyleProp<ViewStyle>;
  /** Clamp lines (headings wrap by default). */
  numberOfLines?: number;
  /** Force the tracked-capitals kicker treatment. */
  caps?: boolean;
};

export function SectionHead({ children, size = 22, tone = 'paper', style, numberOfLines, caps = false }: SectionHeadProps) {
  const colors = useColors();
  const color = tone === 'ink' ? colors.inkText : colors.text;
  const kicker = caps || String(children).trim().split(/\s+/).length <= 3;
  return (
    <View style={[styles.wrap, style]}>
      <View style={[styles.bar, { backgroundColor: colors.primary }]} />
      <Text
        numberOfLines={numberOfLines}
        style={kicker
          ? [styles.kicker, { color }]
          : [styles.title, { color, fontSize: size === 26 ? 20 : 17, lineHeight: size === 26 ? 26 : 23 }]}
      >
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bar: { width: 18, height: 3, borderRadius: 1.5 },
  kicker: { flexShrink: 1, fontFamily: fonts.displayWide, fontSize: 12, letterSpacing: 1.8, textTransform: 'uppercase' },
  title: { flexShrink: 1, fontFamily: fonts.display, letterSpacing: -0.2 },
});

export default SectionHead;
