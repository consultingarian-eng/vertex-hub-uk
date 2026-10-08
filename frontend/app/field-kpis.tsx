/**
 * Field KPIs — mirrors the client's OwnerIQ / DataByte field numbers inside
 * CG1 (doors, spoken-to, pitches, sales, points), synced hourly from
 * OwnerIQ (every office) + a manual Force-refresh.
 *
 * Controls: preset date chips + custom range + office bubbles (All + each
 * OwnerIQ company, super-admins only). Scope is role-driven by the backend:
 *   trainee → self · leader → team + self · admin → office · super → all
 *
 * Shows, for the chosen day/range/office:
 *   • group totals            • average per rep / day
 *   • reverse "ratios to one sale"  (to land 1 sale you need X doors, …)
 *   • per-rep table with exclude-from-average toggles; 0-data BAs (off that
 *     day) are auto-dropped from the average.
 */
import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { officeFromPin, useOwnerIqCompanies } from '../src/utils/liveOps';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Modal, Pressable, TextInput, Platform,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../src/api/client';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { useAuth } from '../src/auth/AuthContext';
import DateField from '../src/components/ui/DateField';
import { toast } from '../src/utils/toast';
import { haptics } from '../src/utils/haptics';
import { useKeyboardInset, dismissKeyboardIfOpen } from '../src/hooks/useKeyboardInset';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { PillTabs, Kicker } from '../src/components/ui/PillTabs';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { APP_LOCALE } from '../src/utils/appTime';

// ── date helpers (local calendar day) ──────────────────────────────────────
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoToday = () => ymd(new Date());
const isoDaysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
const firstOfMonth = () => { const d = new Date(); d.setDate(1); return ymd(d); };

// ── week-ending (Sunday) helpers — mirrors the Quality tab ──────────────────
const addDaysISO = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const toSundayISO = (iso: string) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
};
const thisSundayISO = () => toSundayISO(isoToday());
const fmtSunday = (iso: string) =>
  iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString(APP_LOCALE, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
// Last N week-ending Sundays, most recent first.
const recentSundays = (n: number) => {
  const out: string[] = [];
  let s = thisSundayISO();
  for (let i = 0; i < n; i++) { out.push(s); s = addDaysISO(s, -7); }
  return out;
};

// Unlike the Quality sheet (updated next morning), Field IQ is live intraday —
// so Today is first and the default.
const PRESETS = [
  { key: 'today', label: 'Today', from: isoToday, to: isoToday },
  { key: 'yesterday', label: 'Yesterday', from: () => isoDaysAgo(1), to: () => isoDaysAgo(1) },
  { key: '7d', label: 'Last 7d', from: () => isoDaysAgo(6), to: isoToday },
  { key: '30d', label: 'Last 30d', from: () => isoDaysAgo(29), to: isoToday },
  { key: 'mtd', label: 'MTD', from: firstOfMonth, to: isoToday },
];


const METRICS = [
  { key: 'doors_knocked', label: 'Doors knocked', short: 'Doors', icon: 'walk' as const, color: '#8caf38' },
  // The owner's Field IQ names: Doors / Spoken / Presented / Closed / Sign-ups.
  { key: 'spoken_to', label: 'Spoken', short: 'Spoken', icon: 'chatbubble-ellipses' as const, color: '#06b6d4' },
  { key: 'pitches_commenced', label: 'Presented', short: 'Presented', icon: 'megaphone' as const, color: '#f59e0b' },
  { key: 'pitches_closed', label: 'Closed', short: 'Closed', icon: 'checkmark-done' as const, color: '#22c55e' },
  { key: 'sales', label: 'Sign-ups', short: 'Sign-ups', icon: 'cart' as const, color: '#ec4899' },
];
const RATIOS = [
  { key: 'doors_knocked', label: 'doors knocked' },
  { key: 'spoken_to', label: 'spoken' },
  { key: 'pitches_commenced', label: 'presented' },
  { key: 'pitches_closed', label: 'closed' },
];
// Per-BA table columns, in the field scheme order (Pitched → "Closed").
const ROW_METRICS = [
  // The owner's Field IQ names ("Pres." — the per-rep column is ~45px wide).
  { key: 'doors_knocked', h: 'Doors' },
  { key: 'spoken_to', h: 'Spoken' },
  { key: 'pitches_commenced', h: 'Pres.' },
  { key: 'pitches_closed', h: 'Closed' },
  { key: 'sales', h: 'Sign-ups' },
];

const fmt = (n: any) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(APP_LOCALE));
const fmt1 = (n: any) => (n === null || n === undefined ? '—' : Number(n).toFixed(n >= 100 ? 0 : 1));
const hexToRgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};

// In-memory tab state — survives navigating away and back (the screen unmounts
// on tab switch), and resets only when the app is force-closed (module reload).
let saved: {
  preset: string; from: string; to: string; office: string; weekEnding: string;
  search: string; avgOpen: boolean; ratioOpen: boolean; excluded: string[]; repFilter: string[];
} | null = null;

export default function FieldKpisScreen() {
  const colors = useColors();
  const tabBarClearance = useTabBarClearance();
  const kbInset = useKeyboardInset();
  const wide = useWindowDimensions().width >= 1100;
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useAuth();
  const qc = useQueryClient();

  const role = user?.role;
  const isAdmin = role === 'admin';
  const isSuper = !!user?.is_super_admin;   // only super-admins span offices
  const canManage = role === 'admin' || role === 'leader';
  const scopeLabel = isAdmin || !!user?.coach_plus ? 'Your office' : role === 'leader' ? 'Your team' : 'Your figures';

  // Restore the last in-session view (survives leaving/re-entering the tab).
  const [preset, setPreset] = useState(() => saved?.preset ?? 'today');
  const [from, setFrom] = useState(() => saved?.from ?? isoToday());
  const [to, setTo] = useState(() => saved?.to ?? isoToday());
  const [office, setOffice] = useState(() => saved?.office ?? '');   // '' = all, else an OwnerIQ company pin
  // Office bubbles come from the deployment's OwnerIQ companies. `key` can't
  // be '' (the liquid indicator keys on it), so 'all' stands in for the empty
  // pin and is mapped back on change.
  const companies = useOwnerIqCompanies();
  const OFFICE_SEGMENTS: { key: string; label: string }[] = useMemo(
    () => [{ key: 'all', label: 'All offices' }, ...companies.map((c) => ({ key: c.pin, label: c.name }))],
    [companies],
  );
  const OFFICE_NAME = (pin?: string | null) => officeFromPin(pin, companies) || (pin || '—');
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(saved?.excluded ?? []));
  const [weekEnding, setWeekEnding] = useState(() => saved?.weekEnding ?? thisSundayISO());
  const [weekPickerOpen, setWeekPickerOpen] = useState(false);
  const [search, setSearch] = useState(() => saved?.search ?? '');
  const [avgOpen, setAvgOpen] = useState(() => saved?.avgOpen ?? true);
  const [ratioOpen, setRatioOpen] = useState(() => saved?.ratioOpen ?? true);
  const [repFilter, setRepFilter] = useState<Set<string>>(() => new Set(saved?.repFilter ?? []));
  const [filterOpen, setFilterOpen] = useState(false);

  // Persist to the module store on any change (cleared on app force-close).
  useEffect(() => {
    saved = { preset, from, to, office, weekEnding, search, avgOpen, ratioOpen,
      excluded: Array.from(excluded), repFilter: Array.from(repFilter) };
  }, [preset, from, to, office, weekEnding, search, avgOpen, ratioOpen, excluded, repFilter]);

  const applyPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    setPreset(key);
    setFrom(p.from());
    setTo(p.to());
  };

  // Week ending on `sun` (Sunday) → the field week Mon..Sat.
  const applyWeek = (sun: string) => {
    setPreset('week');
    setWeekEnding(sun);
    setFrom(addDaysISO(sun, -6));
    setTo(addDaysISO(sun, -1));
  };
  const stepWeek = (delta: -1 | 1) => {
    const next = addDaysISO(weekEnding, delta * 7);
    if (delta > 0 && next > thisSundayISO()) return;   // don't go past this week
    applyWeek(next);
  };

  const excludeParam = useMemo(() => Array.from(excluded).join(','), [excluded]);
  const singleDay = from === to;
  // Office filter is a super-admin-only control. Never apply it for anyone else
  // (e.g. previewing as a leader) even if a value persisted from a prior view.
  const activeOffice = isSuper ? office : '';

  const summaryQ = useQuery({
    queryKey: ['owneriq-summary', from, to, activeOffice, excludeParam],
    queryFn: async () => {
      // include_zero stays false — 0-data BAs never count toward the average.
      const { data } = await api.get('/owneriq/summary', {
        params: {
          from_date: from, to_date: to,
          mc_pin: activeOffice || undefined,
          exclude: excludeParam || undefined,
        },
      });
      return data;
    },
  });

  const statusQ = useQuery({
    queryKey: ['owneriq-status'],
    queryFn: async () => (await api.get('/owneriq/status')).data,
    refetchInterval: 60_000,
  });

  const syncM = useMutation({
    // Admin-only on the server, at most 14 days per run (SYNC_MAX_DAYS): pull
    // the last 14 days of the range; older days come from the scheduled sync.
    mutationFn: async () => {
      if (!isAdmin) return null;
      const syncFrom = from > addDaysISO(to, -13) ? from : addDaysISO(to, -13);
      return (await api.post('/owneriq/sync', { from_date: syncFrom, to_date: to })).data;
    },
    onSuccess: () => {
      // Silent — the fresh numbers appearing is feedback enough.
      qc.invalidateQueries({ queryKey: ['owneriq-summary'] });
      qc.invalidateQueries({ queryKey: ['owneriq-status'] });
    },
    onError: (e: any) => {
      qc.invalidateQueries({ queryKey: ['owneriq-summary'] });
      // 429 = a sync ran moments ago; the refetch is all that's needed.
      if (e?.response?.status === 429) return;
      toast.error('Sync failed', e?.response?.data?.detail || undefined);
    },
  });

  // Tap the eye to include/exclude a rep from the average. (0-data reps are
  // always excluded automatically and can't be toggled.)
  const toggleExclude = useCallback((key: string) => {
    haptics.medium?.();
    setExcluded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }, []);

  // Pull-to-refresh = a live sync from OwnerIQ for admins (others just
  // refetch), then the summary refetches via the mutation's invalidation.
  const onRefresh = useCallback(() => { syncM.mutate(); }, [syncM]);

  // Web pull-to-refresh (react-native-web's RefreshControl is a no-op).
  const { pullIndicator } = usePullToRefresh(onRefresh);

  // Feeds the global page scroll phase (masthead condense, card sheens).
  const { onScroll } = useParallaxScroll();

  const data = summaryQ.data;
  const reps: any[] = data?.reps || [];

  // When reps are selected via the filter, the whole view (hero/totals/average/
  // ratios + table) recomputes for just that selection — mirroring the Quality
  // tab. With no selection, use the server's office/team aggregates as-is.
  const RK = ['doors_knocked', 'spoken_to', 'pitches_commenced', 'pitches_closed', 'sales'];
  const view = useMemo(() => {
    const hasFilter = repFilter.size > 0;
    const selected = hasFilter ? reps.filter((r) => repFilter.has(r.key)) : reps;
    const sorted = [...selected].sort((a, b) =>
      (b.totals?.sales || 0) - (a.totals?.sales || 0) || (b.totals?.doors_knocked || 0) - (a.totals?.doors_knocked || 0));
    if (!hasFilter) {
      return {
        reps: sorted,
        totals: data?.group_totals || {},
        avgDay: data?.avg_per_rep_day || {},
        ratios: data?.ratios_to_one_sale || {},
        includedCount: data?.included_count || 0,
        excludedCount: data?.excluded_count || 0,
      };
    }
    const incl = selected.filter((r) => !r.zero && !r.excluded);   // same rules as server
    const totals: any = {}; RK.forEach((k) => (totals[k] = incl.reduce((s, r) => s + (r.totals?.[k] || 0), 0)));
    const days = incl.reduce((s, r) => s + (r.active_days || 0), 0);
    const avgDay: any = {}; RK.forEach((k) => (avgDay[k] = days ? +(totals[k] / days).toFixed(2) : 0));
    const ratios: any = {};
    ['doors_knocked', 'spoken_to', 'pitches_commenced', 'pitches_closed'].forEach(
      (k) => (ratios[k] = totals.sales ? +(totals[k] / totals.sales).toFixed(2) : null));
    return { reps: sorted, totals, avgDay, ratios, includedCount: incl.length, excludedCount: selected.length - incl.length };
  }, [data, reps, repFilter]);

  const shownReps = view.reps;
  const totals = view.totals;
  const avgDay = view.avgDay;
  const ratios = view.ratios;

  const lastSync = statusQ.data?.synced_at
    ? new Date(statusQ.data.synced_at).toLocaleString(APP_LOCALE, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;

  return (
    <View style={{ flex: 1 }}>
      {pullIndicator}
      <Stack.Screen options={{ title: 'Field KPIs', headerTitleStyle: { fontFamily: fonts.display, color: colors.text } }} />
      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: 32 + tabBarClearance }}
        refreshControl={
          <RefreshControl
            refreshing={syncM.isPending || summaryQ.isFetching}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            title="Syncing live from Field IQ…"
            titleColor={colors.textMuted}
          />
        }
      >
        <View style={styles.shell}>
        {/* The range: quick picks, or any two dates. A custom range selects
            none of the quick picks, which is why these are plain chips. */}
        <View style={styles.controls}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.presetScroll} contentContainerStyle={styles.presets}>
            {PRESETS.map((p) => (
              <TouchableOpacity key={p.key} onPress={() => applyPreset(p.key)} style={[styles.presetChip, preset === p.key && styles.presetChipActive]}
                accessibilityRole="button" accessibilityState={{ selected: preset === p.key }}>
                <Text style={[styles.presetText, preset === p.key && styles.presetTextActive]}>{p.label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => applyWeek(thisSundayISO())} style={[styles.presetChip, preset === 'week' && styles.presetChipActive]}
              accessibilityRole="button" accessibilityState={{ selected: preset === 'week' }}>
              <Text style={[styles.presetText, preset === 'week' && styles.presetTextActive]}>Week</Text>
            </TouchableOpacity>
          </ScrollView>
          <View style={styles.dateRow}>
            <View style={styles.dateBox}>
              <Text style={styles.dateLabel}>From</Text>
              <DateField value={from} onChange={(v) => { setFrom(v); setPreset('custom'); }} maxDate={to || undefined} />
            </View>
            <View style={styles.dateBox}>
              <Text style={styles.dateLabel}>To</Text>
              <DateField value={to} onChange={(v) => { setTo(v); setPreset('custom'); }} minDate={from || undefined} maxDate={isoToday()} />
            </View>
          </View>
        </View>

        {/* week-ending stepper (mirrors Quality) */}
        {preset === 'week' && (
          <View style={styles.weekRow}>
            <TouchableOpacity onPress={() => stepWeek(-1)} style={styles.weekChev} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }} accessibilityLabel="Week before">
              <Ionicons name="chevron-back" size={16} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setWeekPickerOpen(true)} style={styles.weekPill}>
              <Ionicons name="calendar-outline" size={13} color={colors.primary} />
              <Text style={styles.weekPillTxt}>Week ending {fmtSunday(weekEnding)}</Text>
              <Ionicons name="chevron-down" size={12} color={colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => stepWeek(1)}
              disabled={weekEnding >= thisSundayISO()}
              style={[styles.weekChev, weekEnding >= thisSundayISO() && { opacity: 0.3 }]}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              accessibilityLabel="Week after"
            >
              <Ionicons name="chevron-forward" size={16} color={colors.text} />
            </TouchableOpacity>
          </View>
        )}

        {/* office bubbles — only super-admins span offices; office admins are
            auto-scoped to their own office, leaders/trainees to their tree. */}
        {isSuper && companies.length > 1 && (
          <PillTabs
            style={styles.officeRow}
            items={OFFICE_SEGMENTS.map((o) => ({ key: o.key, label: o.label }))}
            value={office || 'all'}
            onChange={(k) => setOffice(k === 'all' ? '' : k)}
          />
        )}

        {/* Whose numbers these are, who is in them, and how fresh they are. */}
        <View style={styles.metaRow}>
          <View style={styles.scopePill}>
            <Ionicons name="speedometer-outline" size={13} color={colors.primary} />
            <Text style={styles.scopeText}>{scopeLabel}</Text>
          </View>
          {reps.length > 0 && (
            <TouchableOpacity style={[styles.filterBtn, repFilter.size > 0 && styles.filterBtnOn]} onPress={() => setFilterOpen(true)}>
              <Ionicons name={repFilter.size > 0 ? 'funnel' : 'funnel-outline'} size={13} color={repFilter.size > 0 ? colors.onPrimary : colors.text} />
              <Text style={[styles.filterBtnTxt, repFilter.size > 0 && { color: colors.onPrimary }]}>
                {repFilter.size > 0 ? `${repFilter.size} selected` : 'Filter people'}
              </Text>
            </TouchableOpacity>
          )}
          {repFilter.size > 0 && (
            <TouchableOpacity onPress={() => setRepFilter(new Set())} style={styles.filterClear}>
              <Text style={styles.filterClearTxt}>Clear</Text>
            </TouchableOpacity>
          )}
          <View style={{ flex: 1 }} />
          {lastSync ? <Text style={styles.syncText}>Synced {lastSync}</Text> : null}
          {/* Pull-to-refresh works on native, but react-native-web's ScrollView
              doesn't fire the pull gesture, so this button does it everywhere. */}
          <TouchableOpacity onPress={onRefresh} disabled={syncM.isPending} activeOpacity={0.6} style={styles.filterBtn}
            accessibilityLabel="Sync live from Field IQ">
            {syncM.isPending ? <ActivityIndicator size="small" color={colors.textMuted} /> : <Ionicons name="sync-outline" size={13} color={colors.text} />}
            <Text style={styles.filterBtnTxt}>{syncM.isPending ? 'Syncing…' : 'Sync now'}</Text>
          </TouchableOpacity>
        </View>

        <View>
          {summaryQ.isLoading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : summaryQ.isError ? (
            <Text style={styles.errTxt}>Couldn’t load KPIs. Pull to retry.</Text>
          ) : reps.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="cloud-offline-outline" size={26} color={colors.textMuted} />
              <Text style={styles.emptyTxt}>
                No field data for {OFFICE_NAME(activeOffice) === '—' ? 'this selection' : OFFICE_NAME(activeOffice)}, {singleDay ? 'this day' : 'this range'}.
              </Text>
            </View>
          ) : (
            <>
              {/* Totals: the headline sign-ups, then every step of the day. */}
              <Kicker style={styles.sectionHead} count={`${view.includedCount} in the field`}>Totals</Kicker>
              <View style={styles.grid}>
                {/* Sign-ups lead; the steps that got there follow in order. */}
                {[...METRICS.filter((m) => m.key === 'sales'), ...METRICS.filter((m) => m.key !== 'sales')].map((m) => {
                  const lead = m.key === 'sales';
                  return (
                    <View key={m.key} style={[styles.tile, lead && styles.tileLead]}>
                      <View style={styles.tileHead}>
                        <Ionicons name={m.icon} size={14} color={lead ? colors.onPrimary : colors.primary} />
                        <Text style={[styles.tileLbl, lead && { color: colors.onPrimary }]} numberOfLines={1}>{m.label}</Text>
                      </View>
                      <Text style={[styles.tileNum, lead && { color: colors.onPrimary }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{fmt(totals[m.key])}</Text>
                    </View>
                  );
                })}
              </View>

              <View style={[styles.pair, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
                {/* Average per BA per day (collapsible) */}
                <View style={wide ? { flex: 1.3, minWidth: 0 } : undefined}>
                  <TouchableOpacity style={styles.collHead} activeOpacity={0.7} onPress={() => setAvgOpen((v) => !v)}>
                    <Kicker style={styles.collTitle}>Average per BA per day</Kicker>
                    <Ionicons name={avgOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                  {avgOpen && (
                    <>
                      <View style={styles.avgCard}>
                        {METRICS.map((m, i) => (
                          <View key={m.key} style={[styles.avgItem, i < METRICS.length - 1 && styles.avgDivider]}>
                            <Text style={styles.avgNum} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{fmt1(avgDay[m.key])}</Text>
                            <Text style={styles.avgLbl} numberOfLines={1}>{m.short}</Text>
                          </View>
                        ))}
                      </View>
                      <Text style={styles.helpTxt}>
                        Across {view.includedCount} active {view.includedCount === 1 ? 'BA' : 'BAs'}
                        {view.excludedCount ? ` · ${view.excludedCount} left out` : ''}.
                      </Text>
                    </>
                  )}
                </View>

                {/* What it takes to land 1 sign-up (collapsible) */}
                <View style={wide ? { flex: 1, minWidth: 0 } : undefined}>
                  <TouchableOpacity style={styles.collHead} activeOpacity={0.7} onPress={() => setRatioOpen((v) => !v)}>
                    <Kicker style={styles.collTitle}>What it takes to land 1 sign-up</Kicker>
                    <Ionicons name={ratioOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                  {ratioOpen && (
                    <View style={styles.avgCard}>
                      {totals.sales ? RATIOS.map((r, i) => (
                        <View key={r.key} style={[styles.avgItem, i < RATIOS.length - 1 && styles.avgDivider]}>
                          <Text style={styles.avgNum} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{fmt1(ratios[r.key])}</Text>
                          <Text style={styles.avgLbl} numberOfLines={2}>{r.label}</Text>
                        </View>
                      )) : <Text style={[styles.helpTxt, { marginTop: 0, paddingHorizontal: 14 }]}>No sign-ups in this {singleDay ? 'day' : 'range'}, so no ratio yet.</Text>}
                    </View>
                  )}
                </View>
              </View>

              {/* per-BA table — the full funnel per person, in scheme order */}
              <View style={styles.collHead}>
                <Kicker style={styles.collTitle} count={repFilter.size > 0 ? `${repFilter.size} selected` : shownReps.length}>Per BA</Kicker>
                <TouchableOpacity onPress={() => setFilterOpen(true)} style={styles.perBaFilter}>
                  <Ionicons name={repFilter.size > 0 ? 'funnel' : 'funnel-outline'} size={14} color={colors.primary} />
                  <Text style={styles.perBaFilterTxt}>Filter</Text>
                </TouchableOpacity>
              </View>
              {canManage && (
                <Text style={styles.tableHint}>Tap the eye to leave someone out of the average, or put them back.</Text>
              )}
              <View style={styles.tableCard}>
              <View style={styles.tableHead}>
                <Text style={[styles.thRep]}>BA</Text>
                {ROW_METRICS.map((m) => (
                  <Text key={m.key} style={styles.thCell}>{m.h}</Text>
                ))}
              </View>
              {shownReps.length === 0 && (
                <Text style={[styles.helpTxt, { padding: 14, marginTop: 0 }]}>Nobody selected has data for this {singleDay ? 'day' : 'range'}.</Text>
              )}
              {shownReps.map((rep, i) => {
                const off = rep.excluded;
                return (
                  <View
                    key={rep.key}
                    style={[styles.trRow, i === shownReps.length - 1 && { borderBottomWidth: 0 }, off && styles.repRowOff]}
                  >
                    <View style={styles.trRepCell}>
                      {canManage && (
                        <TouchableOpacity
                          onPress={rep.zero ? undefined : () => toggleExclude(rep.key)}
                          disabled={rep.zero}
                          hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                          style={{ marginRight: 8, padding: 2 }}
                          accessibilityRole="button"
                          accessibilityLabel={`${off ? 'Show' : 'Hide'} ${rep.rep_name || 'this BA'} in the average`}
                        >
                          <Ionicons name={off ? 'eye-off-outline' : 'eye-outline'} size={17}
                            color={off ? colors.textMuted : colors.primary} />
                        </TouchableOpacity>
                      )}
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[styles.repName, off && styles.repDim]} numberOfLines={2}>
                          {rep.rep_name || rep.badge_number || 'Unknown'}
                        </Text>
                        <Text style={styles.repMeta} numberOfLines={1}>
                          {rep.badge_number || 'no badge'} · {OFFICE_NAME(rep.mc_pin)}
                          {rep.zero ? ' · off' : ''}{!rep.cg1_user_id ? ' · unlinked' : ''}
                        </Text>
                      </View>
                    </View>
                    {ROW_METRICS.map((m) => (
                      <Text
                        key={m.key}
                        style={[styles.tdCell, m.key === 'sales' && styles.tdSales, off && styles.repDim]}
                      >
                        {fmt(rep.totals?.[m.key])}
                      </Text>
                    ))}
                  </View>
                );
              })}
              </View>
            </>
          )}
        </View>
        </View>
      </ScrollView>

      {/* week-ending scroll picker */}
      <Modal visible={weekPickerOpen} transparent animationType="fade" onRequestClose={() => setWeekPickerOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setWeekPickerOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation?.()}>
            <Text style={styles.sheetTitle}>Pick a week ending</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {recentSundays(16).map((s) => {
                const on = s === weekEnding && preset === 'week';
                return (
                  <TouchableOpacity key={s} onPress={() => { applyWeek(s); setWeekPickerOpen(false); }} style={[styles.sheetRow, on && styles.sheetRowOn]}>
                    <Text style={[styles.sheetTxt, on && styles.sheetTxtOn]}>Week ending {fmtSunday(s)}</Text>
                    {on && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* rep multi-select filter */}
      <Modal visible={filterOpen} transparent animationType="slide" onRequestClose={() => setFilterOpen(false)}>
        {/* First backdrop tap only closes the keyboard (keeps the typed search) */}
        <Pressable style={styles.backdrop} onPress={() => { if (!dismissKeyboardIfOpen(kbInset)) setFilterOpen(false); }}>
          <Pressable style={[styles.sheet, { maxHeight: '82%', paddingBottom: 32 + kbInset }]} onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.filterHead}>
              <Text style={styles.sheetTitle}>Filter reps</Text>
              <View style={{ flexDirection: 'row', gap: 14 }}>
                <TouchableOpacity onPress={() => setRepFilter(new Set(reps.map((r) => r.key)))}>
                  <Text style={styles.filterAction}>Select all</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setRepFilter(new Set())}>
                  <Text style={[styles.filterAction, { color: colors.textMuted }]}>Clear</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={styles.searchBox}>
              <Ionicons name="search" size={15} color={colors.textMuted} />
              <TextInput style={styles.searchInput} value={search} onChangeText={setSearch}
                placeholder="Search name or badge…" placeholderTextColor={colors.textMuted}
                autoCapitalize="none" autoCorrect={false} />
              {search ? (
                <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              ) : null}
            </View>
            <ScrollView style={{ marginTop: 8 }} keyboardShouldPersistTaps="handled">
              {reps
                .filter((r) => {
                  const q = search.trim().toLowerCase();
                  return !q || (r.rep_name || '').toLowerCase().includes(q) || (r.badge_number || '').toLowerCase().includes(q);
                })
                .map((r) => {
                  const on = repFilter.has(r.key);
                  return (
                    <TouchableOpacity key={r.key} style={styles.pickRow} onPress={() =>
                      setRepFilter((s) => { const n = new Set(s); on ? n.delete(r.key) : n.add(r.key); return n; })}>
                      <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? colors.primary : colors.textMuted} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.pickName} numberOfLines={1}>{r.rep_name || r.badge_number || 'Unknown'}</Text>
                        <Text style={styles.pickSub}>{r.badge_number || 'no badge'} · {fmt(r.totals?.sales)} sign-ups</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
            </ScrollView>
            <TouchableOpacity style={styles.doneBtn} onPress={() => setFilterOpen(false)}>
              <Text style={styles.doneTxt}>{repFilter.size > 0 ? `Show ${repFilter.size} selected` : 'Done'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  shell: { width: '100%', maxWidth: 1240, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 14 },
  controls: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  presetScroll: { flexGrow: 0, flexShrink: 1 },
  presets: { gap: 6, alignItems: 'center' },
  presetChip: { minHeight: 34, paddingHorizontal: 13, borderRadius: 17, justifyContent: 'center', borderWidth: 1, borderColor: c.border, backgroundColor: c.background },
  presetChipActive: { backgroundColor: c.primary, borderColor: c.primary },
  presetText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: c.textSecondary },
  presetTextActive: { color: c.onPrimary },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  scopePill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, paddingHorizontal: 11, borderRadius: 10, backgroundColor: c.surfaceAlt },
  scopeText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: c.text },
  syncText: { fontFamily: fonts.mono, fontSize: 10.5, color: c.textMuted },

  weekRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10, alignSelf: 'flex-start' },
  weekChev: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, backgroundColor: c.background },
  weekPill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 34, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.background },
  weekPillTxt: { fontFamily: fonts.bodySemibold, fontSize: 13, color: c.text },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, paddingBottom: 32 },
  sheetTitle: { fontFamily: fonts.display, fontSize: 16, color: c.text, marginBottom: 10 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.border },
  sheetRowOn: {},
  sheetTxt: { fontFamily: fonts.bodyMedium, fontSize: 14, color: c.textSecondary },
  sheetTxtOn: { fontFamily: fonts.bodyBold, color: c.primary },

  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 4 },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: c.text, padding: 0 },

  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 11, backgroundColor: c.background },
  filterBtnOn: { backgroundColor: c.primary, borderColor: c.primary },
  filterBtnTxt: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: c.text },
  filterClear: { paddingVertical: 6, paddingHorizontal: 4 },
  filterClearTxt: { fontFamily: fonts.bodySemibold, fontSize: 12, color: c.textMuted },
  perBaFilter: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  perBaFilterTxt: { fontFamily: fonts.bodySemibold, fontSize: 12, color: c.primary },

  filterHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  filterAction: { fontFamily: fonts.bodyBold, fontSize: 12.5, color: c.primary },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: c.border },
  pickName: { fontFamily: fonts.bodySemibold, fontSize: 14, color: c.text },
  pickSub: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, marginTop: 1 },
  doneBtn: { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 12 },
  doneTxt: { fontFamily: fonts.bodyBold, fontSize: 14, color: c.onPrimary },

  dateRow: { flexDirection: 'row', gap: 8 },
  dateBox: { width: 158 },
  dateLabel: { fontFamily: fonts.mono, fontSize: 9.5, color: c.textMuted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 3 },

  officeRow: { marginBottom: 10 },

  sectionHead: { marginTop: 18, marginBottom: 10 },
  collTitle: { flex: 1, marginBottom: 0 },
  collHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 32, marginTop: 18, marginBottom: 8 },
  pair: { columnGap: 14 },

  // Totals: six slim tiles; the sign-ups tile is the one filled in.
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { flexGrow: 1, flexBasis: 150, minWidth: 104, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.background },
  tileLead: { backgroundColor: c.primary, borderColor: c.primary },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tileLbl: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 11.5, color: c.textMuted },
  tileNum: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30, letterSpacing: -0.6, color: c.text, marginTop: 4, fontVariant: ['tabular-nums'] as any },

  avgCard: { flexDirection: 'row', alignItems: 'center', minHeight: 72, borderRadius: 14, paddingVertical: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.background },
  avgItem: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  avgDivider: { borderRightWidth: 1, borderRightColor: c.border },
  avgNum: { fontFamily: fonts.display, fontSize: 19, lineHeight: 24, letterSpacing: -0.4, color: c.text, textAlign: 'center', fontVariant: ['tabular-nums'] as any },
  avgLbl: { fontFamily: fonts.body, fontSize: 10.5, color: c.textMuted, marginTop: 3, textAlign: 'center' },

  repRowOff: { opacity: 0.5 },
  repName: { fontFamily: fonts.bodySemibold, fontSize: 13, color: c.text },
  repMeta: { fontFamily: fonts.body, fontSize: 10, color: c.textMuted, marginTop: 1 },
  repDim: { color: c.textMuted },

  // per-BA table
  tableCard: { borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.background, overflow: 'hidden' },
  tableHint: { fontFamily: fonts.body, fontSize: 11.5, color: c.textMuted, marginTop: -2, marginBottom: 8 },
  tableHead: { flexDirection: 'row', alignItems: 'center', minHeight: 34, paddingHorizontal: 12, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
  thRep: { flex: 2.2, fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: c.textMuted },
  thCell: { flex: 1, fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 0.6, textTransform: 'uppercase', color: c.textMuted, textAlign: 'center' },
  trRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingVertical: 6, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  trRepCell: { flex: 2.2, flexDirection: 'row', alignItems: 'center', paddingRight: 6, minWidth: 0 },
  tdCell: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: c.textSecondary, textAlign: 'center', fontVariant: ['tabular-nums'] as any },
  tdSales: { fontFamily: fonts.bodyBold, color: c.text },

  helpTxt: { fontFamily: fonts.body, fontSize: 11.5, color: c.textMuted, marginTop: 8 },
  errTxt: { fontFamily: fonts.body, fontSize: 13, color: c.textSecondary, textAlign: 'center', marginTop: 40 },
  empty: { alignItems: 'center', marginTop: 16, paddingVertical: 32, paddingHorizontal: 24, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.background, gap: 10 },
  emptyTxt: { fontFamily: fonts.body, fontSize: 13.5, color: c.textSecondary, textAlign: 'center' },
});
