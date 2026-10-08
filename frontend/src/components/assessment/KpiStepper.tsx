/**
 * KpiStepper — −/+ counter row for the grader's KPI section.
 *
 * Replaces keyboard number entry. Shows the day target and colors the count
 * green (met), amber (≥60% of target) or muted as it moves. Tapping the
 * number still opens direct entry for big jumps (long lists of doors).
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../theme/ThemeContext';
import { fonts } from '../../theme/brand';
import { haptics } from '../../utils/haptics';

type Props = {
  label: string;
  value: number | null | undefined;
  onChange: (v: number) => void;
  target?: number | null;
  max?: number;
  disabled?: boolean;
};

export function KpiStepper({ label, value, onChange, target, max = 200, disabled }: Props) {
  const colors = useColors();
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  const [editing, setEditing] = useState(false);
  const n = Number(value ?? 0) || 0;

  const tone = target && target > 0
    ? n >= target ? '#10b981' : n >= target * 0.6 ? '#f59e0b' : colors.text
    : colors.text;

  const bump = (d: number) => {
    if (disabled) return;
    haptics.light();
    onChange(Math.max(0, Math.min(max, n + d)));
  };

  return (
    <View style={styles.row}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.label} numberOfLines={1}>{label}</Text>
        {target != null && target > 0 ? (
          <Text style={styles.target}>target {target}</Text>
        ) : null}
      </View>
      <TouchableOpacity onPress={() => bump(-1)} disabled={disabled || n <= 0} style={[styles.btn, (disabled || n <= 0) && { opacity: 0.35 }]}>
        <Ionicons name="remove" size={18} color={colors.text} />
      </TouchableOpacity>
      {editing ? (
        <TextInput
          style={[styles.count, { color: tone, paddingVertical: 0 }]}
          autoFocus
          keyboardType="number-pad"
          defaultValue={String(n)}
          maxLength={3}
          onEndEditing={(e) => {
            const v = parseInt(e.nativeEvent.text, 10);
            if (!Number.isNaN(v)) onChange(Math.max(0, Math.min(max, v)));
            setEditing(false);
          }}
        />
      ) : (
        <TouchableOpacity disabled={disabled} onPress={() => setEditing(true)}>
          <Text style={[styles.count, { color: tone }]}>{n}</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={() => bump(1)} disabled={disabled || n >= max} style={[styles.btn, (disabled || n >= max) && { opacity: 0.35 }]}>
        <Ionicons name="add" size={18} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  label: { fontSize: 13.5, fontWeight: '600', color: colors.text },
  target: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.textMuted, marginTop: 1 },
  btn: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  count: {
    fontFamily: fonts.monoSemibold, fontSize: 18, fontWeight: '800',
    minWidth: 44, textAlign: 'center',
  },
});

export default KpiStepper;
