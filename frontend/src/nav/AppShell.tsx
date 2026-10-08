/**
 * The app frame: a left sidebar and closable tabs along the top (VS Code /
 * OwnerIQ style), replacing the old floating bottom bar.
 *
 *  - Wide screens (>= 900px): the sidebar sits beside the content. It shows
 *    the user's pinned items (Customise Tabs still decides which, and their
 *    order), a "More" group with everything else they can open, and their
 *    profile at the bottom. It collapses to an icon rail (choice remembered
 *    per device).
 *  - Phones: a slim top bar with a menu button that slides the same sidebar
 *    in as a drawer, and the same tabs, scrolling sideways.
 *
 * Every screen you open becomes a tab; × closes it (the neighbour opens if it
 * was the active one). Home is pinned. Up to MAX_TABS stay open; past that the
 * least recently used one closes. Open tabs are remembered per user on this
 * device.
 *
 * The shell owns the top safe-area inset, so the content below gets top: 0
 * through SafeAreaInsetsContext. Full-screen sheets that need the real notch
 * inset read useDeviceInsets().
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Animated, Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, usePathname } from 'expo-router';
import { SafeAreaInsetsContext, useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';
import { withSpring } from 'react-native-reanimated';
import { useColors, fonts } from '../theme/ThemeContext';
import { APP_NAME } from '../theme/brand';
import { MOTION } from '../theme/motion';
import { pageMarkKick, pageTab } from '../theme/pageScroll';
import { VertexMark } from '../components/ui/VertexMark';
import { useAuth } from '../auth/AuthContext';
import { useTabPrefs } from '../customization/TabPrefsContext';
import type { TabItem } from '../customization/tabRegistry';
import { levelWord } from '../utils/roleTitle';
import { haptics } from '../utils/haptics';
import { NavEntry, PROFILE_ITEM, entryForPath, filledIcon, hrefOf, matchItem } from './navModel';
import { badgeText, useUnreadCount } from './useUnread';

const WIDE = 900;
const RAIL_W = 76;
const SIDE_W = 232;
const TAB_H = 40;
const MAX_TABS = 8;
const HOME_KEY = 'home';

const C = {
  side: '#0b211c',
  sideEdge: 'rgba(183,223,88,0.10)',
  text: '#e8efe3',
  muted: '#9fb8a8',
  faint: 'rgba(159,184,168,0.6)',
  lime: '#b7df58',
  onLime: '#102d25',
  hover: 'rgba(240,244,233,0.06)',
  activeBg: 'rgba(183,223,88,0.12)',
};

// ── Insets ───────────────────────────────────────────────────────────────────
const DeviceInsetsContext = createContext<EdgeInsets | null>(null);
/** The device's real safe-area insets (for full-screen sheets under the notch). */
export function useDeviceInsets(): EdgeInsets {
  const fromShell = useContext(DeviceInsetsContext);
  const local = useSafeAreaInsets();
  return fromShell || local;
}

// ── Navigation ───────────────────────────────────────────────────────────────
const lastNav = { href: '', t: 0 };
function go(href: string) {
  const now = Date.now();
  if (lastNav.href === href && now - lastNav.t < 600) return;
  lastNav.href = href; lastNav.t = now;
  haptics.light();
  router.replace(href as never);
  pageMarkKick.value += 1;
}

async function readJSON<T>(key: string): Promise<T | null> {
  try { const raw = await AsyncStorage.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}
function writeJSON(key: string, v: unknown) {
  AsyncStorage.setItem(key, JSON.stringify(v)).catch(() => {});
}

// ── Open tabs ────────────────────────────────────────────────────────────────
function useOpenTabs(enabled: boolean, userId: string | undefined, pathname: string) {
  const storeKey = `open_tabs_v1:${userId || 'anon'}`;
  const home = useMemo(() => entryForPath('/'), []);
  const [tabs, setTabs] = useState<NavEntry[]>([home]);
  const [ready, setReady] = useState(false);
  const used = useRef<Record<string, number>>({});
  const active = useMemo(() => entryForPath(pathname), [pathname]);

  useEffect(() => {
    if (!enabled) return;
    setReady(false);
    readJSON<NavEntry[]>(storeKey).then((saved) => {
      const clean = (Array.isArray(saved) ? saved : []).filter((t) => t && t.key && t.href && t.key !== HOME_KEY);
      setTabs([home, ...clean.slice(0, MAX_TABS - 1)]);
      setReady(true);
    });
  }, [enabled, storeKey, home]);

  useEffect(() => {
    if (!enabled || !ready) return;
    used.current[active.key] = Date.now();
    setTabs((prev) => {
      let next = prev.some((t) => t.key === active.key)
        ? prev.map((t) => (t.key === active.key ? { ...t, ...active } : t))
        : [...prev, active];
      while (next.length > MAX_TABS) {
        const drop = next
          .filter((t) => t.key !== HOME_KEY && t.key !== active.key)
          .sort((a, b) => (used.current[a.key] || 0) - (used.current[b.key] || 0))[0];
        if (!drop) break;
        next = next.filter((t) => t.key !== drop.key);
      }
      return next;
    });
  }, [enabled, ready, active]);

  useEffect(() => {
    if (enabled && ready) writeJSON(storeKey, tabs.filter((t) => t.key !== HOME_KEY));
  }, [enabled, ready, storeKey, tabs]);

  const close = useCallback((key: string) => {
    if (key === HOME_KEY) return;
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.key === key);
      if (i < 0) return prev;
      if (key === active.key) {
        const next = prev[i + 1] || prev[i - 1];
        if (next) go(next.href);
      }
      return prev.filter((t) => t.key !== key);
    });
  }, [active.key]);

  return { tabs, activeKey: active.key, close };
}

// ── Shell ────────────────────────────────────────────────────────────────────
export function AppShell({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const pathname = usePathname() || '/';
  const { user } = useAuth();
  const { resolved, loaded } = useTabPrefs();
  const [expanded, setExpanded] = useState(() => width >= 1280);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    readJSON<boolean>('sidebar_expanded_v1').then((v) => { if (typeof v === 'boolean') setExpanded(v); });
  }, []);
  const toggleExpanded = () => setExpanded((v) => { writeJSON('sidebar_expanded_v1', !v); return !v; });

  const pinned = useMemo(() => resolved.filter((r) => r.visible).map((r) => r.item), [resolved]);
  const more = useMemo(() => resolved.filter((r) => !r.visible).map((r) => r.item), [resolved]);
  const activeItem = useMemo(() => matchItem(pathname, [...pinned, ...more, PROFILE_ITEM]), [pathname, pinned, more]);

  // The page field's ambient drift follows the active nav item, as it did
  // with the bottom bar.
  useEffect(() => {
    const i = activeItem ? pinned.findIndex((p) => p.id === activeItem.id) : -1;
    if (i >= 0) pageTab.value = withSpring(i, MOTION.snappy);
  }, [activeItem, pinned]);

  const { tabs, activeKey, close } = useOpenTabs(enabled, user?.id, pathname);
  // Unread inbox count: the bell, the Inbox row, the app icon and the tab title.
  const unread = useUnreadCount(enabled && !!user?.id);

  useEffect(() => { setDrawer(false); }, [pathname]);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const contentInsets = useMemo<EdgeInsets>(
    () => (enabled ? { ...insets, top: 0, left: wide ? 0 : insets.left } : insets),
    [enabled, insets, wide],
  );

  const show = enabled && loaded;
  const sidebar = (mode: 'rail' | 'full', inDrawer = false) => (
    <Sidebar
      mode={mode}
      inDrawer={inDrawer}
      pinned={pinned}
      more={more}
      activeId={activeItem?.id || null}
      unread={unread}
      onToggle={inDrawer ? () => setDrawer(false) : toggleExpanded}
      topInset={inDrawer ? insets.top : 0}
      user={user}
    />
  );

  return (
    <DeviceInsetsContext.Provider value={insets}>
      <View style={{ flex: 1, flexDirection: wide ? 'row' : 'column' }}>
        {show && wide && sidebar(expanded ? 'full' : 'rail')}
        <View style={{ flex: 1, minWidth: 0 }}>
          {show && (
            <TabStrip
              tabs={tabs}
              activeKey={activeKey}
              onClose={close}
              topInset={insets.top}
              unread={unread}
              inboxActive={activeKey === 'notifications'}
              onMenu={wide ? undefined : () => setDrawer(true)}
            />
          )}
          <SafeAreaInsetsContext.Provider value={contentInsets}>
            <View style={{ flex: 1 }}>{children}</View>
          </SafeAreaInsetsContext.Provider>
        </View>
        {show && !wide && <Drawer open={drawer} onClose={() => setDrawer(false)}>{sidebar('full', true)}</Drawer>}
      </View>
    </DeviceInsetsContext.Provider>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────────────
function Sidebar({ mode, inDrawer, pinned, more, activeId, unread, onToggle, topInset, user }: {
  mode: 'rail' | 'full'; inDrawer: boolean; pinned: TabItem[]; more: TabItem[]; activeId: string | null;
  unread: number; onToggle: () => void; topInset: number; user: any;
}) {
  // The Inbox row carries the count; when Inbox sits under a closed More, More does.
  const badgeFor = (it: TabItem) => (it.id === 'notifications' ? unread : 0);
  const moreBadge = more.some((m) => m.id === 'notifications') ? unread : 0;
  const rail = mode === 'rail';
  const [moreOpen, setMoreOpen] = useState(false);
  const moreHasActive = more.some((m) => m.id === activeId);
  const initials = (user?.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w: string) => w[0]?.toUpperCase()).join('');

  return (
    <View style={[s.side, inDrawer && { flex: 1 }, { width: rail ? RAIL_W : inDrawer ? '100%' : SIDE_W, paddingTop: topInset }]}>
      <LinearGradient pointerEvents="none" colors={['rgba(183,223,88,0.10)', 'rgba(183,223,88,0)']} style={s.sideGlow} />

      <View style={[s.brand, rail && s.brandRail]}>
        <Pressable onPress={() => go('/(tabs)')} style={s.brandMark} accessibilityLabel="Home">
          <VertexMark size={rail ? 30 : 28} color={C.lime} kick={pageMarkKick} ripple={0} />
        </Pressable>
        {!rail && <Text style={s.brandText} numberOfLines={1}>{APP_NAME}</Text>}
        {!rail && (
          <Pressable onPress={onToggle} style={(st: any) => [s.iconBtn, st.hovered && { backgroundColor: C.hover }]}
            accessibilityLabel={inDrawer ? 'Close menu' : 'Collapse sidebar'} hitSlop={6}>
            <Ionicons name={inDrawer ? 'close' : 'chevron-back'} size={18} color={C.muted} />
          </Pressable>
        )}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 6, paddingHorizontal: rail ? 6 : 10 }} showsVerticalScrollIndicator={false}>
        {!rail && <Text style={s.section}>Workspace</Text>}
        {pinned.map((it) => <NavRow key={it.id} item={it} rail={rail} active={it.id === activeId} badge={badgeFor(it)} />)}

        {more.length > 0 && (
          rail ? (
            <>
              <View style={s.railRule} />
              <NavRow
                item={{ id: '__more', label: 'More', longLabel: 'More', icon: moreOpen ? 'chevron-up-outline' : 'grid-outline', kind: 'tab', target: '', visibleFor: [], defaultVisibleByRole: {} }}
                rail
                active={moreHasActive && !moreOpen}
                badge={moreOpen ? 0 : moreBadge}
                onPress={() => setMoreOpen((v) => !v)}
              />
            </>
          ) : (
            <Pressable onPress={() => setMoreOpen((v) => !v)} style={s.moreHead} accessibilityRole="button">
              <Text style={[s.section, { marginTop: 0, flex: 1 }]}>More</Text>
              {!moreOpen && moreBadge > 0 ? <View style={[s.badge, { marginRight: 6 }]}><Text style={s.badgeText}>{badgeText(moreBadge)}</Text></View> : null}
              <Ionicons name={moreOpen ? 'chevron-up' : 'chevron-down'} size={14} color={C.faint} />
            </Pressable>
          )
        )}
        {(moreOpen || (!rail && moreHasActive)) && more.map((it) => <NavRow key={it.id} item={it} rail={rail} active={it.id === activeId} badge={badgeFor(it)} />)}
      </ScrollView>

      <View style={[s.foot, rail && { alignItems: 'center', paddingHorizontal: 6 }]}>
        <NavRow
          item={{ id: '__customise', label: 'Customise', longLabel: 'Choose and order your sidebar', icon: 'options-outline', kind: 'route', target: '/customize-tabs', visibleFor: [], defaultVisibleByRole: {} }}
          rail={rail}
          active={false}
        />
        <Pressable
          onPress={() => go(hrefOf(PROFILE_ITEM))}
          style={(st: any) => [s.me, rail && s.meRail, activeId === 'profile' && { backgroundColor: C.activeBg }, st.hovered && { backgroundColor: C.hover }]}
          accessibilityLabel="Profile"
        >
          <View style={s.avatar}><Text style={s.avatarText}>{initials}</Text></View>
          {!rail && (
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.meName} numberOfLines={1}>{user?.name || 'Profile'}</Text>
              <Text style={s.meRole} numberOfLines={1}>{levelWord(user)}</Text>
            </View>
          )}
        </Pressable>
        {rail && !inDrawer && (
          <Pressable onPress={onToggle} style={(st: any) => [s.iconBtn, { marginTop: 4 }, st.hovered && { backgroundColor: C.hover }]} accessibilityLabel="Expand sidebar">
            <Ionicons name="chevron-forward" size={18} color={C.muted} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function NavRow({ item, rail, active, onPress, badge = 0 }: { item: TabItem; rail: boolean; active: boolean; onPress?: () => void; badge?: number }) {
  const [hover, setHover] = useState(false);
  return (
    <Pressable
      onPress={onPress || (() => { if (!active) go(hrefOf(item)); })}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={[rail ? s.railItem : s.row, hover && { backgroundColor: C.hover }, active && s.rowActive]}
      accessibilityRole="button"
      accessibilityLabel={item.longLabel}
      accessibilityState={{ selected: active }}
      testID={`nav-${item.id}`}
    >
      {active && <View style={[s.activeBar, rail && { left: -6 }]} />}
      <Ionicons name={active ? filledIcon(item.icon) : item.icon} size={rail ? 21 : 19} color={active ? C.lime : C.muted} />
      {rail ? (
        <Text style={[s.railLabel, active && { color: C.text }]} numberOfLines={1}>{item.short || item.label}</Text>
      ) : (
        <Text style={[s.rowLabel, active && { color: C.text, fontFamily: fonts.bodySemibold }]} numberOfLines={1}>{item.label}</Text>
      )}
      {badge > 0 ? (
        <View style={[s.badge, rail && s.badgeRail]} accessibilityLabel={`${badge} unread`}>
          <Text style={s.badgeText}>{badgeText(badge)}</Text>
        </View>
      ) : null}
      {rail && hover && Platform.OS === 'web' && (
        <View pointerEvents="none" style={s.tip}><Text style={s.tipText}>{item.longLabel}</Text></View>
      )}
    </Pressable>
  );
}

// ── Tabs along the top ───────────────────────────────────────────────────────
function TabStrip({ tabs, activeKey, onClose, topInset, onMenu, unread, inboxActive }: {
  tabs: NavEntry[]; activeKey: string; onClose: (k: string) => void; topInset: number; onMenu?: () => void;
  unread: number; inboxActive: boolean;
}) {
  const colors = useColors();
  const scroll = useRef<ScrollView>(null);
  const boxes = useRef<Record<string, { x: number; w: number }>>({});
  const [stripW, setStripW] = useState(0);

  // Keep the active tab in view.
  useEffect(() => {
    const b = boxes.current[activeKey];
    if (b && stripW) scroll.current?.scrollTo({ x: Math.max(0, b.x + b.w / 2 - stripW / 2), animated: true });
  }, [activeKey, stripW, tabs.length]);

  const phone = !!onMenu;
  return (
    <View style={[s.strip, { paddingTop: topInset, height: (phone ? 46 : TAB_H) + topInset }]}>
      {onMenu && (
        <Pressable onPress={onMenu} style={s.menuBtn} accessibilityLabel="Open menu" testID="nav-menu">
          <Ionicons name="menu" size={22} color={C.text} />
        </Pressable>
      )}
      <ScrollView
        ref={scroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ alignItems: 'flex-end', paddingRight: 8 }}
        onLayout={(e) => setStripW(e.nativeEvent.layout.width)}
      >
        {tabs.map((t) => {
          const active = t.key === activeKey;
          const pinned = t.key === HOME_KEY;
          return (
            <TabChip
              key={t.key}
              t={t}
              active={active}
              pinned={pinned}
              phone={phone}
              page={colors.page}
              text={colors.text}
              onPress={() => { if (!active) go(t.href); }}
              onClose={() => onClose(t.key)}
              onLayout={(x, w) => { boxes.current[t.key] = { x, w }; }}
            />
          );
        })}
      </ScrollView>
      {/* The inbox bell, always in reach, with the unread count on it. */}
      <Pressable
        onPress={() => { if (!inboxActive) go('/notifications'); }}
        style={(st: any) => [s.bell, phone && { height: 46 }, st.hovered && { backgroundColor: C.hover }]}
        accessibilityRole="button"
        accessibilityLabel={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
        testID="nav-inbox-bell"
      >
        <Ionicons name={inboxActive ? 'notifications' : 'notifications-outline'} size={19} color={inboxActive || unread > 0 ? C.lime : C.muted} />
        {unread > 0 ? (
          <View style={s.bellBadge}><Text style={s.badgeText}>{badgeText(unread)}</Text></View>
        ) : null}
      </Pressable>
    </View>
  );
}

function TabChip({ t, active, pinned, phone, page, text, onPress, onClose, onLayout }: {
  t: NavEntry; active: boolean; pinned: boolean; phone: boolean; page: string; text: string;
  onPress: () => void; onClose: () => void; onLayout: (x: number, w: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const showClose = !pinned && (active || hover || phone);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      onLayout={(e) => onLayout(e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
      style={[s.tab, phone && s.tabPhone, active ? { backgroundColor: page } : hover && { backgroundColor: C.hover }]}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={t.label}
      testID={`tab-${t.key}`}
    >
      {active && <View style={s.tabTopLine} />}
      <Ionicons name={active ? filledIcon(t.icon) : t.icon} size={15} color={active ? (isDarkHex(page) ? C.lime : '#244c3b') : C.muted} />
      <Text style={[s.tabText, { color: active ? text : C.muted }]} numberOfLines={1}>{t.label}</Text>
      {!pinned && (
        <Pressable
          onPress={onClose}
          hitSlop={8}
          style={(st: any) => [s.tabClose, { opacity: showClose ? 1 : 0 }, st.hovered && { backgroundColor: active ? 'rgba(0,0,0,0.08)' : C.hover }]}
          accessibilityLabel={`Close ${t.label}`}
        >
          <Ionicons name="close" size={13} color={active ? text : C.muted} />
        </Pressable>
      )}
    </Pressable>
  );
}

function isDarkHex(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.5;
}

// ── Phone drawer ─────────────────────────────────────────────────────────────
function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const panelW = Math.min(300, Math.round(width * 0.84));
  const anim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
    Animated.timing(anim, { toValue: open ? 1 : 0, duration: 220, useNativeDriver: Platform.OS !== 'web' })
      .start(() => { if (!open) setMounted(false); });
  }, [open, anim]);
  if (!mounted) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'auto' : 'none'}>
      <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>
      <Animated.View style={[s.drawer, { width: panelW, transform: [{ translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [-panelW, 0] }) }] }]}>
        {children}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  side: { backgroundColor: C.side, borderRightWidth: 1, borderRightColor: C.sideEdge, overflow: 'visible', zIndex: 30 },
  sideGlow: { position: 'absolute', left: 0, right: 0, top: 0, height: 160 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, height: 58 },
  brandRail: { justifyContent: 'center', paddingHorizontal: 0 },
  brandMark: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  brandText: { flex: 1, fontFamily: fonts.displayWide, fontSize: 13, letterSpacing: 0.4, color: C.text },
  iconBtn: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  section: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase', color: C.faint, marginTop: 10, marginBottom: 6, paddingHorizontal: 10 },
  moreHead: { flexDirection: 'row', alignItems: 'center', marginTop: 14, marginBottom: 2, paddingRight: 10, minHeight: 28 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 42, paddingHorizontal: 12, borderRadius: 10, marginBottom: 2 },
  rowActive: { backgroundColor: C.activeBg },
  rowLabel: { flex: 1, fontFamily: fonts.body, fontSize: 14, color: '#cdd9cf' },
  activeBar: { position: 'absolute', left: -10, top: 9, bottom: 9, width: 3, borderRadius: 2, backgroundColor: C.lime, boxShadow: '0 0 10px rgba(183,223,88,0.8)' } as any,
  railItem: { alignItems: 'center', justifyContent: 'center', height: 56, borderRadius: 12, marginBottom: 4, gap: 3 },
  railLabel: { fontFamily: fonts.bodySemibold, fontSize: 9.5, color: C.muted, maxWidth: RAIL_W - 14 },
  railRule: { height: 1, backgroundColor: C.sideEdge, marginVertical: 6, marginHorizontal: 8 },
  tip: { position: 'absolute', left: RAIL_W - 4, top: 14, backgroundColor: '#1c4436', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(183,223,88,0.25)', zIndex: 99, boxShadow: '0 8px 20px rgba(0,0,0,0.35)' } as any,
  tipText: { fontFamily: fonts.bodySemibold, fontSize: 12, color: C.text, whiteSpace: 'nowrap' } as any,
  foot: { borderTopWidth: 1, borderTopColor: C.sideEdge, padding: 10, gap: 4 },
  me: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 12 },
  meRail: { padding: 6, justifyContent: 'center' },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.lime, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bodyBold, fontSize: 13, color: C.onLime },
  meName: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: C.text },
  meRole: { fontFamily: fonts.mono, fontSize: 10, color: C.muted, marginTop: 1, letterSpacing: 0.6 },

  strip: { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: C.side, borderBottomWidth: 1, borderBottomColor: C.sideEdge, zIndex: 20 },
  menuBtn: { width: 48, height: 46, alignItems: 'center', justifyContent: 'center' },
  bell: { width: 48, height: TAB_H, alignItems: 'center', justifyContent: 'center' },
  bellBadge: { position: 'absolute', top: 5, right: 5, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9,
    backgroundColor: '#ef4444', borderWidth: 1.5, borderColor: C.side, alignItems: 'center', justifyContent: 'center' },
  badge: { minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, backgroundColor: '#ef4444', alignItems: 'center', justifyContent: 'center' },
  badgeRail: { position: 'absolute', top: 4, right: 12, minWidth: 18, height: 18, borderWidth: 1.5, borderColor: C.side },
  badgeText: { fontFamily: fonts.bodyBold, fontSize: 10.5, lineHeight: 13, color: '#ffffff', fontVariant: ['tabular-nums'] as any },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 7, height: TAB_H - 4, paddingLeft: 12, paddingRight: 6, marginRight: 2, borderTopLeftRadius: 10, borderTopRightRadius: 10, maxWidth: 220, minWidth: 0 },
  tabPhone: { height: 40, paddingLeft: 10 },
  tabTopLine: { position: 'absolute', left: 10, right: 10, top: 0, height: 2, borderRadius: 1, backgroundColor: C.lime, boxShadow: '0 0 8px rgba(183,223,88,0.7)' } as any,
  tabText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, flexShrink: 1 },
  tabClose: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },

  backdrop: { backgroundColor: 'rgba(5,18,14,0.55)' },
  drawer: { position: 'absolute', left: 0, top: 0, bottom: 0, boxShadow: '12px 0 40px rgba(0,0,0,0.45)' } as any,
});
