/**
 * WebPushPrompt — first-load "Turn on notifications?" banner for the web app /
 * installed PWA. Shows once for users who haven't enabled or blocked notifs.
 *
 * Why a banner and not an auto-prompt: iOS requires the OS permission prompt to
 * be triggered by a user gesture (a tap) — you can't fire it on page load — and
 * Chrome discourages auto-prompts. So the Enable button IS the required gesture.
 *
 * Web-only; renders nothing on native, on unsupported browsers, once enabled or
 * blocked, or if dismissed in the last 14 days.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors, fonts } from '../../theme/ThemeContext';
import { useTabBarClearance } from '../../customization/CustomTabBar';
import { getWebPushStatus, enableWebPush } from '../../utils/webPush';
import { APP_NAME } from '../../theme/brand';

const DISMISS_KEY = 'cg1_push_prompt_dismissed_at';
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // re-ask after 14 days

function recentlyDismissed(): boolean {
  try {
    const t = Number(window.localStorage.getItem(DISMISS_KEY) || 0);
    return t > 0 && Date.now() - t < SNOOZE_MS;
  } catch { return false; }
}

export default function WebPushPrompt() {
  const colors = useColors();
  const tabBarClearance = useTabBarClearance();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let alive = true;
    (async () => {
      const status = await getWebPushStatus();
      // Only nudge people who CAN turn it on and haven't decided yet.
      if (alive && status === 'default' && !recentlyDismissed()) setShow(true);
    })();
    return () => { alive = false; };
  }, []);

  if (Platform.OS !== 'web' || !show) return null;

  const dismiss = () => {
    try { window.localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    setShow(false);
  };

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    const res = await enableWebPush();
    setBusy(false);
    // Whatever the outcome (granted / blocked), don't keep nagging.
    try { window.localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    setShow(false);
  };

  return (
    <View style={[styles.wrap, { bottom: tabBarClearance + 12 }]} pointerEvents="box-none">
      <View style={styles.card}>
        <View style={styles.iconBubble}>
          <Ionicons name="notifications" size={20} color={colors.onPrimary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Turn on notifications</Text>
          <Text style={styles.body}>Get assessment updates, team alerts and reminders — even when {APP_NAME} is closed.</Text>
          <View style={styles.actions}>
            <TouchableOpacity onPress={dismiss} style={styles.laterBtn}>
              <Text style={styles.laterTxt}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={enable} disabled={busy} style={styles.enableBtn}>
              <Text style={styles.enableTxt}>{busy ? 'Enabling…' : 'Enable'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 14, zIndex: 9998 },
  card: {
    flexDirection: 'row', gap: 12, width: '100%', maxWidth: 460,
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 16,
    padding: 14, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  iconBubble: { width: 40, height: 40, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fonts.display, fontSize: 15, color: c.text },
  body: { fontFamily: fonts.body, fontSize: 12.5, color: c.textMuted, marginTop: 3, lineHeight: 17 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  laterBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10 },
  laterTxt: { fontFamily: fonts.bodySemibold, fontSize: 13, color: c.textMuted },
  enableBtn: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10, backgroundColor: c.primary },
  enableTxt: { fontFamily: fonts.bodyBold, fontSize: 13, color: c.onPrimary },
});
