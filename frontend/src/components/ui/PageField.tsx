/**
 * PageField — the app-wide living background. MOUNTED ONCE.
 *
 * The ONE owner of the page colour (`colors.page`). Navigator scenes on the
 * hub routes and the (tabs) navigator are transparent, and screen roots no
 * longer paint a page fill, so cards/sheets/chrome (all opaque hex tokens)
 * float on this field. Two Aurora-style radial blobs drift slowly behind
 * everything; dark mode adds a third magenta one (the "abyss nebula").
 *
 * Mount: first child of RootNavigator's `<View style={{ flex: 1 }}>` in
 * app/_layout.tsx, BEFORE the <Stack>. It is absoluteFill inside the
 * position:fixed #root on web (no transformed ancestor), so it pins to the
 * viewport. Never mount it inside a ScrollView.
 *
 * Motion (all UI-thread, transform/opacity only — no blur, no filters):
 *   - group parallax: translateY = -0.06 × pageScrollY (clamped),
 *                     translateX = -14px × pageTab (clamped 0..7)
 *   - ONE linear phase drives every blob: blob i reads sin(freq_i·phase + φ_i)
 *     for its drift (±amplitude px), scale (0.92–1.08) and opacity (±20% of
 *     its base). The frequencies are rationals (1, 3/4, 5/6) so all three
 *     blobs complete a whole number of cycles inside the repeat span
 *     (12 / 9 / 10) and the wrap is seamless — the same 13 s / 17.3 s / 15.6 s
 *     periods as before out of a SINGLE withRepeat.
 *   - Why one: the loop budget is ≤6 per screen (spec §5) and PageField is
 *     mounted on every one of them. Three blob loops ate half the budget
 *     before a screen rendered anything; now the field costs 1.
 *   - Seeded at rest (sin 0) so a reduce-motion freeze shows the settled
 *     composition. The loop is registered with useLoopPause (AppState /
 *     web visibility) and resumes from the phase it was cancelled at.
 *
 * Props: none — reads the theme, `pageScrollY` and `pageTab`.
 */
import React, { useCallback, useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useColors, useTheme } from '../../theme/ThemeContext';
import { pageScrollY, pageTab } from '../../theme/pageScroll';
import { useLoopPause } from '../../theme/motion';

const TWO_PI = Math.PI * 2;

// ── One loop for the whole field ─────────────────────────────────────────────
/** Base period of the shared phase (the violet blob's own period). */
const BASE_MS = 13000;
/**
 * Repeat span in base cycles. Every blob frequency below must divide it
 * (12·1 = 12, 12·3/4 = 9, 12·5/6 = 10 whole cycles), so the wrap is seamless.
 */
const SPAN_CYCLES = 12;
const SPAN = TWO_PI * SPAN_CYCLES;
const SPAN_MS = BASE_MS * SPAN_CYCLES;

// Group parallax — clamped so the blobs never abandon their corners.
const SCROLL_FACTOR = 0.06;   // px of field travel per px of page scroll
const SCROLL_MIN = -240;      // overscroll (negative y) nudges the field down ≤14px
const SCROLL_MAX = 1400;      // ≤84px of upward travel on long pages
const TAB_FACTOR = 14;        // px per bottom-tab index
const TAB_MAX = 7;            // pageTab is 0..7

type BlobSpec = {
  id: string;
  size: number;
  color: string;
  baseOpacity: number;
  /** Cycles per base cycle — must keep SPAN_CYCLES·freq a whole number. */
  freq: number;
  driftX: number;            // amplitude in px (signed = initial direction)
  driftY: number;
  offset: number;            // phase offset; 0 or π = rest position (mid-phase)
  top?: number | `${number}%`;
  bottom?: number;
  left?: number | `${number}%`;
  right?: number;
};

function Blob({ spec, phase }: { spec: BlobSpec; phase: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const s = Math.sin(spec.freq * phase.value + spec.offset);
    return {
      transform: [
        { translateX: s * spec.driftX },
        { translateY: s * spec.driftY },
        { scale: 1 + 0.08 * s },
      ],
      opacity: spec.baseOpacity * (1 + 0.2 * s),
    };
  }, [spec.freq, spec.offset, spec.driftX, spec.driftY, spec.baseOpacity]);

  return (
    <Animated.View
      // The SVG inside is static — only this view's transform/opacity change —
      // so caching it as a GPU texture is a pure win (no per-frame re-raster).
      renderToHardwareTextureAndroid
      shouldRasterizeIOS
      style={[
        styles.blob,
        {
          width: spec.size,
          height: spec.size,
          top: spec.top,
          bottom: spec.bottom,
          left: spec.left,
          right: spec.right,
        },
        style,
      ]}
    >
      <Svg width={spec.size} height={spec.size}>
        <Defs>
          <RadialGradient id={spec.id} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={spec.color} stopOpacity={1} />
            <Stop offset="55%" stopColor={spec.color} stopOpacity={0.55} />
            <Stop offset="100%" stopColor={spec.color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={spec.size / 2} cy={spec.size / 2} r={spec.size / 2} fill={`url(#${spec.id})`} />
      </Svg>
    </Animated.View>
  );
}

export function PageField() {
  const colors = useColors();
  const { effective } = useTheme();
  const dark = effective === 'dark';

  const blobs = useMemo<BlobSpec[]>(() => {
    const list: BlobSpec[] = [
      {
        id: 'pf-blob-violet',
        size: 460, color: '#8caf38',
        baseOpacity: dark ? 0.34 : 0.16,
        freq: 1, driftX: 40, driftY: 26, offset: 0,          // 13.0 s
        top: -140, right: -160,
      },
      {
        id: 'pf-blob-blue',
        size: 380, color: '#e7b65c',
        baseOpacity: dark ? 0.26 : 0.12,
        freq: 3 / 4, driftX: -30, driftY: -20, offset: Math.PI, // 17.3 s
        bottom: -120, left: -140,
      },
    ];
    if (dark) {
      // Dark only: a magenta nebula mid-field so the abyss isn't flat black.
      list.push({
        id: 'pf-blob-magenta',
        size: 320, color: '#3a7a56',
        baseOpacity: 0.20,
        freq: 5 / 6, driftX: 24, driftY: -22, offset: 0,      // 15.6 s
        top: '34%', left: '30%',
      });
    }
    return list;
  }, [dark]);

  // ONE linear phase for every blob (see the header): 1 loop, not 2–3.
  const phase = useSharedValue(0);
  const start = useCallback(() => {
    // Continue from where it was cancelled, modulo the FULL span so every
    // blob's relative phase survives a pause.
    const from = phase.value % SPAN;
    phase.value = from;
    phase.value = withRepeat(
      withTiming(from + SPAN, { duration: SPAN_MS, easing: Easing.linear }),
      -1,
      false,
    );
  }, [phase]);
  useEffect(() => {
    start();
    return () => cancelAnimation(phase);
  }, [start, phase]);
  useLoopPause(phase, start, 'PageField');

  // Whole-field parallax from the focused screen's scroll + the active tab.
  const groupStyle = useAnimatedStyle(() => {
    const y = Math.min(Math.max(pageScrollY.value, SCROLL_MIN), SCROLL_MAX);
    const t = Math.min(Math.max(pageTab.value, 0), TAB_MAX);
    return {
      transform: [
        { translateY: -y * SCROLL_FACTOR },
        { translateX: -t * TAB_FACTOR },
      ],
    };
  });

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.field, { backgroundColor: colors.page }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[StyleSheet.absoluteFill, styles.group, groupStyle]}>
        {blobs.map((b) => <Blob key={b.id} spec={b} phase={phase} />)}
      </Animated.View>
    </View>
  );
}

export default PageField;

const styles = StyleSheet.create({
  field: { pointerEvents: 'none', overflow: 'hidden' },
  group: { pointerEvents: 'none' },
  blob: { position: 'absolute', pointerEvents: 'none' },
});
