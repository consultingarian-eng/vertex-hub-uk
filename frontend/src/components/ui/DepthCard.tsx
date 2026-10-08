/**
 * DepthCard + CardStack — the app's card.
 *
 * Oct 2026, the Owner's ask (a cleaner, simpler app): the card is FLAT now. A
 * quiet hairline, a 16px corner at most, no layered shadow, no holographic
 * sheen, no gradient rim (edge="gradient" is a plain primary hairline), no
 * staggered entrance, and CardStack no longer fans ghost cards out behind its
 * child. Every screen that uses DepthCard changed at once; the props are all
 * still accepted so no caller had to. The notes below describe the original
 * treatment and still explain the style splitting, which is unchanged.
 *
 * A DepthCard is a white (paper) / translucent (glass) / dark-gradient (ink)
 * face floating on a real layered shadow (`colors.depthShadow`, a boxShadow
 * string: rnw emits the multi-layer CSS shadow, RN 0.81 new-arch draws it
 * natively). It is the drop-in for the app's `<View style={styles.card}>`:
 *
 *   <DepthCard style={styles.card}>…</DepthCard>                 // paper
 *   <DepthCard variant="ink">…inkText/inkMuted children…</DepthCard>
 *   <DepthCard variant="glass" edge="gradient" fill="rgba(255,255,255,0.08)">…</DepthCard>
 *   <DepthCard sheen>…</DepthCard>                               // holographic scroll sheen (≤8 per screen)
 *   <CardStack><DepthCard>…</DepthCard></CardStack>              // fanned deck of ghosts behind
 *
 * Style splitting (so the codemod can pass the old `styles.card` untouched):
 *   - OUTER wrapper keeps the card's place in its parent: margin*, width /
 *     min/maxWidth, alignSelf, flex*, position/top/left/right/bottom, zIndex,
 *     opacity, transform, display.
 *   - FACE gets the box itself: padding*, borderRadius*, border*, height,
 *     overflow, gap, flexDirection/alignItems/justifyContent, …
 *   - `backgroundColor` is OVERRIDDEN by the variant (use `fill` to set an
 *     explicit face colour), and `shadow*`/`elevation`/`boxShadow` are
 *     STRIPPED — the depth shadow replaces them (elevation is ignored on web
 *     anyway and would double-draw on Android).
 *
 * Text colours are NOT inherited in React Native: children of an `ink` card
 * must use `colors.inkText` / `colors.inkMuted` themselves.
 *
 * `index` (list rows, see spec §3.17): rows enter with a FadeInDown stagger
 * (45 ms × index, first 12 rows only) and the first row (`index === 0`) gets
 * `zIndex: 2` (+ `elevation: 2` on Android) so it rides above an
 * EditorialHero's `overlapNext` bleed. Sheen is automatically disabled from
 * the 9th indexed card on (the spec's "first 8 cards per screen" cap) — and
 * never pass `sheen` on list rows.
 *
 * Android: a DepthCard must not sit inside an `overflow: 'hidden'` parent
 * (the native boxShadow is clipped by it). The card clips its own sheen and
 * ink gradient through absolute children, never through the face itself.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, Platform, StyleProp, StyleSheet, View, ViewProps, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import {
  GRADIENT, GRADIENT_HOLO, GRADIENT_INK, GRADIENT_INK_DARK, useColors, useTheme,
} from '../../theme/ThemeContext';
import { GRADIENT_HOLO_LIGHT } from '../../theme/brand';
import { MOTION } from '../../theme/motion';
import { pageScrollY } from '../../theme/pageScroll';

// ── Public types ─────────────────────────────────────────────────────────────
export type DepthCardVariant = 'paper' | 'glass' | 'ink';
export type DepthCardEdge = 'none' | 'gradient';

export type DepthCardProps = Omit<ViewProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  /** paper (default) = white card on the page; glass = translucent chip ON ink/pop blocks; ink = dark gradient block. */
  variant?: DepthCardVariant;
  /** 'gradient' wraps the face in a 1.5px brand-gradient rim. */
  edge?: DepthCardEdge;
  /** Holographic gleam that slides across the face as the page scrolls (reads `pageScrollY`). Opt-in, ≤8 per screen. */
  sheen?: boolean;
  /** Row index in a list: staggered entrance, first row lifted above a hero overlap. */
  index?: number;
  /** Adds a soft `colors.glow` halo to the depth shadow. */
  glow?: boolean;
  /** Explicit face colour (e.g. 'rgba(255,255,255,0.08)' for a glass card on ink). Overrides the variant fill. */
  fill?: string;
};

// ── Style splitting ──────────────────────────────────────────────────────────
/** Keys that place the card in its parent — they stay on the outer wrapper. */
const OUTER_KEYS = new Set<string>([
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'marginHorizontal', 'marginVertical', 'marginStart', 'marginEnd',
  'width', 'minWidth', 'maxWidth',
  'alignSelf', 'flex', 'flexGrow', 'flexShrink', 'flexBasis',
  'position', 'top', 'left', 'right', 'bottom', 'start', 'end', 'zIndex',
  'opacity', 'transform', 'transformOrigin', 'display',
]);
/** Legacy shadow keys — replaced by the boxShadow string, so they never reach either layer. */
const STRIPPED_KEYS = new Set<string>([
  'shadowColor', 'shadowOffset', 'shadowOpacity', 'shadowRadius', 'elevation', 'boxShadow',
  // the variant owns the fill; `fill` is the supported override
  'backgroundColor',
]);

type SplitStyle = { outer: ViewStyle; face: ViewStyle; radius: number };

function splitCardStyle(style: StyleProp<ViewStyle>, defaultRadius: number): SplitStyle {
  const flat = (StyleSheet.flatten(style) || {}) as Record<string, unknown>;
  const outer: Record<string, unknown> = {};
  const face: Record<string, unknown> = {};
  for (const key of Object.keys(flat)) {
    const v = flat[key];
    if (v === undefined || STRIPPED_KEYS.has(key)) continue;
    if (OUTER_KEYS.has(key)) outer[key] = v;
    else face[key] = v;
  }
  const r = face.borderRadius;
  const radius = typeof r === 'number' ? r : defaultRadius;
  return { outer: outer as ViewStyle, face: face as ViewStyle, radius };
}

const DEFAULT_RADIUS = 16;
/** The largest corner a flat card takes, whatever the caller asked for. */
const MAX_RADIUS = 16;
const EDGE_PAD = 1.5;
/** Sheen cap (spec §3.4): the first 8 indexed cards on a screen may carry a sheen. */
const SHEEN_CAP = 8;
/** Width of the sheen band, px (see Sheen — a percentage of the face reads as a wash). */
const SHEEN_W = 72;
/**
 * Tallest face that may carry a sheen, CSS px (round-2 review, finding 1).
 *
 * The band is a fixed-width strip that spans the WHOLE face height, so on a
 * short card it rakes past as a gleam and on a tall one it is a stationary
 * cyan-and-magenta stripe running through the body copy — which is what the
 * review found on the 1300 px onboarding journey card, on Home and on Pay (two
 * screen owners had already switched `sheen` off by hand on their tall cards).
 * Above this height the primitive refuses the sheen rather than leaving each
 * screen to discover the rule. 240, not the 320 the review floated: at 320 a
 * ~265 px list card (Home's "Today's grading") still showed the band running
 * corner to corner through four rows of names.
 */
const SHEEN_MAX_H = 240;
/** Page-scroll distance for one full pass of the gleam across a face, px. */
const SHEEN_TRAVEL = 560;
/** Slant of the band, as a fraction of the face height it shifts across it (tan 18°). */
const SHEEN_SLANT = 0.33;
/**
 * Per-instance phase seed. Every sheen used to interpolate off the SAME
 * `pageScrollY` with the same range, so adjacent cards lined their gleams up
 * into one continuous column down the page (round-2 review, finding 1). Mount
 * order and the face's own layout Y both feed the phase, so two cards can only
 * align by coincidence.
 */
let sheenSeq = 0;
/** Stagger entrance cap (spec §3.17): first 12 rows. */
const STAGGER_CAP = 12;

// ── DepthCard ────────────────────────────────────────────────────────────────
export function DepthCard({
  style, children, variant = 'paper', edge = 'none', sheen = false, index, glow = false, fill, ...rest
}: DepthCardProps) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';

  const split = useMemo(() => splitCardStyle(style, DEFAULT_RADIUS), [style]);
  const { outer, face } = split;
  // Flat cards share one quiet corner; a caller's larger radius is capped.
  const radius = Math.min(split.radius, MAX_RADIUS);

  // Flat: no depth shadow, no glow.
  const shadow = 'none';
  void glow;

  // Variant defaults — the caller's face style (border, radius, padding) may
  // override border/radius; the fill is always ours unless `fill` is given.
  const variantFace: ViewStyle = useMemo(() => {
    switch (variant) {
      case 'glass':
        return { borderWidth: 1, borderColor: colors.glassBorder };
      case 'ink':
        // Dark theme: the ink face and the card face are both near-black, so a
        // 8 %-white hairline disappeared and the block stopped reading as a
        // separate surface (round-2 review, finding 3). A luminous violet rim
        // is what carries the edge at night; light keeps the quiet hairline.
        return { borderWidth: 1, borderColor: isDark ? colors.border : 'rgba(255,255,255,0.08)' };
      case 'paper':
      default:
        return { borderWidth: 1, borderColor: colors.border };
    }
  }, [variant, colors, isDark]);

  const faceFill =
    fill ?? (variant === 'glass' ? colors.glass : variant === 'ink' ? colors.ink : colors.background);

  const hasEdge = edge === 'gradient';
  // The shadow sits on whichever box is outermost (the rim when present) so it
  // falls from the card's true silhouette. Glass cards never cast a shadow —
  // they sit on an ink/pop block where a plum shadow would only muddy it.
  const castsShadow = variant !== 'glass';

  const faceStyle: ViewStyle[] = [
    variantFace,
    face,
    { borderRadius: radius, backgroundColor: faceFill },
    // edge="gradient": the one card to look at, marked with a primary hairline.
    hasEdge ? { borderWidth: 1, borderColor: colors.primary } : null,
    castsShadow && shadow !== 'none' ? { boxShadow: shadow } : null,
    // Fills a definite-height outer (CardStack ghosts, flex:1 cards); content-sized otherwise.
    styles.faceGrow,
  ].filter(Boolean) as ViewStyle[];

  // First row rides above a hero's overlapNext bleed (spec §3.5).
  const liftStyle: ViewStyle | null =
    index === 0 ? (Platform.OS === 'android' ? { zIndex: 2, elevation: 2 } : { zIndex: 2 }) : null;

  // No staggered entrance: the page is simply there.
  const entering = undefined;

  // Face geometry — the sheen needs the card's OWN size to traverse it, and
  // its layout Y to decorrelate its phase from its neighbours'.
  const [box, setBox] = useState<{ w: number; h: number; y: number } | null>(null);
  const seqRef = useRef<number | null>(null);
  if (seqRef.current === null) seqRef.current = sheenSeq++;
  const seq = seqRef.current;
  const onFaceLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height, y } = e.nativeEvent.layout;
    setBox((prev) =>
      prev && Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 && Math.abs(prev.y - y) < 1
        ? prev
        : { w: width, h: height, y });
  }, []);

  // No sheen (the prop is accepted and ignored).
  const wantSheen = false;
  void sheen;
  // Measured and short enough: a gleam. Unmeasured or taller than the cap: none.
  const showSheen = wantSheen && !!box && box.w > 0 && box.h > 0 && box.h <= SHEEN_MAX_H;

  const faceNode = (
    <View style={faceStyle} onLayout={wantSheen ? onFaceLayout : undefined}>
      {variant === 'ink' ? (
        <LinearGradient
          pointerEvents="none"
          colors={isDark ? GRADIENT_INK_DARK : GRADIENT_INK}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
        />
      ) : null}
      {children}
      {showSheen && box ? (
        <Sheen radius={radius} isDark={isDark} w={box.w} h={box.h} phase={(seq * 137 + box.y * 0.6) % SHEEN_TRAVEL} />
      ) : null}
    </View>
  );

  return (
    <Animated.View {...rest} entering={entering} style={[outer, liftStyle]}>
      {faceNode}
    </Animated.View>
  );
}

// ── Sheen — holographic gleam driven by the page scroll ──────────────────────
/**
 * One shared-value reader, no React re-render.
 *
 * Round-2 review, finding 1 — the previous version interpolated a FIXED
 * −40 → +220 px travel off `pageScrollY` for every card on every screen. Three
 * things went wrong with that:
 *   1. +220 never clears a 350 px face, so past 600 px of scroll the band
 *      PARKED on the card instead of leaving. On a tall card, where the strip
 *      spans the whole height, that parked band is a cyan-and-magenta stripe
 *      straight through the body copy (worst in dark, where the stops are
 *      strongest) — it reads as a light leak or a smudge on the display.
 *   2. Every instance read the same value through the same range, so adjacent
 *      cards lined their gleams up into one continuous column down the page.
 *   3. Nothing scaled with the card, so a 120 px chip and a 1300 px journey
 *      card got the same sweep.
 * Now: the travel is measured from the face (it starts fully off the left edge
 * and ends fully off the right, slant included), the phase is seeded per
 * instance from mount order + layout Y, and the sweep WRAPS — so the gleam
 * passes again on a long scroll instead of parking. Faces taller than
 * SHEEN_MAX_H get no sheen at all.
 *
 * The band is a fixed SHEEN_W px strip, not 60 % of the card. At 60 % the band
 * covered most of the face at any static scroll offset, so a light card did
 * not show a highlight raking past — it showed a stain (round-1 review).
 * Clipped by its own absolute wrapper (never by the face — Android would clip
 * the face's shadow too).
 */
function Sheen({ radius, isDark, w, h, phase }: {
  radius: number; isDark: boolean; w: number; h: number; phase: number;
}) {
  // The strip is 2× the face height and rotated 18°, so its ends swing
  // SHEEN_SLANT·h/2 to either side: the travel has to clear that as well as
  // the band's own width, or the gleam's corner stays parked on the face.
  const spread = (SHEEN_SLANT * h) / 2 + 16;
  const from = -(SHEEN_W + spread);
  const to = w + spread;
  const anim = useAnimatedStyle(() => {
    // Wrapping phase: no clamp, so the gleam keeps passing on a long page and
    // is off-face at both ends of the cycle (the wrap is never visible).
    const t = (((pageScrollY.value + phase) % SHEEN_TRAVEL) + SHEEN_TRAVEL) % SHEEN_TRAVEL;
    return {
      transform: [
        { rotate: '18deg' },
        { translateX: from + (t / SHEEN_TRAVEL) * (to - from) },
      ],
    };
  }, [from, to, phase]);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.sheenClip, { borderRadius: radius }]}>
      <Animated.View style={[styles.sheenStrip, anim]}>
        <LinearGradient
          colors={isDark ? GRADIENT_HOLO : GRADIENT_HOLO_LIGHT}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={styles.fill}
        />
      </Animated.View>
    </View>
  );
}

// ── CardStack ────────────────────────────────────────────────────────────────
export type CardStackProps = {
  /** Number of ghost cards fanned out behind (default 2). */
  depth?: 1 | 2;
  /** The real card (normally one DepthCard). It defines the stack's size. */
  children: React.ReactNode;
  /** Margins/width for the whole deck — put them HERE, not on the inner card, so the ghosts align with its face. */
  style?: StyleProp<ViewStyle>;
  /** Ghost variant (default 'paper'; use 'glass' when the deck sits on an ink/pop block). */
  variant?: DepthCardVariant;
};

/**
 * Ghost geometry per layer (1 = nearest ghost, 2 = farthest).
 *
 * Round-1 review (spec §1 asks Pay's "One sale pays you 3 times" for a FANNED
 * 3-card stack): at scaleX .96/.92 the two ghosts peeked out as slabs of
 * near-identical width with no rotation, so at 1x the deck read as a
 * duplicated card or a stuck render rather than as depth. Each layer now
 * tapers harder AND the far one is rotated a degree and a half, which is what
 * makes a stack of paper read as a stack of paper.
 */
const GHOST = [
  { y: 9, scaleX: 0.94, rotate: '0.7deg', opacity: 0.55 },
  { y: 18, scaleX: 0.87, rotate: '1.8deg', opacity: 0.3 },
] as const;

/**
 * Renders 1–2 absolutely-positioned ghost DepthCards behind the child that fan
 * out on mount with a spring (translateY, scaleX taper and a slight rotation).
 * Zero per-frame cost once settled. Ghosts are absolute siblings — the child
 * is never wrapped in an overflow clip, so its shadow stays intact.
 */
export function CardStack({ depth = 2, children, style, variant = 'paper' }: CardStackProps) {
  // 0 → 1 drives every ghost's offset/scale/opacity; springs once on mount.
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withSpring(1, MOTION.spring);
  }, [p]);

  // Farthest ghost first so the paint order is back → front.
  const layers: (1 | 2)[] = depth === 2 ? [2, 1] : [1];

  // Flat: no ghost cards fanned out behind.
  void layers; void variant;
  return <View style={style}>{children}</View>;
}

function Ghost({ layer, p, variant }: { layer: 1 | 2; p: SharedValue<number>; variant: DepthCardVariant }) {
  const g = GHOST[layer - 1];
  const anim = useAnimatedStyle(() => ({
    opacity: p.value * g.opacity,
    transform: [
      { translateY: p.value * g.y },
      { rotate: `${p.value * parseFloat(g.rotate)}deg` },
      { scaleX: 1 - p.value * (1 - g.scaleX) },
    ],
  }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, anim]}>
      <DepthCard variant={variant} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  faceGrow: { flexGrow: 1 },
  fill: { flex: 1 },
  sheenClip: { overflow: 'hidden' },
  // Taller than the face so the 18° rotation never exposes a corner; a fixed
  // narrow band so it reads as a gleam, not a wash (see Sheen).
  sheenStrip: { position: 'absolute', top: '-50%', bottom: '-50%', left: 0, width: SHEEN_W },
});

export default DepthCard;
