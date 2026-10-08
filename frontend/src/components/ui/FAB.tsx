/**
 * FAB — reusable floating action button.
 */
import React from 'react';
import { View, TouchableOpacity, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors, lightColors } from '../../theme/ThemeContext';
import { useTabBarClearance } from '../../customization/CustomTabBar';
import { haptics } from '../../utils/haptics';

type Props = {
  icon?: keyof typeof Ionicons.glyphMap;
  label?: string;
  onPress: () => void;
  /** Right offset in px (default 16) */
  right?: number;
  /** Bottom offset — added on top of safe-area inset (default 16) */
  bottom?: number;
  /** Optional accent color. Defaults to theme primary. */
  color?: string;
  testID?: string;
};

export function FAB({ icon = 'add', label, onPress, right = 16, bottom = 16, color, testID }: Props) {
  const colors = useColors();
  const accent = color || colors.primary;
  // White on a caller-supplied colour; on the theme primary use its own ink
  // (white in light, deep forest on the light dark-theme primary).
  const ink = color ? '#fff' : colors.onPrimary;

  // The tab bar floats over content, so the FAB rides above it (bar height +
  // home-indicator inset) — same math on every platform. All current FAB
  // screens (Coaching, Bells) show the floating bar.
  const clearance = useTabBarClearance();
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { right, bottom: bottom + clearance }]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={label || 'Action'}
        testID={testID}
        onPress={() => { haptics.medium(); onPress(); }}
        activeOpacity={0.85}
        style={[styles.button, { backgroundColor: accent, shadowColor: accent }]}
      >
        <Ionicons name={icon} size={26} color={ink} />
        {label ? <Text style={[styles.label, { color: ink }]}>{label}</Text> : null}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', zIndex: 50 },
  button: {
    minWidth: 58, height: 58, borderRadius: 29,
    paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.32,
    shadowRadius: 10,
    elevation: 8,
  },
  label: { color: '#fff', fontWeight: '900', fontSize: 13, letterSpacing: 0.3 },
});

void lightColors;
