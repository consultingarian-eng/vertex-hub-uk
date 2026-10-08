/**
 * ConfettiCelebration — fire-and-forget confetti burst from the top.
 * Backed by react-native-confetti-cannon, but works on web too via a
 * graceful fallback (the confetti just doesn't render on web).
 *
 * Usage:
 *   const confettiRef = useRef<ConfettiCelebrationHandle>(null);
 *   <ConfettiCelebration ref={confettiRef} />
 *   confettiRef.current?.fire();
 */
import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Platform, View, Dimensions } from 'react-native';
import ConfettiCannon from 'react-native-confetti-cannon';
import { ParticleConfetti } from './ParticleConfetti';
import { haptics } from '../../utils/haptics';

export type ConfettiCelebrationHandle = {
  fire: () => void;
};

type Props = {
  count?: number;
  durationMs?: number;
};

export const ConfettiCelebration = forwardRef<ConfettiCelebrationHandle, Props>(function ConfettiCelebration({ count = 140, durationMs = 3500 }, ref) {
  const [visible, setVisible] = useState(false);
  const [key, setKey] = useState(0);
  const cannonRef = useRef<any>(null);
  const { width } = Dimensions.get('window');

  useImperativeHandle(ref, () => ({
    fire: () => {
      haptics.heavy();
      setKey((k) => k + 1);
      setVisible(true);
      // hide after duration so consecutive fires work cleanly
      setTimeout(() => setVisible(false), durationMs);
    },
  }), [durationMs]);

  if (!visible) return null;

  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 }}>
      {Platform.OS === 'web' ? (
        // ConfettiCannon never rendered reliably on web — which silently
        // muted every celebration on the PWA, our primary surface. The
        // reanimated particle burst plays everywhere.
        <ParticleConfetti burstKey={key} count={count} />
      ) : (
        <ConfettiCannon
          key={key}
          count={count}
          origin={{ x: width / 2, y: -10 }}
          fadeOut
          autoStart
          fallSpeed={2800}
          colors={['#b7df58', '#8caf38', '#3a7a56', '#e7b65c', '#f0f4e9', '#22d3ee']}
          ref={cannonRef}
        />
      )}
    </View>
  );
});
