/**
 * RankUp — the "big moment" overlay, distinct from confetti. The screen dims,
 * a gradient badge springs in with an expanding shockwave ring, title +
 * subtitle land underneath, then it dismisses itself (or on tap).
 *
 * Reserved for milestones (streak marks, Stage 1 complete, earned badges) so
 * it keeps its weight — day-to-day wins stay with ConfettiCelebration.
 *
 * Mounted ONCE globally (app/_layout.tsx) and driven by a zustand store
 * (mirrors alertStore.ts/showAlert) so any screen — or a background
 * badge-watcher — can trigger it without holding a ref:
 *
 *   useRankUpStore.getState().fire({ emoji: '🔥', title: '7-day streak!', subtitle: 'Keep showing up.' });
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat,
  interpolate, Extrapolation, Easing, runOnJS,
} from 'react-native-reanimated';
import { useColors } from '../../theme/ThemeContext';
import { GRADIENT, fonts } from '../../theme/brand';
import { haptics } from '../../utils/haptics';
import { useRankUpStore } from '../../utils/rankUpStore';
import { Aurora } from './Aurora';
import { ParticleConfetti } from './ParticleConfetti';
import { Medal3D } from './Medal3D';
import { SafeLottie } from './SafeLottie';

const AUTO_DISMISS_MS = 2600;
const LEVELUP_DISMISS_MS = 4400; // the takeover earns a longer moment

export const RankUp = function RankUp() {
  const colors = useColors();
  const storeContent = useRankUpStore((s) => s.content);
  const clear = useRankUpStore((s) => s.clear);
  const [content, setContent] = React.useState<{ emoji: string; title: string; subtitle?: string; variant?: 'default' | 'levelup' } | null>(null);
  const [burst, setBurst] = React.useState(0);
  const anim = useSharedValue(0);   // 0 hidden → 1 shown
  const wave = useSharedValue(0);   // shockwave loop
  const dismissTimer = useRef<any>(null);

  const hide = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    anim.value = withTiming(0, { duration: 320, easing: Easing.in(Easing.cubic) }, (done) => {
      if (done) runOnJS(setContent)(null);
    });
    clear();
  };

  useEffect(() => {
    if (!storeContent) return;
    haptics.heavy();
    setContent({ emoji: storeContent.emoji ?? '🏆', title: storeContent.title, subtitle: storeContent.subtitle, variant: storeContent.variant });
    setBurst((b) => b + 1);
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    anim.value = 0;
    wave.value = 0;
    anim.value = withSpring(1, { damping: 13, stiffness: 150 });
    wave.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }), 3, false);
    dismissTimer.current = setTimeout(hide, storeContent.variant === 'levelup' ? LEVELUP_DISMISS_MS : AUTO_DISMISS_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeContent]);

  const dimStyle = useAnimatedStyle(() => ({ opacity: anim.value * 0.82 }));
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: anim.value,
    transform: [
      { scale: interpolate(anim.value, [0, 1], [0.25, 1], Extrapolation.CLAMP) },
      { rotate: `${interpolate(anim.value, [0, 1], [-14, 0], Extrapolation.CLAMP)}deg` },
    ],
  }));
  const textStyle = useAnimatedStyle(() => ({
    opacity: anim.value,
    transform: [{ translateY: interpolate(anim.value, [0, 1], [18, 0], Extrapolation.CLAMP) }],
  }));
  const waveStyle = useAnimatedStyle(() => ({
    opacity: (1 - wave.value) * 0.55 * anim.value,
    transform: [{ scale: interpolate(wave.value, [0, 1], [0.7, 2.6], Extrapolation.CLAMP) }],
  }));
  const wave2Style = useAnimatedStyle(() => {
    const w = Math.max(0, wave.value - 0.25) / 0.75;
    return {
      opacity: (1 - w) * 0.35 * anim.value,
      transform: [{ scale: interpolate(w, [0, 1], [0.7, 2.1], Extrapolation.CLAMP) }],
    };
  });

  if (!content) return null;
  const isLevelUp = content.variant === 'levelup';

  return (
    <Pressable onPress={hide} style={[StyleSheet.absoluteFill, { zIndex: 10000 }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#050f0c' }, dimStyle]}>
        {isLevelUp && <Aurora />}
      </Animated.View>
      {isLevelUp && <ParticleConfetti burstKey={burst} count={110} durationMs={3600} />}
      <View style={styles.center} pointerEvents="none">
        <View style={{ width: 108, height: 108, alignItems: 'center', justifyContent: 'center' }}>
          {isLevelUp && (
            <SafeLottie
              source={require('../../../assets/lottie/starburst.json')}
              style={{ position: 'absolute', width: 300, height: 300 }}
            />
          )}
          <Animated.View style={[styles.wave, { borderColor: '#8caf38' }, waveStyle]} />
          <Animated.View style={[styles.wave, { borderColor: '#e7b65c' }, wave2Style]} />
          <Animated.View style={badgeStyle}>
            {isLevelUp ? (
              <Medal3D size={116} tint="#c9a227">
                <Text style={{ fontSize: 40 }}>{content.emoji}</Text>
              </Medal3D>
            ) : (
              <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.badge}>
                <Text style={{ fontSize: 44 }}>{content.emoji}</Text>
              </LinearGradient>
            )}
          </Animated.View>
        </View>
        <Animated.View style={[{ alignItems: 'center', marginTop: 22 }, textStyle]}>
          {isLevelUp && <Text style={styles.kicker}>LEVEL UP</Text>}
          <Text style={styles.title}>{content.title}</Text>
          {content.subtitle ? <Text style={styles.subtitle}>{content.subtitle}</Text> : null}
          {isLevelUp && <Text style={styles.tapAnywhere}>Tap anywhere to keep climbing</Text>}
        </Animated.View>
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  badge: {
    width: 108, height: 108, borderRadius: 32, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#8caf38', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.7, shadowRadius: 26, elevation: 12,
  },
  wave: { position: 'absolute', width: 108, height: 108, borderRadius: 54, borderWidth: 2.5 },
  title: {
    fontFamily: fonts.display, fontSize: 26, fontWeight: '900', color: '#ffffff',
    letterSpacing: -0.4, textAlign: 'center',
  },
  kicker: {
    fontFamily: fonts.mono, fontSize: 12, fontWeight: '800', color: '#f0c53d',
    letterSpacing: 5, marginBottom: 8,
  },
  tapAnywhere: { fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 16 },
  subtitle: {
    fontSize: 13.5, color: 'rgba(255,255,255,0.75)', marginTop: 8, textAlign: 'center',
    maxWidth: 280, lineHeight: 19,
  },
});

export default RankUp;
