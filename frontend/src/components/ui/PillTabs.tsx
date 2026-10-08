/**
 * PillTabs — a small row of pills for switching between a few views.
 *
 *   <PillTabs items={[{ key: 'a', label: 'Performance' }, …]} value={v} onChange={setV} />
 *
 * The quiet alternative to a page-wide segment rail: the group is only as wide
 * as its labels, the chosen pill is filled with the theme's primary (dark text
 * on lime at night, white on forest by day), and it scrolls sideways if a
 * phone can't fit every label.
 */
import React from 'react';
import { ScrollView, StyleProp, StyleSheet, Text, TouchableOpacity, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors, fonts } from '../../theme/ThemeContext';

export type PillTab = {
  key: string;
  label: string;
  testID?: string;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  /** Shows a small padlock; the pill can still be chosen. */
  locked?: boolean;
};

export function PillTabs({ items, value, onChange, style, testID }: {
  items: PillTab[];
  value: string;
  onChange: (key: string) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[s.scroll, style]} testID={testID}
      contentContainerStyle={[s.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {items.map((it) => {
        const on = it.key === value;
        const fg = on ? colors.onPrimary : colors.textSecondary;
        return (
          <TouchableOpacity
            key={it.key}
            onPress={() => onChange(it.key)}
            style={[s.pill, on && { backgroundColor: colors.primary }]}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${it.label}${it.locked ? ', locked' : ''}`}
            testID={it.testID}
          >
            {it.locked ? <Ionicons name="lock-closed" size={11} color={on ? colors.onPrimary : colors.textMuted} /> : null}
            {it.icon ? <Ionicons name={it.icon} size={14} color={fg} /> : null}
            <Text style={[s.text, { color: fg }]} numberOfLines={1}>{it.label}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

/** A tracked section label with a short brand rule, the app's section heading. */
export function Kicker({ children, count, style }: { children: string; count?: number | string; style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  return (
    <View style={[s.kickerRow, style]}>
      <View style={[s.kickerBar, { backgroundColor: colors.primary }]} />
      <Text style={[s.kicker, { color: colors.text }]}>{children}</Text>
      {count !== undefined ? <Text style={[s.kickerCount, { color: colors.textMuted }]}>{count}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  scroll: { flexGrow: 0, flexShrink: 1, alignSelf: 'flex-start', maxWidth: '100%' },
  group: { flexDirection: 'row', gap: 4, padding: 3, borderRadius: 12, borderWidth: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, paddingHorizontal: 16, borderRadius: 9 },
  text: { fontFamily: fonts.bodySemibold, fontSize: 13 },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  kickerBar: { width: 18, height: 3, borderRadius: 1.5 },
  kicker: { fontFamily: fonts.displayWide, fontSize: 12, letterSpacing: 1.8, textTransform: 'uppercase' },
  kickerCount: { fontFamily: fonts.mono, fontSize: 11.5 },
});
