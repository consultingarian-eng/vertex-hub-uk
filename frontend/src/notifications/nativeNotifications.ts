import { Platform } from 'react-native';

type ExpoNotifications = typeof import('expo-notifications');

let notifications: ExpoNotifications | null = null;

/**
 * Load expo-notifications only on native platforms.
 *
 * The package reads browser storage while its module is being initialized,
 * which is not available during Expo Router's static web render. Keeping the
 * require behind the platform check prevents that initialization on web while
 * preserving the exact native module on iOS and Android.
 */
export function getNativeNotifications(): ExpoNotifications | null {
  if (Platform.OS === 'web') return null;
  if (!notifications) {
    // Deliberately synchronous so the foreground handler is installed during
    // native startup; the web platform guard above prevents SSR evaluation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    notifications = require('expo-notifications') as ExpoNotifications;
  }
  return notifications;
}
