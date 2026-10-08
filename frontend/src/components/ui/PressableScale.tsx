/**
 * PressableScale — drop-in replacement for TouchableOpacity that adds the
 * subtle "squish" scale native apps use for card taps, plus a brief purple
 * glow bloom on press (pairs with the haptic tap).
 *
 * Usage (same props you'd give a TouchableOpacity):
 *   <PressableScale style={styles.card} onPress={...}>...</PressableScale>
 *   <PressableScale glow={false} ...>   // squish only, no bloom
 */
import React from 'react';
import { Pressable, PressableProps, ViewStyle, StyleProp, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming } from 'react-native-reanimated';
import { useColors } from '../../theme/ThemeContext';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = PressableProps & {
  style?: StyleProp<ViewStyle>;
  /** How far to squish on press-in. 0.97 reads as premium, not bouncy. */
  scaleTo?: number;
  /** Flash a soft brand-tint bloom while pressed (default on). */
  glow?: boolean;
  children?: React.ReactNode;
};

export default function PressableScale({ style, scaleTo = 0.97, glow = true, children, ...rest }: Props) {
  const colors = useColors();
  const scale = useSharedValue(1);
  const glowOpacity = useSharedValue(0);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glowOpacity.value }));

  // Match the bloom's corners to the card it sits on.
  const flat = StyleSheet.flatten(style) as ViewStyle | undefined;
  const radius = (flat?.borderRadius as number | undefined) ?? 14;

  return (
    <AnimatedPressable
      {...rest}
      style={[style, animStyle]}
      onPressIn={(e) => {
        scale.value = withSpring(scaleTo, { damping: 20, stiffness: 300 });
        if (glow) glowOpacity.value = withTiming(0.1, { duration: 110 });
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, { damping: 20, stiffness: 300 });
        if (glow) glowOpacity.value = withTiming(0, { duration: 420 });
        rest.onPressOut?.(e);
      }}
    >
      {children}
      {glow && (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: colors.primary, borderRadius: radius },
            glowStyle,
          ]}
        />
      )}
    </AnimatedPressable>
  );
}
