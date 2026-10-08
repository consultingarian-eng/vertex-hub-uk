import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '../../theme/ThemeContext';
import { ScheduleBlock } from '../../utils/scheduleNotifications';
import { DAY_FULL, DAY_SHORT as DAY_LABELS, timeRange } from '../../utils/calendarDates';

// ── Duplicate day-picker sheet ─────────────────────────────────────────
// Bottom sheet that lets an admin clone a block to one or more other days.
// The source's own day is rendered disabled. "Weekdays" / "All days" /
// "Clear" helpers below the chips for one-tap multi-select.
export default function DuplicateDaySheet({
  block, onClose, onConfirm,
}: {
  block: ScheduleBlock;
  onClose: () => void;
  onConfirm: (days: number[]) => void;
}) {
  const colors = useColors();
  const dup = useMemo(() => createDup(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = React.useState<Set<number>>(new Set());

  const toggle = (d: number) => {
    if (d === block.day_of_week) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d); else next.add(d);
      return next;
    });
  };

  const setAllWeekdays = () => setSelected(new Set([0, 1, 2, 3, 4].filter((d) => d !== block.day_of_week)));
  const setAllDays = () => setSelected(new Set([0, 1, 2, 3, 4, 5, 6].filter((d) => d !== block.day_of_week)));
  const clearAll = () => setSelected(new Set());

  const submit = () => {
    if (selected.size === 0) return;
    onConfirm(Array.from(selected).sort((a, b) => a - b));
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={dup.backdrop} onPress={onClose}>
        <Pressable style={[dup.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
          <View style={dup.grip} />
          <View style={dup.head}>
            <View style={[dup.headIcon, { backgroundColor: block.color }]}>
              <Ionicons name="copy" size={16} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={dup.headTitle} numberOfLines={1}>Duplicate "{block.title}"</Text>
              <Text style={dup.headSub}>
                From {DAY_FULL[block.day_of_week]} {timeRange(block.start_time, block.end_time)}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color={colors.textMuted} /></Pressable>
          </View>

          <Text style={dup.lbl}>Copy to</Text>

          {/* Day chips */}
          <View style={dup.chipsRow}>
            {DAY_LABELS.map((label, i) => {
              const isSrc = i === block.day_of_week;
              const isOn = selected.has(i);
              return (
                <TouchableOpacity
                  key={i}
                  disabled={isSrc}
                  style={[
                    dup.chip,
                    isSrc && dup.chipSrc,
                    isOn && dup.chipOn,
                  ]}
                  onPress={() => toggle(i)}
                  activeOpacity={0.7}
                >
                  <Text style={[dup.chipText, isSrc && dup.chipSrcText, isOn && dup.chipOnText]}>{label}</Text>
                  {isSrc && <Text style={dup.chipBadge}>SRC</Text>}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Quick helpers */}
          <View style={dup.helpersRow}>
            <TouchableOpacity style={dup.helperBtn} onPress={setAllWeekdays}>
              <Ionicons name="briefcase-outline" size={13} color={colors.primary} />
              <Text style={dup.helperBtnText}>Weekdays</Text>
            </TouchableOpacity>
            <TouchableOpacity style={dup.helperBtn} onPress={setAllDays}>
              <Ionicons name="calendar-outline" size={13} color={colors.primary} />
              <Text style={dup.helperBtnText}>All days</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[dup.helperBtn, selected.size === 0 && { opacity: 0.4 }]} onPress={clearAll} disabled={selected.size === 0}>
              <Ionicons name="close-circle-outline" size={13} color={colors.textMuted} />
              <Text style={[dup.helperBtnText, { color: colors.textMuted }]}>Clear</Text>
            </TouchableOpacity>
          </View>

          {/* Counter */}
          <Text style={dup.counter}>
            {selected.size === 0 ? 'Pick one or more days' : `${selected.size} day${selected.size === 1 ? '' : 's'} selected`}
          </Text>

          {/* CTA */}
          <TouchableOpacity
            style={[dup.cta, selected.size === 0 && { opacity: 0.5 }]}
            onPress={submit}
            disabled={selected.size === 0}
          >
            <Ionicons name="copy" size={16} color={colors.onPrimary} />
            <Text style={dup.ctaText}>
              {selected.size === 0
                ? 'Select days to duplicate'
                : `Duplicate to ${selected.size} day${selected.size === 1 ? '' : 's'}`}
            </Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createDup = (colors: any) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(11, 33, 28,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 8, paddingHorizontal: 18 },
  grip: { alignSelf: 'center', width: 40, height: 5, borderRadius: 999, backgroundColor: '#91B69E', marginBottom: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  headIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  headSub: { fontSize: 11, fontWeight: '600', color: colors.textMuted, marginTop: 2 },
  lbl: { fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 },
  chipsRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: { flex: 1, minWidth: 44, paddingVertical: 12, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipSrc: { backgroundColor: colors.surfaceAlt, borderColor: colors.border, opacity: 0.55 },
  chipText: { fontSize: 12, fontWeight: '800', color: colors.text, letterSpacing: 0.3 },
  chipOnText: { color: colors.onPrimary },
  chipSrcText: { color: colors.textMuted },
  chipBadge: { fontSize: 7.5, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.6, marginTop: 2 },
  helpersRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  helperBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  helperBtnText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  counter: { textAlign: 'center', fontSize: 11, fontWeight: '700', color: colors.textMuted, marginTop: 16, marginBottom: 8 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, marginTop: 4 },
  ctaText: { color: colors.onPrimary, fontSize: 15, fontWeight: '800', letterSpacing: 0.3 },
});
