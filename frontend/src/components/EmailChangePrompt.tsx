/**
 * EmailChangePrompt — shown to signed-in users whose login email is still an
 * Indeed relay address (…@indeedemail.com). These accounts were provisioned
 * from an Indeed application before we ever had the person's real email, so
 * on first login we ask them to swap in their actual address.
 *
 * Two steps: enter the real email (a 6-digit code is sent there), then enter
 * the code. The backend rejects the flow for anyone NOT on an Indeed relay
 * address, so this renders for exactly those accounts and no one else.
 * Dismissible per session — it comes back on the next app launch until the
 * email is actually changed.
 */
import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors, fonts } from '../theme/ThemeContext';
import { useAuth } from '../auth/AuthContext';
import { apiService } from '../api/client';

const INDEED_RELAY_DOMAIN = '@indeedemail.com';

export default function EmailChangePrompt() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { realUser, isPreviewing, setUser } = useAuth();

  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const needsPrompt =
    !!realUser?.email && realUser.email.toLowerCase().endsWith(INDEED_RELAY_DOMAIN);

  if (!needsPrompt || dismissed || isPreviewing) return null;

  const requestCode = async () => {
    const target = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await apiService.requestMyEmailChange(target);
      setStep('code');
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Could not send the code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async () => {
    if (code.trim().length < 6) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await apiService.confirmMyEmailChange(code.trim());
      // Reflect the new address in app state immediately; the prompt's
      // needsPrompt check then goes false and the modal unmounts itself.
      if (realUser) setUser({ ...realUser, email: res.data.email });
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Invalid code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => setDismissed(true)}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <View style={styles.card}>
          <View style={styles.iconBubble}>
            <Ionicons name="mail" size={22} color={colors.onPrimary} />
          </View>
          <Text style={styles.title}>Set your real email</Text>
          {step === 'email' ? (
            <>
              <Text style={styles.body}>
                Your account was set up with the temporary Indeed address you applied
                with. Add your personal email so your login and updates reach you —
                we'll send a 6-digit code to confirm it's yours.
              </Text>
              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor={colors.textMuted}
                value={email}
                onChangeText={(t) => { setEmail(t); setError(''); }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete="email"
                editable={!busy}
              />
            </>
          ) : (
            <>
              <Text style={styles.body}>
                We sent a 6-digit code to{' '}
                <Text style={styles.emailHighlight}>{email.trim().toLowerCase()}</Text>.
                Enter it below to finish.
              </Text>
              <TextInput
                style={[styles.input, styles.codeInput]}
                placeholder="000000"
                placeholderTextColor={colors.textMuted}
                value={code}
                onChangeText={(t) => { setCode(t.replace(/[^0-9]/g, '')); setError(''); }}
                keyboardType="number-pad"
                maxLength={6}
                editable={!busy}
              />
              <TouchableOpacity onPress={() => { setStep('email'); setCode(''); setError(''); }} disabled={busy}>
                <Text style={styles.linkTxt}>Wrong address? Go back</Text>
              </TouchableOpacity>
            </>
          )}
          {!!error && <Text style={styles.errorTxt}>{error}</Text>}
          <View style={styles.actions}>
            <TouchableOpacity onPress={() => setDismissed(true)} style={styles.laterBtn} disabled={busy}>
              <Text style={styles.laterTxt}>Later</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={step === 'email' ? requestCode : confirmCode}
              disabled={busy}
              style={[styles.primaryBtn, busy && { opacity: 0.7 }]}
            >
              {busy
                ? <ActivityIndicator size="small" color={colors.onPrimary} />
                : <Text style={styles.primaryTxt}>{step === 'email' ? 'Send code' : 'Confirm'}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20,
  },
  card: {
    width: '100%', maxWidth: 420, backgroundColor: c.surface,
    borderWidth: 1, borderColor: c.border, borderRadius: 20, padding: 22,
  },
  iconBubble: {
    width: 44, height: 44, borderRadius: 13, backgroundColor: c.primary,
    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
  },
  title: { fontFamily: fonts.display, fontSize: 19, color: c.text },
  body: { fontFamily: fonts.body, fontSize: 13.5, color: c.textMuted, marginTop: 6, lineHeight: 19 },
  emailHighlight: { fontFamily: fonts.bodySemibold, color: c.text },
  input: {
    marginTop: 14, borderWidth: 1, borderColor: c.border, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12, fontFamily: fonts.body,
    fontSize: 15, color: c.text, backgroundColor: c.background,
  },
  codeInput: { fontFamily: fonts.mono, fontSize: 22, letterSpacing: 8, textAlign: 'center' },
  linkTxt: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: c.primary, marginTop: 10 },
  errorTxt: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: '#e5484d', marginTop: 10 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 18 },
  laterBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  laterTxt: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: c.textMuted },
  primaryBtn: {
    paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10,
    backgroundColor: c.primary, minWidth: 110, alignItems: 'center',
  },
  primaryTxt: { fontFamily: fonts.bodyBold, fontSize: 13.5, color: c.onPrimary },
});
