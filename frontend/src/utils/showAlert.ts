// eslint-disable-next-line no-restricted-imports
import { Alert, Platform } from 'react-native';
import { useAlertStore, AlertButton } from './alertStore';

/**
 * Cross-platform replacement for Alert.alert().
 * On native it delegates to the OS dialog; on web it triggers a React modal.
 * Drop-in: same signature as Alert.alert().
 */
export function showAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  _options?: any,
): void {
  const btns: AlertButton[] = buttons?.length ? buttons : [{ text: 'OK' }];
  if (Platform.OS !== 'web') {
    Alert.alert(title, message, btns as any, _options);
    return;
  }
  useAlertStore.getState().show({ title, message, buttons: btns });
}
