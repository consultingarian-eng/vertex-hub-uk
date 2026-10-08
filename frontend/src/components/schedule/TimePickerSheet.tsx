import React, { useEffect, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../../theme/colors';
import { lightColors } from '../../theme/ThemeContext';
import { useColors } from '../../theme/ThemeContext';

// ─────────────────────────────────────────────────────────────────────────
// Bottom-sheet time picker.
//
// Layout:
//   ┌────────────────────────────────────────────────┐
//   │              Pick a time           Done        │
//   ├────────────────────┬───────────────────────────┤
//   │   12 AM            │     :00                   │
//   │   1  AM   ◀ scroll │     :15  ◀ scroll         │
//   │   …                │     :30                   │
//   │   ▶ 11 PM          │     :45                   │
//   └────────────────────┴───────────────────────────┘
//
// Hours column on the left (12 AM..11 PM), minutes column on the right
// (00 / 15 / 30 / 45). Tap to select. The active row is highlighted in the
// brand color. Returns "HH:MM" 24-hour to the parent on confirm.
// ─────────────────────────────────────────────────────────────────────────

const ROW_H = 44;
const COL_PAD = 60;  // top + bottom padding inside each scroller so any value can be centered

function format12(h: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh} ${ampm}`;
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

export default function TimePickerSheet({
  visible,
  initialValue,
  title,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  initialValue: string;        // 'HH:MM' 24-hour
  title?: string;
  onClose: () => void;
  onConfirm: (value: string) => void;  // returns 'HH:MM' 24-hour
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  // Parse the incoming HH:MM and clamp the minutes to the nearest 15.
  const parsed = useMemo(() => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((initialValue || '').trim());
    let h = m ? parseInt(m[1], 10) : 9;
    let mm = m ? parseInt(m[2], 10) : 0;
    if (h < 0 || h > 23) h = 9;
    // Snap to closest 15-min increment
    const slots = [0, 15, 30, 45];
    let best = 0; let bestDiff = 999;
    for (const s of slots) {
      const d = Math.abs(s - mm);
      if (d < bestDiff) { bestDiff = d; best = s; }
    }
    return { h, m: best };
  }, [initialValue]);

  const [hour, setHour] = React.useState<number>(parsed.h);
  const [minute, setMinute] = React.useState<number>(parsed.m);

  useEffect(() => {
    if (visible) {
      setHour(parsed.h);
      setMinute(parsed.m);
    }
  }, [visible, parsed.h, parsed.m]);

  const hoursRef = useRef<ScrollView | null>(null);
  const minsRef = useRef<ScrollView | null>(null);

  // Auto-scroll selected rows into view when the sheet opens
  useEffect(() => {
    if (!visible) return;
    setTimeout(() => {
      try { hoursRef.current?.scrollTo({ y: parsed.h * ROW_H - ROW_H, animated: false }); } catch {}
      const minIdx = [0, 15, 30, 45].indexOf(parsed.m);
      try { minsRef.current?.scrollTo({ y: Math.max(0, minIdx * ROW_H - ROW_H), animated: false }); } catch {}
    }, 60);
  }, [visible, parsed.h, parsed.m]);

  const onDone = () => {
    onConfirm(`${pad(hour)}:${pad(minute)}`);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]} onPress={() => {}}>
          {/* Grip + header */}
          <View style={styles.grip} />
          <View style={styles.header}>
            <Pressable onPress={onClose} hitSlop={12} style={{ padding: 4 }}>
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
            <Text style={styles.title}>{title || 'Pick a time'}</Text>
            <Pressable onPress={onDone} hitSlop={12} style={{ padding: 4 }}>
              <Text style={styles.done}>Done</Text>
            </Pressable>
          </View>

          {/* Live preview */}
          <View style={styles.previewRow}>
            <Ionicons name="time-outline" size={16} color={colors.primary} />
            <Text style={styles.previewText}>
              {format12(hour).split(' ')[0]}:{pad(minute)} {format12(hour).split(' ')[1]}
            </Text>
          </View>

          {/* Two columns */}
          <View style={styles.cols}>
            {/* Hours */}
            <View style={styles.col}>
              <Text style={styles.colLabel}>Hour</Text>
              <ScrollView
                ref={hoursRef}
                style={styles.scroller}
                contentContainerStyle={{ paddingVertical: COL_PAD }}
                showsVerticalScrollIndicator={false}
              >
                {Array.from({ length: 24 }).map((_, h) => {
                  const sel = h === hour;
                  return (
                    <TouchableOpacity
                      key={h}
                      style={[styles.row, sel && styles.rowSelected]}
                      onPress={() => setHour(h)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.rowText, sel && styles.rowTextSelected]}>{format12(h)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            {/* Minutes */}
            <View style={styles.col}>
              <Text style={styles.colLabel}>Min</Text>
              <ScrollView
                ref={minsRef}
                style={styles.scroller}
                contentContainerStyle={{ paddingVertical: COL_PAD }}
                showsVerticalScrollIndicator={false}
              >
                {[0, 15, 30, 45].map((mm) => {
                  const sel = mm === minute;
                  return (
                    <TouchableOpacity
                      key={mm}
                      style={[styles.row, sel && styles.rowSelected]}
                      onPress={() => setMinute(mm)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.rowText, sel && styles.rowTextSelected]}>:{pad(mm)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(11, 33, 28,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 8 },
  grip: { alignSelf: 'center', width: 40, height: 5, borderRadius: 999, backgroundColor: '#91B69E', marginBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 8 },
  title: { fontSize: 16, fontWeight: '800', color: colors.text },
  cancel: { fontSize: 14, fontWeight: '700', color: colors.textMuted },
  done: { fontSize: 15, fontWeight: '800', color: colors.primary },

  previewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 6, marginHorizontal: 18, borderRadius: 10, backgroundColor: 'rgba(58, 122, 86, 0.07)' },
  previewText: { fontSize: 18, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] as any, letterSpacing: 0.5 },

  cols: { flexDirection: 'row', height: 280, paddingHorizontal: 16, paddingTop: 12, gap: 12 },
  col: { flex: 1, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  colLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.6, textTransform: 'uppercase', textAlign: 'center', paddingVertical: 8, backgroundColor: colors.surfaceAlt, borderBottomWidth: 1, borderBottomColor: colors.border },
  scroller: { flex: 1 },
  row: { height: ROW_H, alignItems: 'center', justifyContent: 'center', borderRadius: 8, marginHorizontal: 8, marginVertical: 1 },
  rowSelected: { backgroundColor: colors.primary },
  rowText: { fontSize: 16, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] as any, letterSpacing: 0.3 },
  rowTextSelected: { color: colors.onPrimary, fontWeight: '800' },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
