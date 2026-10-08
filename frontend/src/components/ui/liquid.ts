/**
 * useLiquidIndicator — the ONE sliding tile behind SlidingSegments and the
 * CustomTabBar (spec §3.13 / §3.14).
 *
 *   const { onSlotLayout, indicatorStyle, labelProgress } = useLiquidIndicator(activeIndex, items.length);
 *
 *   <View style={{ flexDirection: 'row' }}>            // the slots' parent — the indicator's coordinate space
 *     <Animated.View style={[tile, indicatorStyle]} />  // absolute, left 0 — the hook supplies translateX + width
 *     {items.map((it, i) => <Pressable key={it.key} onLayout={onSlotLayout(i)} … />)}
 *   </View>
 *
 * How it moves
 *  - Each slot reports its geometry through `onSlotLayout(i)` (x/width
 *    relative to the shared parent). The first time the ACTIVE slot is
 *    measured the tile SNAPS there (`.value =`, no animation) — there is no
 *    slide-in from x=0 on mount, and `ready` flips to 1 so the tile (and its
 *    shadow) stay invisible until then.
 *  - On `activeIndex` change the tile springs to the new slot
 *    (`MOTION.snappy`: translateX + width) and STRETCHES: scaleX 1 → 1.22 in
 *    150 ms, then settles with a soft spring — the liquid blob.
 *  - A later layout change of the active slot (rotation, font load, the
 *    container resizing) snaps again: a layout shift is not a selection.
 *  - `labelProgress(i)` is a shared value per slot (1 = active, 0 = inactive)
 *    that eases on every change, for `interpolateColor` in the label's own
 *    `useAnimatedStyle`. It is safe to call during render (no hooks inside) —
 *    the values are created lazily and live for the hook's lifetime.
 *  - `useSlotCoverage(indicator, i, active)` is the SAFER label driver and the
 *    one the tile's own surfaces use: instead of easing on a clock of its own,
 *    it reports how much of slot i the TILE actually covers right now. A label
 *    whose active colour only reads on the tile (near-black on white) can then
 *    never turn dark before the tile is under it — the "nothing is selected"
 *    flash that a timing-driven colour shows for as long as the slide takes.
 *
 * Not a loop: nothing here registers with the loop budget.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { LayoutChangeEvent, ViewStyle } from 'react-native';
import {
  makeMutable,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
  type AnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { MOTION } from '../../theme/motion';

/** One measured slot, in the coordinate space of the slots' shared parent. */
export type LiquidSlot = { x: number; w: number };

export type LiquidIndicator = {
  /** Attach to slot i: `onLayout={onSlotLayout(i)}`. Stable per index. */
  onSlotLayout: (i: number) => (e: LayoutChangeEvent) => void;
  /** Put on the tile: `{ width, opacity, transform: [{ translateX }, { scaleX }] }` — position it `absolute, left: 0`. */
  indicatorStyle: AnimatedStyle<ViewStyle>;
  /** 0 → 1 per slot (1 = active); read `.value` inside a worklet for colour interpolation. */
  labelProgress: (i: number) => SharedValue<number>;
  /** 1 once the active slot has been measured (the tile is hidden before). */
  ready: SharedValue<number>;
  /** Last measured geometry per slot (for callers that scroll the active slot into view). */
  slots: React.MutableRefObject<(LiquidSlot | undefined)[]>;
  /** Tile left edge, in the slots' coordinate space (the live translateX). */
  tileX: SharedValue<number>;
  /** Tile width (springs with the slide). */
  tileW: SharedValue<number>;
  /** Slot rects on the UI thread, flat: [x0, w0, x1, w1, …] — for useSlotCoverage. */
  rects: SharedValue<number[]>;
};

/** scaleX peak of the stretch on a selection change, and how long the stretch-out takes. */
const STRETCH_PEAK = 1.22;
const STRETCH_MS = 150;
/**
 * The slide spring.
 *
 * Spec §3.13 asked for {damping:16, stiffness:180}. Measured on the live tree
 * (docs/graphic-overhaul/tools/_fr1_segtap.js, COD stage rail, Stage 3 → SL):
 * that pair is ζ≈0.6, and on react-native-web — where reanimated advances its
 * springs on rAF and the frames right after a tab change are the busiest of
 * the interaction — the tile overshot its slot by ~30 % of the travel and sat
 * PAST THE END OF THE RAIL for most of a second before settling (sampled:
 * target x 288, tile at 332). ζ≈0.7 keeps a visible liquid overshoot but caps
 * it at ~5 % and settles in ~0.5 s even when frames are dropped.
 */
const SLIDE_SPRING = { damping: 22, stiffness: 260, mass: 1 } as const;
/** Label colour ease on a change (timing, not spring, so colours never overshoot their stops). */
const LABEL_EASE = { duration: MOTION.dur.base, easing: MOTION.easeOut } as const;
/**
 * How long the INCOMING label waits before it starts taking the active colour
 * (`labelProgress` only — `useSlotCoverage` needs no clock). The active colour
 * is legible on the tile and nowhere else, so a label that recolours ahead of
 * the tile is briefly invisible on the rail.
 */
const LABEL_LAG_MS = 110;
/**
 * Fraction of a slot trimmed from each side before coverage is measured: the
 * label sits in the middle of its slot, so the type should flip when the tile
 * is under the TYPE, not when its leading edge crosses the slot boundary.
 */
const COVER_PAD = 0.2;

export function useLiquidIndicator(activeIndex: number, count: number): LiquidIndicator {
  // ── UI-thread state ────────────────────────────────────────────────────────
  const ix = useSharedValue(0);        // tile translateX
  const iw = useSharedValue(0);        // tile width
  const stretch = useSharedValue(1);   // tile scaleX (the liquid stretch)
  const ready = useSharedValue(0);     // 1 once the active slot is measured

  // ── JS-side bookkeeping ────────────────────────────────────────────────────
  const slots = useRef<(LiquidSlot | undefined)[]>([]);
  const activeRef = useRef(activeIndex);
  activeRef.current = activeIndex;

  // The same slot geometry, readable from a worklet (useSlotCoverage).
  const rects = useSharedValue<number[]>([]);
  const publishRects = useCallback(() => {
    const flat: number[] = [];
    for (let i = 0; i < slots.current.length; i += 1) {
      const s = slots.current[i];
      flat.push(s ? s.x : 0, s ? s.w : 0);
    }
    rects.value = flat;
  }, [rects]);

  // Per-slot label progress, created lazily (makeMutable is not a hook, so
  // this is safe to call from render for any number of slots).
  const progressRef = useRef<SharedValue<number>[]>([]);
  const labelProgress = useCallback((i: number): SharedValue<number> => {
    const arr = progressRef.current;
    while (arr.length <= i) arr.push(makeMutable(arr.length === activeRef.current ? 1 : 0));
    return arr[i];
  }, []);

  // One stable handler per slot index so slots don't re-render on every parent render.
  const handlersRef = useRef(new Map<number, (e: LayoutChangeEvent) => void>());
  const onSlotLayout = useCallback((i: number) => {
    let handler = handlersRef.current.get(i);
    if (!handler) {
      handler = (e: LayoutChangeEvent) => {
        const { x, width } = e.nativeEvent.layout;
        const prev = slots.current[i];
        if (prev && prev.x === x && prev.w === width) return; // same geometry → nothing to do
        slots.current[i] = { x, w: width };
        publishRects();
        if (i !== activeRef.current) return;
        // First measurement of the active slot, or a layout shift under it:
        // snap. Only a selection change animates.
        ix.value = x;
        iw.value = width;
        ready.value = 1;
      };
      handlersRef.current.set(i, handler);
    }
    return handler;
  }, [ix, iw, ready, publishRects]);

  // Forget slots that no longer exist so a stale x can't be sprung to.
  useEffect(() => {
    if (slots.current.length > count) {
      slots.current.length = count;
      publishRects();
    }
  }, [count, publishRects]);

  // Selection change → slide + stretch + label colours.
  const prevActiveRef = useRef(activeIndex);
  useEffect(() => {
    const changed = prevActiveRef.current !== activeIndex;
    prevActiveRef.current = activeIndex;

    const slot = slots.current[activeIndex];
    if (slot) {
      if (!ready.value) {
        // Measured before we were asked to move: first layout snaps.
        ix.value = slot.x;
        iw.value = slot.w;
        ready.value = 1;
      } else if (changed) {
        ix.value = withSpring(slot.x, SLIDE_SPRING);
        iw.value = withSpring(slot.w, SLIDE_SPRING);
        stretch.value = withSequence(
          withTiming(STRETCH_PEAK, { duration: STRETCH_MS }),
          withSpring(1, MOTION.settle),
        );
      }
    }
    // If the slot isn't measured yet, onSlotLayout snaps there when it is.

    if (changed) {
      const n = Math.max(progressRef.current.length, count);
      for (let i = 0; i < n; i += 1) {
        // The incoming label waits out LABEL_LAG_MS so it never turns "on
        // tile" ink before the tile has left its old slot.
        labelProgress(i).value = i === activeIndex
          ? withDelay(LABEL_LAG_MS, withTiming(1, LABEL_EASE))
          : withTiming(0, LABEL_EASE);
      }
    }
  }, [activeIndex, count, ix, iw, stretch, ready, labelProgress]);

  const indicatorStyle = useAnimatedStyle(() => ({
    width: iw.value,
    opacity: ready.value,
    transform: [{ translateX: ix.value }, { scaleX: stretch.value }],
  }));

  return useMemo(
    () => ({ onSlotLayout, indicatorStyle, labelProgress, ready, slots, tileX: ix, tileW: iw, rects }),
    [onSlotLayout, indicatorStyle, labelProgress, ready, ix, iw, rects],
  );
}

/**
 * How much of slot `index` the tile covers right now, 0 → 1, as a shared value.
 *
 * This is what a label whose ACTIVE colour only reads on the tile should use
 * instead of `labelProgress`: the colour then arrives with the tile instead of
 * on a clock of its own. Before anything is measured it falls back to the
 * plain selected/not-selected value so the first paint is already correct.
 */
export function useSlotCoverage(
  indicator: Pick<LiquidIndicator, 'tileX' | 'tileW' | 'rects' | 'ready'>,
  index: number,
  active: boolean,
): SharedValue<number> {
  const { tileX, tileW, rects, ready } = indicator;
  return useDerivedValue(() => {
    const r = rects.value;
    const x = r[index * 2];
    const w = r[index * 2 + 1];
    if (!ready.value || w === undefined || !(w > 0)) return active ? 1 : 0;
    const pad = w * COVER_PAD;
    const a = x + pad;
    const b = x + w - pad;
    const span = b - a;
    if (span <= 0) return active ? 1 : 0;
    const left = Math.max(a, tileX.value);
    const right = Math.min(b, tileX.value + tileW.value);
    const cover = (right - left) / span;
    return cover < 0 ? 0 : cover > 1 ? 1 : cover;
  }, [index, active]);
}

export default useLiquidIndicator;
