/**
 * Auto-hiding landscape header.
 *
 * Renders its children pinned to the top in landscape. As the user scrolls
 * down through the screen's main scroll surface, the header slides up out of
 * view; scrolling back to the top brings it right back. In portrait it just
 * passes the children through untouched (no overlay, no animation).
 *
 * Usage:
 *   const { scrollY, translateY, onScroll, headerOffset } = useAutoHideHeader(46);
 *   <LandscapeAutoHideHeader translateY={translateY} height={46}>
 *     ...your sub-tab pills...
 *   </LandscapeAutoHideHeader>
 *   <Animated.ScrollView
 *     onScroll={onScroll}
 *     scrollEventThrottle={16}
 *     contentContainerStyle={{ paddingTop: headerOffset }}
 *   >
 *     ...
 *   </Animated.ScrollView>
 */
import React, { useRef, useMemo } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors } from '../theme/colors';
import { lightColors } from '../theme/ThemeContext';
import { useColors } from '../theme/ThemeContext';
import { useIsLandscape } from '../hooks/useIsLandscape';

export function useAutoHideHeader(headerHeight: number = 46) {
  const isLandscape = useIsLandscape();
  const scrollY = useRef(new Animated.Value(0)).current;
  const translateY = scrollY.interpolate({
    inputRange: [0, headerHeight],
    outputRange: [0, -headerHeight],
    extrapolate: 'clamp',
  });
  const onScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    { useNativeDriver: true }
  );
  // ScrollView contentContainer needs paddingTop only in landscape (where
  // the header is overlaid). In portrait the header sits in normal flow.
  return {
    scrollY,
    translateY,
    onScroll,
    headerOffset: isLandscape ? headerHeight : 0,
    isLandscape,
  };
}

type Props = {
  children: React.ReactNode;
  /** Animated translateY produced by useAutoHideHeader. Required in landscape. */
  translateY?: Animated.AnimatedInterpolation<number>;
  /** Fixed pixel height of the rendered header. Defaults to 46. */
  height?: number;
};

export default function LandscapeAutoHideHeader({ children, translateY, height = 46 }: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const isLandscape = useIsLandscape();

  // Portrait: render as a normal block so layout doesn't shift.
  if (!isLandscape) {
    return <View>{children}</View>;
  }

  // Landscape: overlay at top, slides up on scroll. zIndex keeps the segmented
  // pills above the underlying ScrollView content.
  return (
    <Animated.View
      style={[
        styles.overlay,
        { height, transform: translateY ? [{ translateY }] : undefined },
      ]}
      pointerEvents="box-none"
    >
      {children}
    </Animated.View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    justifyContent: 'center',
  },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
