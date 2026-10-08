/**
 * Skeleton — animated shimmering placeholder for loading states.
 *
 * Base pulse (surface ⇄ border) plus a bright scan-line that sweeps across
 * each block — the "scanning in" look, not a gray box.
 *
 * Usage:
 *   <Skeleton width={120} height={16} />
 *   <Skeleton.Card />        // pre-built card skeleton
 *   <Skeleton.Row />         // pre-built single-line row
 *   <Skeleton.BellsRow />    // pre-built bells card row
 */
import React, { useEffect, useState } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, withDelay,
  Easing, interpolateColor, interpolate,
} from 'react-native-reanimated';
import { useColors, useTheme } from '../../theme/ThemeContext';

type Props = {
  width?: number | `${number}%`;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
};

export function Skeleton({ width = '100%', height = 14, borderRadius = 6, style }: Props) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const progress = useSharedValue(0);
  const sweep = useSharedValue(0);
  const [measuredW, setMeasuredW] = useState(0);

  useEffect(() => {
    progress.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }), -1, true);
    // Sweep runs one-way with a beat of rest between passes.
    sweep.value = withRepeat(
      withDelay(300, withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.cubic) })),
      -1,
      false,
    );
  }, [progress, sweep]);

  const animStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [colors.surfaceAlt, colors.border]
    ),
  }));
  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{
      translateX: interpolate(sweep.value, [0, 1], [-measuredW * 0.6, measuredW * 1.1]),
    }],
  }));

  const shine = isDark ? 'rgba(183,223,88,0.16)' : 'rgba(255,255,255,0.65)';

  return (
    <Animated.View
      onLayout={(e) => setMeasuredW(e.nativeEvent.layout.width)}
      style={[
        { width: width as any, height, borderRadius, overflow: 'hidden' },
        animStyle,
        style,
      ]}
    >
      {measuredW > 0 && (
        <Animated.View style={[StyleSheet.absoluteFill, { width: measuredW * 0.55 }, sweepStyle]}>
          <LinearGradient
            colors={['transparent', shine, 'transparent'] as const}
            start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      )}
    </Animated.View>
  );
}

function Row() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 }}>
      <Skeleton width={36} height={36} borderRadius={18} />
      <View style={{ flex: 1, gap: 6 }}>
        <Skeleton width={'60%'} height={12} />
        <Skeleton width={'40%'} height={10} />
      </View>
      <Skeleton width={48} height={20} borderRadius={6} />
    </View>
  );
}

function Card() {
  return (
    <View style={styles.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <Skeleton width={42} height={42} borderRadius={21} />
        <View style={{ flex: 1, gap: 6 }}>
          <Skeleton width={'70%'} height={14} />
          <Skeleton width={'50%'} height={10} />
        </View>
        <Skeleton width={60} height={22} borderRadius={6} />
      </View>
      <Skeleton width={'100%'} height={40} borderRadius={8} />
    </View>
  );
}

// Bells-specific skeleton — matches EntryRow approx shape
function BellsRow() {
  return (
    <View style={[styles.card, { marginTop: 10 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, gap: 6 }}>
          <Skeleton width={'55%'} height={15} />
          <Skeleton width={'80%'} height={11} />
        </View>
        <Skeleton width={56} height={18} />
      </View>
    </View>
  );
}

function List({ count = 3, kind = 'card' }: { count?: number; kind?: 'card' | 'row' | 'bells' }) {
  const Item = kind === 'card' ? Card : kind === 'bells' ? BellsRow : Row;
  return (
    <View>
      {Array.from({ length: count }).map((_, i) => (
        <Item key={i} />
      ))}
    </View>
  );
}

Skeleton.Row = Row;
Skeleton.Card = Card;
Skeleton.BellsRow = BellsRow;
Skeleton.List = List;

const styles = StyleSheet.create({
  card: {
    padding: 12,
    borderRadius: 12,
    marginVertical: 6,
    backgroundColor: 'transparent',
  },
});
