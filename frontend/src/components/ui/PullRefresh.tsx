/**
 * usePullToRefresh — pull-to-refresh that actually works on the PWA.
 *
 * react-native-web's RefreshControl is a documented no-op (it strips every
 * refresh prop and renders a plain ScrollView), so every screen's
 * refreshControl does nothing on web. This hook fills the gap:
 *
 *   const { pullIndicator } = usePullToRefresh(onRefresh);
 *   <View style={{flex:1}}>
 *     {pullIndicator}
 *     <ScrollView refreshControl={<RefreshControl .../>}>  // native keeps its own
 *
 * Native: returns a null indicator and attaches nothing — RefreshControl
 * already works there. Web: listens for a downward touch-drag that starts
 * with every scrollable ancestor at the top, shows a springing spinner
 * bubble, and fires onRefresh past the threshold. Attached only while the
 * screen is focused, so stacked/parked screens never double-fire.
 *
 * Wire this ONLY on screens with genuinely refreshable data (owner rule) —
 * forms and static content pages get no pull behavior at all.
 */
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../theme/ThemeContext';

const PULL_THRESHOLD = 72;
const MAX_PULL = 118;
const RESISTANCE = 0.42;

export function usePullToRefresh(onRefresh: () => Promise<unknown> | unknown) {
  const colors = useColors();
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const startY = useRef<number | null>(null);
  const canPull = useRef(false);
  const busyRef = useRef(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const attach = useCallback(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;

    const scrolledAncestor = (el: Element | null): boolean => {
      // True if anything between the touch target and the root has already
      // scrolled — pulling then means "scroll up", never "refresh".
      let node: Element | null = el;
      while (node && node !== document.documentElement) {
        if (node.scrollTop > 0) return true;
        node = node.parentElement;
      }
      return false;
    };

    const onStart = (e: TouchEvent) => {
      if (busyRef.current || e.touches.length !== 1) return;
      startY.current = e.touches[0].clientY;
      canPull.current = !scrolledAncestor(e.target as Element);
    };
    const onMove = (e: TouchEvent) => {
      if (busyRef.current || startY.current == null || !canPull.current) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0) { setPull(0); return; }
      // Actively pulling: stop the browser from rubber-banding/scrolling.
      if (e.cancelable) e.preventDefault();
      setPull(Math.min(MAX_PULL, dy * RESISTANCE));
    };
    const onEnd = () => {
      if (startY.current == null) return;
      startY.current = null;
      setPull((current) => {
        if (current >= PULL_THRESHOLD && !busyRef.current) {
          busyRef.current = true;
          setBusy(true);
          Promise.resolve()
            .then(() => refreshRef.current())
            .catch(() => {})
            .finally(() => { busyRef.current = false; setBusy(false); });
          return PULL_THRESHOLD * 0.8; // hold under the spinner while busy
        }
        return 0;
      });
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  // Only the focused screen listens — parked stack/tab screens stay silent.
  useFocusEffect(useCallback(() => attach(), [attach]));

  // Snap the indicator away once a non-busy release settles.
  const shown = busy ? Math.max(pull, PULL_THRESHOLD * 0.8) : pull;
  const pullIndicator = Platform.OS === 'web' && shown > 2 ? (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 60,
        alignItems: 'center',
        transform: [{ translateY: shown - 44 }],
      }}
    >
      <View style={{
        width: 40, height: 40, borderRadius: 20,
        backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
        alignItems: 'center', justifyContent: 'center',
        shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
      }}>
        {busy ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Ionicons
            name="arrow-down"
            size={18}
            color={shown >= PULL_THRESHOLD ? colors.primary : colors.textMuted}
            style={{ transform: [{ rotate: shown >= PULL_THRESHOLD ? '180deg' : '0deg' }] }}
          />
        )}
      </View>
    </View>
  ) : null;

  return { pullIndicator, refreshingWeb: busy };
}
