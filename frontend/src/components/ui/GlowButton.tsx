/**
 * GlowButton — THE primary call to action on a screen.
 *
 * A PressableScale wearing the brand gradient, a periodic ShineSweep gleam and
 * a soft purple glow shadow; `breathe` adds the barely-there scale pulse for
 * the one button a screen wants you to press. Copy passes through as
 * children unchanged — hand it a plain string (house label style) or your own
 * <Text>/icon nodes.
 *
 *   <GlowButton onPress={signIn} breathe testID="login-submit">Sign in</GlowButton>
 *   <GlowButton onPress={plan} style={{ marginTop: 12 }}>
 *     <Ionicons name="calendar" size={18} color="#fff" />
 *     <Text style={styles.ctaText}>Plan Saturday now</Text>
 *   </GlowButton>
 *   <GlowButton tone="green" onPress={save}>Save</GlowButton>
 *
 * Layering: the pressable owns the radius, the glow shadow and the press
 * squish; the gradient and the sheen live in an absolute clip view INSIDE it
 * (Android clips a boxShadow under overflow:hidden, so the pressable itself
 * never clips). Loops: ShineSweep (6 s) and Breathe (2.1 s) — one primary CTA
 * per screen keeps the budget.
 */
import React, { useMemo } from 'react';
import { PressableProps, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { GRADIENT, fonts } from '../../theme/ThemeContext';
import { Breathe } from './Breathe';
import PressableScale from './PressableScale';
import { ShineSweep } from './ShineSweep';

// ── Public types ─────────────────────────────────────────────────────────────
export type GlowButtonTone = 'gradient' | 'green';

export type GlowButtonProps = {
  onPress?: PressableProps['onPress'];
  children: React.ReactNode;
  /** Outer style: margins, width, alignSelf, a custom borderRadius/padding. */
  style?: StyleProp<ViewStyle>;
  /** Slow scale pulse for the one primary CTA on the screen. */
  breathe?: boolean;
  /** Periodic specular gleam across the face (default on). */
  sheen?: boolean;
  /** 'gradient' (brand, default) or 'green' (confirm/money actions). */
  tone?: GlowButtonTone;
  testID?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
};

// ── Tones ────────────────────────────────────────────────────────────────────
// White 16px bold label is "large text" → needs ≥3:1; every stop here clears it.
const GREEN_GRADIENT = ['#0d9f6e', '#059669', '#047857'] as const;
const GLOW_SHADOW: Record<GlowButtonTone, string> = {
  gradient: '0 8px 18px rgba(58,122,86,0.45)',
  green: '0 8px 18px rgba(16,185,129,0.45)',
};
const DEFAULT_RADIUS = 16;

export function GlowButton({
  onPress, children, style, breathe = false, sheen = true, tone = 'gradient',
  testID, disabled = false, accessibilityLabel,
}: GlowButtonProps) {
  // Match the gradient/sheen corners to whatever radius the caller asked for.
  const flat = useMemo(() => (StyleSheet.flatten(style) || {}) as ViewStyle, [style]);
  const radius = typeof flat.borderRadius === 'number' ? flat.borderRadius : DEFAULT_RADIUS;
  const stops = tone === 'green' ? GREEN_GRADIENT : GRADIENT;

  const button = (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      scaleTo={0.96}
      glow={false}
      style={[
        styles.button,
        { borderRadius: radius, boxShadow: GLOW_SHADOW[tone] },
        style,
        disabled ? styles.disabled : null,
      ]}
    >
      {/* Face: gradient + sheen, clipped to the radius. */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip, { borderRadius: radius }]}>
        <LinearGradient
          colors={stops}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {/* Top-edge highlight: reads as a lit bevel on both gradients. */}
        <View style={styles.bevel} />
        {sheen ? <ShineSweep periodMs={6000} /> : null}
      </View>
      {/* Copy — a bare string gets the house label; nodes render untouched. */}
      {typeof children === 'string' || typeof children === 'number'
        ? <Text style={styles.label} numberOfLines={1}>{children}</Text>
        : children}
    </PressableScale>
  );

  return breathe ? <Breathe>{button}</Breathe> : button;
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
    paddingHorizontal: 22,
    minHeight: 52,
  },
  clip: { overflow: 'hidden' },
  bevel: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.28)' },
  label: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    letterSpacing: 0.2,
    color: '#ffffff',
    textAlign: 'center',
  },
  disabled: { opacity: 0.5 },
});

export default GlowButton;
