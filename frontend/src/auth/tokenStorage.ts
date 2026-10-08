import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * The only place authentication credentials are persisted by the app.
 *
 * Native stores both JWTs in the OS keychain/keystore. Web relies on the
 * backend's HttpOnly cookies whenever the API is same-origin. Expo Web's
 * cross-origin development setup cannot always use SameSite cookies, so it
 * gets an in-memory bearer/refresh fallback that intentionally disappears on
 * reload and is never written to localStorage or AsyncStorage.
 */
const ACCESS_TOKEN_KEY = 'cg1.auth.access-token.v1';
const REFRESH_TOKEN_KEY = 'cg1.auth.refresh-token.v1';
const LEGACY_ACCESS_TOKEN_KEY = 'auth_token';
const LEGACY_REFRESH_TOKEN_KEY = 'refresh_token';
const LEGACY_KEYS = [LEGACY_ACCESS_TOKEN_KEY, LEGACY_REFRESH_TOKEN_KEY];

let webAccessToken: string | null = null;
let webRefreshToken: string | null = null;
let initializationPromise: Promise<void> | null = null;

const secureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** True only for Expo Web talking to a different origin. */
export function usesWebTokenFallback(): boolean {
  if (Platform.OS !== 'web') return false;

  const configuredBackend = (process.env.EXPO_PUBLIC_BACKEND_URL || '').trim();
  if (!configuredBackend) return false;

  // No credential operation runs during static rendering, but treating a
  // configured absolute backend as cross-origin is the safe SSR default.
  if (typeof window === 'undefined') return true;

  try {
    const backendOrigin = new URL(configuredBackend, window.location.origin).origin;
    return backendOrigin !== window.location.origin;
  } catch {
    return true;
  }
}

async function removeLegacyTokens(): Promise<void> {
  try {
    await AsyncStorage.multiRemove(LEGACY_KEYS);
  } catch {
    // Some storage adapters do not implement multiRemove consistently. Keep
    // cleanup best-effort, without ever falling back to reading tokens on web.
    await Promise.allSettled(LEGACY_KEYS.map((key) => AsyncStorage.removeItem(key)));
  }
}

async function migrateNativeToken(legacyKey: string, secureKey: string): Promise<void> {
  const existingSecureToken = await SecureStore.getItemAsync(secureKey);
  if (existingSecureToken) {
    await AsyncStorage.removeItem(legacyKey).catch(() => {});
    return;
  }

  const legacyToken = await AsyncStorage.getItem(legacyKey);
  if (!legacyToken) return;

  // Delete the old plaintext copy only after the encrypted write succeeds.
  await SecureStore.setItemAsync(secureKey, legacyToken, secureStoreOptions);
  await AsyncStorage.removeItem(legacyKey).catch(() => {});
}

async function initialize(): Promise<void> {
  if (Platform.OS === 'web') {
    // Never import a legacy browser token into memory. Login cookies already
    // cover same-origin sessions; cross-origin development should re-login.
    await removeLegacyTokens();
    return;
  }

  await migrateNativeToken(LEGACY_ACCESS_TOKEN_KEY, ACCESS_TOKEN_KEY);
  await migrateNativeToken(LEGACY_REFRESH_TOKEN_KEY, REFRESH_TOKEN_KEY);
}

export async function initializeTokenStorage(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = initialize().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }
  return initializationPromise;
}

export async function getAccessToken(): Promise<string | null> {
  await initializeTokenStorage();
  if (Platform.OS === 'web') {
    return usesWebTokenFallback() ? webAccessToken : null;
  }
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  await initializeTokenStorage();
  if (Platform.OS === 'web') {
    return usesWebTokenFallback() ? webRefreshToken : null;
  }
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

/** Replace the complete credential pair after login or email verification. */
export async function setAuthTokens(
  accessToken: string,
  refreshToken?: string | null,
): Promise<void> {
  await initializeTokenStorage();

  if (Platform.OS === 'web') {
    if (usesWebTokenFallback()) {
      webAccessToken = accessToken;
      webRefreshToken = refreshToken || null;
    } else {
      // Same-origin web uses only HttpOnly cookies.
      webAccessToken = null;
      webRefreshToken = null;
    }
    return;
  }

  try {
    await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken, secureStoreOptions);
    if (refreshToken) {
      await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, secureStoreOptions);
    } else {
      await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    }
  } catch (error) {
    // Never retain a half-updated pair that could mix two accounts.
    await Promise.allSettled([
      SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    ]);
    throw error;
  }
}

/** Update only the short-lived access credential after a refresh. */
export async function setAccessToken(accessToken: string): Promise<void> {
  await initializeTokenStorage();
  if (Platform.OS === 'web') {
    if (usesWebTokenFallback()) webAccessToken = accessToken;
    return;
  }
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken, secureStoreOptions);
}

export async function clearAuthTokens(): Promise<void> {
  webAccessToken = null;
  webRefreshToken = null;

  if (Platform.OS === 'web') {
    await removeLegacyTokens();
    return;
  }

  await Promise.allSettled([
    SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    AsyncStorage.removeItem(LEGACY_ACCESS_TOKEN_KEY),
    AsyncStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY),
  ]);
}
