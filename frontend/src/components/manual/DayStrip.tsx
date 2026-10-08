/**
 * DayStrip — horizontal day-card selector for the Training Manual reading
 * experience. One card per journey day (Orientation Day 1-2, Field Day 1-6):
 * phase kicker + day label + topic count. The selected card gets the brand
 * gradient treatment. Replaces the old bare number bubbles.
 *
 * Reading-only concern — the admin edit toggle rides in via `trailingRight`
 * so every editor entry point survives unchanged.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '../../theme/ThemeContext';
import { fonts, GRADIENT, brand } from '../../theme/brand';
import { ALL_DAYS, ORIENTATION_DAYS } from '../../manual/constants';
import { getDayLabel } from '../../manual/utils';
import PressableScale from '../ui/PressableScale';

const CARD_W = 96;
const CARD_GAP = 8;

export type DayStripProps = {
  selected: number;
  onSelect: (day: number) => void;
  /** Topic count per DB day number — shown on each card. */
  counts: Record<number, number>;
  /** Slot on the right edge (e.g. the admin edit toggle). */
  trailingRight?: React.ReactNode;
};

export function DayStrip({ selected, onSelect, counts, trailingRight }: DayStripProps) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const scrollRef = useRef<ScrollView>(null);

  // Keep the selected card in view as the reader moves through the days.
  useEffect(() => {
    const idx = ALL_DAYS.indexOf(selected);
    if (idx < 0) return;
    scrollRef.current?.scrollTo({ x: Math.max(0, idx * (CARD_W + CARD_GAP) - 48), animated: true });
  }, [selected]);

  return (
    <View style={styles.wrap}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {ALL_DAYS.map((d) => {
          const active = selected === d;
          const phase = ORIENTATION_DAYS.includes(d) ? 'BA ACADEMY' : 'FIELD';
          const count = counts[d] ?? 0;
          return (
            <PressableScale
              key={d}
              testID={`day-selector-${d}`}
              style={[styles.card, active && styles.cardActive]}
              onPress={() => onSelect(d)}
            >
              {active && (
                <LinearGradient
                  colors={GRADIENT}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[StyleSheet.absoluteFill, { borderRadius: 16 }]}
                />
              )}
              <Text style={[styles.kicker, active && styles.kickerActive]}>{phase}</Text>
              <Text style={[styles.day, active && styles.dayActive]}>{getDayLabel(d)}</Text>
              <Text style={[styles.count, active && styles.countActive]}>
                {count === 1 ? '1 topic' : `${count} topics`}
              </Text>
            </PressableScale>
          );
        })}
      </ScrollView>
      {trailingRight ? <View style={styles.trailing}>{trailingRight}</View> : null}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.background,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  row: { gap: CARD_GAP, paddingHorizontal: 12, paddingVertical: 10 },
  card: {
    width: CARD_W, borderRadius: 16, paddingVertical: 9, paddingHorizontal: 11,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  cardActive: {
    borderColor: 'transparent',
    shadowColor: brand.mid, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.32, shadowRadius: 9, elevation: 4,
  },
  kicker: { fontFamily: fonts.mono, fontSize: 8, fontWeight: '700', color: colors.textMuted, letterSpacing: 1 },
  kickerActive: { color: 'rgba(255,255,255,0.85)' },
  day: { fontFamily: fonts.display, fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 3 },
  dayActive: { color: colors.textLight },
  count: { fontFamily: fonts.body, fontSize: 10.5, fontWeight: '600', color: colors.textMuted, marginTop: 2 },
  countActive: { color: 'rgba(255,255,255,0.9)' },
  trailing: { justifyContent: 'center', alignItems: 'center', paddingRight: 4 },
});

export default DayStrip;
