import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { apiService } from '../api/client';
import { getNativeNotifications } from './nativeNotifications';
import { APP_NAME } from '../theme/brand';

// Configure how notifications are handled when app is in foreground.
// SDK 53+ uses shouldShowBanner + shouldShowList; the old shouldShowAlert
// is deprecated and removing it avoids warnings + production-build glitches.
const notificationsAtStartup = getNativeNotifications();
if (notificationsAtStartup) {
  notificationsAtStartup.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

let lastRegisteredToken: string | null = null;

/**
 * Request permission and register for Expo push notifications.
 * Safe to call on web/simulator — will no-op silently.
 * Sends the token to the backend via PUT /api/auth/push-token.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  // Push notifications don't work on web or on simulators
  if (Platform.OS === 'web') {
    return null;
  }
  if (!Device.isDevice) {
    if (__DEV__) console.log('[push] Skipping — not a physical device');
    return null;
  }

  try {
    const Notifications = getNativeNotifications();
    if (!Notifications) return null;

    // Android needs a notification channel
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: `${APP_NAME} notifications`,
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#D97706',
        sound: 'default',
      });
    }

    // Ask for permission
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      if (__DEV__) console.log('[push] Permission not granted');
      return null;
    }

    // Get the Expo push token. projectId is required in SDK 50+
    const projectId =
      (Constants?.expoConfig as any)?.extra?.eas?.projectId ??
      (Constants as any)?.easConfig?.projectId;
    const tokenResponse = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    const token = tokenResponse?.data;
    if (!token) return null;

    // Avoid spamming backend with the same token on every mount
    if (token === lastRegisteredToken) return token;
    lastRegisteredToken = token;

    try {
      await apiService.savePushToken(token);
      if (__DEV__) console.log('[push] Token registered:', token.slice(0, 30) + '...');
    } catch (err: any) {
      if (__DEV__) console.log('[push] Failed to register token on backend:', err?.message || err);
    }
    return token;
  } catch (err: any) {
    if (__DEV__) console.log('[push] registerForPushNotifications error:', err?.message || err);
    return null;
  }
}

/** Clear the token both locally and on backend (call on logout). */
export async function clearPushToken(): Promise<void> {
  lastRegisteredToken = null;
  try {
    await apiService.savePushToken('');
  } catch {}
}
