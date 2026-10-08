/**
 * Parallax — hero-on-scroll depth for screen headers.
 *
 * The hero drifts up slower than the content, shrinks slightly and fades as
 * you scroll — the "layered app" feel instead of flat text scrolling by.
 *
 * Usage:
 *   const { scrollY, onScroll } = useParallaxScroll();
 *   <ScrollView onScroll={onScroll} scrollEventThrottle={16}>
 *     <ParallaxHero scrollY={scrollY}>
 *       ...gradient hero card...
 *     </ParallaxHero>
 *     ...rest of screen...
 *   </ScrollView>
 *
 * onScroll runs on the JS thread on purpose — it works identically on iOS,
 * Android and web (useAnimatedScrollHandler has web quirks), and the style
 * itself still animates on the UI thread via the shared value.
 *
 * App-wide scroll phase (spec §3 / pageScroll.ts): the same handler also
 * feeds the global `pageScrollY`, so mount-once chrome (Masthead, PageField,
 * the brand cube) reacts to whichever screen is scrolling without the screen
 * knowing. On focus the hook hands `pageScrollY` this screen's offset — 0 for
 * a fresh screen, its retained offset for a screen returning from a tab
 * switch or back-navigation (tabs keep their ScrollView position, so a hard
 * reset to 0 would leave the masthead expanded over scrolled content until
 * the next scroll event). Only a screen's OUTER ScrollView may use this hook;
 * inner pickers/grids must not.
 */
import React from 'react';
import { NativeScrollEvent, NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, interpolate, Extrapolation, SharedValue,
} from 'react-native-reanimated';
import { useFocusEffect } from 'expo-router';
import { pageScrollY } from '../../theme/pageScroll';

export function useParallaxScroll() {
  const scrollY = useSharedValue(0);
  // This screen's last offset, so focus can restore the global phase.
  const lastY = React.useRef(0);

  const onScroll = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    lastY.current = y;
    scrollY.value = y;
    pageScrollY.value = y;
  }, [scrollY]);

  // Focus → the global scroll phase belongs to this screen now.
  useFocusEffect(React.useCallback(() => {
    pageScrollY.value = lastY.current;
  }, []));

  return { scrollY, onScroll };
}

export function ParallaxHero({
  scrollY, children, style,
}: {
  scrollY: SharedValue<number>;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const anim = useAnimatedStyle(() => ({
    transform: [
      // Pull-down overscroll stretches the hero toward you; scrolling away
      // lets it lag behind the content at ~40% speed.
      { translateY: interpolate(scrollY.value, [-120, 0, 200], [-36, 0, 80], Extrapolation.CLAMP) },
      { scale: interpolate(scrollY.value, [-120, 0, 200], [1.05, 1, 0.95], Extrapolation.CLAMP) },
    ],
    opacity: interpolate(scrollY.value, [0, 220], [1, 0.3], Extrapolation.CLAMP),
  }));
  return <Animated.View style={[style, anim]}>{children}</Animated.View>;
}
