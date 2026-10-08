/**
 * Keycap — a raised, bevelled tile that presses down like a keyboard key.
 *
 * The face is a vertical LinearGradient (paper: background → surfaceAlt;
 * gradient: the brand GRADIENT; green: emerald) with inset boxShadow bevels —
 * a 1px light top edge and a 3px dark bottom lip — over a soft drop shadow.
 * Press-in sinks the face 2 px (UI-thread withTiming, 90 ms) and swaps the
 * shadow string to a 1 px lip: boxShadow strings are not interpolatable, so
 * the swap is a React state toggle on pressIn/pressOut (spec §3.12).
 *
 *   <Keycap size={64} radius={16} onPress={open}><Ionicons … /></Keycap>     // Profile tiles
 *   <Keycap size={56} tone="green">{'💰'}</Keycap>                            // Pay payday node
 *   <Keycap size={30} tone={done ? 'gradient' : 'paper'} onPress={toggle} />  // COD K·D·D ticks
 *
 * Static cost only (no loops); ≤12 per screen. Without `onPress` it renders a
 * plain View with the raised shadow — no Pressable, no animation.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { GestureResponderEvent, PressableProps, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { GRADIENT, useColors, useTheme } from '../../theme/ThemeContext';
import PressableScale from './PressableScale';

// ── Public types ─────────────────────────────────────────────────────────────
export type KeycapTone = 'paper' | 'gradient' | 'green';

export type KeycapProps = {
  /** Width and height in px (default 56). */
  size?: number;
  /** Corner radius (default ≈ size × 0.27). */
  radius?: number;
  /** paper (default) = themed tile; gradient = brand GRADIENT; green = emerald (payday / done). */
  tone?: KeycapTone;
  onPress?: PressableProps['onPress'];
  onLongPress?: PressableProps['onLongPress'];
  children?: React.ReactNode;
  /** Outer style: margins, alignSelf, position. */
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
};

// ── Shadows ──────────────────────────────────────────────────────────────────
type ShadowPair = { up: string; down: string };

const GREEN_GRADIENT = ['#34d399', '#059669'] as const;
const PRESS_MS = 90;
const PRESS_DEPTH = 2;

/**
 * Bevel + drop shadow strings per theme/tone. `up` has the 3 px bottom lip,
 * `down` a 1 px lip and a shorter drop (the key is sitting in its well).
 */
function keycapShadows(tone: KeycapTone, isDark: boolean): ShadowPair {
  if (tone === 'paper') {
    return isDark
      ? {
        up: 'inset 0 1px 0 rgba(183,223,88,.35), inset 0 -3px 0 rgba(0,0,0,.5), 0 6px 12px -6px rgba(0,0,0,.6)',
        down: 'inset 0 1px 0 rgba(183,223,88,.25), inset 0 -1px 0 rgba(0,0,0,.5), 0 2px 6px -4px rgba(0,0,0,.6)',
      }
      : {
        up: 'inset 0 1px 0 rgba(255,255,255,.75), inset 0 -3px 0 rgba(16,45,37,.28), 0 6px 12px -6px rgba(16,45,37,.35)',
        down: 'inset 0 1px 0 rgba(255,255,255,.55), inset 0 -1px 0 rgba(16,45,37,.28), 0 2px 6px -4px rgba(16,45,37,.35)',
      };
  }
  // Coloured faces: white top edge, black lip, a tinted drop shadow.
  const glow = tone === 'green' ? 'rgba(16,185,129,.55)' : 'rgba(58,122,86,.55)';
  return {
    up: `inset 0 1px 0 rgba(255,255,255,.45), inset 0 -3px 0 rgba(0,0,0,.35), 0 6px 12px -6px ${glow}`,
    down: `inset 0 1px 0 rgba(255,255,255,.3), inset 0 -1px 0 rgba(0,0,0,.35), 0 2px 6px -4px ${glow}`,
  };
}

// ── Keycap ───────────────────────────────────────────────────────────────────
export function Keycap({
  size = 56, radius, tone = 'paper', onPress, onLongPress, children, style,
  disabled = false, testID, accessibilityLabel,
}: KeycapProps) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';

  const r = radius ?? Math.round(size * 0.27);
  const shadows = useMemo(() => keycapShadows(tone, isDark), [tone, isDark]);
  const stops = tone === 'gradient' ? GRADIENT : tone === 'green' ? GREEN_GRADIENT : ([colors.background, colors.surfaceAlt] as const);

  // Press-in: 2 px sink on the UI thread + shadow string swap in state.
  const [pressed, setPressed] = useState(false);
  const sink = useSharedValue(0);
  const sinkStyle = useAnimatedStyle(() => ({ transform: [{ translateY: sink.value }] }));

  const handlePressIn = useCallback((_e: GestureResponderEvent) => {
    sink.value = withTiming(PRESS_DEPTH, { duration: PRESS_MS });
    setPressed(true);
  }, [sink]);
  const handlePressOut = useCallback((_e: GestureResponderEvent) => {
    sink.value = withTiming(0, { duration: PRESS_MS });
    setPressed(false);
  }, [sink]);

  const faceStyle: ViewStyle = {
    width: size,
    height: size,
    borderRadius: r,
    boxShadow: pressed ? shadows.down : shadows.up,
    // Solid base so the bevels and drop shadow always have a body to sit on.
    backgroundColor: tone === 'paper' ? colors.background : stops[1],
  };

  const face = (
    <Animated.View style={[faceStyle, styles.face, sinkStyle]}>
      <LinearGradient
        pointerEvents="none"
        colors={stops}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={[StyleSheet.absoluteFill, { borderRadius: r }]}
      />
      {children}
    </Animated.View>
  );

  const interactive = !!onPress || !!onLongPress;
  if (!interactive) {
    return (
      <View style={style} testID={testID} accessibilityLabel={accessibilityLabel}>
        {face}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      scaleTo={0.97}
      glow={false}
      hitSlop={size < 44 ? Math.ceil((44 - size) / 2) : undefined}
      style={[style, disabled ? styles.disabled : null]}
    >
      {face}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  face: { alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.5 },
});

export default Keycap;
