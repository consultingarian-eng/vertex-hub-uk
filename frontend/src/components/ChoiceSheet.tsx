/**
 * ChoiceSheet — a bottom-sheet-style scrollable picker.
 *
 * Replaces the Alert.alert pattern for multi-option selection (e.g. "Pick a leader",
 * "Pick an office") which feels foreign on mobile. Slides up from the bottom and
 * shows a tappable list of choices. Works identically on iOS / Android / Web.
 *
 * Theme-aware: respects light/dark via ThemeContext.
 */
import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView,
  TextInput, Pressable, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, lightColors } from '../theme/ThemeContext';
import { useKeyboardInset, useWebViewportPin, dismissKeyboardIfOpen } from '../hooks/useKeyboardInset';

// On touch-web (iOS/Android PWA) auto-focusing the search input pops the
// keyboard the moment the sheet opens, which pans/clips the whole sheet on
// iOS WebKit. Only auto-focus where a hardware keyboard is likely.
const isTouchWeb = Platform.OS === 'web' && typeof window !== 'undefined'
  && ('ontouchstart' in window || (navigator?.maxTouchPoints ?? 0) > 0);

export type ChoiceOption<T = string> = {
  label: string;
  subtitle?: string;
  value: T;
  icon?: keyof typeof Ionicons.glyphMap;
  selected?: boolean;
  disabled?: boolean;
};

type Props<T = string> = {
  visible: boolean;
  title: string;
  subtitle?: string;
  options: ChoiceOption<T>[];
  onSelect: (value: T) => void;
  onClose: () => void;
  /** Optional bottom-row destructive option (e.g. "Remove Leader"). */
  destructiveOption?: { label: string; value: T };
  /** Show a filter input at the top of the sheet. Auto-enables if >8 options. */
  searchable?: boolean;
};

export function ChoiceSheet<T = string>({
  visible,
  title,
  subtitle,
  options,
  onSelect,
  onClose,
  destructiveOption,
  searchable,
}: Props<T>) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [query, setQuery] = useState('');
  const kbInset = useKeyboardInset();
  // Keep the page pinned while the sheet is up so iOS WebKit can't pan the
  // document to chase the focused search input (which clips the sheet).
  useWebViewportPin(visible);
  const shouldSearch = (searchable ?? options.length > 8);

  // Reset search when sheet opens/closes
  React.useEffect(() => { if (!visible) setQuery(''); }, [visible]);

  const filtered = useMemo(() => {
    if (!shouldSearch || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((o) =>
      o.label.toLowerCase().includes(q) || (o.subtitle || '').toLowerCase().includes(q)
    );
  }, [options, query, shouldSearch]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* First backdrop tap only closes the keyboard (so a typed search isn't
          lost); a second tap closes the sheet. */}
      <Pressable style={styles.backdrop} onPress={() => { if (!dismissKeyboardIfOpen(kbInset)) onClose(); }}>
        {/* Clicking on the sheet itself shouldn't dismiss */}
        <Pressable onPress={(e) => e.stopPropagation?.()} style={{ width: '100%' }}>
          {/* When the keyboard is up, the bottom `kbInset` px of the sheet sit
              behind it — grow the cap so the list keeps real height above it. */}
          <View style={[styles.sheet, kbInset > 0 && styles.sheetKeyboardOpen, { paddingBottom: (kbInset > 0 ? kbInset : Math.max(insets.bottom, 10)) + 8 }]}>
            {/* Grab handle */}
            <View style={styles.handle} />

            {/* Header */}
            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{title}</Text>
                {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Search (for long lists) */}
            {shouldSearch && (
              <View style={styles.searchWrap}>
                <Ionicons name="search" size={16} color={colors.textMuted} />
                <TextInput
                  style={styles.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search..."
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus={Platform.OS === 'web' ? !isTouchWeb : Platform.OS !== 'ios'}
                />
                {query.length > 0 && (
                  <TouchableOpacity onPress={() => setQuery('')}>
                    <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Options list */}
            <ScrollView
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              bounces={false}
              showsVerticalScrollIndicator
            >
              {filtered.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>No matches</Text>
                </View>
              ) : (
                filtered.map((opt, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={[styles.row, opt.disabled && { opacity: 0.4 }]}
                    onPress={() => { if (!opt.disabled) { onSelect(opt.value); } }}
                    disabled={opt.disabled}
                    activeOpacity={0.6}
                  >
                    {opt.icon ? (
                      <Ionicons name={opt.icon} size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                    ) : null}
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowLabel, opt.selected && { color: colors.primary, fontWeight: '800' }]} numberOfLines={2}>
                        {opt.label}
                      </Text>
                      {opt.subtitle ? <Text style={styles.rowSubtitle} numberOfLines={1}>{opt.subtitle}</Text> : null}
                    </View>
                    {opt.selected ? (
                      <Ionicons name="checkmark" size={20} color={colors.primary} />
                    ) : null}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>

            {/* Destructive option (e.g. "Remove Leader") */}
            {destructiveOption && (
              <TouchableOpacity
                style={styles.destructiveRow}
                onPress={() => onSelect(destructiveOption.value)}
                activeOpacity={0.6}
              >
                <Ionicons name="close-circle-outline" size={18} color={colors.red} style={{ marginRight: 10 }} />
                <Text style={styles.destructiveText}>{destructiveOption.label}</Text>
              </TouchableOpacity>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: '82%',
    paddingHorizontal: 16,
    paddingTop: 8,
    overflow: 'hidden',
  },
  // With ~300px of keyboard padding inside, 82% leaves the list ~one row tall.
  sheetKeyboardOpen: { maxHeight: '96%' },
  handle: {
    width: 38, height: 4, borderRadius: 2, backgroundColor: colors.borderDark,
    alignSelf: 'center', marginBottom: 10,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, paddingRight: 4 },
  title: { fontSize: 18, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  closeBtn: { padding: 4 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.surfaceAlt, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.text, paddingVertical: 2 },
  // flexShrink lets a clamped sheet compress the list instead of pushing rows
  // under the keyboard padding; minHeight guarantees results stay tappable.
  list: { maxHeight: 420, flexShrink: 1, minHeight: 140 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  rowLabel: { fontSize: 15, color: colors.text, fontWeight: '600' },
  rowSubtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  emptyRow: { padding: 20 },
  emptyText: { textAlign: 'center', fontSize: 13, color: colors.textMuted, fontStyle: 'italic' },
  destructiveRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 4, marginTop: 6,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  destructiveText: { fontSize: 14, color: colors.red, fontWeight: '700' },
});

/* __theme_static_fallback__ */
const styles = createStyles(lightColors);
