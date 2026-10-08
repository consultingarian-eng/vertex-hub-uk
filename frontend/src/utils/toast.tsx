/**
 * Toast wrapper — uses react-native-toast-message under the hood with our
 * theme colors. Mount <Toaster /> ONCE at the root layout, then call:
 *
 *   import { toast } from '@/src/utils/toast';
 *   toast.success('Saved');
 *   toast.error('Could not connect');
 *   toast.info('3 reps applied');
 */
import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Toast, { BaseToastProps } from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { useColors, lightColors } from '../theme/ThemeContext';
import { haptics } from './haptics';

type Variant = 'success' | 'error' | 'info' | 'warning';

const ICONS: Record<Variant, keyof typeof Ionicons.glyphMap> = {
  success: 'checkmark-circle',
  error: 'alert-circle',
  info: 'information-circle',
  warning: 'warning',
};

function ToastBody({ text1, text2, variant }: { text1?: string; text2?: string; variant: Variant }) {
  const colors = useColors();
  const accent =
    variant === 'success' ? colors.green
      : variant === 'error' ? colors.red
      : variant === 'warning' ? colors.yellow
      : colors.primary;
  return (
    <View style={[styles.container, { backgroundColor: colors.surface, borderLeftColor: accent }]}>
      <Ionicons name={ICONS[variant]} size={22} color={accent} />
      <View style={{ flex: 1 }}>
        {text1 ? <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{text1}</Text> : null}
        {text2 ? <Text style={[styles.body, { color: colors.textSecondary }]} numberOfLines={2}>{text2}</Text> : null}
      </View>
    </View>
  );
}

const config = {
  success: (props: BaseToastProps) => <ToastBody text1={props.text1} text2={props.text2} variant="success" />,
  error: (props: BaseToastProps) => <ToastBody text1={props.text1} text2={props.text2} variant="error" />,
  info: (props: BaseToastProps) => <ToastBody text1={props.text1} text2={props.text2} variant="info" />,
  warning: (props: BaseToastProps) => <ToastBody text1={props.text1} text2={props.text2} variant="warning" />,
};

export function Toaster() {
  // Mount once at root layout. Offset toasts below the safe area so they clear
  // the iOS Dynamic Island / notch — critical in the installed PWA (web), where
  // content is drawn under the status bar and a fixed 30px sat behind the island.
  const insets = useSafeAreaInsets();
  // Web uses the SAME offset math as iOS so toasts land in the identical spot
  // on the installed PWA (insets resolve from env(safe-area-inset-top) there;
  // in a plain browser tab insets are 0 and the 60px floor keeps it clear).
  const topOffset =
    Platform.OS === 'android' ? 30 : Math.max(insets.top, 60);
  return <Toast config={config as any} topOffset={topOffset} />;
}

export const toast = {
  success: (text1: string, text2?: string) => {
    haptics.success();
    Toast.show({ type: 'success', text1, text2, visibilityTime: 2200, position: 'top' });
  },
  error: (text1: string, text2?: string) => {
    haptics.error();
    Toast.show({ type: 'error', text1, text2, visibilityTime: 3500, position: 'top' });
  },
  warning: (text1: string, text2?: string) => {
    haptics.warning();
    Toast.show({ type: 'warning', text1, text2, visibilityTime: 3000, position: 'top' });
  },
  info: (text1: string, text2?: string) => {
    Toast.show({ type: 'info', text1, text2, visibilityTime: 2200, position: 'top' });
  },
  hide: () => Toast.hide(),
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginHorizontal: 16,
    borderRadius: 12,
    borderLeftWidth: 4,
    width: '92%',
    maxWidth: 480,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },
  title: { fontSize: 14, fontWeight: '800' },
  body: { fontSize: 12, marginTop: 2 },
});

/* keeps import linter happy on platforms that don't load lightColors */
void lightColors;
