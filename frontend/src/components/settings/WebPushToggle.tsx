/**
 * WebPushToggle — Profile row to enable/disable push notifications for the
 * installed PWA (iOS Home Screen + Android/Chrome). Web-only; renders nothing
 * on native (Expo Go uses expo-notifications) or where web push isn't possible.
 * On an iOS Safari tab it shows an "Add to Home Screen first" hint instead.
 *
 * Visual system ("Ink & Cube" §3.4): the row is a DepthCard — the same white
 * (light) / raised plum (dark) face on the layered plum shadow as every other
 * Profile settings group — and the bell hangs in the same 38px gradient-rimmed
 * IconWell as the rows above and below it (profile.tsx `IconWell`; kept in
 * sync by hand because that helper is local to the screen file).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Switch, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors, fonts } from '../../theme/ThemeContext';
import { GRADIENT, APP_NAME } from '../../theme/brand';
import { DepthCard } from '../ui/DepthCard';
import { toast } from '../../utils/toast';
import {
  getWebPushStatus, enableWebPush, disableWebPush, needsInstallFirst,
  type WebPushStatus,
} from '../../utils/webPush';

// ── IconWell — mirrors app/(tabs)/profile.tsx ────────────────────────────────
const ICON_WELL = 38;
const ICON_WELL_RADIUS = 12;

/** Opaque blend of two 6-digit hex colours (t = 0 → a, 1 → b). */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1, 7), 16);
  const pb = parseInt(b.slice(1, 7), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('');
}

/**
 * The 38px gradient-rimmed key every Profile settings row hangs its icon in:
 * a 1.5px brand-gradient rim around a face tinted 12% toward the primary, so
 * the glyph reads on both themes. Static — one LinearGradient, no loop.
 */
function IconWell({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  const fill = mixHex(colors.primary, colors.background, 0.88);
  return (
    <LinearGradient
      colors={GRADIENT}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width: ICON_WELL, height: ICON_WELL, borderRadius: ICON_WELL_RADIUS, padding: 1.5 }}
    >
      <View style={{ flex: 1, borderRadius: ICON_WELL_RADIUS - 1.5, backgroundColor: fill, alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </View>
    </LinearGradient>
  );
}

export default function WebPushToggle() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [status, setStatus] = useState<WebPushStatus | 'loading'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    getWebPushStatus().then(setStatus).catch(() => setStatus('unsupported'));
  }, []);

  if (Platform.OS !== 'web' || status === 'loading') return null;

  // iOS Safari tab: guide them to install first.
  if (status === 'unsupported') {
    if (needsInstallFirst()) {
      return (
        <DepthCard style={styles.card}>
          <View style={styles.hintRow}>
            <IconWell><Ionicons name="notifications-outline" size={20} color={colors.primary} /></IconWell>
            <Text style={styles.hintText}>
              To get notifications, add {APP_NAME} to your Home Screen: tap <Text style={{ fontFamily: fonts.bodyBold }}>Share → Add to Home Screen</Text>, then open it from there.
            </Text>
          </View>
        </DepthCard>
      );
    }
    return null; // browser genuinely can't — don't clutter
  }

  const on = status === 'subscribed';

  const toggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (next) {
        const res = await enableWebPush();
        if (res.ok) {
          setStatus('subscribed');
          toast.success?.('Notifications on', `You'll get ${APP_NAME} updates here.`);
        } else if (res.reason === 'denied') {
          setStatus('denied');
          toast.error?.('Blocked', 'Enable notifications for this site in your browser settings.');
        } else if (res.reason === 'install-first') {
          toast.info?.('Add to Home Screen first');
        } else {
          toast.error?.('Could not enable', 'Please try again.');
        }
      } else {
        await disableWebPush();
        setStatus('granted');
        toast.info?.('Notifications off');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <DepthCard style={styles.card}>
      <View style={styles.row}>
        <IconWell><Ionicons name="notifications-outline" size={20} color={colors.primary} /></IconWell>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Push notifications</Text>
          <Text style={styles.sub}>
            {status === 'denied' ? 'Blocked in browser settings' : on ? 'On for this device' : 'Get updates on this device'}
          </Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Switch
            value={on}
            onValueChange={toggle}
            disabled={status === 'denied'}
            // Same off-track as the Schedule Reminders switch above it —
            // colors.border is too faint against the white card face.
            trackColor={{ false: '#91B69E', true: colors.primary }}
            thumbColor="#fff"
          />
        )}
      </View>
    </DepthCard>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  // Matches the Profile settings groups: DepthCard owns the fill + shadow.
  card: { borderRadius: 16, marginBottom: 16, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontFamily: fonts.bodySemibold, fontSize: 15, color: c.text },
  sub: { fontFamily: fonts.body, fontSize: 12, color: c.textMuted, marginTop: 2, lineHeight: 16 },
  hintRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  hintText: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, color: c.textSecondary, lineHeight: 18 },
});
