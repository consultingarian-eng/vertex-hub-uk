/**
 * Centralized haptic helpers — the same gestures should always feel
 * identical, so wrap expo-haptics in semantic functions.
 *
 * Usage:
 *   import { haptics } from '@/src/utils/haptics';
 *   haptics.tap();        // small tap (toggle a chip, switch a tab)
 *   haptics.success();    // saved, applied, marked complete
 *   haptics.warning();    // confirm before destructive action
 *   haptics.error();      // failure, validation error
 *   haptics.heavy();      // celebration, goal hit
 */
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

const safe = (fn: () => Promise<any>) => {
  // No-op on web; expo-haptics will throw or be a no-op. Wrap in try/catch
  // to be extra safe for older devices.
  if (Platform.OS === 'web') return;
  try { fn(); } catch { /* ignore */ }
};

export const haptics = {
  tap: () => safe(() => Haptics.selectionAsync()),
  success: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
  light: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  medium: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  heavy: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
};
