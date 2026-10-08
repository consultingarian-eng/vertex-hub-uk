/**
 * PreviewBanner — persistent "you are previewing as someone else" strip.
 * Mounted once globally (app/_layout.tsx), same spot as WebAlertModal/RankUp/
 * Toaster. Only a tap on "Exit" clears it — no swipe-away — so a super admin
 * can't lose track of being in preview mode.
 */
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../../auth/AuthContext';
import { roleWord } from '../../utils/roleTitle';

export function PreviewBanner() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, isPreviewing, exitPreview } = useAuth();

  if (!isPreviewing || !user) return null;

  const handleExit = () => {
    exitPreview();
    router.replace('/(tabs)');
  };

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 6 }]} pointerEvents="box-none">
      <View style={styles.bar}>
        <Text style={styles.text} numberOfLines={1}>
          👁 Previewing as {user.name} · {roleWord(user.role).toUpperCase()} — read-only
        </Text>
        <TouchableOpacity onPress={handleExit} style={styles.exitBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.exitText}>Exit</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9999,
  },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#f59e0b', paddingHorizontal: 14, paddingVertical: 8,
  },
  text: { flex: 1, fontSize: 12.5, fontWeight: '700', color: '#1a0e00', marginRight: 10 },
  exitBtn: { backgroundColor: 'rgba(0,0,0,0.18)', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8 },
  exitText: { fontSize: 12.5, fontWeight: '800', color: '#1a0e00' },
});

export default PreviewBanner;
