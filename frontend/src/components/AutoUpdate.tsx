/**
 * AutoUpdate — keeps a running app on the latest deploy without eating the
 * user's session to do it.
 *
 * Web / installed PWA: a home-screen app can stay open for days and never
 * pick up a new Railway deploy. This polls GET /api/version (changes every
 * deploy) whenever the page regains visibility and every few minutes while
 * open. What happens on a mismatch depends on when it's noticed:
 *   - First open of a new app-time day: reload immediately — indistinguishable
 *     from the cold start the user expects first thing in the morning, and
 *     it lines up with the 8:05 data refresh.
 *   - Any other time: show a small "Update ready" pill and let the user
 *     apply it when THEY want. Deploys land many times a day here, and
 *     force-reloading on every re-foreground made the app feel broken.
 * The web build is a single entry bundle, so an already-open page keeps
 * working against a newer server until the tap (or tomorrow's first open).
 *
 * Native: EAS Update is configured checkAutomatically: ON_LOAD, which only
 * runs on cold launch — iOS keeps the app alive for days too. This adds a
 * foreground check: returning to the app downloads any published update and
 * relaunches into it. Silently no-ops in dev / Expo Go where updates are
 * disabled.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import { api } from '../api/client';
import { APP_LOCALE, APP_TZ } from '../utils/appTime';

const POLL_MS = 5 * 60 * 1000;
const SEEN_KEY = 'cg1_last_open_est_ymd';

// Y-M-D in app time (UK time) — the app's day flips at midnight app time, and
// the first check of a new day is the one moment a forced reload reads as a
// normal morning cold start instead of a rug-pull.
const appYmd = (): string => {
  try {
    const fmt = new Intl.DateTimeFormat(APP_LOCALE, {
      timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = fmt.formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
};

export default function AutoUpdate() {
  const baseline = useRef<string | null>(null);
  const busy = useRef(false);
  // A deploy waiting to be applied; the pill renders while this is set and
  // the user hasn't dismissed this exact version.
  const [pending, setPending] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const typing = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const markSeenToday = () => {
      try {
        const today = appYmd();
        if (localStorage.getItem(SEEN_KEY) !== today) localStorage.setItem(SEEN_KEY, today);
      } catch { /* private mode — degrade to pill-only updates */ }
    };

    const check = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const { data } = await api.get('/version');
        const v: string | undefined = data?.version;
        if (!v || v === 'dev') return;
        if (baseline.current === null) {
          baseline.current = v; // the version this page was loaded under
          markSeenToday();
          return;
        }
        if (v === baseline.current) {
          markSeenToday();
          return;
        }
        // A new deploy landed since this page loaded.
        let firstOpenToday = false;
        try { firstOpenToday = localStorage.getItem(SEEN_KEY) !== appYmd(); } catch { /* pill below */ }
        if (firstOpenToday && !typing()) {
          markSeenToday();
          window.location.reload();
          return;
        }
        setPending(v);
        markSeenToday();
      } catch {
        // Offline / server restarting mid-deploy — try again next tick.
      } finally {
        busy.current = false;
      }
    };

    check(); // capture the version this page was loaded under
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(check, POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    const check = async () => {
      if (busy.current || __DEV__ || !Updates.isEnabled) return;
      busy.current = true;
      try {
        const result = await Updates.checkForUpdateAsync();
        if (result.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      } catch {
        // No network / update server unreachable — retry on next foreground.
      } finally {
        busy.current = false;
      }
    };

    check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => sub.remove();
  }, []);

  if (Platform.OS !== 'web' || !pending || pending === dismissed) return null;
  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      <View style={styles.pill}>
        <Pressable onPress={() => window.location.reload()} hitSlop={6}>
          <Text style={styles.pillText}>Update ready — tap to refresh</Text>
        </Pressable>
        <Pressable onPress={() => setDismissed(pending)} hitSlop={10} accessibilityLabel="Dismiss update reminder">
          <Text style={styles.dismissText}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 104, alignItems: 'center', zIndex: 4000 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(11, 22, 17, 0.94)',
    borderColor: 'rgba(255, 255, 255, 0.18)', borderWidth: 1,
    borderRadius: 999, paddingVertical: 9, paddingLeft: 14, paddingRight: 10,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  dismissText: { color: 'rgba(255, 255, 255, 0.7)', fontSize: 12, fontWeight: '800', paddingHorizontal: 6 },
});
