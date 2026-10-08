/**
 * Team Planners — admin/leader roster view with a Weekly | Monthly switcher.
 *
 * Weekly (default — it's the plan checked most often): every leader in
 * scope with a clear submitted / not-started state for the week currently
 * being planned, plus THAT planner's last-edited date. Tap → their weekly
 * plan (which has its own week-to-week scroller).
 *
 * Monthly: the classic MGP roster (latest month per person). Tap → their
 * Monthly Goal Planner.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../src/theme/colors';
import { lightColors } from '../src/theme/ThemeContext';
import { useColors } from '../src/theme/ThemeContext';
import { apiService } from '../src/api/client';
import { useKeyboardInset } from '../src/hooks/useKeyboardInset';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { roleTitle } from '../src/utils/roleTitle';
import { APP_LOCALE } from '../src/utils/appTime';

function prettyMonth(m?: string | null): string {
  if (!m) return '—';
  const [y, mm] = m.split('-').map(Number);
  return new Date(y, mm - 1, 1).toLocaleString(APP_LOCALE, { month: 'short', year: 'numeric' });
}
function prettyDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' });
}
function shortWE(iso?: string | null): string {
  if (!iso) return '';
  const [y, m, dd] = String(iso).split('-').map(Number);
  if (!y) return '';
  return new Date(y, m - 1, dd).toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' });
}
// The week currently being planned (Mon–Sat → upcoming Sunday; Sunday → next week).
function planningSunday(): string {
  const d = new Date();
  const offset = (7 - d.getDay()) % 7;
  d.setDate(d.getDate() + (offset === 0 ? 7 : offset));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addWeeksISO(iso: string, n: number): string {
  const [y, m, dd] = iso.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  d.setDate(d.getDate() + n * 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// "This week" / "Next week" / "2 weeks ago" relative to the week we're IN.
function weekRelative(week: string): { label: string; tone: 'now' | 'future' | 'past' } {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  const cur = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const [y2, m2, d2] = week.split('-').map(Number);
  const diff = Math.round((new Date(y2, m2 - 1, d2).getTime() - cur) / (7 * 24 * 3600 * 1000));
  if (diff === 0) return { label: 'This week', tone: 'now' };
  if (diff === 1) return { label: 'Next week', tone: 'future' };
  if (diff === -1) return { label: 'Last week', tone: 'past' };
  return diff > 0 ? { label: `In ${diff} weeks`, tone: 'future' } : { label: `${-diff} weeks ago`, tone: 'past' };
}

export default function TeamPlannersScreen() {
  const colors = useColors();
  const s = useMemo(() => createS(colors), [colors]);

  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const kbInset = useKeyboardInset();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'weekly' | 'monthly'>('weekly');
  const [week, setWeek] = useState<string>(planningSunday());

  const monthlyQ = useQuery({
    queryKey: ['monthly-planner-roster'],
    queryFn: () => apiService.monthlyPlannerTeamRoster().then((r) => r.data?.items || []),
    enabled: mode === 'monthly',
  });
  const weeklyQ = useQuery({
    queryKey: ['weekly-planner-roster', week],
    queryFn: () => apiService.weeklyPlannerTeamRoster(week).then((r) => r.data),
    enabled: mode === 'weekly',
  });

  const activeQ = mode === 'weekly' ? weeklyQ : monthlyQ;
  const { pullIndicator } = usePullToRefresh(() => activeQ.refetch());
  const items: any[] = mode === 'weekly' ? (weeklyQ.data?.items || []) : (monthlyQ.data || []);

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const needle = search.trim().toLowerCase();
    return items.filter((u: any) => (u.name || '').toLowerCase().includes(needle));
  }, [items, search]);

  const weekLabel = shortWE(weeklyQ.data?.week_ending || week);
  const submitted = mode === 'weekly' ? items.filter((u: any) => u.has_planner).length : 0;
  const rel = weekRelative(week);
  const onPlanningWeek = week === planningSunday();

  return (
    <View style={{ flex: 1, paddingTop: insets.top * 0 }}>
      {pullIndicator}
      <Stack.Screen options={{ title: 'Team Planners' }} />
      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 80 + tabBarClearance + kbInset }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={activeQ.isFetching} onRefresh={() => activeQ.refetch()} tintColor={colors.primary} />}
      >
        <Text style={s.title}>Team Planners</Text>
        <Text style={s.subtitle}>
          {mode === 'weekly'
            ? `Weekly plans · WE ${weekLabel || '…'}${items.length ? ` — ${submitted}/${items.length} submitted` : ''}`
            : 'Monthly Goal Planners — tap a person to open theirs'}
        </Text>

        {/* Weekly | Monthly switcher */}
        <View style={s.modeRow}>
          <TouchableOpacity
            style={[s.modeBtn, mode === 'weekly' && s.modeBtnActive]}
            onPress={() => setMode('weekly')}
            testID="team-planners-weekly"
          >
            <Ionicons name="calendar-number-outline" size={13} color={mode === 'weekly' ? colors.onPrimary : colors.textMuted} />
            <Text style={[s.modeText, mode === 'weekly' && s.modeTextActive]}>Weekly</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.modeBtn, mode === 'monthly' && s.modeBtnActive]}
            onPress={() => setMode('monthly')}
            testID="team-planners-monthly"
          >
            <Ionicons name="bar-chart-outline" size={13} color={mode === 'monthly' ? colors.onPrimary : colors.textMuted} />
            <Text style={[s.modeText, mode === 'monthly' && s.modeTextActive]}>Monthly</Text>
          </TouchableOpacity>
        </View>

        {/* Week scroller (weekly mode) — browse any past/future week's roster */}
        {mode === 'weekly' && (
          <View style={s.weekRow}>
            <TouchableOpacity style={s.weekArrow} onPress={() => setWeek((w) => addWeeksISO(w, -1))} testID="team-planners-prev-week">
              <Ionicons name="chevron-back" size={18} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={s.weekCenter} onPress={() => setWeek(planningSunday())} disabled={onPlanningWeek}>
              <Text style={s.weekTitle}>WE {weekLabel}</Text>
              <Text style={[s.weekRel, rel.tone === 'now' && { color: '#16a34a' }, rel.tone === 'past' && { color: colors.textMuted }]}>
                {rel.label}{onPlanningWeek ? '' : ' · tap to jump back'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.weekArrow} onPress={() => setWeek((w) => addWeeksISO(w, 1))} testID="team-planners-next-week">
              <Ionicons name="chevron-forward" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>
        )}

        <View style={s.searchBar}>
          <Ionicons name="search" size={16} color={colors.textMuted} />
          <TextInput
            style={s.searchInput}
            placeholder="Search by name…"
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch('')}><Ionicons name="close-circle" size={16} color={colors.textMuted} /></TouchableOpacity>
          )}
        </View>

        {filtered.length === 0 ? (
          <View style={s.empty}>
            <Ionicons name="people-outline" size={32} color={colors.textMuted} />
            <Text style={s.emptyText}>{activeQ.isFetching ? 'Loading…' : 'No team members found.'}</Text>
          </View>
        ) : mode === 'weekly' ? (
          filtered.map((u: any) => (
            <TouchableOpacity
              key={u.id}
              style={s.row}
              onPress={() => router.push(`/weekly-planner?user_id=${u.id}&week=${weeklyQ.data?.week_ending || week}`)}
            >
              <View style={[s.statusDot, { backgroundColor: u.has_planner ? '#dcfce7' : u.steps_done > 0 ? '#fef3c7' : colors.surfaceAlt }]}>
                <Ionicons
                  name={u.has_planner ? 'checkmark' : u.steps_done > 0 ? 'ellipsis-horizontal' : 'time-outline'}
                  size={16}
                  color={u.has_planner ? '#16a34a' : u.steps_done > 0 ? '#b45309' : colors.textMuted}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.rowName}>{u.name}</Text>
                <Text style={s.rowMeta}>
                  {u.role === 'admin' ? 'Admin · ' : ''}
                  {u.has_planner
                    ? `Filled in · last edited ${prettyDate(u.updated_at)}`
                    : u.steps_done > 0
                    ? `${u.steps_done}/${u.steps_total || 5} parts filled · ${prettyDate(u.updated_at)}`
                    : 'Not started yet'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          ))
        ) : (
          filtered.map((u: any) => (
            <TouchableOpacity
              key={u.id}
              style={s.row}
              onPress={() => router.push(`/monthly-planner?user_id=${u.id}${u.latest_month ? `&month=${u.latest_month}` : ''}`)}
            >
              <View style={[s.avatar, { backgroundColor: u.role === 'leader' ? '#fef3c7' : '#dcfce7' }]}>
                <Text style={[s.avatarText, { color: u.role === 'leader' ? '#92400e' : '#166534' }]}>
                  {(u.name || '?').slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.rowName}>{u.name}</Text>
                <Text style={s.rowMeta}>
                  {roleTitle(u)} · Latest: {prettyMonth(u.latest_month)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const createS = (colors: any) => StyleSheet.create({
  title: { fontSize: 22, fontWeight: '900', color: colors.text },
  subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: 12 },
  modeRow: { flexDirection: 'row', gap: 4, padding: 4, backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginBottom: 12 },
  modeBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8, borderRadius: 8 },
  modeBtnActive: { backgroundColor: colors.primary },
  modeText: { fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.4, textTransform: 'uppercase' },
  modeTextActive: { color: colors.onPrimary },
  weekRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginBottom: 12 },
  weekArrow: { paddingHorizontal: 16, paddingVertical: 10 },
  weekCenter: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  weekTitle: { fontSize: 14, fontWeight: '900', color: colors.text },
  weekRel: { fontSize: 10, fontWeight: '700', color: colors.primary, marginTop: 1, textTransform: 'uppercase', letterSpacing: 0.4 },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 14 },
  searchInput: { flex: 1, fontSize: 14, color: colors.text },
  empty: { alignItems: 'center', padding: 40, gap: 10 },
  emptyText: { color: colors.textMuted, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, marginBottom: 8, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 14, fontWeight: '900' },
  statusDot: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  rowName: { fontSize: 14, fontWeight: '700', color: colors.text },
  rowMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const s = createS(lightColors);
