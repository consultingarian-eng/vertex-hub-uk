/**
 * ScrollFx — scroll-reactive building blocks (companions to Parallax.tsx):
 *
 *   ScrollProgress — 4 px gradient bar pinned to the top that fills as you
 *   read down the page, with a soft purple glow. Feed it the same scrollY as
 *   ParallaxHero plus the content/viewport heights from the ScrollView
 *   callbacks.
 *
 *   ScrollReveal — sections that tilt up into place as they scroll into
 *   view (not on mount — ON SCROLL): opacity 0→1, a 14° backward lean
 *   straightening, 36 px rise, 96 %→100 % scale, all driven by the scroll
 *   offset on the UI thread (spec §3.17). Works as a direct child of the
 *   scroll content view: onLayout y is content-relative there.
 *   Already-visible sections render revealed immediately. Sections taller
 *   than ~600 px (the schedule grid) should pass `tilt={0}` — a large
 *   surface rotating in perspective looks like a page flip, not a reveal.
 *
 * Once a section is fully revealed its transform is the flat identity
 * (no perspective), so settled content never sits in a 3D rendering context.
 */
import React, { useState } from 'react';
import { StyleProp, ViewStyle, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Extrapolation, interpolate, SharedValue, useAnimatedStyle,
} from 'react-native-reanimated';
import { GRADIENT } from '../../theme/brand';
import { useColors } from '../../theme/ThemeContext';

const BAR_H = 4;
const PERSPECTIVE = 900;
const SCALE_FROM = 0.96;

export function ScrollProgress({ scrollY, contentH, viewportH }: {
  scrollY: SharedValue<number>; contentH: number; viewportH: number;
}) {
  const colors = useColors();
  const track = Math.max(1, contentH - viewportH);
  const style = useAnimatedStyle(() => ({
    width: `${interpolate(scrollY.value, [0, track], [0, 100], Extrapolation.CLAMP)}%`,
  }));
  if (contentH <= viewportH) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute', top: 0, left: 0, height: BAR_H, zIndex: 50,
          borderRadius: BAR_H / 2, overflow: 'hidden',
          // The glow is the element's own shadow, so the clip above doesn't eat it.
          boxShadow: '0 0 8px ' + colors.glow,
        },
        style,
      ]}
    >
      <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1 }} />
    </Animated.View>
  );
}

export function ScrollReveal({ scrollY, children, style, distance = 36, tilt = 14 }: {
  scrollY: SharedValue<number>;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Rise distance in px (default 36). */
  distance?: number;
  /** Backward lean at the start, in degrees (default 14; `tilt={0}` = flat rise, for tall sections). */
  tilt?: number;
}) {
  const [y, setY] = useState<number | null>(null);
  const { height: winH } = useWindowDimensions();

  const anim = useAnimatedStyle(() => {
    // Not measured yet, or already on screen at mount → fully visible.
    if (y == null || y < winH * 0.9) {
      return { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] };
    }
    // Reveal across the band where the section crosses the bottom ~15% of
    // the viewport — fully in once it's a quarter of the way up the screen.
    const start = y - winH * 0.98;
    const end = y - winH * 0.78;
    const p = interpolate(scrollY.value, [start, end], [0, 1], Extrapolation.CLAMP);
    if (p >= 1) {
      // Landed: flat identity, no perspective left on the element.
      return { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] };
    }
    const rest = 1 - p;
    return {
      opacity: p,
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
  }, [y, winH, distance, tilt]);

  return (
    <Animated.View style={[style, anim]} onLayout={(e) => setY(e.nativeEvent.layout.y)}>
      {children}
    </Animated.View>
  );
}
