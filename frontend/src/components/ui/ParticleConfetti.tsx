/**
 * ParticleConfetti — cross-platform confetti burst built on reanimated, so
 * the PWA celebrates too (react-native-confetti-cannon renders nothing
 * reliable on web, which silently muted every level-up for web users).
 *
 * Fire-and-forget: mount with a fresh `burstKey` and it plays once —
 * pieces launch from the top, sway as they fall, spin on two axes and fade.
 */
import React, { useEffect, useMemo } from 'react';
import { Dimensions, View } from 'react-native';
import Animated, {
  Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming,
} from 'react-native-reanimated';

const COLORS = ['#b7df58', '#8caf38', '#3a7a56', '#e7b65c', '#f0f4e9', '#22d3ee', '#f59e0b', '#ec4899'];

function Piece({ index, durationMs }: { index: number; durationMs: number }) {
  const { width, height } = Dimensions.get('window');
  // Deterministic-ish variety without Math.random storms on re-render.
  const seed = useMemo(() => ({
    x: Math.random() * width,
    delay: Math.random() * 500,
    fall: durationMs * (0.65 + Math.random() * 0.5),
    swayW: 24 + Math.random() * 46,
    swayMs: 520 + Math.random() * 620,
    size: 6 + Math.random() * 7,
    color: COLORS[index % COLORS.length],
    spinMs: 380 + Math.random() * 520,
    round: Math.random() > 0.6,
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const fall = useSharedValue(0);
  const sway = useSharedValue(0);
  const spin = useSharedValue(0);

  useEffect(() => {
    fall.value = withDelay(seed.delay, withTiming(1, { duration: seed.fall, easing: Easing.in(Easing.quad) }));
    sway.value = withRepeat(withTiming(1, { duration: seed.swayMs, easing: Easing.inOut(Easing.sin) }), -1, true);
    spin.value = withRepeat(withTiming(1, { duration: seed.spinMs, easing: Easing.linear }), -1, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: -20 + fall.value * (height + 60) },
      { translateX: (sway.value - 0.5) * seed.swayW },
      { rotate: `${spin.value * 360}deg` },
      { rotateX: `${spin.value * 540}deg` },
    ],
    opacity: fall.value < 0.75 ? 1 : Math.max(0, (1 - fall.value) / 0.25),
  }));

  return (
    <Animated.View
      style={[{
        position: 'absolute', top: 0, left: seed.x,
        width: seed.size, height: seed.round ? seed.size : seed.size * 1.9,
        borderRadius: seed.round ? seed.size / 2 : 2,
        backgroundColor: seed.color,
      }, style]}
    />
  );
}

export function ParticleConfetti({ burstKey, count = 90, durationMs = 3200 }: {
  burstKey: number | string; count?: number; durationMs?: number;
}) {
  return (
    <View key={String(burstKey)} pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
      {Array.from({ length: count }, (_, i) => (
        <Piece key={i} index={i} durationMs={durationMs} />
      ))}
    </View>
  );
}
