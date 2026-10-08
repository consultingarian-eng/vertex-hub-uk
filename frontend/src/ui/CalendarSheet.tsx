/**
 * Dependency-free calendar sheet for picking a day. OTA-safe (pure JS, no
 * native module) and react-native-web friendly. Days after `maxDate` are
 * disabled; selecting a day closes the sheet.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useColors } from '../theme/ThemeContext';
import { APP_LOCALE } from '../utils/appTime';

function pad(n: number) { return String(n).padStart(2, '0'); }

export default function CalendarSheet({ visible, value, onClose, onSelect, maxDate }: {
  visible: boolean;
  value: string;              // 'YYYY-MM-DD'
  onClose: () => void;
  onSelect: (iso: string) => void;
  maxDate?: string;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [month, setMonth] = useState(() => value.slice(0, 7)); // 'YYYY-MM'
  useEffect(() => {
    if (visible) setMonth(value.slice(0, 7));
  }, [visible, value]);

  const grid = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const startDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells: (string | null)[] = Array(startDow).fill(null);
    for (let d = 1; d <= daysIn; d++) cells.push(`${y}-${pad(m)}-${pad(d)}`);
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [month]);

  const shiftMonth = (dir: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + dir, 1));
    setMonth(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
  };

  const monthLabel = new Date(`${month}-15T12:00:00Z`)
    .toLocaleDateString(APP_LOCALE, { month: 'long', year: 'numeric' });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.head}>
            <Pressable style={styles.nav} onPress={() => shiftMonth(-1)} hitSlop={8}>
              <Ionicons name="chevron-back" size={18} color={colors.primary} />
            </Pressable>
            <Text style={styles.monthLabel}>{monthLabel}</Text>
            <Pressable style={styles.nav} onPress={() => shiftMonth(1)} hitSlop={8}>
              <Ionicons name="chevron-forward" size={18} color={colors.primary} />
            </Pressable>
          </View>
          <View style={styles.grid}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <View key={`dow${i}`} style={styles.cell}>
                <Text style={styles.dow}>{d}</Text>
              </View>
            ))}
            {grid.map((iso, i) => {
              const disabled = !iso || (maxDate ? iso > maxDate : false);
              const selected = iso === value;
              return (
                <Pressable
                  key={i}
                  style={[styles.cell, selected && styles.cellSel]}
                  disabled={disabled}
                  onPress={() => {
                    if (iso) {
                      onSelect(iso);
                      onClose();
                    }
                  }}
                >
                  <Text style={[styles.cellText, disabled && styles.cellOff,
                                selected && styles.cellTextSel]}>
                    {iso ? String(Number(iso.slice(8, 10))) : ''}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  sheet: {
    backgroundColor: colors.background, borderRadius: 16, padding: 14,
    width: '100%', maxWidth: 360,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  nav: { padding: 8, borderRadius: 8, backgroundColor: colors.surfaceAlt },
  monthLabel: { fontWeight: '800', color: colors.text, fontSize: 15 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: '14.28%', aspectRatio: 1.15, alignItems: 'center', justifyContent: 'center',
    borderRadius: 8,
  },
  cellSel: { backgroundColor: colors.primary },
  dow: { fontSize: 11, fontWeight: '800', color: colors.primaryLight },
  cellText: { fontSize: 14, fontWeight: '600', color: colors.text },
  cellTextSel: { color: colors.onPrimary, fontWeight: '800' },
  cellOff: { color: colors.borderDark },
});
