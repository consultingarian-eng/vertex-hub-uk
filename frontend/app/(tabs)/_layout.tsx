import React from 'react';
import { Platform } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, fonts } from '../../src/theme/ThemeContext';
import { Masthead, MASTHEAD_COMPACT } from '../../src/components/nav/Masthead';
import { useAuth } from '../../src/auth/AuthContext';
import { useIsLandscape } from '../../src/hooks/useIsLandscape';

export default function TabLayout() {
  const colors = useColors();
  const { user } = useAuth();
  const isLandscape = useIsLandscape();
  const insets = useSafeAreaInsets();
  const isTrainee = user?.role === 'trainee';
  const isAdmin = user?.role === 'admin';

  return (
    <Tabs
      // Hide the navigator's built-in bar — we render a global CustomTabBar
      // at the root layout level so it persists across pushed routes (Bells,
      // Badges, Quality, etc.) outside this navigator.
      tabBar={() => null}
      backBehavior="none"
      screenOptions={{
        animation: 'none',
        // NO paddingBottom here: the CustomTabBar is a normal-flow sibling
        // BELOW the root Stack (not an absolute overlay), so it already
        // takes its own space. A legacy `sceneContainerStyle` version of
        // this padding was silently ignored by react-navigation v7 for
        // months; when it was migrated to the working `sceneStyle` prop it
        // started actually applying and double-reserved the bar's height —
        // a dead strip (black in dark mode) between content and the tabs.
        //
        // Transparent: tabs are animation:'none' (inactive scenes are detached
        // ...was the theory. In practice on web the OUTGOING tab scene stays
        // visible behind a transparent incoming one: switching Home -> Schedule
        // drew both at once, two mastheads and two page bodies overlapping.
        // Opaque page colour is the only safe answer; it costs the PageField's
        // ambient blobs behind tab content, which is a fair trade for a screen
        // you can actually read. To bring the blobs back, render PageField as
        // the first child INSIDE this navigator rather than at the root.
        // VERIFY BY TAPPING BETWEEN TABS — loading a tab by URL cannot show it.
        sceneStyle: { backgroundColor: colors.page },
        headerShown: !isLandscape,
        // Ink & Cube masthead (spec §3.2) — the same custom header as the
        // root stack, reading each tab's `title`/headerRight. Home (`index`)
        // hides it below: its ink hero starts at the top edge. The
        // headerStyle/headerTitle* options that follow only feed
        // react-navigation's own Header and are kept as the fallback.
        header: (props) => <Masthead {...props} />,
        // Web parity: the JS header defaults to 64px tall on web vs 44px on
        // iPhone — pin web to the iOS height so tab screens' chrome matches
        // the native app instead of feeling bulkier.
        headerStyle: {
          // Page field colour (not ink) so the header + status-bar region
          // blends with the page — no band across the top.
          backgroundColor: colors.page,
          ...(Platform.OS === 'web' ? { height: 44 + insets.top } : null),
        },
        headerShadowVisible: false,
        headerTintColor: colors.text,
        headerTitleStyle: { fontFamily: fonts.display, fontWeight: '700', fontSize: 18 },
        // Centered on iOS native but left-aligned on web/Android by default —
        // pin it so the PWA matches the native app.
        headerTitleAlign: 'center',
      }}
    >
      {/* All Tabs.Screen entries below are registered in the navigator so
          CustomTabBar can navigate to them via navigation.navigate(name).
          The CustomTabBar decides which ones are actually rendered on the
          bottom bar based on per-user prefs. We still set per-screen
          header titles + role gating for screens that should not be
          reachable at all (e.g. trainees can't see hires/admin). */}
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          // Home's EditorialHero is the masthead — it starts at the top edge.
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="hires"
        options={{
          title: 'Performance Hub',
          // Trainees can never reach this — keep route inert.
          href: isTrainee ? null : undefined,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: 'Schedule',
          // Dense grid: 48px cube-less masthead.
          ...MASTHEAD_COMPACT,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="progress"
        options={{
          title: 'COD',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="trending-up-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="manual"
        options={{
          title: 'Manual',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="book-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="pay"
        options={{
          title: 'Earnings Calculator',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calculator-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="admin"
        options={{
          title: 'Admin',
          // Dense tables: 48px cube-less masthead.
          ...MASTHEAD_COMPACT,
          // Non-admins can never reach this — keep route inert.
          href: isAdmin ? undefined : null,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="shield-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
