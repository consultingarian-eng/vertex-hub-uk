import React, { useState, useRef, useEffect, useMemo } from 'react';
import { showAlert } from '../src/utils/showAlert';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator, Image,  } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors } from '../src/theme/colors';
import { lightColors } from '../src/theme/ThemeContext';
import { useColors } from '../src/theme/ThemeContext';
import { GRADIENT, fonts } from '../src/theme/brand';
import { useAuth } from '../src/auth/AuthContext';

const CODE_LENGTH = 6;
const RESEND_COOLDOWN = 30;

export default function VerifyEmailScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { email: emailParam } = useLocalSearchParams<{ email?: string }>();
  const { verifyEmail, resendOtp } = useAuth();
  const email = String(emailParam || '');

  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<Array<TextInput | null>>([]);

  useEffect(() => {
    // Cooldown timer for resend
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  // Auto-focus first input
  useEffect(() => {
    const t = setTimeout(() => inputs.current[0]?.focus(), 300);
    return () => clearTimeout(t);
  }, []);

  const fullCode = digits.join('');

  // Auto-submit when all 6 entered
  useEffect(() => {
    if (fullCode.length === CODE_LENGTH && !loading) {
      handleVerify();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullCode]);

  const handleChange = (idx: number, value: string) => {
    setError(null);
    // Support paste: if multi-char string is pasted, spread across boxes
    const clean = value.replace(/\D/g, '');
    if (clean.length > 1) {
      const next = Array(CODE_LENGTH).fill('');
      for (let i = 0; i < Math.min(CODE_LENGTH, clean.length); i++) {
        next[i] = clean[i];
      }
      setDigits(next);
      const focusIdx = Math.min(CODE_LENGTH - 1, clean.length);
      inputs.current[focusIdx]?.focus();
      return;
    }
    const next = [...digits];
    next[idx] = clean.slice(0, 1);
    setDigits(next);
    if (clean && idx < CODE_LENGTH - 1) {
      inputs.current[idx + 1]?.focus();
    }
  };

  const handleKeyPress = (idx: number, key: string) => {
    if (key === 'Backspace' && !digits[idx] && idx > 0) {
      inputs.current[idx - 1]?.focus();
      const next = [...digits];
      next[idx - 1] = '';
      setDigits(next);
    }
  };

  const handleVerify = async () => {
    if (fullCode.length !== CODE_LENGTH) return;
    setLoading(true);
    setError(null);
    try {
      await verifyEmail(email, fullCode);
      // AuthContext.setUser triggers root navigator to redirect
    } catch (err: any) {
      const msg = err.response?.data?.detail || 'Invalid code. Please try again.';
      setError(typeof msg === 'string' ? msg : 'Invalid code. Please try again.');
      setDigits(Array(CODE_LENGTH).fill(''));
      setTimeout(() => inputs.current[0]?.focus(), 100);
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0) return;
    setError(null);
    try {
      await resendOtp(email);
      setCooldown(RESEND_COOLDOWN);
      showAlert('Code sent', 'A new verification code has been sent to your email.');
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      const msg = typeof detail === 'string' ? detail : detail?.message || 'Could not resend code';
      showAlert('Error', msg);
    }
  };

  const handleChangeEmail = () => {
    router.replace('/login');
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[styles.content, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.header}>
          <Image
            source={require('../assets/logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>Verify your email</Text>
          <Text style={styles.subtitle}>
            We sent a 6-digit code to{'\n'}
            <Text style={styles.email}>{email}</Text>
          </Text>
        </View>

        <View style={styles.codeRow}>
          {digits.map((d, i) => (
            <TextInput
              key={i}
              ref={(r) => { inputs.current[i] = r; }}
              style={[
                styles.codeBox,
                d ? styles.codeBoxFilled : undefined,
                error ? styles.codeBoxError : undefined,
              ]}
              value={d}
              onChangeText={(v) => handleChange(i, v)}
              onKeyPress={({ nativeEvent }) => handleKeyPress(i, nativeEvent.key)}
              keyboardType="number-pad"
              maxLength={CODE_LENGTH}
              textContentType="oneTimeCode"
              autoComplete={Platform.OS === 'ios' ? 'one-time-code' : 'sms-otp'}
              selectTextOnFocus
              editable={!loading}
              testID={`otp-digit-${i}`}
            />
          ))}
        </View>

        {error ? (
          <View style={styles.errorRow}>
            <Ionicons name="alert-circle" size={16} color="#ef4444" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[{ marginTop: 8 }, (fullCode.length !== CODE_LENGTH || loading) && styles.verifyBtnDisabled]}
          onPress={handleVerify}
          disabled={fullCode.length !== CODE_LENGTH || loading}
          activeOpacity={0.85}
          testID="verify-button"
        >
          <LinearGradient
            colors={GRADIENT}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.verifyBtn}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.verifyBtnText}>Verify & Continue</Text>
            )}
          </LinearGradient>
        </TouchableOpacity>

        <View style={styles.resendRow}>
          <Text style={styles.resendLabel}>Didn't get the code?</Text>
          <TouchableOpacity onPress={handleResend} disabled={cooldown > 0} testID="resend-button">
            <Text style={[styles.resendLink, cooldown > 0 && styles.resendLinkDisabled]}>
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.hintBox}>
          <Ionicons name="mail-outline" size={16} color={colors.textMuted} />
          <Text style={styles.hintText}>
            The code expires in 10 minutes. Check your spam folder if you don't see it.
          </Text>
        </View>

        <TouchableOpacity onPress={handleChangeEmail} style={styles.backLink} testID="back-to-login">
          <Ionicons name="chevron-back" size={16} color={colors.textMuted} />
          <Text style={styles.backLinkText}>Use a different email</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 24 },
  header: { alignItems: 'center', marginBottom: 32 },
  logo: { width: 80, height: 80, marginBottom: 16 },
  title: { fontFamily: fonts.display, fontSize: 26, fontWeight: '700', color: colors.text, marginBottom: 8 },
  subtitle: { fontSize: 15, color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
  email: { fontFamily: fonts.mono, fontWeight: '600', color: colors.text },
  codeRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20, paddingHorizontal: 4 },
  codeBox: {
    width: 48, height: 56, borderRadius: 12,
    borderWidth: 2, borderColor: colors.border,
    backgroundColor: colors.surface,
    textAlign: 'center', fontSize: 22, fontWeight: '700',
    fontFamily: fonts.mono,
    color: colors.text,
  },
  codeBoxFilled: { borderColor: colors.primary, backgroundColor: colors.background },
  codeBoxError: { borderColor: '#ef4444' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16, paddingHorizontal: 4 },
  errorText: { color: '#ef4444', fontSize: 13, flex: 1 },
  verifyBtn: {
    borderRadius: 14, paddingVertical: 16, alignItems: 'center', justifyContent: 'center',
  },
  verifyBtnDisabled: { opacity: 0.5 },
  verifyBtnText: { fontFamily: fonts.bodySemibold, color: '#fff', fontSize: 16, fontWeight: '700' },
  resendRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 20 },
  resendLabel: { color: colors.textMuted, fontSize: 14 },
  resendLink: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  resendLinkDisabled: { color: colors.textMuted, fontWeight: '400' },
  hintBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    marginTop: 24, padding: 14, borderRadius: 12,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  hintText: { color: colors.textMuted, fontSize: 12, flex: 1, lineHeight: 18 },
  backLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 24, gap: 4 },
  backLinkText: { color: colors.textMuted, fontSize: 14 },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
