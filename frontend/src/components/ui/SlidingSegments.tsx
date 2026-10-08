/**
 * SlidingSegments — the app's segmented control: a small group of pills.
 *
 *   <SlidingSegments
 *     items={[{ key: 'week', label: 'This week' }, { key: 'rates', label: 'Rates' }]}
 *     value={tab}
 *     onChange={setTab}
 *   />
 *
 * (Oct 2026: this used to be a page-wide dark rail with a sliding gradient
 * tile. The Owner asked for the app to look cleaner and simpler, so every
 * screen's rail became this quiet pill group at once. The name and the props
 * are kept so no screen had to change; `tone`, `scrollable` and `haptic` are
 * still accepted.)
 *
 * The group is only as wide as its labels and scrolls sideways when a phone
 * can't fit them all, so a label is never cut. The chosen pill is filled with
 * the theme's primary: dark text on lime at night, white on forest by day.
 * Pills are 36px tall with generous padding, a comfortable thumb target.
 */
import React from 'react';
import { ScrollView, StyleProp, StyleSheet, Text, TouchableOpacity, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors, fonts } from '../../theme/ThemeContext';
import { haptics } from '../../utils/haptics';

export type SegmentItem = {
  key: string;
  label: string;
  /** Optional leading icon. */
  icon?: React.ReactNode;
  /** Shows a padlock and dims the label. Still selectable. */
  locked?: boolean;
  /** Per-slot test id. */
  testID?: string;
};

export type SlidingSegmentsTone = 'ink' | 'paper';

export type SlidingSegmentsProps = {
  items: SegmentItem[];
  /** Key of the selected item. */
  value: string;
  onChange: (key: string) => void;
  /** Kept for callers; both tones draw the same pill group. */
  tone?: SlidingSegmentsTone;
  /** Kept for callers; the group always scrolls when it has to. */
  scrollable?: boolean;
  /** Selection haptic (default true). */
  haptic?: boolean;
  /** Outer style (margins). */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** A label written "🔒 Stage 4" by an old caller: the padlock is drawn as an icon instead. */
const stripLock = (label: string) => label.replace(/^\s*🔒\s*/, '');

export function SlidingSegments({ items, value, onChange, haptic = true, style, testID }: SlidingSegmentsProps) {
  const colors = useColors();
  return (
    <View style={style} testID={testID}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.scroll}
        contentContainerStyle={[s.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {items.map((it) => {
          const on = it.key === value;
          const locked = it.locked || /^\s*🔒/.test(it.label);
          const fg = on ? colors.onPrimary : colors.textSecondary;
          return (
            <TouchableOpacity
              key={it.key}
              onPress={() => {
                if (it.key === value) return;
                if (haptic) { try { haptics.tap(); } catch { /* no haptics here */ } }
                onChange(it.key);
              }}
              style={[s.pill, on && { backgroundColor: colors.primary }]}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${stripLock(it.label)}${locked ? ', locked' : ''}`}
              testID={it.testID}
            >
              {locked ? <Ionicons name="lock-closed" size={11} color={on ? colors.onPrimary : colors.textMuted} /> : null}
              {it.icon ? <View style={{ opacity: on ? 1 : 0.85 }}>{it.icon}</View> : null}
              <Text style={[s.text, { color: fg }, locked && !on && { color: colors.textMuted }]} numberOfLines={1}>{stripLock(it.label)}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  scroll: { flexGrow: 0, alignSelf: 'flex-start', maxWidth: '100%' },
  group: { flexDirection: 'row', gap: 4, padding: 3, borderRadius: 12, borderWidth: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 16, borderRadius: 9 },
  text: { fontFamily: fonts.bodySemibold, fontSize: 13 },
});

export default SlidingSegments;
