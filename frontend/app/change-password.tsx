/**
 * Choose your own password — the first screen for anyone who signed in with
 * the shared starter password. Nothing else in the app opens until it is done
 * (the server refuses everything but this for such an account), so there is no
 * way round it and no menu to wander into.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, ScrollView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { APP_NAME, GRADIENT_INK_DARK, brand, fonts } from '../src/theme/brand';
import { VertexMark } from '../src/components/ui/VertexMark';
import { apiService } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { setAuthTokens } from '../src/auth/tokenStorage';
import { forgetStarterPassword, heldStarterPassword } from '../src/auth/starterPassword';
import { useKeyboardInset } from '../src/hooks/useKeyboardInset';

const MIN = 8;

export default function ChangePasswordScreen() {
  const insets = useSafeAreaInsets();
  const kb = useKeyboardInset();
  const router = useRouter();
  const { realUser, setUser, logout } = useAuth();
  const held = heldStarterPassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const first = (realUser?.name || '').split(/\s+/)[0];
  const longEnough = next.length >= MIN;
  const matches = next.length > 0 && next === again;
  const ready = longEnough && matches && (!!held || current.length > 0) && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const res = await apiService.changePassword(held || current, next);
      const { token, refresh_token: refreshToken } = res.data || {};
      if (token && refreshToken) await setAuthTokens(token, refreshToken);
      forgetStarterPassword();
      // Their own password now: lift the hold in the app and go Home.
      if (realUser) setUser({ ...realUser, must_change_password: false });
      router.replace('/(tabs)');
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Could not save your password. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.container}>
      <LinearGradient colors={GRADIENT_INK_DARK} style={StyleSheet.absoluteFill} />
      <ScrollView
        contentContainerStyle={[s.scroll, { paddingTop: insets.top + 28, paddingBottom: insets.bottom + 28 + kb }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.card}>
          <VertexMark size={64} color={brand.lime} glow ripple={0} />
          <Text style={s.kicker}>{APP_NAME} · one last step</Text>
          <Text style={s.title}>{first ? `Welcome, ${first}.` : 'Welcome.'}{'\n'}Choose your own password</Text>
          <Text style={s.lede}>
            You signed in with the starter password everyone was sent. Set one only you know, and you're in.
          </Text>

          {!held && (
            <Field label="Starter password" value={current} onChangeText={setCurrent} show={show} testID="cp-current" autoFocus />
          )}
          <Field label="New password" value={next} onChangeText={setNext} show={show} testID="cp-new" autoFocus={!!held} />
          <Field label="New password again" value={again} onChangeText={setAgain} show={show} testID="cp-again" onSubmit={submit} />

          <Pressable onPress={() => setShow((v) => !v)} style={s.showRow} accessibilityRole="checkbox" accessibilityState={{ checked: show }}>
            <Ionicons name={show ? 'checkbox' : 'square-outline'} size={18} color={show ? brand.lime : '#9fb8a8'} />
            <Text style={s.showText}>Show passwords</Text>
          </Pressable>

          <View style={s.rules}>
            <Rule ok={longEnough} text={`At least ${MIN} characters`} />
            <Rule ok={matches} text="Both entries match" />
          </View>

          {error ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : null}

          <Pressable onPress={submit} disabled={!ready} style={[s.btn, !ready && { opacity: 0.45 }]} accessibilityRole="button" testID="cp-save">
            {busy ? <ActivityIndicator color={brand.forest} /> : <Text style={s.btnText}>Save and continue</Text>}
          </Pressable>
          <Pressable onPress={() => { forgetStarterPassword(); logout(); }} style={s.linkBtn} hitSlop={8}>
            <Text style={s.linkText}>Sign out</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function Field({ label, value, onChangeText, show, testID, autoFocus, onSubmit }: {
  label: string; value: string; onChangeText: (v: string) => void; show: boolean; testID: string; autoFocus?: boolean; onSubmit?: () => void;
}) {
  return (
    <View style={{ alignSelf: 'stretch', marginTop: 14 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={!show}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={Platform.OS === 'web' && autoFocus}
        style={s.input}
        placeholderTextColor="rgba(159,184,168,0.6)"
        onSubmitEditing={onSubmit}
        returnKeyType={onSubmit ? 'done' : 'next'}
        testID={testID}
      />
    </View>
  );
}

function Rule({ ok, text }: { ok: boolean; text: string }) {
  return (
    <View style={s.rule}>
      <Ionicons name={ok ? 'checkmark-circle' : 'ellipse-outline'} size={15} color={ok ? brand.lime : '#9fb8a8'} />
      <Text style={[s.ruleText, ok && { color: '#eef4e6' }]}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: GRADIENT_INK_DARK[2] },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  card: { width: '100%', maxWidth: 440, alignItems: 'center', padding: 24, borderRadius: 24, backgroundColor: 'rgba(16,45,37,0.92)',
    borderWidth: 1, borderColor: 'rgba(183,223,88,0.18)', boxShadow: '0 30px 70px rgba(0,0,0,0.5)' } as any,
  kicker: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.6, textTransform: 'uppercase', color: brand.lime, marginTop: 14 },
  title: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30, color: '#eef4e6', textAlign: 'center', marginTop: 8 },
  lede: { fontFamily: fonts.body, fontSize: 13.5, lineHeight: 20, color: '#9fb8a8', textAlign: 'center', marginTop: 8 },
  label: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: '#9fb8a8', marginBottom: 6 },
  input: { height: 50, borderRadius: 12, paddingHorizontal: 14, backgroundColor: 'rgba(5,15,11,0.55)', borderWidth: 1, borderColor: 'rgba(183,223,88,0.22)',
    fontFamily: fonts.body, fontSize: 16, color: '#eef4e6', outlineStyle: 'none' } as any,
  showRow: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', marginTop: 12, minHeight: 32 },
  showText: { fontFamily: fonts.body, fontSize: 13, color: '#eef4e6' },
  rules: { alignSelf: 'stretch', gap: 6, marginTop: 10 },
  rule: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ruleText: { fontFamily: fonts.body, fontSize: 12.5, color: '#9fb8a8' },
  error: { alignSelf: 'stretch', fontFamily: fonts.bodySemibold, fontSize: 13, color: '#fca5a5', backgroundColor: 'rgba(248,113,113,0.12)',
    borderRadius: 10, padding: 10, marginTop: 14, overflow: 'hidden' },
  btn: { alignSelf: 'stretch', height: 52, borderRadius: 14, backgroundColor: brand.lime, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  btnText: { fontFamily: fonts.bodyBold, fontSize: 16, color: brand.forest },
  linkBtn: { marginTop: 14, minHeight: 32, justifyContent: 'center' },
  linkText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: '#9fb8a8' },
});
