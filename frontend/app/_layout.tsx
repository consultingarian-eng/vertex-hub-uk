import React, { useMemo, useState, useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { View, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated';
// Side-effect: makes Inter the app-wide default font for Text/TextInput.
import '../src/theme/applyGlobalFont';
import { PageField } from '../src/components/ui/PageField';
import { Masthead, MASTHEAD_COMPACT } from '../src/components/nav/Masthead';
import WebPullToRefresh from '../src/components/web/WebPullToRefresh';
import AutoUpdate from '../src/components/AutoUpdate';
import WebPushPrompt from '../src/components/settings/WebPushPrompt';
import EmailChangePrompt from '../src/components/EmailChangePrompt';
// expo-notifications has no web implementation — imported lazily inside the
// native-only useEffect that is already guarded by Platform.OS !== 'web'.
import { colors } from '../src/theme/colors';
import { lightColors } from '../src/theme/ThemeContext';
import { useColors } from '../src/theme/ThemeContext';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { ThemeProvider, useTheme } from '../src/theme/ThemeContext';
import { ThemeProvider as NavThemeProvider, DefaultTheme as NavDefaultTheme, DarkTheme as NavDarkTheme } from '@react-navigation/native';
import { TabPrefsProvider } from '../src/customization/TabPrefsContext';
// Metro resolves the .native implementation on iOS/Android; the default file
// is a no-op so the web/PWA bundle never imports expo-audio.
import { ActiveOfficeProvider } from '../src/office/ActiveOfficeContext';
import { AppShell } from '../src/nav/AppShell';
import { queryClient } from '../src/api/queryClient';
import { Toaster } from '../src/utils/toast';
import { CenterNoticeHost } from '../src/utils/centerNotice';
import { BrandedSplash } from '../src/components/BrandedSplash';
import WebAlertModal from '../src/components/ui/WebAlertModal';
import { RankUp } from '../src/components/ui/RankUp';
import { PreviewBanner } from '../src/components/ui/PreviewBanner';

// Scenes that show the mount-once PageField through them. ONLY for the (tabs)
// navigator and animation:'none' hub routes — there is no transition on those,
// so nothing can ghost. Every animated push/card/modal keeps the opaque
// `colors.page` default from screenOptions.contentStyle.
// EVERY scene keeps the opaque `colors.page` default from screenOptions.contentStyle.
// A transparent scene does NOT merely ghost during a transition — it shows whatever is
// beneath it permanently. Shipped transparent, it broke the customised tab bar: tapping
// Bells/Quality/Planner/KPIs drew them over the current screen (two mastheads at once),
// and tapping Home drew the tab bar over the hub route. `router.replace` did not save us.
// The mount-once PageField sits behind all of this and is therefore no longer visible;
// restoring its ambient blobs means rendering it INSIDE the tab layout, not at the root.
// VERIFY BY TAPPING, NOT BY URL. Loading a route directly cannot reproduce this, because
// there is no previous screen underneath — which is why 167 screenshots all missed it.

function RootNavigator() {
  const colors = useColors();
  const { effective: themeMode } = useTheme();
  // react-navigation paints its own theme background (#f2f2f2 by default)
  // on every navigator container — it sat ON TOP of PageField and hid the
  // page field entirely. Make the navigation theme transparent so the
  // mount-once field shows through; screens that need an opaque page get it
  // from the Stack's contentStyle default (colors.page) instead.
  const navTheme = useMemo(() => {
    const base = themeMode === 'dark' ? NavDarkTheme : NavDefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: 'transparent',
        card: 'transparent',
        primary: colors.primary,
        text: colors.text,
        border: colors.border,
      },
    };
  }, [themeMode, colors]);
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  // Brand fonts — Space Grotesk (display), Inter (body),
  // JetBrains Mono (data), Unbounded (editorial: mastheads, kickers, stat
  // numerals — fonts.displayWide / fonts.displayBlack; reference by family
  // name only, never stack fontWeight on them). Bundled locally
  // (assets/fonts) so no npm dep.
  const [fontsLoaded] = useFonts({
    'SpaceGrotesk': require('../assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-Bold': require('../assets/fonts/SpaceGrotesk-Bold.ttf'),
    'Inter': require('../assets/fonts/Inter-Regular.ttf'),
    'Inter-Medium': require('../assets/fonts/Inter-Medium.ttf'),
    'Inter-SemiBold': require('../assets/fonts/Inter-SemiBold.ttf'),
    'Inter-Bold': require('../assets/fonts/Inter-Bold.ttf'),
    'JetBrainsMono': require('../assets/fonts/JetBrainsMono-Regular.ttf'),
    'JetBrainsMono-SemiBold': require('../assets/fonts/JetBrainsMono-SemiBold.ttf'),
    'Unbounded-SemiBold': require('../assets/fonts/Unbounded-SemiBold.ttf'),
    'Unbounded-Black': require('../assets/fonts/Unbounded-Black.ttf'),
  });

  const { user, realUser, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Hold splash for at least 2 s so the tab bar and data have time to settle
  // before the user sees the UI — avoids the jank of a half-loaded screen.
  const [splashHeld, setSplashHeld] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setSplashHeld(false), 2000);
    return () => clearTimeout(t);
  }, []);

  React.useEffect(() => {
    if (loading) return;
    const inAuth = segments[0] === 'login' || segments[0] === 'verify-email';
    const isPublic = String(segments[0] || '') === 'public'; // publicly-shared read-only routes (no auth required)
    const choosing = String(segments[0] || '') === 'change-password';
    if (!user && !inAuth && !isPublic) {
      router.replace('/login');
    } else if (realUser?.must_change_password) {
      // Signed in on the shared starter password: the only screen is
      // "choose your own password" (the server refuses everything else).
      if (!choosing) router.replace('/change-password' as never);
    } else if (user && (inAuth || choosing)) {
      // Everyone lands on the role-aware Home dashboard.
      router.replace('/(tabs)');
    }
  }, [user, realUser?.must_change_password, loading, segments]);

  // Handle notification taps — route user to the appropriate screen
  React.useEffect(() => {
    if (Platform.OS === 'web') return;
    const Notifications = require('expo-notifications');
    const sub = Notifications.addNotificationResponseReceivedListener((response: any) => {
      try {
        const data: any = response?.notification?.request?.content?.data || {};
        const type = data?.type;
        if (type === 'assessment_complete') {
          // Trainee — the graded day-by-day record lives on My Progress
          // (the COD tab is the capability view, no scores there).
          router.push('/assessments' as any);
        } else if (type === 'new_hire') {
          // Leader — open their team
          router.push('/(tabs)');
        } else if (type === 'promotion') {
          // Promoted user — open home
          router.push('/(tabs)');
        } else if (type === 'weekly_bulletins') {
          // Monday 9am — honour the push's target (the one-tap
          // generate-and-share screen); /weekly-share stays reachable for
          // pushes sent before the retarget.
          router.push((String(data?.url || '') || '/share-bulletins') as never);
        } else if (type === 'grading_reminder') {
          // Bell-triggered assessment nag — Home hosts the grading queue
          router.push('/(tabs)');
        } else if (type === 'orientation_grading') {
          // Admin 6 PM nudge (category: grading) — the Day-1/Day-2
          // orientation mass-grader with the whole cohort ticked.
          router.push((String(data?.url || '') || '/orientation-grading') as never);
        } else if (type === 'broadcast') {
          // Admin announcement — its inbox row carries the details.
          router.push((String(data?.url || '') || '/notifications') as never);
        } else if (type === 'morning_briefing') {
          router.push((String(data?.url || '') || '/(tabs)/progress') as never);
        }
      } catch (e) {
        // no-op
      }
    });
    return () => sub.remove();
  }, [router]);

  if (loading || splashHeld || !fontsLoaded) {
    return <BrandedSplash />;
  }

  // Decide whether the app frame (sidebar + top tabs) shows. Hidden on
  // auth/public flows + add-hire modal so it doesn't appear over the
  // login form, OTP screen, or full-screen modals.
  const seg0 = String(segments[0] || '');
  const showFloatingBar = !!user && !realUser?.must_change_password
    && seg0 !== 'login' && seg0 !== 'verify-email' && seg0 !== 'public' && seg0 !== 'add-hire' && seg0 !== 'change-password';

  return (
    <View style={{ flex: 1 }}>
      {/* The ONE owner of the page colour: a mount-once living background
          (colors.page + ambient blobs) that the transparent (tabs) navigator
          and the animation:'none' hub routes show through. Must stay the
          first child so the Stack paints above it. */}
      <PageField />
      <AppShell enabled={showFloatingBar}>
      <NavThemeProvider value={navTheme}>
      <Stack
        screenOptions={{
          // Ink & Cube masthead (spec §3.2): one custom header for every
          // stack screen — gradient Unbounded title, glass back chip, the
          // live brand cube and a gradient hairline, condensing with
          // pageScrollY. It reads title/headerLeft/headerRight/headerBackVisible
          // from each screen's options, so the per-screen options below keep
          // working. Compact (48px, no cube) routes spread MASTHEAD_COMPACT.
          // The headerStyle/headerTitle* options that follow are only used by
          // react-navigation's own Header, which this replaces; they are kept
          // as the documented fallback if `header` is ever removed.
          header: (props) => <Masthead {...props} />,
          // Web parity: react-navigation's web header defaults to 64px tall
          // (vs 44px on iPhone) — 20px of extra chrome on every screen that
          // made the PWA feel bulkier than the native app. The web fallback
          // renders the JS elements Header, which honors headerStyle.height
          // (native iOS uses UINavigationBar and ignores it, so this is
          // web-only by construction, cast past the native-stack type).
          headerStyle: {
            // Page field colour (not ink) so the header + status-bar region
            // blends with the page — no band across the top.
            backgroundColor: colors.page,
            ...(Platform.OS === 'web' ? { height: 44 + insets.top } : null),
          } as any,
          headerShadowVisible: false,
          headerTintColor: colors.text,
          // fontSize 17 matches the iOS default; web would otherwise use 18.
          headerTitleStyle: { fontFamily: 'SpaceGrotesk-Bold', fontWeight: '700', fontSize: 17 },
          // React Navigation centers the title on iOS native but LEFT-aligns it
          // on web/Android, so every stack-header screen looked different on the
          // PWA. Pin it centered everywhere to match the native app.
          headerTitleAlign: 'center',
          // OPAQUE page fill is the DEFAULT so an animated push/card/modal never
          // shows the previous screen through it. Transparency (revealing the
          // PageField blobs) is an allowlist: the (tabs) navigator and the
          // animation:'none' hub routes below spread TRANSPARENT_SCENE.
          contentStyle: { backgroundColor: colors.page },
        }}
      >
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="verify-email" options={{ headerShown: false }} />
      <Stack.Screen name="change-password" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="onboarding" options={{ headerShown: true, title: 'Start Here', headerBackTitle: 'Back' }} />
      <Stack.Screen name="badges" options={{ headerShown: true, title: 'Badges', headerLeft: () => null, headerBackVisible: false, animation: 'none' }} />
      <Stack.Screen name="module/[id]" options={{ headerShown: true, title: 'Module', headerBackTitle: 'Back' }} />
      <Stack.Screen name="leadership" options={{ headerShown: true, title: 'My Progress', headerLeft: () => null, headerBackVisible: false, animation: 'none' }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="bells" options={{ headerShown: true, title: 'Bells', headerLeft: () => null, headerBackVisible: false, animation: 'none', ...MASTHEAD_COMPACT }} />
      <Stack.Screen name="field-kpis" options={{ headerShown: true, title: 'Field KPIs', headerLeft: () => null, headerBackVisible: false, animation: 'none', ...MASTHEAD_COMPACT }} />
      <Stack.Screen name="assessments" options={{ headerShown: true, title: 'My Progress', headerLeft: () => null, headerBackVisible: false, animation: 'none' }} />
      <Stack.Screen name="report" options={{ headerShown: true, title: 'AI Report', headerBackTitle: 'Back' }} />
      <Stack.Screen name="owneriq-admin" options={{ headerShown: true, title: 'OwnerIQ Sync', headerBackTitle: 'Back' }} />
      <Stack.Screen name="live-ops" options={{ headerShown: true, title: 'Live Operations', headerLeft: () => null, headerBackVisible: false, animation: 'none', ...MASTHEAD_COMPACT }} />
      <Stack.Screen name="live-sector" options={{ headerShown: true, title: 'Sector', headerBackTitle: 'Back', ...MASTHEAD_COMPACT }} />
      <Stack.Screen name="person/[id]" options={{ headerShown: true, title: 'Person', headerBackTitle: 'Back', ...MASTHEAD_COMPACT }} />
      <Stack.Screen name="live-ba" options={{ headerShown: true, title: 'BA', headerBackTitle: 'Back', ...MASTHEAD_COMPACT }} />
      <Stack.Screen name="monthly-planner" options={{ headerShown: true, title: 'Monthly Planner', headerLeft: () => null, headerBackVisible: false, animation: 'none', ...MASTHEAD_COMPACT }} />
      <Stack.Screen name="monthly-planner-team" options={{ headerShown: true, title: 'Team Planner', headerBackTitle: 'Back', ...MASTHEAD_COMPACT }} />
      <Stack.Screen name="weekly-planner" options={{ headerShown: true, title: 'Weekly Planner', headerBackTitle: 'Back', ...MASTHEAD_COMPACT }} />
      <Stack.Screen name="absence-approvals" options={{ headerShown: true, title: 'Absence Approvals', headerBackTitle: 'Back', ...MASTHEAD_COMPACT }} />
      <Stack.Screen name="weekly-review" options={{ headerShown: true, title: 'Monday Review', headerBackTitle: 'Back' }} />
      <Stack.Screen name="coaching" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="product-knowledge" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="customize-tabs" options={{ headerShown: false }} />
      <Stack.Screen name="notifications" options={{ headerShown: false }} />
      <Stack.Screen name="weekly-share" options={{ headerShown: false }} />
      <Stack.Screen name="share-bulletins" options={{ headerShown: false }} />
      <Stack.Screen name="new-hire/[id]" options={{ title: 'New Starter Details', presentation: 'card' }} />
      <Stack.Screen name="assessment/[id]" options={{ title: 'Daily Assessment', presentation: 'card' }} />
      <Stack.Screen name="day/[id]" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="cod/[id]" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="checklist/[id]" options={{ title: 'Skill Grading', presentation: 'card' }} />
      <Stack.Screen name="orientation-grading" options={{ headerShown: false }} />
      <Stack.Screen name="add-hire" options={{ title: 'Add New Starter', presentation: 'modal' }} />
      <Stack.Screen name="public/bells/[office]" options={{ headerShown: false }} />
      </Stack>
      </NavThemeProvider>
      </AppShell>
      {/* Web/PWA pull-to-refresh (RefreshControl is a no-op on web). */}
      <WebPullToRefresh />
      {/* Reload into new deploys automatically (web polls /api/version; native checks EAS Update on foreground). */}
      <AutoUpdate />
      {/* First-load "turn on notifications" nudge — signed-in web users only. */}
      {showFloatingBar && <WebPushPrompt />}
      {/* Indeed-relay accounts (…@indeedemail.com): ask for their real email
          on first login. Renders nothing for everyone else. */}
      {showFloatingBar && <EmailChangePrompt />}
    </View>
  );
}

function ThemedStatusBar() {
  const { effective } = useTheme();
  const colors = useColors();

  // Web/PWA: keep the document chrome (safe-area bands, browser theme-color)
  // painted with the live theme's page field so the whole screen is one
  // continuous background. The static #061410 in +html.tsx only covers the
  // instant before React mounts.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.documentElement.style.backgroundColor = colors.page;
    document.body.style.backgroundColor = colors.page;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.page);
  }, [colors.page]);

  return <StatusBar style={effective === 'dark' ? 'light' : 'dark'} />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedStatusBar />
          {/* Respect the OS reduce-motion setting (reanimated's default, made
              explicit): timings jump, loops freeze. Every loop seeds its shared
              value at mid-phase so the frozen frame is the intended composition. */}
          <ReducedMotionConfig mode={ReduceMotion.System} />
          <AuthProvider>
            <ActiveOfficeProvider>
              <TabPrefsProvider>
                <RootNavigator />
                <Toaster />
                <CenterNoticeHost />
                <WebAlertModal />
                <RankUp />
                <PreviewBanner />
              </TabPrefsProvider>
            </ActiveOfficeProvider>
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
