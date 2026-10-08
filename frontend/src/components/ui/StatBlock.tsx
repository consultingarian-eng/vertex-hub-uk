/**
 * StatBlock — oversized glowing numerals (the game-HUD number).
 *
 *   <StatBlock value={12} label="Sectors" tone="ink" size={34} />
 *   <StatBlock value={4.6} decimals={1} label="Piece avg" size={26} accent />
 *   <StatBlock value={1240} prefix="£" decimals={2} label="This week" size={46} gradient />
 *
 * Render: an AnimatedNumber (UI-thread count-up) in fonts.displayBlack,
 * letterSpacing −1, primary (paper) / inkText (ink); a mono uppercase label;
 * an optional 24×2 brand-gradient accent bar between them.
 *
 * Glow: Android's TextInput ignores text-shadow props, so the glow is a
 * duplicate solid Text behind the numeral (purple fill at 0.35 with a
 * colors.glow text-shadow) that lights up when the count lands — the number
 * "lands and glows" together with the pop, identically on iOS, Android and web.
 *
 * `gradient`: static value only. The solid count-up runs first; when it lands
 * a GradientText of the final value (with its own glow) crossfades in on top
 * and the solid fades out. Live numbers never render inside a mask (Android
 * masked-view flicker), which is why the two are separate layers.
 *
 * The pop (1 → 1.08 → spring 1) is applied to the whole numeral stack here,
 * so the AnimatedNumber inside runs with pop={false}.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { LayoutChangeEvent, StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming,
} from 'react-native-reanimated';
import { useColors, fonts, brand, GRADIENT, GRADIENT_TEXT } from '../../theme/ThemeContext';
import { MOTION } from '../../theme/motion';
import { AnimatedNumber, formatAnimatedNumber } from './AnimatedNumber';
import { GradientText } from './GradientText';

export type StatBlockProps = {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  /** Thousands separators in the counted figure ("£1,240.00"). Default false. */
  grouping?: boolean;
  label: string;
  /** Numeral font size (default 34). */
  size?: 26 | 34 | 46 | 56;
  /** paper = on cards/page (primary numeral), ink = on ink/pop blocks (inkText numeral). */
  tone?: 'paper' | 'ink';
  /** Gradient-filled final value (static overlay after the count lands). Default false. */
  gradient?: boolean;
  /** 24×2 brand-gradient bar under the number (default true). */
  accent?: boolean;
  /** Default 'center' (tiles); 'left' for inline/editorial placements. */
  align?: 'center' | 'left';
  /** Container style (margins, flex). */
  style?: StyleProp<ViewStyle>;
};

const COUNT_MS = MOTION.dur.count;
const FADE_MS = 240;

export function StatBlock({
  value, prefix = '', suffix = '', decimals = 0, grouping = false, label,
  size = 34, tone = 'paper', gradient = false, accent = true, align = 'center', style,
}: StatBlockProps) {
  const colors = useColors();
  const ink = tone === 'ink';
  const target = Number.isFinite(value) ? value : 0;
  const finalText = formatAnimatedNumber(target, prefix, suffix, decimals, grouping);

  const numeral: TextStyle = useMemo(() => ({
    fontFamily: fonts.displayBlack, // never add fontWeight to Unbounded (web faux-bold)
    fontSize: size,
    letterSpacing: -1,
    color: ink ? colors.inkText : colors.primary,
    textAlign: align,
    // Round-2 review, finding 8 asked for tabular/slashed figures here so a
    // bare "0" stops reading as a letter O. TRIED AND REVERTED: the numeral is
    // rendered by AnimatedNumber's UI-thread TextInput, and this module's own
    // contract already warns that a `fontVariant` array mis-sizes that input
    // (see AnimatedNumber's header, `legacy`). It does: with
    // fontVariant/fontFeatureSettings on, the glow twin and the input picked up
    // different glyph advances and the ink stage hero rendered "17" and "0%"
    // with hard purple discs beside them (verified in dark /progress). Unbounded
    // also ships no `zero` feature, so the slash was never going to arrive —
    // and swapping a lone zero to fonts.displayWide would put one tile of a
    // three-tile row in a different typeface. Left as authored.
  }), [size, ink, colors.inkText, colors.primary, align]);

  const gradientStops = ink ? GRADIENT_TEXT : colors.titleGradient;

  // ── landing choreography (all UI thread) ──
  const scale = useSharedValue(1);
  const solid = useSharedValue(1);   // count-up layer opacity
  const ghost = useSharedValue(0);   // glow ghost opacity (solid mode)
  const grad = useSharedValue(0);    // gradient overlay opacity (gradient mode)
  const prevRef = useRef(0);

  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = target;
    const landed = from === target; // nothing to count → show the resting state now
    const delay = landed ? 0 : COUNT_MS;

    if (!landed) {
      // Reset to the "counting" state, then land after the count.
      solid.value = 1;
      ghost.value = 0;
      grad.value = 0;
      scale.value = withDelay(
        COUNT_MS,
        withSequence(withTiming(1.08, { duration: 120 }), withSpring(1, MOTION.settle)),
      );
    }
    if (gradient) {
      grad.value = withDelay(delay, withTiming(1, { duration: FADE_MS }));
      solid.value = withDelay(delay, withTiming(0, { duration: FADE_MS }));
      ghost.value = 0;
    } else {
      ghost.value = withDelay(delay, withTiming(0.35, { duration: FADE_MS }));
      solid.value = 1;
      grad.value = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, gradient]);

  // The pop scales from the glyph anchor: left-aligned numerals hold their
  // left edge instead of drifting. A translateX compensation does that
  // WITHOUT the RN `transformOrigin` style key, which react-native-web
  // forwards to the DOM node (React then logs "Invalid DOM property
  // `transform-origin`" on every dev render). translate-then-scale maps a
  // point p from the box centre to t + s·p, so holding the left edge means
  // t = (s − 1)·w/2; native behaves the same.
  const stackW = useSharedValue(0);
  const onStackLayout = useCallback((e: LayoutChangeEvent) => {
    stackW.value = e.nativeEvent.layout.width;
  }, [stackW]);
  const leftAnchored = align !== 'center';
  const popStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: leftAnchored ? ((scale.value - 1) * stackW.value) / 2 : 0 },
      { scale: scale.value },
    ],
  }), [leftAnchored]);
  const solidStyle = useAnimatedStyle(() => ({ opacity: solid.value }));
  const ghostStyle = useAnimatedStyle(() => ({ opacity: ghost.value }));
  const gradStyle = useAnimatedStyle(() => ({ opacity: grad.value }));

  const alignItems = align === 'center' ? 'center' : 'flex-start';

  return (
    <View style={[{ alignItems }, style]}>
      <Animated.View style={popStyle} onLayout={leftAnchored ? onStackLayout : undefined}>
        {/* Glow ghost — lights up when the count lands (solid mode). */}
        {!gradient ? (
          <Animated.Text
            numberOfLines={1}
            aria-hidden
            style={[numeral, styles.ghost, { textShadowColor: colors.glow }, ghostStyle]}
          >
            {finalText}
          </Animated.Text>
        ) : null}
        <Animated.View style={solidStyle}>
          <AnimatedNumber
            value={target}
            prefix={prefix}
            suffix={suffix}
            decimals={decimals}
            grouping={grouping}
            duration={COUNT_MS}
            style={numeral}
            pop={false}
          />
        </Animated.View>
        {gradient ? (
          <Animated.View style={[StyleSheet.absoluteFill, styles.overlay, gradStyle]} aria-hidden>
            <GradientText colors={gradientStops} style={numeral} numberOfLines={1} glow>
              {finalText}
            </GradientText>
          </Animated.View>
        ) : null}
      </Animated.View>

      {accent ? (
        <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.accent} />
      ) : null}

      <Text
        numberOfLines={1}
        style={[styles.label, { color: ink ? colors.inkMuted : colors.textMuted, textAlign: align }]}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * Headroom around the glow twin, px.
 *
 * Round-2 review, finding 9: the numeral glow rendered as a rectangular halo
 * with hard vertical edges (sampled behind Pay's "$77.00" in dark: card face
 * rgb(12,26,20), box rgb(16,34,26), a hard left edge inside three pixels).
 * The cause is the clip, not the shadow — a single-line Text sets
 * `overflow: hidden`, so a 12-14 px blur that spreads past the glyph box is
 * sliced off square at the box edge. The twin is inset NEGATIVELY by this much
 * and given matching padding, so the content box lands exactly where it did
 * and the blur has room to fall off inside the clip.
 */
const GLOW_PAD = 18;

const styles = StyleSheet.create({
  ghost: {
    position: 'absolute',
    top: -GLOW_PAD,
    left: -GLOW_PAD,
    right: -GLOW_PAD,
    bottom: -GLOW_PAD,
    padding: GLOW_PAD,
    // react-native-web's Text base style carries `max-width: 100%`, which
    // clamps this absolutely-inset box back to the numeral's own width — the
    // content box then collapses to a few px, the string overflows and rnw
    // draws its ellipsis dots (three purple discs beside the number, seen on
    // the COD ink stage hero). An explicit maxWidth wins over the base class,
    // so the border box really is PAD wider on every side and the content box
    // lands exactly where it did.
    maxWidth: 9999,
    color: brand.limeDark,
    textShadowRadius: 14,
    textShadowOffset: { width: 0, height: 0 },
  },
  overlay: { justifyContent: 'center', pointerEvents: 'none' },
  accent: { width: 24, height: 2, borderRadius: 1, marginTop: 8 },
  label: {
    marginTop: 6,
    fontFamily: fonts.mono,
    fontSize: 10.5,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
});

export default StatBlock;
