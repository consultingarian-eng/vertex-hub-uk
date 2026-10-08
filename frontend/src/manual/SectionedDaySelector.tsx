/**
 * Two-bubble day selector — Orientation pill bar + Field pill bar — used at
 * the top of the Manual screen. Extracted from app/(tabs)/manual.tsx.
 *
 * Receives `styles` as a prop because the parent owns the createStyles()
 * theme-aware sheet; passing it down avoids duplicating the colour-palette
 * resolution logic here.
 */
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { ORIENTATION_DAYS, FIELD_DAYS } from './constants';
import { getDayLabel } from './utils';

export type SectionedDaySelectorProps = {
  selected: number;
  onSelect: (day: number) => void;
  styles: any;
  trailingRight?: React.ReactNode;
};

export function SectionedDaySelector({
  selected,
  onSelect,
  styles,
  trailingRight,
}: SectionedDaySelectorProps) {
  const renderGroup = (label: string, icon: any, days: number[]) => (
    <View style={styles.sectionBubble}>
      <View style={styles.sectionBubbleHeader}>
        <Ionicons name={icon} size={13} color={colors.textSecondary} />
        <Text style={styles.sectionBubbleLabel}>{label}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sectionBubbleRow}>
        {days.map(d => {
          const active = selected === d;
          return (
            <TouchableOpacity
              key={d}
              testID={`day-selector-${d}`}
              style={[styles.bubbleDayBtn, active && styles.bubbleDayBtnActive]}
              onPress={() => onSelect(d)}
            >
              <Text style={[styles.bubbleDayText, active && styles.bubbleDayTextActive]}>{getDayLabel(d)}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
  return (
    <View style={styles.daySectionWrap}>
      <View style={styles.daySectionContent}>
        {renderGroup('BA Academy', 'home-outline', ORIENTATION_DAYS)}
        {renderGroup('Field', 'walk-outline', FIELD_DAYS)}
      </View>
      {trailingRight ? <View style={styles.daySectionTrailing}>{trailingRight}</View> : null}
    </View>
  );
}
