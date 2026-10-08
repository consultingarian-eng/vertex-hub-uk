/**
 * OTA-safe haptics. The Android APK currently in the field was built BEFORE
 * expo-haptics was added, so the native module may not exist at runtime — an
 * OTA update must never crash on import. The require() is wrapped in
 * try/catch and every helper no-ops cleanly when the module is missing.
 * Web (react-native-web) falls back to navigator.vibrate where supported.
 */
import { Platform } from 'react-native';

let H: any = null;
try {
  H = require('expo-haptics');
} catch {
  H = null; // binary without expo-haptics — every helper below no-ops
}

function vibrate(ms: number) {
  try {
    (navigator as any)?.vibrate?.(ms);
  } catch {
    // browser without the Vibration API — do nothing
  }
}

/** Light tick — arming a confirm, flipping a toggle. */
export function hapticTap(): void {
  if (Platform.OS === 'web') {
    vibrate(20);
    return;
  }
  if (!H) return;
  try {
    H.impactAsync?.(H.ImpactFeedbackStyle?.Light)?.catch?.(() => {});
  } catch {}
}

/** Positive confirmation — something started or saved. */
export function hapticSuccess(): void {
  if (Platform.OS === 'web') {
    vibrate(40);
    return;
  }
  if (!H) return;
  try {
    H.notificationAsync?.(H.NotificationFeedbackType?.Success)?.catch?.(() => {});
  } catch {}
}

/** Big deliberate action — a final/destructive confirm. */
export function hapticHeavy(): void {
  if (Platform.OS === 'web') {
    vibrate(60);
    return;
  }
  if (!H) return;
  try {
    H.impactAsync?.(H.ImpactFeedbackStyle?.Heavy)?.catch?.(() => {});
  } catch {}
}
