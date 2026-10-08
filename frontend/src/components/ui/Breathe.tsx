/**
 * Breathe — a barely-there scale pulse for THE primary action on a screen
 * (one per screen, or it means nothing). Draws the eye without shouting.
 *
 * Rides the SHARED pulse clock (`usePulseClock`, ShineSweep.tsx) instead of
 * owning a `withRepeat` of its own: a GlowButton wears a ShineSweep gleam AND
 * this pulse, which used to cost the screen TWO of its six continuous loops
 * for one button. Both now read one repeating timeline, so the pair costs a
 * share of one — measured on trainee Home (8 loops → 7) and COD (7 → 6).
 *
 * The clock is cancelled when the app backgrounds or the tab hides and
 * resumes from the phase it was cancelled at (useLoopPause, inside the hook),
 * so a GlowButton left on screen cannot animate in a rep's pocket all day.
 * The loop is registered with the __DEV__ budget registry once per clock, so
 * the census counts the timeline honestly rather than once per breath.
 *
 * Motion shape: scale = 1 + amount·(0.5 + 0.5·sin(2π·phase)), i.e. a true
 * sine over `periodMs` up and `periodMs` back — the same slow swell the eased
 * withRepeat/reverse produced, seeded MID-phase so a reduce-motion freeze
 * sits halfway between the extremes instead of at a hard edge.
 */
import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { usePulseClock } from './ShineSweep';

const TWO_PI = Math.PI * 2;

export function Breathe({ children, style, amount = 0.032, periodMs = 2100 }: {
  children: React.ReactNode; style?: StyleProp<ViewStyle>; amount?: number; periodMs?: number;
}) {
  // A full breath is out-and-back: two `periodMs` halves.
  const { sv, cycleS } = usePulseClock(periodMs * 2);

  const anim = useAnimatedStyle(() => {
    const raw = sv.value / cycleS;
    const u = raw - Math.floor(raw);
    const t = 0.5 + 0.5 * Math.sin(u * TWO_PI);
    return { transform: [{ scale: 1 + t * amount }] };
  }, [amount, cycleS]);

  return <Animated.View style={[style, anim]}>{children}</Animated.View>;
}
