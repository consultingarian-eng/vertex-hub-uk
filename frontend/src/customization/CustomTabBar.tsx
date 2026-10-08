/**
 * The floating bottom tab bar has been replaced by the app frame in
 * src/nav/AppShell.tsx (left sidebar + closable tabs along the top).
 *
 * Screens still call useTabBarClearance() for their bottom padding; with no
 * bar down there it is just the device's bottom inset plus a little air.
 */
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Bottom padding that keeps scrolling content and floating buttons clear of the screen edge. */
export function useTabBarClearance(extra: number = 0): number {
  const insets = useSafeAreaInsets();
  const offset = Platform.OS === 'web' ? insets.bottom : Math.max(insets.bottom, 8);
  return offset + 16 + extra;
}
