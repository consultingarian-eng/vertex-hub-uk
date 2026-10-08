/**
 * AnimatedNumber — counts up from the previous value to the new value.
 *
 * Usage (unchanged public props):
 *   <AnimatedNumber value={370} prefix="£" duration={800} />
 *   <AnimatedNumber value={6} suffix=" sales" />
 *   <AnimatedNumber value={pct} suffix="%" pop={false} />   // no landing pop
 *   <AnimatedNumber value={n} legacy />                      // JS setState fallback
 *
 * Implementation (Ink & Cube): the count-up runs entirely on the UI thread.
 * A shared value is driven by withTiming and written into a read-only
 * TextInput's `text` prop via useAnimatedProps — no React re-render per
 * frame. Native: reanimated updates the native text directly. Web: reanimated
 * special-cases `text` on <input> and sets `element.value` (a DOM write).
 *
 * Sizing: an invisible twin <Text> of the final formatted value sits in
 * normal flow and the TextInput is absolutely filled over it, so the box
 * is always the right size for the number (no intrinsic <input> width on
 * web, no stale Yoga measurement on native) and never flexes mid-count.
 *
 * End pop: the wrapper scales 1 → 1.08 → 1 (120 ms + spring) when the count
 * lands — `pop={false}` disables it (StatBlock pops its whole stack instead).
 *
 * `legacy` keeps the previous requestAnimationFrame + setState renderer for
 * any call site where a TextInput mis-sizes (e.g. fontVariant arrays).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, Platform, StyleProp, StyleSheet, Text, TextInput, TextStyle, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming,
} from 'react-native-reanimated';
import { MOTION } from '../../theme/motion';

type Props = {
  value: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  /**
   * Thousands separators in the counted figure ("£1,240.00"). Default false —
   * every existing call site keeps the exact string it renders today. Pay's
   * calculator/forecast heroes need it: spec §4 asks for a 46px count-up
   * StatBlock there, and pay.tsx had to fall back to a plain <Text> (killing
   * the screen's one hero motion) purely because the formatter had no
   * grouping. Implemented by hand, not Intl — this runs inside a worklet.
   */
  grouping?: boolean;
  style?: StyleProp<TextStyle>;
  /** Scale pop when the count lands (default true). */
  pop?: boolean;
  /** Use the old JS-driven Text renderer instead of the UI-thread TextInput. */
  legacy?: boolean;
};

const AText = Animated.createAnimatedComponent(TextInput);

// Box keys go on the wrapper; glyph keys go on both the twin and the input so
// the two boxes coincide exactly.
const LAYOUT_KEYS = new Set([
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical',
  'marginStart', 'marginEnd', 'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'paddingHorizontal', 'paddingVertical', 'paddingStart', 'paddingEnd',
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf',
  'width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight',
  'position', 'top', 'left', 'right', 'bottom', 'start', 'end', 'zIndex', 'opacity', 'transform', 'transformOrigin',
  'backgroundColor', 'borderRadius', 'borderWidth', 'borderColor', 'overflow', 'display',
]);

function splitStyle(style: StyleProp<TextStyle>): { layout: ViewStyle; text: TextStyle } {
  const flat = (StyleSheet.flatten(style) || {}) as Record<string, unknown>;
  const layout: Record<string, unknown> = {};
  const text: Record<string, unknown> = {};
  for (const key of Object.keys(flat)) {
    if (flat[key] === undefined) continue;
    if (LAYOUT_KEYS.has(key)) layout[key] = flat[key];
    else text[key] = flat[key];
  }
  return { layout: layout as ViewStyle, text: text as TextStyle };
}

/**
 * The exact formatter the count-up uses on every frame — exported so a static
 * overlay (StatBlock's gradient final value) matches the landed frame.
 */
export function formatAnimatedNumber(
  n: number, prefix: string, suffix: string, decimals: number, grouping: boolean = false,
): string {
  'worklet';
  const body = decimals > 0 ? n.toFixed(decimals) : String(Math.round(n));
  if (!grouping) return `${prefix}${body}${suffix}`;
  // Group by hand: Intl is not available (or not worklet-safe) on the UI thread.
  const negative = body.charAt(0) === '-';
  const abs = negative ? body.slice(1) : body;
  const dot = abs.indexOf('.');
  const whole = dot === -1 ? abs : abs.slice(0, dot);
  const fraction = dot === -1 ? '' : abs.slice(dot);
  let grouped = '';
  for (let i = 0; i < whole.length; i += 1) {
    grouped += whole.charAt(i);
    const left = whole.length - 1 - i;
    if (left > 0 && left % 3 === 0) grouped += ',';
  }
  return `${prefix}${negative ? '-' : ''}${grouped}${fraction}${suffix}`;
}

export function AnimatedNumber(props: Props) {
  return props.legacy ? <LegacyAnimatedNumber {...props} /> : <CountUp {...props} />;
}

// ── UI-thread count-up ───────────────────────────────────────────────────────
function CountUp({
  value, duration = MOTION.dur.count, prefix = '', suffix = '', decimals = 0, grouping = false, style, pop = true,
}: Props) {
  const target = Number.isFinite(value) ? value : 0;
  const { layout, text } = useMemo(() => splitStyle(style), [style]);
  const fmt = useCallback(
    (n: number) => formatAnimatedNumber(n, prefix, suffix, decimals, grouping),
    [prefix, suffix, decimals, grouping],
  );

  const progress = useSharedValue(0);
  const scale = useSharedValue(1);
  // `defaultValue` never changes after mount so React never rewrites the
  // native text underneath the running animation.
  const initialText = useRef(fmt(0)).current;
  const prevRef = useRef(0);
  // Twin text: the wider of previous/final while counting (a count DOWN would
  // otherwise clip), then the final value once landed.
  const [sizer, setSizer] = useState(() => fmt(target));

  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = target;
    const fromText = fmt(from);
    const toText = fmt(target);
    const wider = fromText.length > toText.length;
    setSizer(wider ? fromText : toText);
    if (from === target) {
      progress.value = target;
      return;
    }
    progress.value = withTiming(target, { duration, easing: MOTION.easeOut });
    if (pop) {
      scale.value = withDelay(
        duration,
        withSequence(withTiming(1.08, { duration: 120 }), withSpring(1, MOTION.settle)),
      );
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (wider) timer = setTimeout(() => setSizer(toText), duration);
    return () => { if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration, fmt, pop]);

  const animatedProps = useAnimatedProps(() => {
    return { text: formatAnimatedNumber(progress.value, prefix, suffix, decimals, grouping) } as any;
  });
  // Pop from the glyph anchor, not the box centre, so left-aligned numbers in
  // a full-width row don't slide while they scale. Done with a translateX
  // COMPENSATION rather than the RN `transformOrigin` style key: on web
  // react-native-web forwards that key to the DOM node, where React logs
  // "Invalid DOM property `transform-origin`" on every render (dev-only noise,
  // but noise in every console we read). translate-then-scale maps a point p
  // (from the box centre) to t + s·p, so holding the left edge (-w/2) still
  // means t = (s−1)·w/2 — and it behaves identically on native.
  const anchor = text.textAlign === 'center' ? 0 : text.textAlign === 'right' ? -1 : 1;
  const boxW = useSharedValue(0);
  const onBoxLayout = useCallback((e: LayoutChangeEvent) => {
    boxW.value = e.nativeEvent.layout.width;
  }, [boxW]);
  const popStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: anchor === 0 ? 0 : ((scale.value - 1) * boxW.value * anchor) / 2 },
      { scale: scale.value },
    ],
  }), [anchor]);

  return (
    <Animated.View
      style={[layout, popStyle]}
      onLayout={anchor === 0 ? undefined : onBoxLayout}
      accessible
      accessibilityLabel={fmt(target)}
    >
      {/* Twin stays readable by assistive tech (web has no group label); the input below is hidden. */}
      <Text numberOfLines={1} style={[text, styles.twin]}>
        {sizer}
      </Text>
      <AText
        animatedProps={animatedProps}
        defaultValue={initialText}
        editable={false}
        focusable={false}
        caretHidden
        scrollEnabled={false}
        multiline={false}
        contextMenuHidden
        underlineColorAndroid="transparent"
        aria-hidden
        style={[text, StyleSheet.absoluteFill, styles.input]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  twin: { opacity: 0 },
  input: {
    padding: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
    margin: 0,
    minHeight: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    includeFontPadding: false,
    textAlignVertical: 'center',
    pointerEvents: 'none',
  },
});

// ── Legacy JS renderer (opt-in via `legacy`) ─────────────────────────────────
function LegacyAnimatedNumber({ value, duration = 700, prefix = '', suffix = '', decimals = 0, grouping = false, style }: Props) {
  // Start at 0 so numbers count UP on first mount — the stat-chip "alive"
  // feel — then animate between values on later changes as before.
  const [display, setDisplay] = useState<number>(0);
  const frameRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  useEffect(() => {
    const targetValue = Number.isFinite(value) ? value : 0;
    const fromValue = display;
    const startTime = Date.now();

    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
    }

    const tick = () => {
      const elapsed = Date.now() - startTime;
      const t = Math.min(1, elapsed / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const current = fromValue + (targetValue - fromValue) * eased;
      setDisplay(current);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(targetValue);
      }
    };
    if (Platform.OS === 'web' || typeof requestAnimationFrame !== 'undefined') {
      frameRef.current = requestAnimationFrame(tick);
    } else {
      setDisplay(targetValue);
    }
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);

  return (
    <Text style={style}>{formatAnimatedNumber(display, prefix, suffix, decimals, grouping)}</Text>
  );
}

export default AnimatedNumber;
