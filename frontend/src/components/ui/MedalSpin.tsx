/**
 * MedalSpin — the pseudo-3D medal: a slow perspective Y-wobble plus a
 * periodic specular shine sweeping across, so the level medal reads like a
 * physical coin catching the light instead of a flat emoji. Reanimated
 * only — no 3D engine, works identically on native and the PWA.
 */
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';

export function MedalSpin({ size = 56, children }: { size?: number; children: React.ReactNode }) {
  const wobble = useSharedValue(0);
  const shine = useSharedValue(0);

  useEffect(() => {
    // A gentle breath only — the old perspective rotateY wobble skewed the
    // flat emoji glyph and read as broken rather than 3D (owner feedback).
    wobble.value = withRepeat(
      withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }), -1, true);
    // Shine: sweep, then rest — the pause is what makes the sweep read as light.
    shine.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }),
        withDelay(2600, withTiming(0, { duration: 0 })),
      ), -1, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const coin = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + wobble.value * 0.05 }],
  }));
  const sweep = useAnimatedStyle(() => ({
    transform: [
      { translateX: -size + shine.value * size * 2.4 },
      { rotate: '18deg' },
    ],
    opacity: shine.value > 0 && shine.value < 1 ? 0.85 : 0,
  }));

  return (
    <Animated.View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, coin]}>
      {children}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }}>
        <Animated.View style={[{ position: 'absolute', top: -6, width: size * 0.38, height: size * 1.4 }, sweep]}>
          <LinearGradient
            colors={['#ffffff00', '#ffffffcc', '#ffffff00']}
            start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      </View>
    </Animated.View>
  );
}
