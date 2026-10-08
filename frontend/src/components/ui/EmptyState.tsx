/**
 * EmptyState — friendly empty-state component for lists with zero items.
 *
 * Usage:
 *   <EmptyState
 *     icon="document-text-outline"
 *     title="No bells yet this week"
 *     subtitle="Tap the green WhatsApp button to import yesterday's report"
 *     actionLabel="Paste from WhatsApp"
 *     onAction={() => setWaModalOpen(true)}
 *   />
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors, lightColors } from '../../theme/ThemeContext';
import { haptics } from '../../utils/haptics';

type Props = {
  icon?: keyof typeof Ionicons.glyphMap;
  emoji?: string;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
};

export function EmptyState({ icon = 'file-tray-outline', emoji, title, subtitle, actionLabel, onAction, compact }: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={[styles.container, compact && styles.containerCompact]}>
      {emoji ? (
        <Text style={[styles.emoji, compact && { fontSize: 36 }]}>{emoji}</Text>
      ) : (
        <View style={[styles.iconCircle, compact && { width: 56, height: 56 }]}>
          <Ionicons name={icon} size={compact ? 26 : 32} color={colors.primary} />
        </View>
      )}
      <Text style={[styles.title, compact && { fontSize: 14 }]}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {actionLabel && onAction ? (
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => { haptics.tap(); onAction(); }}
          activeOpacity={0.8}
        >
          <Text style={styles.actionBtnText}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40, paddingHorizontal: 24, gap: 10 },
  containerCompact: { paddingVertical: 24 },
  iconCircle: {
    width: 76, height: 76, borderRadius: 38,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: `${colors.primary}1A`,
    borderWidth: 1.5, borderColor: `${colors.primary}33`,
  },
  emoji: { fontSize: 56 },
  title: { fontSize: 16, fontWeight: '800', color: colors.text, textAlign: 'center', marginTop: 4 },
  subtitle: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', lineHeight: 18, maxWidth: 280 },
  actionBtn: { marginTop: 8, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999, backgroundColor: colors.primary },
  actionBtnText: { color: colors.onPrimary, fontWeight: '800', fontSize: 13 },
});

/* keep linter happy */
void lightColors;
