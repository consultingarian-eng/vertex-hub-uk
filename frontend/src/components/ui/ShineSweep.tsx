/**
 * ShineSweep — a periodic specular gleam that sweeps across whatever it
 * overlays (parent needs overflow:'hidden'). The #1 leaderboard row wears
 * it like a gold card catching the light. Reanimated only.
 *
 * ONE CLOCK FOR EVERY PULSE (the budget fix, round 2). A single module-level
 * linear phase — `usePulseClock`, exported for `Breathe` — drives every sweep
 * AND every breathing CTA, whatever their periods. Each consumer maps the
 * shared seconds counter onto its own cycle (`frac(clock / cycleS)`) and
 * offsets its phase inside it, so gleams still stagger instead of flashing in
 * unison while the screen runs exactly ONE repeating timeline.
 *
 *   round 1: one clock per period  → trainee Home 11 → 8 loops
 *   round 2: one clock, full stop  → trainee Home 8 → 7, COD 7 → 6
 *
 * A GlowButton is the reason this matters: it wears a sweep AND a Breathe, so
 * the app's primary CTA used to cost two of the six loops a screen may spend.
 * It now costs a share of one.
 *
 * Why 462 s: the shared span has to be a whole number of cycles for EVERY
 * consumer, or the sawtooth wrap would jump mid-gleam. 462 s = 66 × 7.0 s
 * (a 6 s sweep), 105 × 4.4 s (the 3.4 s default) and 110 × 4.2 s (Breathe's
 * 2.1 s half-cycle). A cycle that does NOT divide it transparently falls back
 * to its own private clock, so an unusual `periodMs` is still correct — it
 * just costs its own loop, and says so in the census.
 *
 * Paused via useLoopPause (spec §5 names this primitive explicitly): the
 * clock is cancelled when the app backgrounds or the tab hides and resumes
 * from the phase it was cancelled at, so it cannot keep animating in a rep's
 * pocket all day. The loop is registered with the __DEV__ budget registry
 * once per clock (honestly: one timeline, one loop).
 *
 * Reduce motion: withRepeat freezes the clock at its start value and every
 * sweep's phase offset sits inside the IDLE part of its cycle, so a frozen
 * frame shows no half-drawn gleam — exactly what it showed before.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing, cancelAnimation, makeMutable, useAnimatedStyle, withRepeat, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { registerLoop, useLoopPause } from '../../theme/motion';

/** How long one gleam takes to cross the face; `periodMs` is the idle gap after it. */
const SWEEP_MS = 1000;

// ── The shared pulse clock ───────────────────────────────────────────────────
/** Shared span in seconds — a whole number of cycles for every stock period. */
const SPAN_S = 462;

type PulseClock = {
  /** Seconds, sawtooth over `spanS`, repeating. */
  sv: SharedValue<number>;
  spanS: number;
  refs: number;
  unregister: (() => void) | null;
  name: string;
};

const master: PulseClock = {
  sv: makeMutable(0), spanS: SPAN_S, refs: 0, unregister: null, name: 'PulseClock',
};
/** Private clocks for cycles that don't divide the shared span (rare). */
const oddClocks = new Map<number, PulseClock>();

function dividesSpan(cycleS: number): boolean {
  if (!(cycleS > 0) || !Number.isFinite(cycleS)) return false;
  const n = SPAN_S / cycleS;
  return Math.abs(n - Math.round(n)) < 1e-9;
}

function clockFor(cycleS: number): PulseClock {
  if (dividesSpan(cycleS)) return master;
  let c = oddClocks.get(cycleS);
  if (!c) {
    c = {
      sv: makeMutable(0), spanS: cycleS, refs: 0, unregister: null,
      name: `PulseClock@${cycleS}s`,
    };
    oddClocks.set(cycleS, c);
  }
  return c;
}

/**
 * Resume from where the clock was cancelled, modulo the span, so a
 * background/visibility pause never jumps a gleam or a breath mid-stride.
 * The span is a whole number of cycles, so the sawtooth wrap is seamless from
 * any offset.
 */
function startClock(c: PulseClock) {
  const from = c.sv.value % c.spanS;
  c.sv.value = from;
  c.sv.value = withRepeat(
    withTiming(from + c.spanS, { duration: c.spanS * 1000, easing: Easing.linear }),
    -1,
    false,
  );
}

export type PulseCycle = {
  /** Seconds since the clock's span began (sawtooth). */
  sv: SharedValue<number>;
  /** This consumer's cycle length in seconds: `frac(sv.value / cycleS)` is its 0→1 phase. */
  cycleS: number;
};

/**
 * Subscribe to (and, for the first subscriber, start) the pulse clock for a
 * cycle length. Shared with every other consumer of the same clock — the loop
 * is registered once, not once per component.
 */
export function usePulseClock(cycleMs: number): PulseCycle {
  const cycleS = cycleMs / 1000;
  const clock = useMemo(() => clockFor(cycleS), [cycleS]);
  const run = useCallback(() => startClock(clock), [clock]);

  useEffect(() => {
    clock.refs += 1;
    if (clock.refs === 1) {
      clock.unregister = registerLoop(clock.name);
      startClock(clock);
    }
    return () => {
      clock.refs -= 1;
      if (clock.refs === 0) {
        cancelAnimation(clock.sv);
        clock.unregister?.();
        clock.unregister = null;
      }
    };
  }, [clock]);

  // AppState/visibility pause for the shared clock. `register: false` — the
  // loop is counted once above, not once per consumer.
  useLoopPause(clock.sv, run, clock.name, { register: false });

  return { sv: clock.sv, cycleS };
}

/** Stable-per-instance phase spread, so sweeps on one screen don't fire together. */
let instanceSeq = 0;

export function ShineSweep({ periodMs = 3400, tint = '#ffffff' }: { periodMs?: number; tint?: string }) {
  const { sv, cycleS } = usePulseClock(SWEEP_MS + periodMs);

  // Fraction of the cycle the gleam is actually crossing; the rest is idle.
  const sweepFraction = SWEEP_MS / (SWEEP_MS + periodMs);
  // Phase offset parked INSIDE the idle window (see "Reduce motion" above).
  const offsetRef = useRef<number | null>(null);
  if (offsetRef.current === null) {
    const idle = Math.max(0.001, 1 - sweepFraction);
    instanceSeq += 1;
    offsetRef.current = sweepFraction + ((instanceSeq * 0.37) % idle);
  }
  const offset = offsetRef.current;

  const style = useAnimatedStyle(() => {
    const raw = sv.value / cycleS + offset;
    const local = raw - Math.floor(raw);
    if (local >= sweepFraction) {
      return { opacity: 0, transform: [{ translateX: -80 }, { rotate: '16deg' }] };
    }
    const p = local / sweepFraction;
    // Easing.inOut(quad), inlined so the worklet needs no easing object.
    const e = p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
    return { opacity: 0.5, transform: [{ translateX: -80 + e * 480 }, { rotate: '16deg' }] };
  }, [offset, sweepFraction, cycleS]);

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { width: 64 }, style]}>
      <LinearGradient
        colors={['#ffffff00', tint + 'B3', '#ffffff00']}
        start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
        style={{ flex: 1 }}
      />
    </Animated.View>
  );
}
