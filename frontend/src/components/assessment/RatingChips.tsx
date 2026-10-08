/**
 * RatingChips — one-tap 5-level rating row for the end-of-day grader.
 *
 * Replaces the old free-text 0–10 keyboard fields. Each chip maps to a fixed
 * score (Poor 2 · Below 4 · OK 6 · Good 8 · Excellent 10) so the backend
 * keeps receiving the same 0–10 numbers and historical data stays comparable.
 * Loading a legacy draft (e.g. a typed 7) highlights the nearest chip while
 * preserving the stored value until the leader taps a chip.
 */
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useColors } from '../../theme/ThemeContext';
import { fonts } from '../../theme/brand';
import { haptics } from '../../utils/haptics';

export const RATING_LEVELS = [
  { label: 'Poor', value: 2 },
  { label: 'Below', value: 4 },
  { label: 'OK', value: 6 },
  { label: 'Good', value: 8 },
  { label: 'Excellent', value: 10 },
] as const;

/** Nearest chip for a legacy/typed value (7 → Good, 5 → OK …). */
export function nearestLevel(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  const v = Number(value);
  let best: number = RATING_LEVELS[0].value;
  for (const l of RATING_LEVELS) {
    if (Math.abs(l.value - v) < Math.abs(best - v)) best = l.value;
  }
  return best;
}

type Props = {
  label: string;
  value: number | null | undefined;
  onChange: (v: number) => void;
  disabled?: boolean;
};

export function RatingChips({ label, value, onChange, disabled }: Props) {
  const colors = useColors();
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  const selected = nearestLevel(value);
  const exact = value !== null && value !== undefined && String(value) !== '';

  return (
    <View style={styles.row}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {exact ? <Text style={styles.valueText}>{Number(value)}</Text> : null}
      </View>
      <View style={styles.chips}>
        {RATING_LEVELS.map((l) => {
          const active = exact && selected === l.value;
          return (
            <TouchableOpacity
              key={l.value}
              disabled={disabled}
              onPress={() => { haptics.light(); onChange(l.value); }}
              style={[styles.chip, active && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                {l.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  row: { marginBottom: 12 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  label: { fontSize: 13.5, fontWeight: '600', color: colors.text },
  valueText: { fontFamily: fonts.mono, fontSize: 12, fontWeight: '700', color: colors.primary },
  chips: { flexDirection: 'row', gap: 5 },
  chip: {
    flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 9,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  chipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '18' },
  chipText: { fontSize: 10.5, fontWeight: '600', color: colors.textMuted },
  chipTextActive: { color: colors.primary, fontWeight: '800' },
});

export default RatingChips;
