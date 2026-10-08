/**
 * DateField — compact, cross-platform date picker pill.
 *
 *  • Web: renders an actual <input type="date"> via React.createElement (the
 *    browser's native date picker, with full keyboard + calendar UX). Styled
 *    to match the rest of the app.
 *  • iOS: opens the native DateTimePicker inline as a popover when tapped.
 *  • Android: opens the stock Android date dialog.
 *
 * Value is always a `YYYY-MM-DD` string. Empty string → today.
 */
import React, { createElement, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useColors, useTheme, fonts } from '../../theme/ThemeContext';
import { APP_LOCALE } from '../../utils/appTime';

interface Props {
  value: string;                     // YYYY-MM-DD (or '' for today)
  onChange: (iso: string) => void;
  label?: string;
  placeholder?: string;              // when value is empty
  minDate?: string;                  // YYYY-MM-DD
  maxDate?: string;                  // YYYY-MM-DD
  testID?: string;
}

const fmtPretty = (iso: string): string => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
};

const isoFromDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function DateField({ value, onChange, label, placeholder = 'Pick a date', minDate, maxDate, testID }: Props) {
  const colors = useColors();
  const { effective } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [showNativePicker, setShowNativePicker] = useState(false);
  const [webFocused, setWebFocused] = useState(false);

  const display = value ? fmtPretty(value) : placeholder;

  // ── Web: the SAME branded pill as native (calendar icon + "Jul 17, 2026"
  //     in brand type), with an invisible <input type="date"> stretched over
  //     it — a tap/click lands on the real input, so the browser's native
  //     date popover and keyboard entry still work.
  if (Platform.OS === 'web') {
    return (
      <View>
        {label && <Text style={styles.label}>{label}</Text>}
        <View style={{ position: 'relative' }}>
          <View style={[styles.pill, webFocused && { borderColor: colors.primary }]}>
            <Ionicons name="calendar-outline" size={14} color={colors.primary} />
            <Text style={[styles.pillText, !value && { color: colors.textMuted }]}>{display}</Text>
          </View>
          {createElement('input', {
            type: 'date',
            value: value || '',
            onChange: (e: any) => onChange(e.target.value || ''),
            // Desktop Chrome/Edge only open the calendar when you hit the
            // little indicator icon — and ours is invisible and stretched, so
            // a click just focused a segment and nothing appeared. iOS Safari
            // opens on tap, which is why the PWA seemed fine. showPicker()
            // opens it explicitly; it throws without a user gesture or on
            // browsers that lack it, where the old focus behaviour still applies.
            onClick: (e: any) => {
              const el = e.currentTarget;
              if (typeof el?.showPicker === 'function') {
                try { el.showPicker(); } catch { /* unsupported / not user-activated */ }
              }
            },
            onKeyDown: (e: any) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              const el = e.currentTarget;
              if (typeof el?.showPicker === 'function') {
                e.preventDefault();
                try { el.showPicker(); } catch { /* unsupported */ }
              }
            },
            onFocus: () => setWebFocused(true),
            onBlur: () => setWebFocused(false),
            min: minDate || undefined,
            max: maxDate || undefined,
            'data-testid': testID,
            'aria-label': label || placeholder,
            style: {
              position: 'absolute',
              top: 0, left: 0, width: '100%', height: '100%',
              opacity: 0,
              border: 'none', margin: 0, padding: 0,
              cursor: 'pointer',
              // 16px+ stops iOS Safari from zooming in on focus.
              fontSize: 16,
              // Theme the browser's date popover to the app theme.
              colorScheme: effective,
            },
          })}
        </View>
      </View>
    );
  }

  // ── Native: a tappable pill that opens the native picker
  const valueDate = value ? new Date(value + 'T00:00:00') : new Date();
  const minDt = minDate ? new Date(minDate + 'T00:00:00') : undefined;
  const maxDt = maxDate ? new Date(maxDate + 'T00:00:00') : undefined;

  return (
    <View>
      {label && <Text style={styles.label}>{label}</Text>}
      <TouchableOpacity
        style={styles.pill}
        onPress={() => setShowNativePicker(true)}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${display}` : display}
      >
        <Ionicons name="calendar-outline" size={14} color={colors.primary} />
        <Text style={[styles.pillText, !value && { color: colors.textMuted }]}>{display}</Text>
      </TouchableOpacity>

      {/* iOS: inline picker inside a modal-style card with Done button */}
      {Platform.OS === 'ios' && showNativePicker && (
        <Modal transparent animationType="fade" visible onRequestClose={() => setShowNativePicker(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setShowNativePicker(false)} style={styles.iosOverlay}>
            <TouchableOpacity activeOpacity={1} style={styles.iosCard}>
              <DateTimePicker
                value={valueDate}
                mode="date"
                display="inline"
                themeVariant="light"
                minimumDate={minDt}
                maximumDate={maxDt}
                onChange={(_: any, d?: Date) => { if (d) onChange(isoFromDate(d)); }}
                style={{ backgroundColor: '#fff' }}
              />
              <TouchableOpacity style={styles.doneBtn} onPress={() => setShowNativePicker(false)}>
                <Text style={styles.doneText}>Done</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      )}

      {/* Android: stock dialog */}
      {Platform.OS === 'android' && showNativePicker && (
        <DateTimePicker
          value={valueDate}
          mode="date"
          display="default"
          minimumDate={minDt}
          maximumDate={maxDt}
          onChange={(_: any, d?: Date) => {
            setShowNativePicker(false);
            if (d) onChange(isoFromDate(d));
          }}
        />
      )}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  // Explicit brand fontFamily: the global Inter default is native-only
  // (applyGlobalFont is guarded off on web), so web needs it spelled out.
  label: { fontSize: 11, fontWeight: '700', fontFamily: fonts.bodyBold, color: colors.textMuted, marginBottom: 4, letterSpacing: 0.3, textTransform: 'uppercase' },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: colors.surface, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  pillText: { fontSize: 14, fontWeight: '700', fontFamily: fonts.bodyBold, color: colors.text },
  iosOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  iosCard: { backgroundColor: '#fff', borderRadius: 16, padding: 12, gap: 6 },
  doneBtn: { paddingVertical: 10, alignItems: 'center', backgroundColor: colors.primary, borderRadius: 10 },
  doneText: { color: colors.onPrimary, fontSize: 14, fontWeight: '800' },
});
