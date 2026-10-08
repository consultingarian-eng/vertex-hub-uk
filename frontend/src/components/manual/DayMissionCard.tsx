/**
 * DayMissionCard — compact day-mission header under the Manual's day strip.
 *
 * Shows the day objective (from the targets collection — hidden silently
 * when unset), the day identity + topic count + assessment weighting as
 * quiet chips, and a confidence-first kicker: trainees read "WHAT YOU'LL
 * MASTER TODAY", coaches read "TODAY'S MISSION" (mirrors the day/[id] hero).
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors, useTheme } from '../../theme/ThemeContext';
import { fonts, GRADIENT_PANEL } from '../../theme/brand';
import { GlowOrb, DotField } from '../ui/Decor';
import { ORIENTATION_DAYS } from '../../manual/constants';
import { getDayLabel } from '../../manual/utils';

export type DayMissionCardProps = {
  day: number;
  objective?: string | null;
  itemCount: number;
  weightText: string;
  isTrainee: boolean;
};

export function DayMissionCard({ day, objective, itemCount, weightText, isTrainee }: DayMissionCardProps) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const styles = useMemo(() => createStyles(colors), [colors]);
  const phase = ORIENTATION_DAYS.includes(day) ? 'BA Academy' : 'Field';

  return (
    <View style={styles.wrap}>
      <LinearGradient
        colors={isDark ? GRADIENT_PANEL : (['#e1ebce', '#eef4e3', '#f9fbf5'] as const)}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <GlowOrb size={150} color={colors.primaryLight} opacity={isDark ? 0.4 : 0.2} style={{ top: -70, right: -45 }} />
        <DotField size={96} color={isDark ? colors.primaryLight : colors.primary} opacity={isDark ? 0.24 : 0.14} corner="bottom-right" style={{ right: 0, bottom: 0 }} />
        <Text style={styles.kicker}>{isTrainee ? "WHAT YOU'LL MASTER TODAY" : "TODAY'S MISSION"}</Text>
        {objective ? <Text style={styles.objective}>{objective}</Text> : null}
        <View style={styles.metaRow}>
          <View style={styles.metaChip}>
            <Text style={styles.metaChipText}>{phase} · {getDayLabel(day)}</Text>
          </View>
          <View style={styles.metaChip}>
            <Text style={styles.metaChipText}>{itemCount === 1 ? '1 topic' : `${itemCount} topics`}</Text>
          </View>
          <View style={styles.metaChip}>
            <Text style={styles.metaChipText}>{weightText}</Text>
          </View>
        </View>
      </LinearGradient>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  wrap: {
    borderRadius: 20, marginBottom: 16,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.22, shadowRadius: 12, elevation: 4,
  },
  hero: {
    borderRadius: 20, padding: 16, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
  },
  kicker: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.primary, letterSpacing: 2 },
  objective: {
    fontFamily: fonts.display, fontSize: 18, fontWeight: '800',
    color: colors.text, lineHeight: 24, marginTop: 7,
  },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  metaChip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    backgroundColor: colors.background + 'B3', borderWidth: 1, borderColor: colors.border,
  },
  metaChipText: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.textSecondary },
});

export default DayMissionCard;
