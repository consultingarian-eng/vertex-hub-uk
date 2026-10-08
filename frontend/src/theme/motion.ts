/**
 * Motion constants + loop hygiene for the visual system.
 *
 * - MOTION: the shared springs/easings/durations (see docs: motion spec).
 * - useLoopPause: every `withRepeat` primitive registers its restart here so
 *   loops are cancelled when the app is backgrounded (or the web tab hidden)
 *   and restarted on return — no wakelocks, no battery drain from decoration.
 * - registerLoop: __DEV__-only counter that warns when a screen mounts more
 *   than LOOP_BUDGET continuous loops (the perf budget from the spec).
 *
 * Reduce motion: reanimated's ReduceMotion.System default already makes
 * withTiming jump and withRepeat finish at its start value — we respect it
 * and seed every loop's shared value at mid-phase so the frozen frame is the
 * intended composition (a ¾-view cube, a settled blob, a tilted coin).
 */
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { Easing, cancelAnimation, type SharedValue } from 'react-native-reanimated';

export const MOTION = {
  spring: { damping: 14, stiffness: 120 },   // entrances
  snappy: { damping: 16, stiffness: 180 },   // liquid indicator slide
  settle: { damping: 12 },                   // stretch settle / count-up pop
  easeOut: Easing.out(Easing.cubic),
  sine: Easing.inOut(Easing.sin),
  dur: { fast: 140, base: 360, enter: 420, charge: 900, count: 700, ring: 1100 },
} as const;

export const LOOP_BUDGET = 6;
let liveLoops = 0;
/** __DEV__ only: how many of each named loop are mounted right now. */
const liveNames = new Map<string, number>();

/** __DEV__-only: count a continuous loop for the perf budget. Returns an unregister fn. */
export function registerLoop(name: string): () => void {
  if (!__DEV__) return () => {};
  liveLoops += 1;
  liveNames.set(name, (liveNames.get(name) ?? 0) + 1);
  if (liveLoops > LOOP_BUDGET) {
    // eslint-disable-next-line no-console
    console.warn(`[motion] ${liveLoops} continuous loops mounted (budget ${LOOP_BUDGET}) — latest: ${name}`);
  }
  return () => {
    liveLoops = Math.max(0, liveLoops - 1);
    const n = (liveNames.get(name) ?? 1) - 1;
    if (n > 0) liveNames.set(name, n); else liveNames.delete(name);
  };
}

/**
 * __DEV__ only: read the live loop census from a console/QA probe —
 * `__cg1Loops()` → `{ count, budget, names }`. The warning above fires once,
 * at the moment the budget is crossed; a screen that mounts its loops in a
 * different order (or unmounts one first) can still sit over budget without
 * ever tripping it, so the census is what a QA sweep should read.
 */
if (__DEV__ && typeof globalThis !== 'undefined') {
  (globalThis as unknown as Record<string, unknown>).__cg1Loops = () => ({
    count: liveLoops,
    budget: LOOP_BUDGET,
    names: Object.fromEntries(liveNames),
  });
}

/**
 * Cancel a looping shared value while the app is in the background (or the
 * web tab is hidden) and call `restart` when it becomes active again.
 * `restart` must (re)assign the withRepeat animation to the shared value.
 */
export function useLoopPause(
  sv: SharedValue<number>,
  restart: () => void,
  name = 'loop',
  /** `register: false` when several consumers share ONE timeline and the loop is counted elsewhere. */
  options?: { register?: boolean },
) {
  const restartRef = useRef(restart);
  restartRef.current = restart;
  const counts = options?.register !== false;
  useEffect(() => {
    const unregister = counts ? registerLoop(name) : () => {};
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') restartRef.current();
      else cancelAnimation(sv);
    });
    let onVis: (() => void) | null = null;
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      onVis = () => {
        if (document.visibilityState === 'hidden') cancelAnimation(sv);
        else restartRef.current();
      };
      document.addEventListener('visibilitychange', onVis);
    }
    return () => {
      unregister();
      sub.remove();
      if (onVis) document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sv, counts]);
}
