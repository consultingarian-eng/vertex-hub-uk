/**
 * EditorialHero + ParallaxLayer — the full-bleed hero block above the fold.
 *
 * An ink block (dark gradient + optional nebula), a pop block (brand gradient
 * + aurora) or a paper block (white + depth shadow) that bleeds edge-to-edge
 * out of a padded ScrollView, carries the screen's kicker / title / lede, a
 * live Vertex X mark cut off at the right (the `cube` slot), and lets the next card ride up over its
 * bottom edge (`overlapNext`). Everything inside moves at its own depth as
 * the page scrolls; pulling down stretches the block.
 *
 *   <EditorialHero variant="ink" topEdge nebula scrollY={scrollY}
 *     cube={{ size: 168 }}
 *     kicker="GOOD MORNING" title="Sam" lede={dateText}>
 *     …avatar row, HexCoin, XPBar…
 *   </EditorialHero>
 *   <DepthCard index={0}>…</DepthCard>   // index 0 → zIndex 2, rides the overlap
 *
 * Typography (spec §3.5): kicker `fonts.mono 11 uppercase 1.6`; title
 * `fonts.displayBlack` (GradientText GRADIENT_TEXT on ink, white on pop,
 * GradientText titleGradient on paper); lede `fonts.body 16`. Pass a string
 * to get that styling, or a ReactNode to render your own.
 *
 * Layering: the block's OUTER view owns radius/shadow and the overscroll
 * stretch; an absolute CLIP view inside holds background gradient, nebula and
 * the cube (so the shadow is never clipped — Android clips a boxShadow under
 * overflow:hidden); the text stack sits on top in normal flow.
 *
 * Text colours do not inherit in RN: children placed on an ink/pop block must
 * use `colors.inkText` / `colors.inkMuted` (or white) themselves. What DOES
 * travel down is the block's surface: `useHeroSurface()` reports 'ink' | 'pop'
 * | 'paper', and XPBar reads it to cut a dark groove instead of a pale lilac
 * track (a pale track on a dark block reads as the FILLED portion — an empty
 * bar looked 100 % charged next to "0/6").
 *
 * ── The cube's exclusion zone ───────────────────────────────────────────────
 * The cube renders BEHIND the children, so anything at the block's right edge
 * lands on top of it. Five screens collided that way before the footprint was
 * published (a wordmark, an edit pencil, a streak chip, an XP bar, the tail of
 * a title), each screen guessing its own `paddingRight`. Now the hero derives
 * how much of the content column the cube occupies and:
 *   - keeps the kicker + title clear of it by default (`cube.reserve`), and
 *   - publishes the number: `useHeroCubeInset()` inside the hero returns it,
 *     so a screen can pad its own children instead of guessing.
 * Heroes with no cube reserve nothing and are pixel-identical to before.
 *
 * ── The corner seat ─────────────────────────────────────────────────────────
 * The cube layer is clipped to the block, and the block's 22px top corners are
 * an ARC — so a small cube dropped at the slot's default offsets is not
 * "cropped at the edge", it is amputated mid-silhouette. A cube ≤ CORNER_CUBE_MAX
 * placed with no explicit `right`/`top` on a block that HAS top corners is
 * therefore seated inboard of the arc. Bigger cubes keep their bleed.
 *
 * ── Mark colour ─────────────────────────────────────────────────────────────
 * `cube.color` overrides it. The default is surface-aware: lime
 * (`colors.markOnInk`) on ink and pop blocks, brand green on LIGHT paper.
 */
import React, { useCallback, useContext, useMemo } from 'react';
import { LayoutChangeEvent, StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  GRADIENT_HERO, GRADIENT_INK, GRADIENT_INK_DARK, GRADIENT_TEXT, fonts, useColors, useTheme,
} from '../../theme/ThemeContext';
import { pageMarkKick } from '../../theme/pageScroll';
import { Aurora } from './Aurora';
import { VertexMark } from './VertexMark';
import { GradientText } from './GradientText';

// ── Public types ─────────────────────────────────────────────────────────────
export type EditorialHeroVariant = 'ink' | 'pop' | 'paper';

/** Which parts of the hero keep clear of the cube's footprint. */
export type EditorialHeroReserve = 'head' | 'type' | 'all' | 'none';

export type EditorialHeroCube = {
  size: number;
  opacity?: number;
  /** Offset from the block's right edge (default −size·0.25 — cut off at the right). */
  right?: number;
  /** Offset from the block's top edge (default −size·0.15). */
  top?: number;
  /** Mark colour (default: lime on ink/pop blocks, brand green on LIGHT paper blocks). */
  color?: string;
  /**
   * How much of the content column the cube occupies at the right, in px.
   * Default: derived from `size` / `right`. `false` reserves nothing (and
   * `useHeroCubeInset()` then reports 0).
   */
  inset?: number | false;
  /**
   * What keeps clear of that footprint (default 'head' — the kicker and the
   * title, the band the cube actually sits in). 'type' adds the lede, 'all'
   * adds the children too, 'none' reserves nothing but still publishes the
   * inset through `useHeroCubeInset()`.
   *
   * A hero that carries its HEADLINE in `lede` (Pay's "You're paid per
   * delivery…", with no `title`) wants 'type'. It is not the default because
   * the reserve is a rectangle down the whole slot: on a five-line lede under
   * a cube that only covers the first two, it buys a collision that isn't
   * happening at the price of a much taller, much narrower block.
   */
  reserve?: EditorialHeroReserve;
};

export type EditorialHeroProps = {
  variant: EditorialHeroVariant;
  /** Mono uppercase eyebrow above the title. */
  kicker?: React.ReactNode;
  /** Masthead line (string → styled per variant; node → rendered as-is). */
  title?: React.ReactNode;
  /** Body line under the title. */
  lede?: React.ReactNode;
  /** Title font size when `title` is a string (34–44; default 36). */
  titleSize?: number;
  /** The brand mark slot — the Vertex X, rendered behind the text, clipped by the block. */
  cube?: EditorialHeroCube;
  /** The screen's scroll offset (from useParallaxScroll) — drives parallax + overscroll stretch. */
  scrollY: SharedValue<number>;
  /** How far the block bleeds past the scroll content's side padding (default 16). */
  bleed?: number;
  /** Block starts at the status bar: square top corners + `insets.top + 14` top padding. */
  topEdge?: boolean;
  /** How many px the next sibling rides up over the block (default 18). */
  overlapNext?: number;
  /** Ink blocks: a nebula inside (dark mode intense, light mode dim). Paper: a dim one. */
  nebula?: boolean;
  /**
   * Animate the nebula (the drifting `Aurora`) instead of painting its settled
   * frame. Off by default: the PageField already runs the app's one ambient
   * field, and a second drifting field inside every hero cost a continuous
   * loop that the cube, the XP tip and the coin all wanted (spec §5 caps a
   * screen at six). The static nebula IS Aurora's settled composition, so the
   * block looks the same in a screenshot.
   */
  liveAurora?: boolean;
  /** Extra content under the lede (avatar rows, coins, XP bars…). */
  children?: React.ReactNode;
  /** Extra style for the block (margins other than the bleed, minHeight…). */
  style?: StyleProp<ViewStyle>;
};

// ── Constants ────────────────────────────────────────────────────────────────
const BOTTOM_RADIUS = 28;
const TOP_RADIUS = 22;
const SIDE_PAD = 16;
const DEFAULT_BLEED = 16;
const DEFAULT_OVERLAP = 18;
const DEFAULT_TITLE = 36;
/** Parallax depths (spec §3.5): cube far, orbs mid, text near. */
export const HERO_DEPTH = { cube: 0.35, orbs: 0.5, text: 0.85 } as const;

/**
 * The Vertex X is drawn 86 % of its size×size box wide and 63 % tall
 * (VertexMark), so its body starts 7 % in from the box's sides and 18 % down
 * from its top.
 */
const MARK_INSET_X = 0.07;
const MARK_INSET_Y = 0.18;
/**
 * How far below the content's top edge the "head" reaches — a mono kicker
 * plus the first line of a displayBlack title. A cube whose body starts below
 * this band (Home's drops to +58, Sales Path's to +118) is already clear of
 * the head, so those heroes reserve nothing for it.
 */
const HEAD_BAND = 96;
/**
 * A cube up to this size, placed at the slot's DEFAULT offsets, is a corner
 * ornament rather than a cropped object, and is seated fully inboard of the
 * block's TOP_RADIUS arc (see CORNER_SEAT). Bigger cubes (Home's 168, Sales
 * Path's 150, Pay's 130) are meant to bleed off the edge and keep their
 * offsets exactly as before.
 */
const CORNER_CUBE_MAX = 96;
/**
 * How far the drawn cube BODY is held in from the block's top/right edges when
 * it is seated in the corner. Round-1 review: the leadership stage hero's 64px
 * cube sat at right −16 / top −9.6, and the block's 22px corner arc sliced its
 * top face and right vertical edge off — "a torn wedge" in admin-progress and
 * dark-admin-progress. app/(tabs)/progress.tsx hand-rolls its own mark at
 * exactly this inset to dodge the same clip; the slot does it for everyone else.
 * 10px inside a 22px corner puts the body's corner 16.9px from the arc centre,
 * i.e. comfortably inside the 22px radius at every yaw phase.
 */
const CORNER_SEAT = 10;

/**
 * Aurora's `intense` prop (×1.4 presence, blobs ×1.5) is being added by the
 * Aurora owner. Spread as an untyped bag so this file compiles before and
 * after that lands — an unknown prop is simply ignored by the component.
 */
const AURORA_INTENSE = { intense: true } as Record<string, unknown>;

// ── Hero context: the surface and the cube's footprint ───────────────────────
const HeroSurfaceContext = React.createContext<EditorialHeroVariant | null>(null);
const HeroCubeInsetContext = React.createContext(0);

/**
 * Which hero block this subtree is painted on, or null outside one. XPBar uses
 * it to pick its track: a pale lilac groove on paper, a dark one on ink/pop.
 */
export function useHeroSurface(): EditorialHeroVariant | null {
  return useContext(HeroSurfaceContext);
}

/**
 * How many px of the content column the hero's cube occupies at the right
 * (0 when there is no cube, or `cube.inset === false`). Pad your own hero
 * children with it instead of guessing a magic number.
 */
export function useHeroCubeInset(): number {
  return useContext(HeroCubeInsetContext);
}

// ── ParallaxLayer ────────────────────────────────────────────────────────────
export type ParallaxLayerProps = {
  /** 0 = pinned to the viewport (far), 1 = moves with the content (near). */
  depth: number;
  scrollY: SharedValue<number>;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Moves its children at `depth` × the scroll speed while the hero is in view:
 * translateY = interpolate(scrollY, [−120, 0, 300], [−40·depth, 0, 300·(1−depth)]).
 * Overscroll (negative scrollY) pulls far layers up slightly for a stretched look.
 */
export function ParallaxLayer({ depth, scrollY, children, style }: ParallaxLayerProps) {
  const anim = useAnimatedStyle(() => ({
    transform: [{
      translateY: interpolate(
        scrollY.value,
        [-120, 0, 300],
        [-40 * depth, 0, 300 * (1 - depth)],
        Extrapolation.CLAMP,
      ),
    }],
  }));
  return <Animated.View style={[style, anim]}>{children}</Animated.View>;
}

// ── EditorialHero ────────────────────────────────────────────────────────────
export function EditorialHero({
  variant, kicker, title, lede, titleSize = DEFAULT_TITLE, cube, scrollY,
  bleed = DEFAULT_BLEED, topEdge = false, overlapNext = DEFAULT_OVERLAP, nebula = false,
  liveAurora = false, children, style,
}: EditorialHeroProps) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const insets = useSafeAreaInsets();

  const radii = useMemo<ViewStyle>(() => ({
    borderTopLeftRadius: topEdge ? 0 : TOP_RADIUS,
    borderTopRightRadius: topEdge ? 0 : TOP_RADIUS,
    borderBottomLeftRadius: BOTTOM_RADIUS,
    borderBottomRightRadius: BOTTOM_RADIUS,
  }), [topEdge]);

  const padTop = topEdge ? insets.top + 14 : 24;

  // Geometry: bleed past the content padding, pad back in, hand the bottom
  // `overlapNext` px to the next sibling (and keep our own content clear of it).
  const block = useMemo<ViewStyle>(() => ({
    marginHorizontal: -bleed,
    paddingHorizontal: SIDE_PAD + bleed,
    paddingTop: padTop,
    paddingBottom: 24 + overlapNext,
    marginBottom: -overlapNext,
    ...radii,
  }), [bleed, padTop, overlapNext, radii]);

  // ── The cube's footprint (see the header) ─────────────────────────────────
  const cubeGeo = useMemo(() => {
    if (!cube) return { inset: 0, head: 0, lede: 0, children: 0, right: 0, top: 0 };
    // A small default-placed cube is seated inboard of the rounded corner
    // instead of being amputated by it (see CORNER_SEAT). The offsets are
    // measured to the cube's BOX, and the drawn body starts CUBE_BODY_INSET
    // inside that box, so the seat subtracts it back out.
    const seated =
      !topEdge && cube.right === undefined && cube.top === undefined && cube.size <= CORNER_CUBE_MAX;
    const seat = (inset: number) => Math.round((CORNER_SEAT - cube.size * inset) * 10) / 10;
    const right = cube.right ?? (seated ? seat(MARK_INSET_X) : -cube.size * 0.25);
    const top = cube.top ?? (seated ? seat(MARK_INSET_Y) : -cube.size * 0.15);
    // Distance from the block's right edge to the cube's drawn left edge,
    // less the padding the content already keeps.
    const derived = Math.max(
      0,
      Math.round((cube.size + right) - cube.size * MARK_INSET_X - (SIDE_PAD + bleed)),
    );
    const inset = cube.inset === false ? 0 : cube.inset ?? derived;
    const reserve = cube.reserve ?? 'head';
    // A cube whose body starts below the head band is already clear of it.
    const bodyTop = top + cube.size * MARK_INSET_Y;
    const headClear = bodyTop >= padTop + HEAD_BAND;
    const head = reserve === 'none' || headClear ? 0 : inset;
    return {
      inset,
      head,
      lede: reserve === 'type' || reserve === 'all' ? inset : 0,
      children: reserve === 'all' ? inset : 0,
      right,
      top,
    };
  }, [cube, bleed, padTop, topEdge]);

  // Paper blocks are solid and cast the depth shadow; ink/pop paint a gradient
  // inside the clip view (the outer stays transparent so the shadow-free
  // gradient edge is crisp against the page).
  const surface = useMemo<ViewStyle>(() => (
    variant === 'paper'
      ? { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, boxShadow: colors.depthShadow }
      : { backgroundColor: variant === 'ink' ? colors.ink : GRADIENT_HERO[1] }
  ), [variant, colors]);

  // Overscroll stretch: pulling down 120 px scales the block to 1.12× FROM ITS
  // TOP EDGE. The anchor is a translateY compensation, not the RN
  // `transformOrigin` style key: react-native-web forwards that key to the DOM
  // node, where React logs "Invalid DOM property `transform-origin`" on every
  // dev render. translate-then-scale maps a point p (from the box centre) to
  // t + s·p, so pinning the top edge (−h/2) means t = (s − 1)·h/2; identical
  // on native, and a block whose height has not been measured yet simply
  // scales about its centre for one frame.
  const blockH = useSharedValue(0);
  const onBlockLayout = useCallback((e: LayoutChangeEvent) => {
    blockH.value = e.nativeEvent.layout.height;
  }, [blockH]);
  const stretch = useAnimatedStyle(() => {
    const s = interpolate(scrollY.value, [-120, 0], [1.12, 1], Extrapolation.CLAMP);
    return { transform: [{ translateY: ((s - 1) * blockH.value) / 2 }, { scaleY: s }] };
  });

  const type = useMemo(() => heroType(variant, colors, titleSize), [variant, colors, titleSize]);

  // Mark colour: lime on the dark ink/pop blocks; brand green on LIGHT paper.
  const markColor = cube?.color
    ?? (variant === 'paper' && !isDark ? PAPER_MARK : colors.markOnInk);

  return (
    <HeroSurfaceContext.Provider value={variant}>
    <HeroCubeInsetContext.Provider value={cubeGeo.inset}>
    <Animated.View onLayout={onBlockLayout} style={[block, surface, style, stretch]}>
      {/* Clipped decorative layers: gradient, nebula, cube. */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip, radii]}>
        {variant === 'ink' ? (
          <LinearGradient
            colors={isDark ? GRADIENT_INK_DARK : GRADIENT_INK}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        {variant === 'pop' ? (
          <LinearGradient
            colors={GRADIENT_HERO}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        {/* Orbs drift at mid depth (the drift is scroll-driven; the nebula
            itself is a still frame unless `liveAurora`). */}
        {variant === 'pop' || nebula ? (
          <ParallaxLayer depth={HERO_DEPTH.orbs} scrollY={scrollY} style={StyleSheet.absoluteFill}>
            {liveAurora ? (
              variant === 'ink' && isDark
                ? <Aurora {...(AURORA_INTENSE as any)} />
                : variant === 'pop'
                  ? <Aurora />
                  : <Aurora dim />
            ) : (
              <StaticNebula
                intense={variant === 'ink' && isDark}
                dim={variant !== 'pop' && !(variant === 'ink' && isDark)}
              />
            )}
          </ParallaxLayer>
        ) : null}
        {cube ? (
          <ParallaxLayer
            depth={HERO_DEPTH.cube}
            scrollY={scrollY}
            style={{
              position: 'absolute',
              right: cubeGeo.right,
              top: cubeGeo.top,
            }}
          >
            <VertexMark
              size={cube.size}
              opacity={cube.opacity}
              color={markColor}
              kick={pageMarkKick}
            />
          </ParallaxLayer>
        ) : null}
      </View>

      {/* Text stack — near depth. Each slot keeps clear of the cube per `reserve`. */}
      <ParallaxLayer depth={HERO_DEPTH.text} scrollY={scrollY}>
        {kicker !== undefined && kicker !== null ? (
          <View style={cubeGeo.head ? { paddingRight: cubeGeo.head } : undefined}>
            {isTextual(kicker) ? <Text style={type.kicker}>{String(kicker)}</Text> : kicker}
          </View>
        ) : null}
        {title !== undefined && title !== null ? (
          <View style={cubeGeo.head ? { paddingRight: cubeGeo.head } : undefined}>
            {isTextual(title)
              ? <HeroTitle variant={variant} style={type.title} text={String(title)} gradient={type.titleGradient} />
              : title}
          </View>
        ) : null}
        {lede !== undefined && lede !== null ? (
          <View style={cubeGeo.lede ? { paddingRight: cubeGeo.lede } : undefined}>
            {isTextual(lede) ? <Text style={type.lede}>{String(lede)}</Text> : lede}
          </View>
        ) : null}
        {cubeGeo.children
          ? <View style={{ paddingRight: cubeGeo.children }}>{children}</View>
          : children}
      </ParallaxLayer>
    </Animated.View>
    </HeroCubeInsetContext.Provider>
    </HeroSurfaceContext.Provider>
  );
}

// ── Nebula ───────────────────────────────────────────────────────────────────
/** Brand green that reads on a near-white card (light paper blocks only). */
const PAPER_MARK = 'rgba(36,76,59,0.62)';

/**
 * Aurora's settled frame, painted once. Same three radial blobs, same colours,
 * same positions and the same presence Aurora shows at mid-phase (scale 1.02,
 * full base opacity) — but with no `withRepeat`, so a hero costs zero
 * continuous loops for its background. `liveAurora` brings the drift back.
 */
type NebulaBlob = {
  size: number; color: string; baseOpacity: number;
  top?: number; bottom?: number; left?: number | string; right?: number;
};

/** Aurora's three blobs, verbatim (Aurora.tsx `blobs`). */
const NEBULA_BLOBS: readonly NebulaBlob[] = [
  { size: 230, color: '#8caf38', baseOpacity: 0.60, top: -90, right: -60 },
  { size: 180, color: '#e7b65c', baseOpacity: 0.38, bottom: -80, left: -50 },
  { size: 150, color: '#3a7a56', baseOpacity: 0.32, top: 0, left: '36%' },
];

function StaticNebula({ dim, intense }: { dim?: boolean; intense?: boolean }) {
  const rawId = React.useId();
  const uid = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ''), [rawId]);
  const sizeMult = intense ? 1.5 : 1;
  const opacityMult = (dim ? 0.6 : 1) * (intense ? 1.4 : 1);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {NEBULA_BLOBS.map((b, i) => {
        const size = b.size * sizeMult;
        const id = `heroNebula-${uid}-${i}`;
        return (
          <View
            key={i}
            pointerEvents="none"
            style={{
              position: 'absolute',
              width: size,
              height: size,
              top: b.top,
              bottom: b.bottom,
              left: b.left as any,
              right: b.right,
              opacity: Math.min(1, opacityMult * b.baseOpacity),
              transform: [{ scale: 1.02 }],
            }}
          >
            <Svg width={size} height={size}>
              <Defs>
                <RadialGradient id={id} cx="50%" cy="50%" r="50%">
                  <Stop offset="0%" stopColor={b.color} stopOpacity={1} />
                  <Stop offset="55%" stopColor={b.color} stopOpacity={0.55} />
                  <Stop offset="100%" stopColor={b.color} stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
            </Svg>
          </View>
        );
      })}
    </View>
  );
}

// ── Typography ───────────────────────────────────────────────────────────────
/** Strings and numbers get the house type; anything else is a caller-owned node. */
function isTextual(node: React.ReactNode): node is string | number {
  return typeof node === 'string' || typeof node === 'number';
}

type HeroType = {
  kicker: TextStyle;
  title: TextStyle;
  lede: TextStyle;
  /** Gradient stops for the title, or null for a solid title (pop). */
  titleGradient: readonly string[] | null;
};

function heroType(variant: EditorialHeroVariant, colors: ReturnType<typeof useColors>, titleSize: number): HeroType {
  const kickerColor = variant === 'ink' ? colors.inkMuted : variant === 'pop' ? 'rgba(255,255,255,0.85)' : colors.textMuted;
  const ledeColor = variant === 'ink' ? colors.inkText : variant === 'pop' ? 'rgba(255,255,255,0.92)' : colors.textSecondary;
  return {
    kicker: {
      fontFamily: fonts.mono,
      fontSize: 11,
      letterSpacing: 1.6,
      textTransform: 'uppercase',
      color: kickerColor,
      marginBottom: 10,
    },
    // Unbounded-Black: never add fontWeight (expo-font web @font-face has no weight descriptor).
    title: {
      fontFamily: fonts.displayBlack,
      fontSize: titleSize,
      lineHeight: Math.round(titleSize * 1.08),
      letterSpacing: -Math.round(titleSize * 0.028 * 10) / 10,
      color: '#ffffff',
    },
    lede: {
      fontFamily: fonts.body,
      fontSize: 16,
      lineHeight: 23,
      color: ledeColor,
      opacity: variant === 'ink' ? 0.88 : 1,
      marginTop: 10,
    },
    titleGradient: variant === 'ink' ? GRADIENT_TEXT : variant === 'paper' ? colors.titleGradient : null,
  };
}

function HeroTitle({ variant, style, text, gradient }: {
  variant: EditorialHeroVariant; style: TextStyle; text: string; gradient: readonly string[] | null;
}) {
  if (variant === 'pop' || !gradient) {
    return <Text style={style} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75}>{text}</Text>;
  }
  return (
    <GradientText colors={gradient} style={style} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75}>
      {text}
    </GradientText>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});

export default EditorialHero;
