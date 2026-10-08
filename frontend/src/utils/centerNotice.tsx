/**
 * CenterNotice — a standalone confirmation bubble that lands in the MIDDLE of
 * the screen rather than as an edge toast. Used for actions that are easy to
 * miss but important to acknowledge (absence requests, owner approvals), where
 * a toast at the screen edge gets overlooked.
 *
 * Mount <CenterNoticeHost /> ONCE at the root layout (next to <Toaster />),
 * then call:
 *
 *   import { centerNotice } from '@/src/utils/centerNotice';
 *   centerNotice.success('Absence requested', 'The owner has been notified.');
 *
 * It dims the screen, blocks taps while visible, and auto-dismisses. Tapping
 * the backdrop dismisses early.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Modal, Animated, Easing, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme/ThemeContext';
import { haptics } from './haptics';

type Variant = 'success' | 'error' | 'info' | 'warning';

type Notice = { title: string; body?: string; variant: Variant; duration: number };

const ICONS: Record<Variant, keyof typeof Ionicons.glyphMap> = {
  success: 'checkmark-circle',
  error: 'alert-circle',
  info: 'information-circle',
  warning: 'warning',
};

// Simple module-level pub/sub so the imperative API works from anywhere
// without threading a context through every caller.
let emit: ((n: Notice | null) => void) | null = null;

function show(variant: Variant, title: string, body?: string, duration = 2400) {
  if (variant === 'success') haptics.success();
  else if (variant === 'error') haptics.error();
  else if (variant === 'warning') haptics.warning();
  emit?.({ title, body, variant, duration });
}

export const centerNotice = {
  success: (title: string, body?: string, duration?: number) => show('success', title, body, duration),
  error: (title: string, body?: string, duration?: number) => show('error', title, body, duration),
  warning: (title: string, body?: string, duration?: number) => show('warning', title, body, duration),
  info: (title: string, body?: string, duration?: number) => show('info', title, body, duration),
  hide: () => emit?.(null),
};

export function CenterNoticeHost() {
  const colors = useColors();
  const [notice, setNotice] = useState<Notice | null>(null);
  const scale = useRef(new Animated.Value(0.88)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<any>(null);

  useEffect(() => {
    emit = (n) => setNotice(n);
    return () => { emit = null; };
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!notice) return;
    scale.setValue(0.88);
    opacity.setValue(0);
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 7, tension: 80 }),
      Animated.timing(opacity, { toValue: 1, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
    timer.current = setTimeout(() => dismiss(), notice.duration);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice]);

  const dismiss = () => {
    if (timer.current) clearTimeout(timer.current);
    Animated.parallel([
      Animated.timing(scale, { toValue: 0.94, duration: 120, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 120, useNativeDriver: true }),
    ]).start(() => setNotice(null));
  };

  if (!notice) return null;

  const accent =
    notice.variant === 'success' ? colors.green
      : notice.variant === 'error' ? colors.red
      : notice.variant === 'warning' ? colors.yellow
      : colors.primary;

  return (
    <Modal visible transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent>
      <Animated.View style={[styles.backdrop, { opacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
        <Animated.View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: accent, transform: [{ scale }] },
          ]}
          pointerEvents="none"
        >
          <View style={[styles.iconRing, { backgroundColor: accent + '1A' }]}>
            <Ionicons name={ICONS[notice.variant]} size={34} color={accent} />
          </View>
          <Text style={[styles.title, { color: colors.text }]}>{notice.title}</Text>
          {notice.body ? (
            <Text style={[styles.body, { color: colors.textSecondary }]}>{notice.body}</Text>
          ) : null}
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(5, 15, 11, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  card: {
    width: '100%',
    maxWidth: 320,
    alignItems: 'center',
    paddingVertical: 26,
    paddingHorizontal: 22,
    borderRadius: 20,
    borderWidth: 1.5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 14,
  },
  iconRing: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
  body: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 6 },
});
