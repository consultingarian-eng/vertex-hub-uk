/**
 * Live Operations — OwnerIQ's Live Operations, in the app. Three screens that
 * read the same OwnerIQ data and are laid out the way OwnerIQ has them:
 *
 *   LiveOverview  the day's six figures (Sales, Piece Average, Scoring, BAs in
 *                 the field, Reliability, Scoring BAs) and a card per sector:
 *                 postcodes, Sector Lead, Brand Ambassadors, sales, first and
 *                 last door.
 *   LiveSector    one sector: the door activity strip with averages and a row
 *                 per BA (first/last knock, doors, spoken, pitches, sales,
 *                 points).
 *   LiveBa        one BA: their figures and their laps, door by door, grouped
 *                 by street.
 *
 * What a person sees is scoped on the server (admins their office, Coaches
 * their teams, BAs their own sector). Today refreshes every minute; a past
 * day is whatever OwnerIQ recorded. Dark forest green in both themes.
 */
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Image, ScrollView, ActivityIndicator, LayoutChangeEvent, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { fonts } from '../../theme/ThemeContext';
import { api } from '../../api/client';
import { APP_LOCALE, APP_TZ } from '../../utils/appTime';
import { addDays, todayISO } from '../../utils/calendarDates';
import { useTabBarClearance } from '../../customization/CustomTabBar';

const L = {
  canvas: '#07170f',
  panel: '#0d2419',
  tile: '#102d25',
  raised: '#163a2d',
  line: 'rgba(183,223,88,0.14)',
  lineSoft: 'rgba(238,244,230,0.07)',
  text: '#eef4e6',
  muted: '#9fb8a8',
  faint: 'rgba(159,184,168,0.55)',
  lime: '#b7df58',
  onLime: '#102d25',
  green: '#34d399',
  red: '#f87171',
  redText: '#fca5a5',
  amber: '#e7b65c',
};
type Icon = React.ComponentProps<typeof Ionicons>['name'];

const METRICS: { key: string; label: string; icon: Icon }[] = [
  { key: 'doors_knocked', label: 'Doors Knocked', icon: 'home-outline' },
  { key: 'spoken_to', label: 'Spoken to', icon: 'chatbubble-ellipses-outline' },
  { key: 'pitches_commenced', label: 'Pitch Commenced', icon: 'play-circle-outline' },
  { key: 'pitches_closed', label: 'Pitch Closed', icon: 'checkmark-circle-outline' },
  { key: 'sales', label: 'Sales', icon: 'flag-outline' },
  { key: 'points', label: 'Points', icon: 'podium-outline' },
];

const num = (n: any) => (n === null || n === undefined || n === '' ? '–' : Math.round(Number(n)).toLocaleString('en-GB'));
function clock(iso?: string | null): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString(APP_LOCALE, { timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}
function took(ms: any): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const s = Math.round(n / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
const initials = (n?: string | null) => (n || '?').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
const stageShort = (s?: string | null) => { const m = /^stage_(\d+)(_plus)?$/.exec(s || ''); return m ? `${m[1]}${m[2] ? '+' : ''}` : null; };
function dayLabel(iso: string, today: string): string {
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(APP_LOCALE, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function errText(q: any): string {
  const detail = String(q.error?.response?.data?.detail || '');
  // A copy of the app with no OwnerIQ login (the local preview) says so plainly.
  if (/not configured/i.test(detail)) return "OwnerIQ isn't connected on this copy of the app, so only days already saved can be shown.";
  if (q.error?.response?.status === 403) return detail || "That isn't in your teams.";
  return 'OwnerIQ could not be reached. Try again in a moment.';
}

// ── Shared pieces ───────────────────────────────────────────────────────────
function Shell({ children, onRefresh, busy }: { children: React.ReactNode; onRefresh: () => void; busy: boolean }) {
  const pad = useTabBarClearance();
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: pad + 24 }} showsVerticalScrollIndicator={Platform.OS === 'web'}>
      <View style={s.shell}>{children}</View>
      <Pressable onPress={onRefresh} style={s.refresh} accessibilityLabel="Refresh from OwnerIQ" testID="live-refresh">
        {busy ? <ActivityIndicator size="small" color={L.lime} /> : <Ionicons name="refresh" size={14} color={L.muted} />}
        <Text style={s.refreshText}>Refresh from OwnerIQ</Text>
      </Pressable>
    </ScrollView>
  );
}

function DateBar({ date, onChange, left }: { date: string; onChange: (d: string) => void; left?: React.ReactNode }) {
  const today = todayISO();
  return (
    <View style={s.bar}>
      {left}
      <View style={{ flex: 1 }} />
      <Pressable onPress={() => onChange(addDays(date, -1))} style={s.navBtn} accessibilityLabel="Day before" hitSlop={6}>
        <Ionicons name="chevron-back" size={16} color={L.text} />
      </Pressable>
      <View style={s.datePill}>
        <Ionicons name="calendar-outline" size={13} color={L.lime} />
        <Text style={s.dateText}>{dayLabel(date, today)}</Text>
      </View>
      <Pressable onPress={() => date < today && onChange(addDays(date, 1))} disabled={date >= today}
        style={[s.navBtn, date >= today && { opacity: 0.3 }]} accessibilityLabel="Day after" hitSlop={6}>
        <Ionicons name="chevron-forward" size={16} color={L.text} />
      </Pressable>
      {date !== today && (
        <Pressable onPress={() => onChange(today)} style={s.todayBtn}><Text style={s.todayText}>Today</Text></Pressable>
      )}
    </View>
  );
}

function Section({ icon, text }: { icon: Icon; text: string }) {
  return (
    <View style={s.section}>
      <Ionicons name={icon} size={12} color={L.muted} />
      <Text style={s.sectionText} numberOfLines={1}>{text}</Text>
    </View>
  );
}

function Avatar({ p, size = 34, ring }: { p?: any; size?: number; ring?: boolean }) {
  const st = stageShort(p?.stage);
  return (
    <View style={{ width: size, height: size }}>
      {p?.avatar_url ? (
        <Image source={{ uri: p.avatar_url }} style={{ width: size, height: size, borderRadius: size / 2, borderWidth: ring ? 1.5 : 0, borderColor: L.lime }} />
      ) : (
        <View style={[s.avatarFallback, { width: size, height: size, borderRadius: size / 2 }, ring && { borderWidth: 1.5, borderColor: L.lime }]}>
          <Text style={[s.avatarText, { fontSize: size * 0.36 }]}>{initials(p?.full_name)}</Text>
        </View>
      )}
      {st ? <View style={s.stageDot}><Text style={s.stageDotText}>{st}</Text></View> : null}
    </View>
  );
}

/** First Knock … Points, with an Average row when there is one. */
function Strip({ first, last, totals, averages, wide }: { first?: string | null; last?: string | null; totals?: any; averages?: any; wide: boolean }) {
  const cells = [
    { label: 'First Knock', icon: 'hand-left-outline' as Icon, value: clock(first), avg: null as string | null },
    { label: 'Last Knock', icon: 'hand-right-outline' as Icon, value: clock(last), avg: null },
    ...METRICS.map((m) => ({ label: m.label, icon: m.icon, value: num(totals?.[m.key]), avg: averages ? num(averages[m.key]) : null })),
  ];
  const body = (
    <View style={[s.strip, !wide && { minWidth: 760 }]}>
      <View style={s.stripRow}>
        {cells.map((c) => (
          <View key={c.label} style={s.stripCell}>
            <Ionicons name={c.icon} size={15} color={L.lime} />
            <Text style={s.stripLabel} numberOfLines={1}>{c.label}</Text>
            <Text style={s.stripValue}>{c.value}</Text>
          </View>
        ))}
      </View>
      {averages ? (
        <View style={[s.stripRow, s.stripAvg]}>
          {cells.map((c, i) => (
            <View key={c.label} style={s.stripCell}>
              <Text style={i === 0 ? s.stripAvgLabel : s.stripAvgValue}>{i === 0 ? 'Average' : c.avg ?? ''}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
  return wide ? body : <ScrollView horizontal showsHorizontalScrollIndicator={false}>{body}</ScrollView>;
}

function useLive<T = any>(key: any[], url: string, date: string, enabled = true) {
  const force = useRef(false);
  const q = useQuery({
    enabled,
    queryKey: [...key, date],
    queryFn: async () => {
      const f = force.current; force.current = false;
      return (await api.get(url, { params: { date, ...(f ? { refresh: 1 } : {}) } })).data as T;
    },
    refetchInterval: date === todayISO() ? 60_000 : false,
    retry: false,
  });
  return { q, refresh: () => { force.current = true; q.refetch(); } };
}

// ════════════════════════════════════════════════════════════════════════════
// All sectors
// ════════════════════════════════════════════════════════════════════════════
export function LiveOverview() {
  const [date, setDate] = useState(todayISO());
  const [w, setW] = useState(0);
  const { q, refresh } = useLive(['live-ops'], '/owneriq/live', date);
  const d: any = q.data;
  const sectors: any[] = d?.sectors || [];
  const k = d?.kpis;
  const sum = d?.summary || {};
  const tiles: { label: string; icon: Icon; value: string }[] = [
    { label: 'Sales', icon: 'flag-outline', value: num(k ? k.sales : sum.sales) },
    { label: 'Piece Average', icon: 'trending-up-outline',
      value: k ? (k.piece_average == null ? '–' : Number(k.piece_average).toFixed(1)) : sum.bas_in_field ? (sum.sales / sum.bas_in_field).toFixed(1) : '–' },
    { label: 'Scoring', icon: 'flame-outline', value: k?.scoring_percentage == null ? '–' : `${Math.round(k.scoring_percentage)}%` },
    { label: 'BAs in the field', icon: 'person-outline', value: num(k ? k.bas_in_field : sum.bas_in_field) },
    { label: 'Reliability', icon: 'shield-checkmark-outline', value: k?.reliability == null ? '–' : `${Math.round(k.reliability)}%` },
    { label: 'Scoring BAs', icon: 'flame-outline', value: num(k?.scoring_bas) },
  ];
  const gap = 12;
  const kCols = w >= 760 ? 3 : w >= 420 ? 2 : 1;
  const sCols = w >= 1100 ? 4 : w >= 800 ? 3 : w >= 520 ? 2 : 1;
  const width = (cols: number) => (w ? (w - gap * (cols - 1)) / cols : 0);

  return (
    <Shell onRefresh={refresh} busy={q.isFetching}>
      <DateBar date={date} onChange={setDate} left={<Text style={s.heading}>Live Operations</Text>} />
      <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
        <Section icon="grid-outline" text="Overall performance" />
        <View style={[s.grid, { gap }]}>
          {tiles.map((t) => (
            <View key={t.label} style={[s.kpi, { width: width(kCols) }]}>
              <Ionicons name={t.icon} size={16} color={L.lime} />
              <Text style={s.kpiLabel} numberOfLines={1}>{t.label}</Text>
              <Text style={s.kpiValue}>{q.isLoading ? '…' : t.value}</Text>
            </View>
          ))}
        </View>

        <View style={{ height: 18 }} />
        <Section icon="apps-outline" text="All sectors" />
        {q.isLoading ? (
          <View style={s.centre}><ActivityIndicator color={L.lime} /><Text style={s.note}>Loading from OwnerIQ…</Text></View>
        ) : q.isError ? (
          <View style={s.centre}><Ionicons name="cloud-offline-outline" size={30} color={L.muted} /><Text style={s.note}>{errText(q)}</Text></View>
        ) : sectors.length === 0 ? (
          <View style={s.centre}><Ionicons name="location-outline" size={32} color={L.muted} /><Text style={s.note}>Sectors haven't been established yet.</Text></View>
        ) : (
          <View style={[s.grid, { gap }]}>
            {sectors.map((sec) => <SectorCard key={sec.id} sec={sec} width={width(sCols)} date={date} />)}
          </View>
        )}
      </View>
    </Shell>
  );
}

function SectorCard({ sec, width, date }: { sec: any; width: number; date: string }) {
  const members: any[] = sec.members || [];
  const count = members.length + (sec.extra_member_count || 0);
  return (
    <Pressable onPress={() => router.push(`/live-sector?id=${sec.id}&date=${date}` as never)}
      style={(st: any) => [s.card, { width }, st.hovered && s.cardHover]} testID={`live-sector-${sec.id}`}>
      <View style={s.cardTop}>
        <Text style={s.campaign} numberOfLines={1}>{sec.campaign_name || 'Campaign'}</Text>
        <Ionicons name="radio-outline" size={15} color={sec.live ? L.green : L.faint} />
      </View>
      <View style={s.chips}>
        {(sec.postcodes || []).map((p: any) => (
          <View key={p.label} style={[s.chip, p.has_interactions && s.chipOn]}>
            <Text style={[s.chipText, p.has_interactions && { color: L.green }]}>{p.label}</Text>
          </View>
        ))}
      </View>
      <Text style={s.cardName} numberOfLines={2}>{sec.name || 'Sector'}</Text>
      {sec.leader ? (
        <>
          <Text style={s.caption}>Sector Lead</Text>
          <View style={s.lead}><Avatar p={sec.leader} size={32} ring /><Text style={s.leadName} numberOfLines={1}>{sec.leader.full_name}</Text></View>
        </>
      ) : null}
      <Text style={s.caption}>Brand Ambassadors ({count})</Text>
      <View style={s.memberRow}>
        {members.slice(0, 3).map((m, i) => <View key={String(m.id)} style={{ marginLeft: i ? -8 : 0 }}><Avatar p={{ ...m, stage: null }} size={24} /></View>)}
        {count > 3 ? <Text style={s.more}>+{count - 3}</Text> : null}
      </View>
      <View style={{ flex: 1, minHeight: 14 }} />
      <Text style={s.sales}>{num(sec.total_sales ?? 0)}<Text style={s.salesUnit}> Sales</Text></Text>
      <View style={s.knocks}>
        <Knock icon="hand-left-outline" label="Knocked on first door" at={sec.first_knock_at} />
        <Knock icon="hand-right-outline" label="Knocked on last door" at={sec.last_knock_at} />
      </View>
    </Pressable>
  );
}

function Knock({ icon, label, at }: { icon: Icon; label: string; at?: string | null }) {
  return (
    <View style={s.knock}>
      <Ionicons name={icon} size={13} color={L.muted} />
      <Text style={s.knockLabel} numberOfLines={1}>{label}</Text>
      <View style={s.knockRule} />
      <View style={s.timePill}><Ionicons name="time-outline" size={11} color={L.onLime} /><Text style={s.timeText}>{clock(at)}</Text></View>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// One sector
// ════════════════════════════════════════════════════════════════════════════
const BA_COLS: { key: string; icon: Icon; time?: boolean }[] = [
  { key: 'first_knock_at', icon: 'hand-left-outline', time: true },
  { key: 'last_knock_at', icon: 'hand-right-outline', time: true },
  ...METRICS.map((m) => ({ key: m.key, icon: m.icon })),
];
const SORTS: { key: string; label: string }[] = [
  { key: 'points', label: 'Points' }, { key: 'sales', label: 'Sales' }, { key: 'doors_knocked', label: 'Doors' }, { key: 'full_name', label: 'Name' },
];

export function LiveSector({ id, initialDate }: { id: string; initialDate?: string }) {
  const [date, setDate] = useState(initialDate || todayISO());
  const [sort, setSort] = useState(0);
  const [w, setW] = useState(0);
  const { q, refresh } = useLive(['live-sector', id], `/owneriq/live/sector/${id}`, date, !!id);
  const all = useLive(['live-ops'], '/owneriq/live', date);
  const d: any = q.data;
  const sec = d?.sector || {};
  const pills: any[] = all.q.data?.sectors || [];
  const members = useMemo(() => {
    const rows = [...(d?.members || [])];
    const k = SORTS[sort].key;
    rows.sort((a, b) => (k === 'full_name' ? String(a.full_name).localeCompare(String(b.full_name)) : (b[k] ?? 0) - (a[k] ?? 0)));
    return rows;
  }, [d?.members, sort]);
  const wide = w >= 820;

  return (
    <Shell onRefresh={() => { refresh(); all.refresh(); }} busy={q.isFetching}>
      <DateBar date={date} onChange={setDate} left={
        <Pressable onPress={() => router.replace('/live-ops' as never)} style={s.backPill} testID="live-all-sectors">
          <Ionicons name="arrow-back" size={13} color={L.onLime} /><Text style={s.backPillText}>All sectors</Text>
        </Pressable>
      } />
      {pills.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 6 }}>
          {pills.map((p) => (
            <Pressable key={p.id} onPress={() => router.replace(`/live-sector?id=${p.id}&date=${date}` as never)} style={[s.pill, String(p.id) === String(id) && s.pillOn]}>
              <Ionicons name="radio-outline" size={12} color={p.live ? L.green : L.faint} />
              <Text style={[s.pillText, String(p.id) === String(id) && { color: L.text }]} numberOfLines={1}>{p.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
        {q.isLoading ? (
          <View style={s.centre}><ActivityIndicator color={L.lime} /><Text style={s.note}>Loading from OwnerIQ…</Text></View>
        ) : q.isError ? (
          <View style={s.centre}><Ionicons name="cloud-offline-outline" size={30} color={L.muted} /><Text style={s.note}>{errText(q)}</Text></View>
        ) : (
          <>
            <Text style={s.title} numberOfLines={2}>{sec.name || 'Sector'}</Text>
            {sec.campaign_name ? <Text style={[s.campaign, { marginBottom: 12 }]}>{sec.campaign_name}</Text> : null}
            <Section icon="grid-outline" text="Overall performance" />
            <Strip first={sec.first_knock_at} last={sec.last_knock_at} totals={d?.hero} averages={d?.hero_averages} wide={w >= 760} />

            <View style={s.listBar}>
              <Section icon="people-outline" text="Brand Ambassadors" />
              <View style={{ flex: 1 }} />
              <Pressable onPress={() => setSort((v) => (v + 1) % SORTS.length)} style={s.sortBtn} testID="live-sort">
                <Ionicons name="swap-vertical" size={13} color={L.text} />
                <Text style={s.sortText}>Sort by: {SORTS[sort].label}</Text>
              </Pressable>
            </View>
            <View style={s.table}>
              {members.length === 0 ? <Text style={[s.note, { padding: 18 }]}>Nobody in this sector yet.</Text> : null}
              {members.map((m) => (
                <Pressable key={String(m.id)} onPress={() => router.push(`/live-ba?id=${m.id}&date=${date}&sector=${id}` as never)}
                  style={(st: any) => [s.tr, !wide && { flexDirection: 'column', alignItems: 'stretch', gap: 10 }, st.hovered && { backgroundColor: 'rgba(238,244,230,0.04)' }]}
                  testID={`live-ba-${m.id}`}>
                  <View style={[s.person, wide && { flex: 1 }]}>
                    <Avatar p={m} size={38} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.personName} numberOfLines={1}>{m.full_name}</Text>
                      <View style={s.tags}>
                        {m.is_leader ? <View style={s.leadTag}><Text style={s.leadTagText}>Sector Leader</Text></View> : null}
                        {m.shared ? <View style={s.sharedTag}><Text style={s.sharedTagText}>Shared</Text></View> : null}
                      </View>
                    </View>
                  </View>
                  <View style={[s.cells, wide && { width: 8 * 66 }]}>
                    {BA_COLS.map((c) => (
                      <View key={c.key} style={s.cell}>
                        <Ionicons name={c.icon} size={13} color={L.muted} />
                        <Text style={s.cellValue} numberOfLines={1}>{c.time ? clock(m[c.key]) : num(m[c.key])}</Text>
                      </View>
                    ))}
                  </View>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </View>
    </Shell>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// One BA
// ════════════════════════════════════════════════════════════════════════════
function doorMeta(i: any): { icon: Icon; colour: string; label: string } {
  const st = String(i.state || '').toLowerCase();
  const stage = i.lost_state ? String(i.lost_state).replace(/_/g, ' ').replace(/^\w/, (c: string) => c.toUpperCase()) : '';
  if (st.includes('sale') || st.includes('sold') || st === 'won') return { icon: 'checkmark-circle', colour: L.green, label: 'Sale' };
  if (st === 'lost') return { icon: 'close', colour: L.redText, label: stage };
  if (st === 'swing_by_later' || st === 'swing_by') return { icon: 'return-down-back', colour: L.amber, label: stage };
  if (i.not_knocked) return { icon: 'remove', colour: L.faint, label: 'Not knocked' };
  return { icon: 'ellipse-outline', colour: L.faint, label: stage };
}
const doorNo = (i: any) => [i.house_number, i.address_suffix].filter(Boolean).join(' ') || i.house_name || (i.apt_number ? `Flat ${i.apt_number}` : '–');

export function LiveBa({ id, initialDate, sectorId }: { id: string; initialDate?: string; sectorId?: string }) {
  const [date, setDate] = useState(initialDate || todayISO());
  const [lap, setLap] = useState(0);
  const [w, setW] = useState(0);
  const { q, refresh } = useLive(['live-ba', id], `/owneriq/live/ba/${id}`, date, !!id);
  const d: any = q.data;
  const ba = d?.ba || {};
  const hero = d?.hero || {};
  const secId = String(d?.sector?.id ?? sectorId ?? '');
  const secQ = useLive(['live-sector', secId], `/owneriq/live/sector/${secId}`, date, !!secId);
  const mates: any[] = secQ.q.data?.members || [];
  const laps: any[] = d?.laps || [];
  const shown = laps[Math.min(lap, Math.max(0, laps.length - 1))];
  const head = [
    { label: 'First Knock', icon: 'hand-left-outline' as Icon, value: clock(hero.first_knock_at) },
    { label: 'Last Knock', icon: 'hand-right-outline' as Icon, value: clock(hero.last_knock_at) },
    ...METRICS.map((m) => ({ label: m.label, icon: m.icon, value: num(hero[m.key]) })),
  ];
  const wide = w >= 820;

  return (
    <Shell onRefresh={refresh} busy={q.isFetching}>
      <DateBar date={date} onChange={(v) => { setDate(v); setLap(0); }} left={
        <Pressable onPress={() => (secId ? router.replace(`/live-sector?id=${secId}&date=${date}` as never) : router.replace('/live-ops' as never))} style={s.backPill} testID="live-back-sector">
          <Ionicons name="arrow-back" size={13} color={L.onLime} />
          <Text style={s.backPillText} numberOfLines={1}>{d?.sector?.name ? String(d.sector.name).slice(0, 22) : 'Sector'}</Text>
        </Pressable>
      } />
      {mates.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 6 }}>
          {mates.map((m) => (
            <Pressable key={m.id} onPress={() => router.replace(`/live-ba?id=${m.id}&date=${date}&sector=${secId}` as never)} style={[s.pill, String(m.id) === String(id) && s.pillOn]}>
              <Text style={[s.pillText, String(m.id) === String(id) && { color: L.text }]} numberOfLines={1}>{m.full_name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
        {q.isLoading ? (
          <View style={s.centre}><ActivityIndicator color={L.lime} /><Text style={s.note}>Loading from OwnerIQ…</Text></View>
        ) : q.isError ? (
          <View style={s.centre}><Ionicons name="cloud-offline-outline" size={30} color={L.muted} /><Text style={s.note}>{errText(q)}</Text></View>
        ) : (
          <>
            <View style={[s.baHead, !wide && { flexDirection: 'column', alignItems: 'stretch' }]}>
              <View style={[s.person, wide && { width: 250 }]}>
                <Avatar p={ba} size={46} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.baName} numberOfLines={1}>{ba.full_name || 'BA'}</Text>
                  <View style={s.roleTag}><Ionicons name="person-outline" size={10} color={L.text} /><Text style={s.roleTagText}>{ba.role_name || 'Brand Ambassador'}</Text></View>
                </View>
              </View>
              <View style={[s.headCells, !wide && { flexWrap: 'wrap' }]}>
                {head.map((c) => (
                  <View key={c.label} style={[s.headCell, !wide && { flexBasis: '25%', flexGrow: 0, marginTop: 12 }]}>
                    <Ionicons name={c.icon} size={14} color={L.lime} />
                    <Text style={s.headLabel} numberOfLines={2}>{c.label}</Text>
                    <Text style={s.headValue}>{c.value}</Text>
                  </View>
                ))}
              </View>
            </View>

            {laps.length === 0 ? (
              <View style={s.centre}><Ionicons name="walk-outline" size={30} color={L.muted} /><Text style={s.note}>No doors logged this day.</Text></View>
            ) : (
              <>
                <View style={s.lapTabs}>
                  {laps.map((l, i) => (
                    <Pressable key={l.number ?? i} onPress={() => setLap(i)} style={[s.lapTab, shown === l && s.lapTabOn]} testID={`live-lap-${i}`}>
                      <Text style={[s.lapText, shown === l && { color: L.text }]}>Lap {l.number ?? i + 1}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={s.table}>
                  {(shown?.interactions_by_address || []).map((a: any, ai: number) => (
                    <View key={`${a.street_name}-${ai}`}>
                      <View style={s.street}>
                        <Text style={s.streetName} numberOfLines={1}>{a.street_name || 'Street'}</Text>
                        <Text style={s.streetMeta} numberOfLines={1}>{[a.postal_code, a.city].filter(Boolean).join(' · ')}</Text>
                      </View>
                      {(a.interactions || []).map((it: any) => {
                        const m = doorMeta(it);
                        return (
                          <View key={String(it.id)} style={s.door}>
                            <Ionicons name={m.icon} size={14} color={m.colour} style={{ width: 20 }} />
                            <Text style={s.doorNo}>{doorNo(it)}</Text>
                            <Text style={[s.doorLabel, { color: m.colour }]} numberOfLines={1}>{m.label}</Text>
                            <Text style={s.doorTime}>{clock(it.created_at)}</Text>
                            <Text style={s.doorTook}>{took(it.duration)}</Text>
                          </View>
                        );
                      })}
                    </View>
                  ))}
                </View>
              </>
            )}
          </>
        )}
      </View>
    </Shell>
  );
}

const s = StyleSheet.create({
  shell: { backgroundColor: L.canvas, borderRadius: 20, padding: 14, borderWidth: 1, borderColor: L.line },
  refresh: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', marginTop: 12, paddingHorizontal: 12, minHeight: 34 },
  refreshText: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 0.6, color: '#6b8070' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' },
  heading: { fontFamily: fonts.displayWide, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase', color: L.text },
  navBtn: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: L.tile, borderWidth: 1, borderColor: L.lineSoft },
  datePill: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingHorizontal: 12, borderRadius: 10, backgroundColor: L.tile, borderWidth: 1, borderColor: L.line, minWidth: 116, justifyContent: 'center' },
  dateText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: L.text },
  todayBtn: { height: 34, paddingHorizontal: 12, borderRadius: 10, justifyContent: 'center', borderWidth: 1, borderColor: L.lineSoft },
  todayText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: L.muted },
  backPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, minHeight: 34, borderRadius: 999, backgroundColor: L.lime, maxWidth: 230 },
  backPillText: { fontFamily: fonts.bodyBold, fontSize: 12.5, color: L.onLime },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, minHeight: 34, borderRadius: 999, borderWidth: 1, borderColor: L.lineSoft, maxWidth: 200 },
  pillOn: { backgroundColor: L.raised, borderColor: L.lime },
  pillText: { fontFamily: fonts.bodySemibold, fontSize: 12, color: L.muted },
  section: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  sectionText: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.4, textTransform: 'uppercase', color: L.muted },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  centre: { alignItems: 'center', gap: 10, paddingVertical: 56 },
  note: { fontFamily: fonts.body, fontSize: 12.5, color: L.muted, textAlign: 'center' },
  title: { fontFamily: fonts.display, fontSize: 24, color: L.text, marginBottom: 2 },

  kpi: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 58, paddingHorizontal: 16, borderRadius: 14, backgroundColor: L.tile, borderWidth: 1, borderColor: L.line },
  kpiLabel: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13.5, color: L.text },
  kpiValue: { fontFamily: fonts.display, fontSize: 18, color: L.text, fontVariant: ['tabular-nums'] as any },

  card: { backgroundColor: L.tile, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(52,211,153,0.28)', padding: 18, minHeight: 400 },
  cardHover: { borderColor: L.lime, boxShadow: '0 0 0 1px rgba(183,223,88,0.35), 0 12px 30px rgba(0,0,0,0.35)' } as any,
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  campaign: { flex: 1, fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1, textTransform: 'uppercase', color: L.muted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12, minHeight: 26 },
  chip: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(238,244,230,0.06)', borderWidth: 1, borderColor: 'transparent' },
  chipOn: { backgroundColor: 'rgba(52,211,153,0.08)', borderColor: 'rgba(52,211,153,0.6)' },
  chipText: { fontFamily: fonts.bodySemibold, fontSize: 11, color: L.muted },
  cardName: { fontFamily: fonts.display, fontSize: 23, lineHeight: 28, color: L.text, marginTop: 14 },
  caption: { fontFamily: fonts.body, fontSize: 11.5, color: L.muted, marginTop: 14, marginBottom: 7 },
  lead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  leadName: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 14.5, color: L.text },
  memberRow: { flexDirection: 'row', alignItems: 'center', minHeight: 26 },
  more: { fontFamily: fonts.mono, fontSize: 11, color: L.muted, marginLeft: 7 },
  sales: { fontFamily: fonts.display, fontSize: 38, letterSpacing: -1.2, color: L.text },
  salesUnit: { fontFamily: fonts.body, fontSize: 13, letterSpacing: 0, color: L.muted },
  knocks: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: L.lineSoft, gap: 8 },
  knock: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  knockLabel: { fontFamily: fonts.body, fontSize: 12, color: L.muted, flexShrink: 1 },
  knockRule: { flex: 1, height: 1, backgroundColor: L.lineSoft, minWidth: 8 },
  timePill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: L.text },
  timeText: { fontFamily: fonts.bodyBold, fontSize: 11.5, color: L.onLime, fontVariant: ['tabular-nums'] as any },

  avatarFallback: { backgroundColor: L.raised, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bodyBold, color: L.text },
  stageDot: { position: 'absolute', right: -4, bottom: -3, minWidth: 16, height: 15, paddingHorizontal: 3, borderRadius: 8, backgroundColor: L.canvas, borderWidth: 1, borderColor: L.lime, alignItems: 'center', justifyContent: 'center' },
  stageDotText: { fontFamily: fonts.bodyBold, fontSize: 8.5, color: L.text },

  strip: { borderRadius: 14, borderWidth: 1, borderColor: L.line, overflow: 'hidden', backgroundColor: L.tile },
  stripRow: { flexDirection: 'row' },
  stripCell: { flex: 1, alignItems: 'center', paddingVertical: 11, paddingHorizontal: 4, gap: 3, minWidth: 0 },
  stripLabel: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: L.text },
  stripValue: { fontFamily: fonts.mono, fontSize: 12.5, color: L.muted },
  stripAvg: { backgroundColor: L.raised, borderTopWidth: 1, borderTopColor: L.line },
  stripAvgLabel: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: L.text },
  stripAvgValue: { fontFamily: fonts.bodyBold, fontSize: 15, color: L.text, fontVariant: ['tabular-nums'] as any },

  listBar: { flexDirection: 'row', alignItems: 'center', marginTop: 18, marginBottom: 2 },
  sortBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, minHeight: 34, borderRadius: 10, borderWidth: 1, borderColor: L.lineSoft, backgroundColor: L.tile, marginBottom: 10 },
  sortText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: L.text },
  table: { borderRadius: 14, borderWidth: 1, borderColor: L.line, backgroundColor: L.panel, overflow: 'hidden' },
  tr: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: L.lineSoft },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  personName: { fontFamily: fonts.bodySemibold, fontSize: 14, color: L.text },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  leadTag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: L.text },
  leadTagText: { fontFamily: fonts.bodySemibold, fontSize: 9.5, color: L.onLime },
  sharedTag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(238,244,230,0.1)' },
  sharedTagText: { fontFamily: fonts.bodySemibold, fontSize: 9.5, color: L.text },
  cells: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', gap: 4, minWidth: 0 },
  cellValue: { fontFamily: fonts.bodyBold, fontSize: 13.5, color: L.text, fontVariant: ['tabular-nums'] as any },

  baHead: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 16, backgroundColor: L.tile, borderWidth: 1, borderColor: L.line },
  baName: { fontFamily: fonts.display, fontSize: 17, color: L.text },
  roleTag: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginTop: 5, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1, borderColor: L.lineSoft },
  roleTagText: { fontFamily: fonts.bodySemibold, fontSize: 10, color: L.text },
  headCells: { flex: 1, flexDirection: 'row' },
  headCell: { flex: 1, alignItems: 'center', gap: 3, minWidth: 0 },
  headLabel: { fontFamily: fonts.bodySemibold, fontSize: 10.5, lineHeight: 13, color: L.text, textAlign: 'center', minHeight: 26 },
  headValue: { fontFamily: fonts.bodyBold, fontSize: 15, color: L.text, fontVariant: ['tabular-nums'] as any },
  lapTabs: { flexDirection: 'row', gap: 4, marginTop: 16, marginBottom: 10 },
  lapTab: { paddingHorizontal: 12, minHeight: 36, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  lapTabOn: { borderBottomColor: L.lime },
  lapText: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: L.muted },
  street: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: L.raised },
  streetName: { fontFamily: fonts.bodySemibold, fontSize: 13, color: L.text, flexShrink: 1 },
  streetMeta: { flex: 1, textAlign: 'right', fontFamily: fonts.mono, fontSize: 10, color: L.muted },
  door: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, minHeight: 38, borderBottomWidth: 1, borderBottomColor: L.lineSoft },
  doorNo: { fontFamily: fonts.bodyBold, fontSize: 13, color: L.text, minWidth: 34 },
  doorLabel: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 12.5 },
  doorTime: { fontFamily: fonts.mono, fontSize: 11.5, color: L.muted },
  doorTook: { fontFamily: fonts.mono, fontSize: 11.5, color: L.muted, minWidth: 62, textAlign: 'right' },
});
