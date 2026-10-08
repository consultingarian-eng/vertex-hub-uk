/**
 * TapToRefresh — a tappable "refresh" control for the web app.
 *
 * RefreshControl's pull-down gesture is a no-op with a desktop mouse, and the
 * root <WebPullToRefresh /> only re-fetches active React Queries — it can't
 * reproduce a screen whose pull does more than that (a forced live pull with a
 * cache-busting param, a mutation, an imperative loader). Those screens need a
 * reliable trigger on web, so this renders a small tap button there and calls
 * their own onRefresh. Renders nothing on native, where the pull already works.
 */
import React from 'react';
import { Platform, TouchableOpacity, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors, fonts } from '../../theme/ThemeContext';

export default function TapToRefresh({
  onPress,
  busy,
  label = 'Refresh',
}: {
  onPress: () => void;
  busy?: boolean;
  label?: string;
}) {
  const colors = useColors();
  if (Platform.OS !== 'web') return null;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={busy}
      activeOpacity={0.6}
      style={[styles.btn, { borderColor: colors.border }]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.textMuted} />
      ) : (
        <Ionicons name="sync-outline" size={14} color={colors.textMuted} />
      )}
      <Text style={[styles.txt, { color: colors.textMuted, fontFamily: fonts.body }]}>
        {busy ? 'Refreshing…' : label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 6, marginBottom: 10,
    borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, minHeight: 30,
  },
  txt: { fontSize: 12 },
});
