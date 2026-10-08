/**
 * Unread inbox count, for the badges an inbox normally carries:
 *   - the bell at the top of the app and the Inbox item in the sidebar,
 *   - the number on the installed app's icon (the Badging API: Android and
 *     desktop Chrome/Edge, and iPhone web apps from iOS 16.4),
 *   - "(5)" at the front of the browser tab's title.
 *
 * One query (shared with Home's bell via its key), refreshed every minute and
 * whenever the app comes back to the front. Reading the inbox invalidates the
 * same key, so every badge clears together. The service worker sets the icon
 * number too when a push arrives while the app is closed (public/sw.js).
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { apiService } from '../api/client';
import { APP_NAME } from '../theme/brand';

export function useUnreadCount(enabled: boolean): number {
  const q = useQuery({
    enabled,
    queryKey: ['notifications-unread-count'],
    queryFn: () => apiService.getUnreadNotificationCount().then((r) => r.data),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: false,
  });
  const count = enabled ? Math.max(0, q.data?.count ?? 0) : 0;

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined') return;
    const nav: any = navigator;
    try {
      if (count > 0) nav.setAppBadge?.(count)?.catch?.(() => {});
      else nav.clearAppBadge?.()?.catch?.(() => {});
    } catch { /* not supported here */ }
    try {
      if (typeof document !== 'undefined') {
        const base = document.title.replace(/^\(\d+\+?\)\s*/, '') || APP_NAME;
        document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
      }
    } catch { /* ignore */ }
  }, [count]);

  return count;
}

export const badgeText = (n: number) => (n > 99 ? '99+' : String(n));
