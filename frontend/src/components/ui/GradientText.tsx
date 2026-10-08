/**
 * GradientText — gradient-filled type (native: iOS + Android).
 *
 * A MaskedView clips a horizontal LinearGradient with the text's own glyphs.
 * An invisible twin Text (same style + line props) sits INSIDE the gradient,
 * so the gradient box is exactly the text box — it wraps, truncates and
 * shrinks (numberOfLines / adjustsFontSizeToFit) like any Text, with no
 * measuring or re-renders.
 *
 * Web has its own implementation (GradientText.web.tsx — CSS
 * background-clip:text), so masked-view never enters the web bundle.
 *
 * Static strings only: never render an AnimatedNumber inside the mask
 * (Android re-rasterises the mask on every native text update and flickers).
 * StatBlock covers the "gradient count-up" case by crossfading a solid
 * count-up into a static GradientText of the final value.
 *
 * Usage:
 *   <GradientText colors={colors.titleGradient}
 *     style={{ fontFamily: fonts.displayBlack, fontSize: 28 }}
 *     numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
 *     Sales Path
 *   </GradientText>
 */
import React, { useMemo } from 'react';
import { StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
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

// Style keys that describe the BOX (position in the parent), not the glyphs.
// They live on the outer wrapper so the mask, the twin and the glow layer all
// share one identical inner box.
const LAYOUT_KEYS = new Set([
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical',
  'marginStart', 'marginEnd', 'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'paddingHorizontal', 'paddingVertical', 'paddingStart', 'paddingEnd',
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf',
  'width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight',
  'position', 'top', 'left', 'right', 'bottom', 'start', 'end', 'zIndex', 'opacity', 'transform', 'transformOrigin',
  'backgroundColor', 'borderRadius', 'borderWidth', 'borderColor', 'overflow', 'display',
]);
// Never let a caller's text shadow leak into the mask (it would reveal a
// blurred gradient halo) — `glow` is the supported way to get one.
const STRIPPED_KEYS = new Set(['textShadowColor', 'textShadowOffset', 'textShadowRadius', 'color']);

/** Descender headroom below the mask, as a fraction of the font size. */
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

/** expo-linear-gradient wants a ≥2-stop tuple; tolerate a 1-stop array. */
function toStops(colors: readonly string[]): readonly [string, string, ...string[]] {
  if (colors.length >= 2) return colors as unknown as readonly [string, string, ...string[]];
  const c = colors[0] ?? '#2f6a4b';
  return [c, c];
}

export function GradientText({
  colors, style, numberOfLines, adjustsFontSizeToFit, minimumFontScale, glow, children,
}: GradientTextProps) {
  const theme = useColors();
  const { layout, text } = useMemo(() => splitStyle(style), [style]);
  const stops = useMemo(() => toStops(colors), [colors]);

  // The gradient box hugs the glyphs (not the full parent width) so a short
  // left-aligned title still shows the whole gradient. Yoga still caps the
  // hugging box at the parent width, so wrapping/shrinking is unchanged.
  const textAlign = text.textAlign;
  const alignSelf: ViewStyle['alignSelf'] =
    textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : textAlign === 'justify' ? 'stretch' : 'flex-start';

  const lineProps = { numberOfLines, adjustsFontSizeToFit, minimumFontScale } as const;
  const label = String(children);
  // Descender headroom: the mask and its gradient are sized to the LINE BOX,
  // and Unbounded-Black's descenders hang below it — Home's "Quick actions"
  // came out with the Q's tail sliced flat (round-1 review). Padding grows the
  // masked box; the negative margin keeps the laid-out height identical.
  // Skipped when lines are clamped away below (the clip is the point there).
  const headroom = !numberOfLines || numberOfLines === 1
    ? Math.round(((text.fontSize as number | undefined) ?? 14) * DESCENDER_HEADROOM)
    : 0;
  const glowHue = stops[Math.floor(stops.length / 2)];

  return (
    <View style={layout} accessible accessibilityLabel={label}>
      {glow ? (
        <Text
          {...lineProps}
          aria-hidden
          style={[
            text,
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
      <MaskedView
        style={{ alignSelf, marginBottom: -headroom }}
        maskElement={
          // Mask = alpha of the glyphs; force an opaque colour so the caller's
          // style can never make the mask itself translucent.
          <Text {...lineProps} style={[text, styles.maskText, { paddingBottom: headroom }]}>
            {label}
          </Text>
        }
      >
        <LinearGradient colors={stops} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
          {/* Invisible twin — sizes the gradient to the exact text box. */}
          <Text
            {...lineProps}
            aria-hidden
            style={[text, styles.twin, { paddingBottom: headroom }]}
          >
            {label}
          </Text>
        </LinearGradient>
      </MaskedView>
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
  maskText: { color: '#000' },
  twin: { opacity: 0 },
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
