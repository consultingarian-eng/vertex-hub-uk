import React, { useState, useEffect } from 'react';
import { showAlert } from '../src/utils/showAlert';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { darkColors } from '../src/theme/ThemeContext';
import { APP_NAME, GRADIENT, GRADIENT_INK_DARK, GRADIENT_TEXT, brand, fonts } from '../src/theme/brand';
import { DecorField } from '../src/components/ui/Decor';
import { Reveal } from '../src/components/ui/Reveal';
import { ParallaxHero, useParallaxScroll } from '../src/components/ui/Parallax';
import { VertexMark } from '../src/components/ui/VertexMark';
import { DepthCard } from '../src/components/ui/DepthCard';
import { GradientText } from '../src/components/ui/GradientText';
import { GlowButton } from '../src/components/ui/GlowButton';
import { useAuth } from '../src/auth/AuthContext';
import { apiService } from '../src/api/client';
import { toast } from '../src/utils/toast';

// ── Always-dark editorial screen ─────────────────────────────────────────
// Login is the one screen that ignores the OS scheme: it is an ink block in
// both light and dark mode (the PageField never shows through), so every
// token below is read from the DARK palette regardless of the active theme.
// Deliberate deviation from spec §4 ("the static `colors` import stays"): the
// screen paints entirely from `ink`, so that import was dead — zero `colors.`
// references — and lint flagged it. `ink` is the single source of colour here.
const ink = darkColors;

// Card faces ON the ink. A DepthCard's gradient rim is an opaque wrapper behind
// a translucent face, so the face must be near-opaque plum: the rim then reads
// as a 1.5 px brand edge plus a faint diagonal tint, never as a magenta block,
// and inkText/inkMuted keep ≥7:1 on it. Literal rgba — no token concatenation.
const FORM_FILL = 'rgba(8,26,20,0.84)';
const CHIP_FILL = 'rgba(8,26,20,0.80)';

type FocusField = 'email' | 'password' | 'resetEmail' | 'resetCode' | 'newPassword' | 'confirmPassword' | null;

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login, loginWithBiometric, enableBiometricForCurrentUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [focused, setFocused] = useState<FocusField>(null);
  const [bioState, setBioState] = useState<{ enabled: boolean; label: string; iconName: string }>({ enabled: false, label: 'Face ID', iconName: 'finger-print' });

  // Password reset state
  const [resetMode, setResetMode] = useState<'none' | 'email' | 'code'>('none');
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  // ── Scroll phase ─────────────────────────────────────────────────────────
  // The outer ScrollView feeds the app-wide `pageScrollY` (card sheen, PageField)
  // and this screen's own `scrollY` (hero parallax).
  const { scrollY, onScroll } = useParallaxScroll();

  useEffect(() => {
    // Detect biometric availability + auto-attempt if previously enabled.
    (async () => {
      try {
        const { getBiometricState, isBiometricEnabled, getBiometricEmail } = await import('../src/auth/biometric');
        const state = await getBiometricState();
        const enabled = await isBiometricEnabled();
        const stored = await getBiometricEmail();
        const iconName = state.type === 'face' ? 'scan' : state.type === 'fingerprint' ? 'finger-print' : 'lock-closed';
        setBioState({ enabled: state.available && state.enrolled && enabled, label: state.prettyLabel, iconName });
        if (stored) setEmail(stored);
        // Auto-prompt biometric on mount if it's enabled
        if (state.available && state.enrolled && enabled) {
          const ok = await loginWithBiometric();
          if (!ok) toast.info('Sign in', 'Use password or try again with Face ID.');
        }
      } catch {}
    })();
  }, []);

  const handleSubmit = async () => {
    if (!email.trim() || !password.trim()) {
      showAlert('Error', 'Please fill in all fields');
      return;
    }
    setLoading(true);
    try {
      {
        await login(email.trim(), password);
        // After first successful password login, offer to enable biometric.
        try {
          const { getBiometricState, isBiometricEnabled } = await import('../src/auth/biometric');
          const state = await getBiometricState();
          const already = await isBiometricEnabled();
          if (state.available && state.enrolled && !already) {
            showAlert(
              `Enable ${state.prettyLabel}?`,
              `Use ${state.prettyLabel} to sign in next time — no need to type your password.`,
              [
                { text: 'Not now', style: 'cancel' },
                { text: 'Enable', onPress: async () => {
                  const ok = await enableBiometricForCurrentUser();
                  if (ok) toast.success(`${state.prettyLabel} enabled`);
                }},
              ]
            );
          }
        } catch {}
      }
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      // Handle unverified email on login → route to verify screen
      if (err.response?.status === 403 && typeof detail === 'object' && detail?.requires_verification) {
        try {
          await apiService.resendOtp(detail.email || email.trim());
        } catch {}
        router.push({ pathname: '/verify-email', params: { email: detail.email || email.trim() } });
        return;
      }
      // Fall back to err.message so client-side failures with no HTTP body —
      // notably the web "browser refused the session cookie" case — reach the
      // user instead of collapsing into a meaningless "Something went wrong".
      const msg =
        (typeof detail === 'string' ? detail : detail?.message) ||
        err?.message ||
        'Something went wrong';
      showAlert('Error', msg);
    } finally {
      setLoading(false);
    }
  };

  // Dark well + focus glow. `ink.glow` is an rgba token dropped into a
  // boxShadow string (not hex-alpha concatenation).
  const wellStyle = (field: FocusField) => [
    styles.inputWrapper,
    focused === field ? styles.inputWrapperFocused : null,
  ];

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Always-dark screen: light status-bar glyphs whatever the OS scheme. */}
      <StatusBar style="light" />
      {/* Backdrop layer: full-bleed ink gradient + the brand decor (glow orbs +
          halftone dot fields) at half strength. One wrapper, so everything that
          scrolls is a LATER sibling and paints above it — even mid-entrance,
          when the Reveal's 3D tilt would otherwise let the decor through. */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <LinearGradient
          colors={GRADIENT_INK_DARK}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, styles.decor]}>
          <DecorField dark />
        </View>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* Hero: the Vertex X + editorial title. Lags, shrinks and fades as
            the form slides up over it (ParallaxHero). */}
        <Reveal index={0}>
        <ParallaxHero scrollY={scrollY}>
        <View style={styles.logoSection}>
          <View style={styles.markStage}>
            <VertexMark size={200} color={brand.lime} glow ripple={4} />
          </View>
          <GradientText
            colors={GRADIENT_TEXT}
            glow
            numberOfLines={1}
            adjustsFontSizeToFit
            // 0.62, not 0.7: at a 320 px viewport the 272 px of content width
            // needs scale 0.68 (40 -> 27.2 px), and a 0.7 floor clamped the
            // autofit ABOVE the fit, ellipsising the product's own name. The
            // floor only has to sit under the narrowest real device's ratio —
            // 360/390/430 still fit at 31.2/34.2/38.2 px, untouched.
            minimumFontScale={0.62}
            style={styles.appTitle}
          >
            {APP_NAME}
          </GradientText>
          <Text style={styles.appSubtitle}>Learn today, lead tomorrow.</Text>
        </View>
        </ParallaxHero>
        </Reveal>

        {/* Form — dark glass card with a gradient rim, floating on a violet
            halo; a holographic sheen slides across it as the page scrolls. */}
        <Reveal index={1}>
        <View style={styles.formHalo}>
        <DepthCard variant="glass" edge="gradient" sheen fill={FORM_FILL} style={styles.form}>
          <LinearGradient
            colors={GRADIENT}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.formRule}
          />
          <Text style={styles.formTitle}>Welcome Back</Text>
          <Text style={styles.formSubtitle}>Sign in to continue</Text>


          <View style={styles.inputGroup}>
            <Text style={styles.label}>Email</Text>
            <View style={wellStyle('email')}>
              <Ionicons name="mail-outline" size={20} color={focused === 'email' ? ink.primary : ink.inkMuted} />
              <TextInput
                testID="login-email-input"
                style={styles.input}
                placeholder="your@email.com"
                placeholderTextColor={ink.inkMuted}
                value={email}
                onChangeText={setEmail}
                onFocus={() => setFocused('email')}
                onBlur={() => setFocused((f) => (f === 'email' ? null : f))}
                autoCapitalize="none"
                keyboardType="email-address"
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Password</Text>
            <View style={wellStyle('password')}>
              <Ionicons name="lock-closed-outline" size={20} color={focused === 'password' ? ink.primary : ink.inkMuted} />
              <TextInput
                testID="login-password-input"
                style={styles.input}
                placeholder="Password"
                placeholderTextColor={ink.inkMuted}
                value={password}
                onChangeText={setPassword}
                onFocus={() => setFocused('password')}
                onBlur={() => setFocused((f) => (f === 'password' ? null : f))}
                secureTextEntry={!showPassword}
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color={ink.inkMuted} />
              </TouchableOpacity>
            </View>
          </View>

          <GlowButton
            testID="login-submit-btn"
            onPress={handleSubmit}
            disabled={loading}
            breathe
            style={styles.submit}
          >
            {loading ? <ActivityIndicator color="#fff" /> : 'Sign In'}
          </GlowButton>

          {(
            <TouchableOpacity
              style={styles.forgotButton}
              onPress={() => { setResetMode('email'); setResetEmail(email); }}
            >
              <Text style={styles.forgotText}>Forgot Password?</Text>
            </TouchableOpacity>
          )}


          {/* Biometric quick-sign-in (only when device is enrolled + previously enabled) — dark glass chip, gradient rim */}
          {bioState.enabled && (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={async () => {
                const ok = await loginWithBiometric();
                if (!ok) toast.error(`${bioState.label} failed`, 'Use your password instead.');
              }}
            >
              <DepthCard variant="glass" edge="gradient" fill={CHIP_FILL} style={styles.bioButton}>
                <Ionicons name={bioState.iconName as any} size={18} color={ink.primaryLight} />
                <Text style={styles.bioButtonText}>Sign in with {bioState.label}</Text>
              </DepthCard>
            </TouchableOpacity>
          )}

          {/* No sign-up. Accounts are created by an office admin or leader
              (Add Trainee / Add User), which can email the login details. */}
          <Text style={styles.toggleText}>
            No account? Your office admin or coach sets one up for you.
          </Text>

        </DepthCard>
        </View>
        </Reveal>
      </ScrollView>
      {/* Password Reset Modal — OPAQUE sheet (ink.surface, a hex fill) with a
          gradient rim, floating on a halo over a scrim. */}
      {resetMode !== 'none' && (
        <View style={styles.resetOverlay}>
          <View style={styles.resetHalo}>
          <DepthCard variant="glass" edge="gradient" fill={ink.surface} style={styles.resetCard}>
            <TouchableOpacity style={styles.resetClose} onPress={() => { setResetMode('none'); setResetCode(''); setNewPassword(''); }}>
              <Ionicons name="close" size={24} color={ink.inkMuted} />
            </TouchableOpacity>

            {resetMode === 'email' && (
              <>
                <Ionicons name="mail-outline" size={40} color={ink.primary} style={{ alignSelf: 'center', marginBottom: 12 }} />
                <Text style={styles.resetTitle}>Reset Password</Text>
                <Text style={styles.resetSubtitle}>Enter your email and we'll send you a 6-digit code</Text>
                <View style={wellStyle('resetEmail')}>
                  <Ionicons name="mail-outline" size={20} color={ink.inkMuted} />
                  <TextInput
                    style={styles.input}
                    placeholder="your@email.com"
                    placeholderTextColor={ink.inkMuted}
                    value={resetEmail}
                    onChangeText={setResetEmail}
                    onFocus={() => setFocused('resetEmail')}
                    onBlur={() => setFocused((f) => (f === 'resetEmail' ? null : f))}
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />
                </View>
                <GlowButton
                  sheen={false}
                  disabled={resetLoading}
                  style={styles.submit}
                  onPress={async () => {
                    if (!resetEmail.trim()) { showAlert('Error', 'Please enter your email'); return; }
                    setResetLoading(true);
                    try {
                      await apiService.forgotPassword(resetEmail.trim());
                      showAlert('Code Sent', 'Check your email for a 6-digit reset code');
                      setResetMode('code');
                    } catch (e: any) {
                      showAlert('Error', e.response?.data?.detail || 'Failed to send reset code');
                    }
                    setResetLoading(false);
                  }}
                >
                  {resetLoading ? <ActivityIndicator color="#fff" /> : 'Send Reset Code'}
                </GlowButton>
              </>
            )}

            {resetMode === 'code' && (
              <>
                <Ionicons name="key-outline" size={40} color={ink.primary} style={{ alignSelf: 'center', marginBottom: 12 }} />
                <Text style={styles.resetTitle}>Enter Code</Text>
                <Text style={styles.resetSubtitle}>Check your email for the 6-digit code</Text>
                <View style={wellStyle('resetCode')}>
                  <Ionicons name="keypad-outline" size={20} color={ink.inkMuted} />
                  <TextInput
                    style={[styles.input, styles.codeInput]}
                    placeholder="000000"
                    placeholderTextColor={ink.inkMuted}
                    value={resetCode}
                    onChangeText={setResetCode}
                    onFocus={() => setFocused('resetCode')}
                    onBlur={() => setFocused((f) => (f === 'resetCode' ? null : f))}
                    keyboardType="number-pad"
                    maxLength={6}
                  />
                </View>
                <View style={[wellStyle('newPassword'), { marginTop: 12 }]}>
                  <Ionicons name="lock-closed-outline" size={20} color={ink.inkMuted} />
                  <TextInput
                    style={styles.input}
                    placeholder="New password"
                    placeholderTextColor={ink.inkMuted}
                    value={newPassword}
                    onChangeText={setNewPassword}
                    onFocus={() => setFocused('newPassword')}
                    onBlur={() => setFocused((f) => (f === 'newPassword' ? null : f))}
                    secureTextEntry={!showNewPassword}
                  />
                  <TouchableOpacity onPress={() => setShowNewPassword(!showNewPassword)}>
                    <Ionicons name={showNewPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color={ink.inkMuted} />
                  </TouchableOpacity>
                </View>
                <View style={[wellStyle('confirmPassword'), { marginTop: 12 }]}>
                  <Ionicons name="lock-closed-outline" size={20} color={ink.inkMuted} />
                  <TextInput
                    style={styles.input}
                    placeholder="Confirm new password"
                    placeholderTextColor={ink.inkMuted}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    onFocus={() => setFocused('confirmPassword')}
                    onBlur={() => setFocused((f) => (f === 'confirmPassword' ? null : f))}
                    secureTextEntry={!showNewPassword}
                  />
                </View>
                <GlowButton
                  sheen={false}
                  disabled={resetLoading}
                  style={styles.submit}
                  onPress={async () => {
                    if (!resetCode.trim() || resetCode.length !== 6) { showAlert('Error', 'Please enter the 6-digit code'); return; }
                    if (!newPassword || newPassword.length < 8) { showAlert('Error', 'Password must be at least 8 characters'); return; }
                    if (newPassword !== confirmPassword) { showAlert('Error', 'Passwords do not match'); return; }
                    setResetLoading(true);
                    try {
                      await apiService.resetPassword(resetEmail.trim(), resetCode.trim(), newPassword);
                      showAlert('Success', 'Password reset! You can now sign in.', [
                        { text: 'OK', onPress: () => { setResetMode('none'); setResetCode(''); setNewPassword(''); setConfirmPassword(''); setPassword(''); } }
                      ]);
                    } catch (e: any) {
                      showAlert('Error', e.response?.data?.detail || 'Failed to reset password');
                    }
                    setResetLoading(false);
                  }}
                >
                  {resetLoading ? <ActivityIndicator color="#fff" /> : 'Reset Password'}
                </GlowButton>
                <TouchableOpacity onPress={() => setResetMode('email')} style={{ marginTop: 12 }}>
                  <Text style={styles.forgotText}>Didn't receive a code? Resend</Text>
                </TouchableOpacity>
              </>
            )}
          </DepthCard>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

// Always-dark: styles are built once from the dark palette (see `ink` above),
// so the screen never re-styles on an OS scheme change.
const styles = StyleSheet.create({
  // The ink gradient paints the page (login is the deliberate always-dark
  // exception to the PageField); the solid fallback is the gradient's deepest
  // stop so nothing lighter ever flashes behind it (keyboard resize, overscroll).
  container: { flex: 1, backgroundColor: GRADIENT_INK_DARK[2] },
  decor: { opacity: 0.5 },
  // Above the backdrop layer in every stacking model (web z-index, native zIndex).
  scroll: { zIndex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 24 },

  // ── Hero ──
  logoSection: { alignItems: 'center', marginBottom: 16 },
  // The X fills ~63 % of its box's height, so the box is pulled in top and bottom.
  markStage: { width: 200, height: 200, marginTop: -36, marginBottom: -28 },
  appTitle: {
    fontFamily: fonts.displayBlack, fontSize: 40, lineHeight: 48, letterSpacing: -1,
    textAlign: 'center', maxWidth: '100%',
  },
  appSubtitle: {
    fontFamily: fonts.mono, fontSize: 11, color: ink.inkMuted, marginTop: 6,
    letterSpacing: 2.6, textTransform: 'uppercase',
  },

  // ── Dark glass form card on the ink ──
  // The halo wrapper owns the card's width and casts the depth + violet glow
  // (a glass DepthCard casts no shadow of its own). Literal rgba shadows.
  formHalo: {
    width: '100%', maxWidth: 440, alignSelf: 'center', borderRadius: 25.5,
    boxShadow: '0 28px 60px -24px rgba(0,0,0,0.75), 0 0 46px rgba(140,175,56,0.30)',
  },
  form: { borderRadius: 24, padding: 20 },
  // Editorial rule above the card title (SectionHead's 28×3 eyebrow).
  formRule: { width: 28, height: 3, borderRadius: 2, marginBottom: 12 },
  formTitle: { fontFamily: fonts.displayWide, fontSize: 20, lineHeight: 26, color: ink.inkText, marginBottom: 4 },
  formSubtitle: { fontFamily: fonts.body, fontSize: 14, color: ink.inkMuted, marginBottom: 22 },
  inputGroup: { marginBottom: 16 },
  label: {
    fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase',
    color: ink.inkMuted, marginBottom: 8,
  },
  // Dark well: sunken on the glass, brand border, purple focus glow.
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(5,15,11,0.55)',
    borderRadius: 14, borderWidth: 1, borderColor: ink.border, paddingHorizontal: 14, gap: 10,
  },
  inputWrapperFocused: {
    borderColor: ink.primary,
    boxShadow: `0 0 0 3px ${ink.glow}, 0 0 18px ${ink.glow}`,
  },
  input: {
    // `minWidth: 0` is load-bearing on web: a DOM <input> has a ~185 px
    // min-content width (the default `size`), and CSS `min-width: auto` on a
    // flex child refuses to shrink past it — at a 320 px viewport that pushed
    // the password row 34 px wider than its well and threw the eye toggle
    // outside the card. No-op on native (0 is already the default).
    flex: 1, minWidth: 0, paddingVertical: 14, fontSize: 16, fontFamily: fonts.body, color: ink.inkText,
    // No browser focus ring — the well draws its own glow. `outlineWidth: 0`
    // is not enough on Chrome: its :focus-visible ring is `outline-style: auto`,
    // which ignores the width, so the style/colour have to be overridden too.
    outlineWidth: 0, outlineStyle: 'solid', outlineColor: 'transparent',
  },
  codeInput: { letterSpacing: 6, fontSize: 20, fontFamily: fonts.monoSemibold },
  submit: { marginTop: 8 },
  toggleText: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: ink.inkMuted, textAlign: 'center', marginTop: 18 },
  forgotButton: { alignItems: 'center', marginTop: 14 },
  forgotText: { fontFamily: fonts.bodySemibold, fontSize: 14, color: ink.primary },
  // Glass chip
  // Dark glass chip with a gradient rim (DepthCard glass + edge="gradient")
  bioButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 16, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14,
  },
  bioButtonText: { fontFamily: fonts.bodySemibold, fontSize: 14, color: ink.inkText, letterSpacing: 0.2 },

  // ── Reset dialog: opaque sheet ──
  resetOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', paddingHorizontal: 24, zIndex: 100 },
  // Now that the overlay spans the viewport rather than the login card, cap the
  // dialog so it stays a dialog on a wide desktop window instead of stretching
  // edge to edge. The halo wrapper owns width + shadow; the card face is the
  // opaque `ink.surface` hex (set via DepthCard `fill`).
  resetHalo: {
    width: '100%', maxWidth: 420, alignSelf: 'center', borderRadius: 21.5,
    boxShadow: '0 30px 70px -20px rgba(0,0,0,0.85), 0 0 40px rgba(140,175,56,0.25)',
  },
  resetCard: { borderRadius: 20, padding: 24 },
  resetClose: { position: 'absolute', top: 12, right: 12, zIndex: 10, padding: 4 },
  resetTitle: { fontFamily: fonts.displayWide, fontSize: 18, lineHeight: 24, color: ink.inkText, textAlign: 'center', marginBottom: 4 },
  resetSubtitle: { fontFamily: fonts.body, fontSize: 14, color: ink.inkMuted, textAlign: 'center', marginBottom: 20 },
});
