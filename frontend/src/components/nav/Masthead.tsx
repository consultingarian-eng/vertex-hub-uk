/**
 * Masthead — the global editorial header of the "Ink & Cube" system (spec §3.2).
 *
 * ONE component serves three callers:
 *
 *   1. The root native-stack:  screenOptions.header = (props) => <Masthead {...props} />
 *   2. The bottom-tabs:        screenOptions.header = (props) => <Masthead {...props} />
 *   3. Screens that hide the navigator header (`headerShown: false`) and want
 *      the same look:          <Masthead standalone title="Bells" compact right={…} onBack={…} />
 *
 * Navigator mode reads the screen's ordinary options so every existing
 * `Stack.Screen`/`Tabs.Screen` keeps working unchanged: `headerTitle` (string)
 * → `title` → `route.name`; `headerRight`; `headerLeft` (`() => null` hides
 * the chevron, a node replaces it); `headerBackVisible`. "Can go back" comes
 * from `props.back` on the stack and `navigation.canGoBack()` on the tabs.
 *
 * Layout: `paddingTop: insets.top` (skipped when a parent navigator already
 * shows a header), then one fixed-height row — 68px, or 48px + no cube in
 * `compact` — holding [glass back chip] [gradient Unbounded title] [headerRight]
 * [44px Vertex X mark], with a 3px brand-gradient hairline along the bottom.
 *
 * Scroll condense (UI thread, from the app-wide `pageScrollY`): the title
 * scales 1 → 0.72 over the first 120px with a translateX that pins its LEFT
 * edge (the wrapper width comes from one onLayout), and the hairline fades to
 * 0.35. The row height never changes — condensing is visual only, so the
 * scene below never relayouts.
 *
 * Compact routes: spread `MASTHEAD_COMPACT` into a screen's options. The
 * navigation option types are `type` aliases, not interfaces, so they cannot
 * be augmented via `declare module` (TS2300); a typed constant spread into the
 * options literal is the type-safe way to carry the custom key, and the
 * masthead reads it back as `MastheadOptions`.
 *
 * Background: transparent on web and Android — the header sits over the
 * mount-once PageField and its blobs must flow through, and on pushed routes
 * the scene's own `contentStyle` (opaque `colors.page`) is painted behind the
 * header by react-native-screens, so nothing can ghost. iOS is the platform
 * the spec flags as unverified in Expo Go (§7): there the header paints
 * `colors.page` on opaque (animated push/card/modal) routes — identical to the
 * scene fill beneath, so zero visual cost, and immune to any push-transition
 * exposure of the header band — and stays transparent on the allowlisted
 * transparent scenes (animation:'none' hubs + tabs), which have no transition
 * and must show the field's blobs.
 *
 * Perf: one gradient text, one static gradient hairline and one 44px cube (9
 * animated SVG nodes, one worklet per frame). Every screen in a stack keeps
 * its header mounted, so the cube is only mounted while its screen is focused
 * (released ~450ms after blur, once the transition has finished) — otherwise a
 * three-deep stack plus eight visited tabs would run eleven cube loops.
 */
import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { NavigationContext } from '@react-navigation/native';
import { HeaderShownContext } from '@react-navigation/elements';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import type { BottomTabHeaderProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { fonts, GRADIENT, useColors, useTheme, type ColorPalette } from '../../theme/ThemeContext';
import { pageMarkKick, pageScrollY } from '../../theme/pageScroll';
import { VertexMark } from '../ui/VertexMark';
import { GradientText } from '../ui/GradientText';
import { haptics } from '../../utils/haptics';

// ── Public API ───────────────────────────────────────────────────────────────

/** Custom screen option read by the Masthead (see MASTHEAD_COMPACT). */
export type MastheadOptions = {
  /** 48px row without the cube — dense data screens (schedule, bells, planners, live-*). */
  mastheadCompact?: boolean;
};

/**
 * Spread into a `Stack.Screen` / `Tabs.Screen` `options` literal (or pass to
 * `navigation.setOptions`) to get the compact masthead:
 *
 *   <Stack.Screen name="bells" options={{ title: 'Bells', ...MASTHEAD_COMPACT }} />
 */
export const MASTHEAD_COMPACT: Readonly<MastheadOptions> = Object.freeze({ mastheadCompact: true });

/** Header props handed to us by either navigator. */
export type MastheadNavProps = NativeStackHeaderProps | BottomTabHeaderProps;

/** Opt-in header for screens that hide the navigator header. */
export type MastheadStandaloneProps = {
  standalone: true;
  title: string;
  compact?: boolean;
  /** Node(s) rendered in the right slot, before the cube. */
  right?: React.ReactNode;
  /** Provide to show the glass back chip (e.g. `() => router.back()`); omit for no chip. */
  onBack?: () => void;
};

export type MastheadProps = MastheadNavProps | MastheadStandaloneProps;

/** Fixed row heights (below the safe-area inset). Exported for layout math elsewhere. */
export const MASTHEAD_ROW = 68;
export const MASTHEAD_ROW_COMPACT = 48;

// ── Constants ────────────────────────────────────────────────────────────────
const HAIRLINE = 3;
const GUTTER = 16;
const SLOT_GAP = 12;
const CUBE_SIZE = 44;
/** The Vertex X on the LIGHT masthead: brand green, a touch softer than the title. */
const MASTHEAD_MARK_LIGHT = 'rgba(36,76,59,0.85)';
const CHIP_SIZE = 36;
const CONDENSE_PX = 120;        // scroll distance over which the title condenses
const CONDENSE_SCALE = 0.72;
const HAIRLINE_MIN_OPACITY = 0.35;
const CUBE_RELEASE_MS = 450;    // keep the cube through a push/pop transition before unmounting
const LONG_TITLE = 14;          // > 14 chars → 22px instead of 28px

// ── Option access ────────────────────────────────────────────────────────────
// The two navigators' option types differ in the shape of headerLeft/headerRight
// params; this is the common subset the masthead needs, plus our custom key.
type HeaderOpts = MastheadOptions & {
  title?: string;
  headerTitle?: unknown;
  headerBackVisible?: boolean;
  headerLeft?: (p: { tintColor?: string; canGoBack?: boolean }) => React.ReactNode;
  headerRight?: (p: { tintColor?: string; canGoBack: boolean }) => React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
};

type Resolved = {
  title: string;
  compact: boolean;
  /** Whether a back affordance is possible at all. */
  canGoBack: boolean;
  /** Render the glass chevron chip (back possible, not hidden, no custom headerLeft). */
  showChip: boolean;
  /** Custom headerLeft output: undefined = not provided, null = explicitly hidden. */
  leftNode: React.ReactNode | undefined;
  rightNode: React.ReactNode;
  onBack: () => void;
  /** Scene behind the header is transparent (PageField shows through). */
  sceneTransparent: boolean;
};

function isStandalone(p: MastheadProps): p is MastheadStandaloneProps {
  return 'standalone' in p && p.standalone === true;
}

function isTabs(p: MastheadNavProps): p is BottomTabHeaderProps {
  // Bottom-tabs header props carry `layout`; native-stack's carry `back`.
  return 'layout' in p;
}

function resolve(props: MastheadProps, colors: ColorPalette): Resolved {
  if (isStandalone(props)) {
    return {
      title: props.title,
      compact: !!props.compact,
      canGoBack: !!props.onBack,
      showChip: !!props.onBack,
      leftNode: undefined,
      rightNode: props.right ?? null,
      // No-op when omitted: showChip is false so it can never be pressed.
      onBack: props.onBack ?? (() => {}),
      // A standalone masthead lives inside the screen, which owns its own fill.
      sceneTransparent: true,
    };
  }

  const { navigation, route } = props;
  const opts = props.options as HeaderOpts;
  const tabs = isTabs(props);

  const title = typeof opts.headerTitle === 'string'
    ? opts.headerTitle
    : (opts.title ?? route.name);

  const canGoBack = tabs ? navigation.canGoBack() : props.back != null;
  const leftNode = opts.headerLeft ? opts.headerLeft({ tintColor: colors.text, canGoBack }) : undefined;
  const showChip = canGoBack && opts.headerBackVisible !== false && opts.headerLeft === undefined;
  const rightNode = opts.headerRight ? opts.headerRight({ tintColor: colors.text, canGoBack }) : null;

  // Tabs scenes are transparent by construction (sceneStyle in (tabs)/_layout);
  // stack scenes are opaque `colors.page` unless the route spreads TRANSPARENT_SCENE.
  const sceneTransparent = tabs
    ? true
    : StyleSheet.flatten(opts.contentStyle)?.backgroundColor === 'transparent';

  return {
    title,
    compact: opts.mastheadCompact === true,
    canGoBack,
    showChip,
    leftNode,
    rightNode,
    onBack: () => navigation.goBack(),
    sceneTransparent,
  };
}

// ── Focus (tolerant useIsFocused) ────────────────────────────────────────────
// Same contract as @react-navigation's useIsFocused, but a masthead rendered
// outside any navigator (storybook, a bare test) simply counts as focused
// instead of throwing.
function useScreenFocused(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState<boolean>(() => (navigation ? navigation.isFocused() : true));
  useEffect(() => {
    if (!navigation) return;
    setFocused(navigation.isFocused());
    const offFocus = navigation.addListener('focus', () => setFocused(true));
    const offBlur = navigation.addListener('blur', () => setFocused(false));
    return () => { offFocus(); offBlur(); };
  }, [navigation]);
  return focused;
}

/** Mounted while focused; released CUBE_RELEASE_MS after blur so the cube survives the exit transition. */
function useCubeMounted(focused: boolean): boolean {
  const [mounted, setMounted] = useState(focused);
  useEffect(() => {
    if (focused) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), CUBE_RELEASE_MS);
    return () => clearTimeout(t);
  }, [focused]);
  return mounted;
}

// ── Back chip ────────────────────────────────────────────────────────────────
function BackChip({ onPress, label, colors, light }: {
  onPress: () => void;
  label: string;
  colors: ColorPalette;
  light: boolean;
}) {
  const press = useCallback(() => { haptics.tap(); onPress(); }, [onPress]);
  return (
    <Pressable
      onPress={press}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: colors.glass,
          borderColor: colors.glassBorder,
          // depthShadow is a boxShadow STRING (not hex-alpha concatenation); light theme only per spec.
          ...(light ? { boxShadow: colors.depthShadow } : null),
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {/* Optical centring: the chevron glyph sits right of its box centre. */}
      <Ionicons name="chevron-back" size={20} color={colors.text} style={styles.chevron} />
    </Pressable>
  );
}

// ── Masthead ─────────────────────────────────────────────────────────────────
export function Masthead(props: MastheadProps) {
  const colors = useColors();
  const { effective } = useTheme();
  const insets = useSafeAreaInsets();
  // A parent navigator that already shows a header has paid the status-bar
  // inset; the default elements Header does the same check.
  const parentHeaderShown = useContext(HeaderShownContext);
  const topInset = parentHeaderShown ? 0 : insets.top;

  const r = resolve(props, colors);
  const rowHeight = r.compact ? MASTHEAD_ROW_COMPACT : MASTHEAD_ROW;

  // iOS paints colors.page behind opaque scenes (see header comment); everything
  // else is transparent so the PageField shows through.
  const background = Platform.OS === 'ios' && !r.sceneTransparent ? colors.page : 'transparent';

  // Title type: Unbounded Black via fonts.displayBlack — NEVER add fontWeight
  // (expo-font's web @font-face has no weight descriptor → faux-bold smear).
  const fontSize = r.compact ? 20 : r.title.length > LONG_TITLE ? 22 : 28;
  const titleTextStyle = useMemo<TextStyle>(() => ({
    fontFamily: fonts.displayBlack,
    fontSize,
    letterSpacing: -0.6,
  }), [fontSize]);

  // ── Scroll condense (transform/opacity only, fixed row height) ───────────
  const titleWidth = useSharedValue(0);
  const onTitleLayout = useCallback((e: LayoutChangeEvent) => {
    titleWidth.value = e.nativeEvent.layout.width;
  }, [titleWidth]);

  const titleAnim = useAnimatedStyle(() => {
    const s = interpolate(pageScrollY.value, [0, CONDENSE_PX], [1, CONDENSE_SCALE], Extrapolation.CLAMP);
    return {
      transform: [
        // Scale happens about the wrapper's centre; shifting left by half the
        // lost width keeps the LEFT edge pinned (left-origin scale).
        { translateX: -((1 - s) * titleWidth.value) / 2 },
        { scale: s },
      ],
    };
  });
  const hairlineAnim = useAnimatedStyle(() => ({
    opacity: interpolate(pageScrollY.value, [0, CONDENSE_PX], [1, HAIRLINE_MIN_OPACITY], Extrapolation.CLAMP),
  }));

  // ── Cube only while this screen is (or is just leaving) focus ───────────
  const focused = useScreenFocused();
  const cubeMounted = useCubeMounted(focused);

  // Left slot: a custom headerLeft wins (null = deliberately empty), else the chip.
  let left: React.ReactNode = null;
  if (r.leftNode !== undefined) {
    left = r.leftNode ? <View style={styles.slot}>{r.leftNode}</View> : null;
  } else if (r.showChip) {
    const backTitle = !isStandalone(props) && !isTabs(props) ? props.back?.title : undefined;
    left = (
      <BackChip
        onPress={r.onBack}
        label={backTitle ? `Back to ${backTitle}` : 'Back'}
        colors={colors}
        light={effective === 'light'}
      />
    );
  }

  return (
    <View style={[styles.root, { paddingTop: topInset, backgroundColor: background }]}>
      <View style={[styles.row, { height: rowHeight }]}>
        {left}
        <Animated.View style={[styles.titleWrap, titleAnim]} onLayout={onTitleLayout}>
          <GradientText
            colors={colors.titleGradient}
            style={titleTextStyle}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.75}
          >
            {r.title}
          </GradientText>
        </Animated.View>
        {r.rightNode ? <View style={styles.slot}>{r.rightNode}</View> : null}
        {!r.compact ? (
          // Fixed-size slot so the title width is stable whether or not the cube is mounted.
          <View style={styles.cubeSlot}>
            {cubeMounted ? (
              <VertexMark
                size={CUBE_SIZE}
                color={effective === 'dark' ? colors.markColor : MASTHEAD_MARK_LIGHT}
                kick={pageMarkKick}
              />
            ) : null}
          </View>
        ) : null}
      </View>
      <Animated.View pointerEvents="none" style={[styles.hairline, hairlineAnim]}>
        <LinearGradient
          colors={GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'relative',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: GUTTER,
    gap: SLOT_GAP,
  },
  // flex:1 (grow + shrink) bounds the title so numberOfLines/adjustsFontSizeToFit
  // have a width to fit into; RN's default flexShrink is 0, so flex:1 matters.
  titleWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  slot: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cubeSlot: {
    width: CUBE_SIZE,
    height: CUBE_SIZE,
  },
  chip: {
    width: CHIP_SIZE,
    height: CHIP_SIZE,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: {
    marginLeft: -2,
  },
  hairline: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: HAIRLINE,
  },
});

export default Masthead;
