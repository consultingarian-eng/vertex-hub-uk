/**
 * Inbox — the in-app history of every notification we've sent this user.
 *
 * Every push (expo + webpush) also lands a row in the notifications
 * collection, so this screen is the durable record: nothing is lost to a
 * dismissed banner. Newest first, unread rows stand out, tapping a row
 * marks it read and follows its deep link (http → browser, /path → screen).
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator, Linking, Modal, Pressable, Switch } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { Skeleton } from '../src/components/ui/Skeleton';
import { EmptyState } from '../src/components/ui/EmptyState';
import { apiService } from '../src/api/client';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { APP_LOCALE } from '../src/utils/appTime';

type NotificationRow = {
  id: string;
  title: string;
  body: string;
  type: string;
  data?: Record<string, any>;
  read: boolean;
  created_at: string;
};

type PrefCategory = { key: string; label: string; description: string; enabled: boolean };

const PAGE_SIZE = 50;

function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(t).toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' });
}

/** Human chip label per notification type — only where a chip adds signal. */
function typeChip(type: string): string | null {
  if (type === 'broadcast') return 'Announcement';
  return null;
}

export default function NotificationsScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const queryClient = useQueryClient();
  const tabBarClearance = useTabBarClearance();

  // First page via React Query; "load more" pages accumulate in local state
  // (keyed by ?before=<oldest created_at>). A pull-to-refresh resets both.
  const [extraRows, setExtraRows] = useState<NotificationRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  // Optimistic read state — rows tapped (or "mark all") flip instantly
  // without waiting for a refetch.
  const [localRead, setLocalRead] = useState<Set<string>>(new Set());
  const [allReadLocal, setAllReadLocal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const insets = useSafeAreaInsets();

  const inboxQ = useQuery({
    queryKey: ['notifications-inbox'],
    queryFn: () => apiService.listNotifications({ limit: PAGE_SIZE }).then((r) => r.data),
    retry: false,
  });

  // Notification-type toggles — fetched lazily when the settings sheet opens.
  const prefsQ = useQuery({
    queryKey: ['notification-prefs'],
    queryFn: () => apiService.getNotificationPrefs().then((r) => r.data),
    enabled: settingsOpen,
    retry: false,
  });
  // Web pull-to-refresh (react-native-web's RefreshControl is a no-op).
  // Same refetch as onRefresh below, which is declared later in the component.
  const { pullIndicator } = usePullToRefresh(async () => {
    setExtraRows([]);
    setExhausted(false);
    await inboxQ.refetch();
    queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] });
  });

  const prefCategories: PrefCategory[] = Array.isArray(prefsQ.data?.categories)
    ? (prefsQ.data!.categories as PrefCategory[])
    : [];

  // Optimistic: flip the cached switch instantly, save in the background,
  // and fall back to server truth if the save fails.
  const togglePref = (key: string, next: boolean) => {
    queryClient.setQueryData(['notification-prefs'], (curr: any) =>
      curr
        ? { categories: (curr.categories || []).map((c: PrefCategory) => (c.key === key ? { ...c, enabled: next } : c)) }
        : curr,
    );
    apiService.setNotificationPref(key, next).catch(() => {
      queryClient.invalidateQueries({ queryKey: ['notification-prefs'] });
    });
  };

  const firstPage: NotificationRow[] = Array.isArray(inboxQ.data) ? inboxQ.data : [];
  const rows: NotificationRow[] = useMemo(() => {
    const seen = new Set<string>();
    const out: NotificationRow[] = [];
    for (const r of [...firstPage, ...extraRows]) {
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out;
  }, [firstPage, extraRows]);

  const isUnread = (r: NotificationRow) => !r.read && !localRead.has(r.id) && !allReadLocal;
  const unreadShown = rows.filter(isUnread).length;
  // A full first page means there may be older rows to pull.
  const hasMore = !exhausted && rows.length >= PAGE_SIZE;

  const invalidateUnread = () =>
    queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] });

  const onRefresh = async () => {
    setRefreshing(true);
    setExtraRows([]);
    setExhausted(false);
    await inboxQ.refetch();
    invalidateUnread();
    setRefreshing(false);
  };

  const loadMore = async () => {
    const oldest = rows[rows.length - 1]?.created_at;
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await apiService.listNotifications({ limit: PAGE_SIZE, before: oldest });
      const page: NotificationRow[] = Array.isArray(res.data) ? res.data : [];
      if (page.length < PAGE_SIZE) setExhausted(true);
      setExtraRows((curr) => [...curr, ...page]);
    } catch {
      // Leave the button in place — tapping again retries.
    } finally {
      setLoadingMore(false);
    }
  };

  const markAllRead = async () => {
    setAllReadLocal(true);
    try {
      await apiService.markAllNotificationsRead();
    } catch {
      // Optimistic flip stays — the next refetch reconciles.
    }
    invalidateUnread();
  };

  const openRow = (r: NotificationRow) => {
    if (isUnread(r)) {
      setLocalRead((curr) => new Set(curr).add(r.id));
      apiService.markNotificationRead(r.id).then(invalidateUnread).catch(() => {});
    }
    const url = String(r.data?.url || '');
    if (/^https?:\/\//i.test(url)) {
      Linking.openURL(url).catch(() => {});
    } else if (url.startsWith('/') && url !== '/notifications') {
      router.push(url as never);
    }
    // No URL (or it points back here) → the row is just marked read.
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      {pullIndicator}
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} testID="inbox-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Inbox</Text>
          <Text style={styles.subtitle}>
            {inboxQ.isLoading ? 'Loading…' : unreadShown > 0 ? `${unreadShown} unread` : 'All caught up'}
          </Text>
        </View>
        {unreadShown > 0 && (
          <TouchableOpacity onPress={markAllRead} style={styles.markAllBtn} testID="inbox-mark-all">
            <Text style={styles.markAllText}>Mark all read</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={() => setSettingsOpen(true)}
          hitSlop={{ top: 10, bottom: 10, left: 6, right: 10 }}
          testID="inbox-settings"
        >
          <Ionicons name="settings-outline" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 + tabBarClearance }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {inboxQ.isLoading ? (
          <View>
            {[0, 1, 2, 3, 4].map((i) => (
              <View key={i} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Skeleton width={'55%' as const} height={14} />
                  <View style={{ height: 8 }} />
                  <Skeleton height={11} />
                </View>
              </View>
            ))}
          </View>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="mail-open-outline"
            title="You're all caught up"
            subtitle="Notifications you receive will collect here, so you never lose one to a dismissed banner."
          />
        ) : (
          <>
            {rows.map((r) => {
              const unread = isUnread(r);
              const chip = typeChip(r.type);
              return (
                <TouchableOpacity
                  key={r.id}
                  style={styles.row}
                  onPress={() => openRow(r)}
                  activeOpacity={0.7}
                  testID={`inbox-row-${r.id}`}
                >
                  <View style={styles.dotCol}>
                    {unread && <View style={styles.unreadDot} />}
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={styles.rowTop}>
                      <Text style={[styles.rowTitle, unread && styles.rowTitleUnread]} numberOfLines={1}>
                        {r.title}
                      </Text>
                      <Text style={styles.rowWhen}>{timeAgo(r.created_at)}</Text>
                    </View>
                    {!!r.body && (
                      <Text style={styles.rowBody} numberOfLines={2}>{r.body}</Text>
                    )}
                    {chip && (
                      <View style={styles.chip}>
                        <Text style={styles.chipText}>{chip}</Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
            {hasMore && (
              <TouchableOpacity onPress={loadMore} style={styles.moreBtn} disabled={loadingMore} testID="inbox-load-more">
                {loadingMore ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Text style={styles.moreBtnText}>Load older notifications</Text>
                )}
              </TouchableOpacity>
            )}
          </>
        )}
      </ScrollView>

      {/* Notification settings — per-type on/off switches, saved to the
          account so they apply on every device (push, web push AND inbox). */}
      <Modal visible={settingsOpen} transparent animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setSettingsOpen(false)}>
          {/* Taps on the sheet itself shouldn't dismiss it */}
          <Pressable onPress={(e) => e.stopPropagation?.()} style={{ width: '100%' }}>
            <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 10) + 8 }]}>
              <View style={styles.sheetHandle} />
              <View style={styles.sheetHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sheetTitle}>Notification settings</Text>
                  <Text style={styles.sheetSubtitle}>Choose which types of notifications you receive.</Text>
                </View>
                <TouchableOpacity
                  onPress={() => setSettingsOpen(false)}
                  style={styles.sheetCloseBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  testID="inbox-settings-close"
                >
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.sheetList} bounces={false} showsVerticalScrollIndicator>
                {prefsQ.isLoading ? (
                  <View style={{ paddingVertical: 8 }}>
                    {[0, 1, 2, 3].map((i) => (
                      <View key={i} style={styles.prefRow}>
                        <View style={{ flex: 1 }}>
                          <Skeleton width={'45%' as const} height={14} />
                          <View style={{ height: 6 }} />
                          <Skeleton height={10} />
                        </View>
                      </View>
                    ))}
                  </View>
                ) : prefsQ.isError ? (
                  <TouchableOpacity style={styles.prefRetry} onPress={() => prefsQ.refetch()}>
                    <Text style={styles.prefRetryText}>Couldn't load settings — tap to retry</Text>
                  </TouchableOpacity>
                ) : (
                  prefCategories.map((c) => (
                    <View key={c.key} style={styles.prefRow} testID={`pref-row-${c.key}`}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.prefLabel}>{c.label}</Text>
                        <Text style={styles.prefDesc}>{c.description}</Text>
                      </View>
                      <Switch
                        value={c.enabled}
                        onValueChange={(next) => togglePref(c.key, next)}
                        trackColor={{ false: '#91B69E', true: colors.primary }}
                        thumbColor="#fff"
                        testID={`pref-switch-${c.key}`}
                      />
                    </View>
                  ))
                )}
              </ScrollView>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontFamily: fonts.display, fontSize: 17, fontWeight: '900', color: colors.text },
  subtitle: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  markAllBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.primary + '18' },
  markAllText: { fontSize: 12.5, fontWeight: '800', color: colors.primary },

  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 4,
    backgroundColor: colors.background, borderRadius: 14, padding: 14, marginBottom: 10,
    shadowColor: colors.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1,
  },
  dotCol: { width: 14, paddingTop: 5, alignItems: 'flex-start' },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { flex: 1, fontSize: 13.5, fontWeight: '600', color: colors.textSecondary },
  rowTitleUnread: { fontWeight: '800', color: colors.text },
  rowWhen: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },
  rowBody: { fontSize: 12.5, color: colors.textMuted, lineHeight: 17, marginTop: 3 },
  chip: { alignSelf: 'flex-start', backgroundColor: colors.primary + '15', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, marginTop: 7 },
  chipText: { fontSize: 9.5, fontWeight: '800', color: colors.primary, letterSpacing: 0.4, textTransform: 'uppercase' },

  moreBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 14, marginTop: 2 },
  moreBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },

  // Settings sheet — mirrors the ChoiceSheet bottom-sheet look.
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    maxHeight: '82%', paddingHorizontal: 16, paddingTop: 8, overflow: 'hidden',
  },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, backgroundColor: colors.borderDark, alignSelf: 'center', marginBottom: 10 },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6, paddingRight: 4 },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  sheetSubtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  sheetCloseBtn: { padding: 4 },
  sheetList: { maxHeight: 460, flexShrink: 1 },
  prefRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 13, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  prefLabel: { fontSize: 15, fontWeight: '600', color: colors.text },
  prefDesc: { fontSize: 11.5, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  prefRetry: { padding: 20, alignItems: 'center' },
  prefRetryText: { fontSize: 13, fontWeight: '700', color: colors.primary },
});
