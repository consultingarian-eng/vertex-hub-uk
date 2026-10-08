/**
 * StatusRail — Home's condensed sticky strip (spec §3.21).
 *
 * Home hides the navigator masthead (its ink EditorialHero starts at the top
 * edge), so once the hero has scrolled away this 52px ink rail fades in under
 * the status bar with the essentials from the hero: the sales-level HexCoin,
 * the first name, a 120px XP bar and the inbox bell — the same handler the
 * hero's bell uses.
 *
 *   <View style={{ flex: 1 }}>
 *     <ScrollView onScroll={onScroll} …>…</ScrollView>
 *     <StatusRail scrollY={scrollY} name={firstName} level={3} tint="silver"
 *       progress={0.6} unread={2} onBell={() => router.push('/notifications')} />
 *   </View>
 *
 * Motion: opacity/translateY interpolated from `scrollY` [140, 220] → [0, 1] /
 * [−12, 0] on the UI thread. `style.pointerEvents` is toggled from a
 * useAnimatedReaction (runOnJS only when the 0.5 threshold is crossed, so the
 * rail re-renders twice per scroll direction at most) — 'none' while it is
 * still mostly transparent, so it never steals taps from the hero beneath.
 *
 * Opaque by design (colors.ink) — it is sticky chrome; the ink also covers the
 * status-bar inset so the name never sits on the page field. Zero loops: the
 * 28px coin is static and the bar runs with tip/glow off.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { GRADIENT, fonts, useColors, useTheme } from '../../theme/ThemeContext';
import { HexCoin, type HexCoinTint } from './HexCoin';
import { XPBar } from './XPBar';

export type StatusRailProps = {
  /** The screen's outer scroll offset (from useParallaxScroll). */
  scrollY: SharedValue<number>;
  /** First name, as shown in the hero. */
  name: string;
  /** Sales level for the 28px coin; omit (null) to render no coin. */
  level?: number | null;
  tint?: HexCoinTint;
  /** 0–1 for the 120px XP bar; null renders no bar (a viewer with no ladder). */
  progress: number | null;
  /** Unread inbox count for the bell badge. */
  unread?: number;
  onBell?: () => void;
  testID?: string;
};

export const STATUS_RAIL_HEIGHT = 52;
/** Scroll range over which the rail fades in. */
const FADE_START = 140;
const FADE_END = 220;
/** Midpoint of the fade — pointer events flip here. */
const INTERACTIVE_AT = (FADE_START + FADE_END) / 2;
const XP_WIDTH = 120;

export function StatusRail({
  scrollY, name, level = null, tint = 'purple', progress, unread = 0, onBell, testID,
}: StatusRailProps) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const insets = useSafeAreaInsets();

  // Visible ↔ interactive. Flipped from the UI thread only when the threshold
  // is crossed, so scrolling costs no React work.
  const [interactive, setInteractive] = useState(false);
  useAnimatedReaction(
    () => scrollY.value >= INTERACTIVE_AT,
    (on, prev) => {
      if (prev === null || on !== prev) runOnJS(setInteractive)(on);
    },
    [scrollY],
  );

  const anim = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [FADE_START, FADE_END], [0, 1], Extrapolation.CLAMP),
    transform: [{
      translateY: interpolate(scrollY.value, [FADE_START, FADE_END], [-12, 0], Extrapolation.CLAMP),
    }],
  }));

  // Light glass on ink is a pale chip → dark glyph; dark glass stays dark → inkText glyph.
  const bellColor = isDark ? colors.inkText : colors.text;

  return (
    <Animated.View
      accessibilityElementsHidden={!interactive}
      importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}
      testID={testID}
      style={[
        styles.rail,
        {
          paddingTop: insets.top,
          height: STATUS_RAIL_HEIGHT + insets.top,
          backgroundColor: colors.ink,
          // In the style, not the prop — rnw logs a deprecation for the prop form.
          pointerEvents: interactive ? 'box-none' : 'none',
        },
        anim,
      ]}
    >
      <View style={styles.row}>
        {level != null ? (
          <HexCoin size={28} tint={tint} animate={false}>{String(level)}</HexCoin>
        ) : null}
        <Text style={[styles.name, { color: colors.inkText }]} numberOfLines={1}>{name}</Text>
        {/* No ladder for this viewer (admins have no sales path) → no bar: an
            empty track in the chrome reads as something that failed to load,
            and a bar derived from "which COD stages are open" is pinned full
            for every admin for ever, which is worse (round-2 review). The
            caller passes null for that case. */}
        {progress != null && (level != null || progress > 0) ? (
          <XPBar
            value={progress}
            // tone="ink", not the default 'auto': the rail is NOT inside an
            // EditorialHero, so auto falls back to 'paper' and paints the
            // light theme's pale-lilac track straight onto the near-black
            // rail — the empty part of the bar then reads as a second lit
            // segment and a 55 % bar looks finished. 'ink' cuts a dark groove
            // in both themes (the rail is colors.ink either way).
            tone="ink"
            height={6}
            ticks={false}
            tip={false}
            glow={false}
            animateOnEnter={false}
            style={styles.xp}
          />
        ) : null}
        <TouchableOpacity
          onPress={onBell}
          disabled={!onBell}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          accessibilityRole="button"
          style={[styles.bell, { backgroundColor: colors.glass, borderColor: colors.glassBorder }]}
        >
          <Ionicons name="notifications-outline" size={17} color={bellColor} />
          {unread > 0 ? (
            <View style={[styles.badge, { backgroundColor: colors.red, borderColor: colors.ink }]}>
              <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
      </View>
      <LinearGradient
        colors={GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.hairline}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    // Sticky chrome: a soft drop so it reads as a lid over the scrolling page.
    boxShadow: '0 8px 20px -8px rgba(0,0,0,0.45)',
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  name: {
    flex: 1,
    // Unbounded: never add fontWeight (web faux-bold).
    fontFamily: fonts.displayWide,
    fontSize: 13,
    letterSpacing: 0.4,
  },
  xp: { width: XP_WIDTH },
  bell: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -5,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 9, fontFamily: fonts.bodyBold },
  hairline: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2 },
});

export default StatusRail;
