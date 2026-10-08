// eslint-disable-next-line no-restricted-imports
import { Alert, Platform } from 'react-native';
import { showAlert } from './showAlert';

/**
 * Ask for one line of text. Resolves with the trimmed text, or null if the
 * person cancels or leaves it blank.
 *
 * Alert.prompt only exists on iOS native — on the installed web app (how the
 * team actually uses Vertex Hub) it is undefined, so screens that called it
 * directly silently did nothing. On web this uses the browser's own prompt,
 * which works in iPhone Safari / Android Chrome home-screen apps too.
 */
export function promptText(title: string, message = '', defaultValue = ''): Promise<string | null> {
  const clean = (value: string | null | undefined) => {
    const t = (value ?? '').trim();
    return t ? t : null;
  };

  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
      return Promise.resolve(null);
    }
    const text = window.prompt(message ? `${title}\n\n${message}` : title, defaultValue);
    return Promise.resolve(clean(text));
  }

  if (typeof Alert.prompt === 'function') {
    return new Promise((resolve) => {
      Alert.prompt(
        title,
        message,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
          { text: 'OK', onPress: (value?: string) => resolve(clean(value)) },
        ],
        'plain-text',
        defaultValue,
      );
    });
  }

  // Android native has no text prompt.
  showAlert(title, 'Typing text here isn’t available on this device — use the web app instead.');
  return Promise.resolve(null);
}
