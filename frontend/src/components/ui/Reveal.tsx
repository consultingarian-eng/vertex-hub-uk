/**
 * Reveal — staggered tilt-in entrance for cards/sections (spec §3.17).
 *
 * Wrap any block to make it tilt into place when the screen mounts: it
 * fades in (420 ms ease-out) while a spring carries it from a 14° backward
 * lean, 36 px down and 96 % scale to rest. Pass `index` to stagger siblings
 * (each index adds 70 ms) so lists of cards cascade instead of appearing as
 * a wall of text.
 *
 *   <Reveal index={0}><HeroCard /></Reveal>
 *   <Reveal index={1}><StatsRow /></Reveal>
 *
 * Reanimated on the UI thread; the same code path on iOS, Android and the
 * PWA. While the entrance runs the transform carries a perspective +
 * rotateX (a real 3D tilt); once the spring lands the transform drops back
 * to a flat translate/scale identity, so settled content is never left in a
 * 3D rendering context (crisper text on web, no layer promotion).
 *
 * Reduce motion: withTiming/withSpring jump to their end values — the
 * block simply appears in place.
 */
import React, { useEffect, useMemo } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type EntryOrExitLayoutType,
} from 'react-native-reanimated';
import { MOTION } from '../../theme/motion';

type Props = {
  children: React.ReactNode;
  /** Sibling position — used to stagger the cascade (index * 70ms). */
  index?: number;
  /** Extra delay in ms on top of the stagger. */
  delay?: number;
  /** How far the block rises from, in px (default 36). */
  distance?: number;
  /** Backward lean at the start, in degrees (default 14; 0 = flat rise). */
  tilt?: number;
  style?: StyleProp<ViewStyle>;
};

/** Stagger step per sibling index. */
const STAGGER_MS = 70;
const PERSPECTIVE = 900;
const SCALE_FROM = 0.96;

export function Reveal({ children, index = 0, delay = 0, distance = 36, tilt = 14, style }: Props) {
  const opacity = useSharedValue(0);
  const t = useSharedValue(0);        // 0 = leaning/low/small, 1 = at rest
  const settled = useSharedValue(0);  // 1 once the spring has landed → flat transform

  useEffect(() => {
    const wait = delay + index * STAGGER_MS;
    opacity.value = withDelay(wait, withTiming(1, { duration: MOTION.dur.enter, easing: MOTION.easeOut }));
    t.value = withDelay(
      wait,
      withSpring(1, MOTION.spring, (finished) => {
        'worklet';
        if (finished) settled.value = 1;
      }),
    );
  }, [opacity, t, settled, delay, index]);

  const anim = useAnimatedStyle(() => {
    if (settled.value) {
      return { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] };
    }
    const p = t.value;
    const rest = 1 - p;
    return {
      opacity: opacity.value,
      transform: tilt > 0
        ? [
          { perspective: PERSPECTIVE },
          { rotateX: `${rest * tilt}deg` },
          { translateY: rest * distance },
          { scale: SCALE_FROM + p * (1 - SCALE_FROM) },
        ]
        : [
          { translateY: rest * distance },
          { scale: SCALE_FROM + p * (1 - SCALE_FROM) },
        ],
    };
  }, [distance, tilt]);

  return (
    <Animated.View style={[style, anim]}>
      {children}
    </Animated.View>
  );
}

/**
 * Stagger — wrap a screen's sections once and every direct child tilts in
 * with a cascading delay. Conditional children (false/null) are skipped
 * automatically, so it drops straight into existing JSX:
 *
 *   <ScrollView>
 *     <Stagger>
 *       ...existing sections, untouched...
 *     </Stagger>
 *   </ScrollView>
 */
export function Stagger({ children, max = 9 }: { children: React.ReactNode; max?: number }) {
  const kids = React.Children.toArray(children);
  return (
    <>
      {kids.map((k, i) => (
        <Reveal key={(k as any)?.key ?? i} index={Math.min(i, max)}>
          {k}
        </Reveal>
      ))}
    </>
  );
}

// ── List rows ────────────────────────────────────────────────────────────────
/** Rows past this index mount without an entering animation (perf cap). */
export const STAGGER_ROWS = 12;
const ROW_STEP_MS = 45;
const ROW_MS = 360;
const ROW_DAMPING = 15;

/**
 * Entering config for a FlatList row at `index`: FadeInDown, 360 ms spring
 * (damping 15), delayed 45 ms × index — for the first 12 rows only; later
 * rows return undefined and mount instantly. Plain function for use inside
 * `renderItem`; `useStaggerEntering` is the memoised hook form for row
 * components.
 *
 *   <Animated.View entering={staggerEntering(index)}>…</Animated.View>
 *
 * Never use on DraggableFlatList rows (it breaks drag measurement).
 */
export function staggerEntering(index: number): EntryOrExitLayoutType | undefined {
  if (!Number.isFinite(index) || index < 0 || index >= STAGGER_ROWS) return undefined;
  // springify(ms) sets the spring's duration — calling .duration() first
  // would be overwritten by a bare .springify().
  return FadeInDown.delay(index * ROW_STEP_MS).springify(ROW_MS).damping(ROW_DAMPING);
}

export function useStaggerEntering(index: number): EntryOrExitLayoutType | undefined {
  return useMemo(() => staggerEntering(index), [index]);
}

export default Reveal;
