/**
 * Biometric authentication utility — wraps expo-local-authentication +
 * expo-secure-store so the user can re-login with Face ID / Touch ID.
 *
 * Flow:
 *   1. After successful password login, call `enableBiometric(token)`.
 *      This stores the JWT in SecureStore (encrypted) and sets a flag.
 *   2. On next launch, the login screen calls `tryBiometricLogin()`. It:
 *      - returns null if biometric is disabled or unavailable
 *      - prompts Face ID; on success returns the stored token
 *      - returns null on cancel/fail
 *   3. `disableBiometric()` clears the stored token + flag (e.g. on logout).
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { APP_NAME } from '../theme/brand';

const FLAG_KEY = 'cg1.biometric.enabled';
const TOKEN_KEY = 'cg1_biometric_token';
const EMAIL_KEY = 'cg1.biometric.email';

export type BiometricState = {
  available: boolean;
  enrolled: boolean;
  type: 'face' | 'fingerprint' | 'iris' | null;
  prettyLabel: string;
};

export async function getBiometricState(): Promise<BiometricState> {
  if (Platform.OS === 'web') {
    return { available: false, enrolled: false, type: null, prettyLabel: 'Not available' };
  }
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    let type: BiometricState['type'] = null;
    let label = 'Biometric';
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
      type = 'face'; label = Platform.OS === 'ios' ? 'Face ID' : 'Face Unlock';
    } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
      type = 'fingerprint'; label = Platform.OS === 'ios' ? 'Touch ID' : 'Fingerprint';
    } else if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
      type = 'iris'; label = 'Iris';
    }
    return { available: hasHardware, enrolled, type, prettyLabel: label };
  } catch {
    return { available: false, enrolled: false, type: null, prettyLabel: 'Not available' };
  }
}

export async function isBiometricEnabled(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(FLAG_KEY)) === '1'; } catch { return false; }
}

export async function getBiometricEmail(): Promise<string | null> {
  try { return await AsyncStorage.getItem(EMAIL_KEY); } catch { return null; }
}

export async function enableBiometric(token: string, email: string): Promise<void> {
  if (Platform.OS === 'web') return;
  await SecureStore.setItemAsync(TOKEN_KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await AsyncStorage.setItem(FLAG_KEY, '1');
  await AsyncStorage.setItem(EMAIL_KEY, email);
}

export async function disableBiometric(): Promise<void> {
  try { await SecureStore.deleteItemAsync(TOKEN_KEY); } catch {}
  try { await AsyncStorage.removeItem(FLAG_KEY); } catch {}
  try { await AsyncStorage.removeItem(EMAIL_KEY); } catch {}
}

export async function tryBiometricLogin(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  const enabled = await isBiometricEnabled();
  if (!enabled) return null;
  const state = await getBiometricState();
  if (!state.available || !state.enrolled) return null;

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: `Sign in to ${APP_NAME}`,
    fallbackLabel: 'Use password',
    cancelLabel: 'Cancel',
    disableDeviceFallback: false,
  });

  if (!result.success) return null;
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}
