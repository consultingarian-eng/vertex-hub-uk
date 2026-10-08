/**
 * OfficeToggle — segmented control for super admins to switch the office the
 * current screen is scoped to (Bells / Team / Spider). Renders nothing when
 * the user only has one office (regular admins/leaders), so it's safe to drop
 * into any screen unconditionally.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../theme/ThemeContext';
import { useActiveOffice } from '../../office/ActiveOfficeContext';

export default function OfficeToggle({ style }: { style?: any }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { officeId, setOfficeId, offices, canSwitch } = useActiveOffice();

  if (!canSwitch) return null;

  return (
    <View style={[styles.wrap, style]}>
      <Ionicons name="business-outline" size={13} color={colors.textMuted} style={{ marginLeft: 8, marginRight: 2 }} />
      {offices.map((o) => {
        const active = o.id === officeId;
        return (
          <TouchableOpacity
            key={o.id}
            style={[styles.seg, active && styles.segActive]}
            onPress={() => setOfficeId(o.id)}
            testID={`office-toggle-${o.id}`}
          >
            <Text style={[styles.segText, active && styles.segTextActive]} numberOfLines={1}>
              {o.name}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.surfaceAlt, borderRadius: 10, padding: 3,
  },
  seg: { flex: 1, paddingVertical: 7, paddingHorizontal: 8, borderRadius: 8, alignItems: 'center' },
  segActive: {
    backgroundColor: colors.background,
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1,
  },
  segText: { fontSize: 13, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.2 },
  segTextActive: { color: colors.primary },
});
