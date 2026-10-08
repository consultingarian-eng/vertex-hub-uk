/**
 * GradientText — gradient-filled type (web).
 *
 * A plain <span> via react-native-web's unstable_createElement with
 * `background-image: linear-gradient(…)` + `background-clip: text`. rnw passes
 * unknown CSS properties straight through, so this needs no masked-view and
 * keeps that native module out of the web bundle entirely.
 *
 * Parity with the native file:
 *  - numberOfLines === 1 → nowrap + overflow hidden + text-overflow ellipsis
 *  - numberOfLines > 1   → -webkit-line-clamp
 *  - adjustsFontSizeToFit → one synchronous measure in useLayoutEffect (before
 *    paint) shrinks the font down to minimumFontScale so long mastheads fit
 *    instead of ellipsising; re-measured on resize.
 *  - glow → a duplicate solid Text behind at 0.35 with a colors.glow text-shadow.
 *
 * Same public props as GradientText.tsx.
 */
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
// @ts-expect-error react-native-web ships no TypeScript declarations; this file only exists in the web graph.
import { unstable_createElement } from 'react-native-web';
import { useColors } from '../../theme/ThemeContext';

export type GradientTextProps = {
  /** Gradient stops, left → right (e.g. colors.titleGradient, GRADIENT_TEXT). */
  colors: readonly string[];
  /** Text style — fontFamily/fontSize/letterSpacing/textAlign. Layout keys (margin, flex, …) go on the wrapper. */
  style: StyleProp<TextStyle>;
  numberOfLines?: number;
  adjustsFontSizeToFit?: boolean;
  minimumFontScale?: number;
  /** A soft duplicate behind the type in the gradient's mid hue with a colors.glow text-shadow. */
  glow?: boolean;
  children: string;
};

type CreateElement = (type: string, props: Record<string, unknown>) => React.ReactElement;
const createElement = unstable_createElement as CreateElement;

const LAYOUT_KEYS = new Set([
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical',
  'marginStart', 'marginEnd', 'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'paddingHorizontal', 'paddingVertical', 'paddingStart', 'paddingEnd',
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf',
  'width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight',
  'position', 'top', 'left', 'right', 'bottom', 'start', 'end', 'zIndex', 'opacity', 'transform', 'transformOrigin',
  'backgroundColor', 'borderRadius', 'borderWidth', 'borderColor', 'overflow', 'display',
]);
const STRIPPED_KEYS = new Set(['textShadowColor', 'textShadowOffset', 'textShadowRadius', 'color']);

/**
 * Descender headroom, as a fraction of the font size.
 *
 * `background-clip: text` paints the gradient only inside the element's
 * PADDING BOX and `-webkit-text-fill-color: transparent` erases everything
 * else — so any glyph ink that falls below the box is not clipped, it is
 * simply never painted. The box is the line box (lineHeight), and
 * Unbounded-Black's descender at the section-head sizes hangs below it: the
 * "Q" of "Quick actions" on Home came out with its tail sliced flat, on every
 * role and both themes (round-1 review). A padding-bottom extends the painted
 * box; a matching negative margin keeps the laid-out height identical, so no
 * caller's spacing moves.
 */
const DESCENDER_HEADROOM = 0.18;

function splitStyle(style: StyleProp<TextStyle>): { layout: ViewStyle; text: TextStyle } {
  const flat = (StyleSheet.flatten(style) || {}) as Record<string, unknown>;
  const layout: Record<string, unknown> = {};
  const text: Record<string, unknown> = {};
  for (const key of Object.keys(flat)) {
    if (flat[key] === undefined) continue;
    if (LAYOUT_KEYS.has(key)) layout[key] = flat[key];
    else if (!STRIPPED_KEYS.has(key)) text[key] = flat[key];
  }
  return { layout: layout as ViewStyle, text: text as TextStyle };
}

export function GradientText({
  colors, style, numberOfLines, adjustsFontSizeToFit, minimumFontScale = 0.75, glow, children,
}: GradientTextProps) {
  const theme = useColors();
  const { layout, text } = useMemo(() => splitStyle(style), [style]);
  const label = String(children);
  const baseFontSize = text.fontSize ?? 14;
  const stops = colors.length >= 2 ? colors : [colors[0] ?? '#2f6a4b', colors[0] ?? '#2f6a4b'];
  const glowHue = stops[Math.floor(stops.length / 2)];

  const textAlign = text.textAlign;
  const alignSelf: ViewStyle['alignSelf'] =
    textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : textAlign === 'justify' ? 'stretch' : 'flex-start';

  // ── adjustsFontSizeToFit (single-line only, like the common native use) ──
  const spanRef = useRef<HTMLElement | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const fitEnabled = !!adjustsFontSizeToFit && numberOfLines === 1;

  const measure = useCallback(() => {
    const el = spanRef.current;
    if (!el || !fitEnabled) return;
    // Measure at the natural size, then settle on the scale that fits. All
    // synchronous inside a layout effect → no visible flash.
    el.style.fontSize = `${baseFontSize}px`;
    const natural = el.scrollWidth;
    const available = el.clientWidth;
    const next = natural > available && natural > 0 ? Math.max(minimumFontScale, available / natural) : 1;
    el.style.fontSize = `${baseFontSize * next}px`;
    setFitScale((prev) => (Math.abs(prev - next) < 0.005 ? prev : next));
  }, [fitEnabled, baseFontSize, minimumFontScale]);

  useLayoutEffect(() => {
    if (!fitEnabled) {
      setFitScale(1);
      return;
    }
    measure();
    const el = spanRef.current;
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && el && el.parentElement) {
      ro = new ResizeObserver(() => measure());
      ro.observe(el.parentElement);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', measure);
    }
    return () => {
      if (ro) ro.disconnect();
      else if (typeof window !== 'undefined') window.removeEventListener('resize', measure);
    };
  }, [fitEnabled, measure, label]);

  const fittedText: TextStyle = fitScale === 1 ? text : { ...text, fontSize: baseFontSize * fitScale };

  // ── the gradient span ──
  const clampStyle: Record<string, unknown> =
    numberOfLines === 1
      ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', display: 'inline-block' }
      : numberOfLines && numberOfLines > 1
        ? { display: '-webkit-box', WebkitLineClamp: numberOfLines, WebkitBoxOrient: 'vertical', overflow: 'hidden', maxWidth: '100%' }
        : { display: 'inline-block', maxWidth: '100%' };

  // Only where nothing is clamped away below: with -webkit-line-clamp the
  // overflow box IS the clip, and extra bottom padding would reveal a sliver
  // of the line that was meant to be cut.
  const headroom = !numberOfLines || numberOfLines === 1
    ? Math.round((fittedText.fontSize ?? baseFontSize) * DESCENDER_HEADROOM)
    : 0;

  const span = createElement('span', {
    ref: spanRef,
    children: label,
    style: [
      fittedText,
      clampStyle,
      headroom ? { paddingBottom: headroom, marginBottom: -headroom } : null,
      {
        alignSelf,
        backgroundImage: `linear-gradient(100deg, ${stops.join(', ')})`,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        // Keep the ellipsis/glyphs painted by the gradient rather than a
        // fallback colour if text-fill-color ever loses.
        color: glowHue,
      },
    ],
  });

  return (
    <View style={layout}>
      {glow ? (
        <Text
          numberOfLines={numberOfLines}
          aria-hidden
          style={[
            fittedText,
            styles.glowTwin,
            {
              color: glowHue,
              opacity: 0.35,
              textShadowColor: theme.glow,
              textShadowRadius: 12,
              textShadowOffset: { width: 0, height: 0 },
            },
          ]}
        >
          {label}
        </Text>
      ) : null}
      {span}
    </View>
  );
}

/**
 * Headroom around the glow twin, px.
 *
 * Round-2 review, finding 9: the numeral glow rendered as a rectangular halo
 * with hard vertical edges (sampled behind Pay's "$77.00" in dark: card face
 * rgb(12,26,20), box rgb(16,34,26), a hard left edge inside three pixels).
 * The cause is the clip, not the shadow — a single-line Text sets
 * `overflow: hidden`, so a 12-14 px blur that spreads past the glyph box is
 * sliced off square at the box edge. The twin is inset NEGATIVELY by this much
 * and given matching padding, so the content box lands exactly where it did
 * and the blur has room to fall off inside the clip.
 */
const GLOW_PAD = 16;

const styles = StyleSheet.create({
  glowTwin: {
    position: 'absolute',
    top: -GLOW_PAD,
    left: -GLOW_PAD,
    right: -GLOW_PAD,
    bottom: -GLOW_PAD,
    padding: GLOW_PAD,
    // react-native-web's Text base style carries `max-width: 100%`, which
    // clamps this absolutely-inset box back to the numeral's own width — the
    // content box then collapses to a few px, the string overflows and rnw
    // draws its ellipsis dots (three purple discs beside the number, seen on
    // the COD ink stage hero). An explicit maxWidth wins over the base class,
    // so the border box really is PAD wider on every side and the content box
    // lands exactly where it did.
    maxWidth: 9999,
  },
});

export default GradientText;
