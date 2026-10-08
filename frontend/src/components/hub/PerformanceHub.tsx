/**
 * Performance Hub — OwnerIQ's Performance Hub, in the app.
 *
 * Laid out the way OwnerIQ has it:
 *   • Overall performance: eight tiles (Sales, Piece Average, Scoring %,
 *     Reliability, BAs in business, BA in the field, Scoring BAs, Days in the
 *     field). Each shows the week's figure, its change on last week, and the
 *     split between BAs without a goal (top right) and BAs with one (bottom
 *     right, against target for Sales). Tap a tile and it flips to the figure
 *     for each day, Monday to Sunday.
 *   • Door activity: First Knock, Last Knock, Doors Knocked, Spoken to, Pitch
 *     Commenced, Pitch Closed, Sales, Points, with the per-BA Average under it.
 *   • Teams | BAs. Teams are the named teams plus "No Team"; tap one to open
 *     it (its own tiles, activity and BAs). BAs lists everyone with their four
 *     figures and a tile per day of the week.
 *
 * The numbers come straight from OwnerIQ (GET /owneriq/hub), so they match it.
 * The hub is dark forest green in both themes.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, Image, Animated, ScrollView, Modal, ActivityIndicator, LayoutChangeEvent, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { fonts } from '../../theme/ThemeContext';
import { apiService } from '../../api/client';
import { APP_LOCALE, APP_TZ } from '../../utils/appTime';
import { showAlert } from '../../utils/showAlert';
import { shareAvailability } from './availabilityPdf';

const H = {
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
  greenBg: 'rgba(52,211,153,0.14)',
  red: '#f87171',
  redText: '#fca5a5',
  redBg: 'rgba(248,113,113,0.14)',
  amber: '#e7b65c',
};

type Icon = React.ComponentProps<typeof Ionicons>['name'];
type Daily = { date: string; weekday: string; value: number | null };
type Kpi = {
  value: number | null; trend_percent?: number | null; trend_direction?: string | null; target?: number | null;
  daily?: Daily[];
  segments?: Record<string, { value: number | null; target?: number | null; trend_percent?: number | null; trend_direction?: string | null; daily?: Daily[] }>;
};
type Person = { id: number | string; full_name: string; avatar_url?: string | null; stage?: string | null; stage_label?: string | null };
type Day = {
  date: string; weekday: string; phase: string; status: string; tile_variant?: string;
  planned?: boolean; checked_in?: boolean; has_sale?: boolean; sales_count?: number; in_field?: boolean;
};
type UserRow = {
  user: Person; team?: { id: number; name: string } | null; team_leader?: boolean;
  goal_status?: { not_set?: boolean };
  days: Day[];
  kpis: { sales?: number | null; sales_target?: number | null; piece_average?: number | null; reliability?: number | null; scoring?: number | null };
};
type Segs = { all?: { value: number }; goal_setters?: { value: number; target?: number | null }; non_goal_setters?: { value: number } };
type Team = {
  id?: number | string; name?: string | null; avatar_url?: string | null; leader?: Person | null;
  members?: Person[]; extra_member_count?: number; sales_actual?: number; sales_target?: number | null;
  sales_segments?: Segs; not_set_count?: number;
};
type View_ = {
  kpis: Record<string, Kpi>;
  activity_kpis?: { first_knock_at?: string | null; last_knock_at?: string | null; totals?: Record<string, number>; averages?: Record<string, number> };
  teams?: Team[]; no_team?: Team | null; team?: Team | null; available_teams?: { id: number; name: string }[];
  users: UserRow[]; daily_totals?: { date: string; weekday: string; phase: string; planned_in: number | null; days_in: number | null }[];
  fetched_at?: string | null; stale?: boolean;
};
type HubResponse = {
  week_start: string; scope: string; weeks: { week_start: string; week_end: string; label: string | null }[];
  /** A Coach: their own team only (and teams led by people under them). */
  restricted?: boolean; my_teams?: { id: number; name: string }[];
  app_users: Record<string, { id: string; role?: string }>; view: View_;
};

const KPIS: { key: string; label: string; icon: Icon; fmt: 'int' | 'dec' | 'pct' }[] = [
  { key: 'sales', label: 'Sales', icon: 'flag-outline', fmt: 'int' },
  { key: 'piece_average', label: 'Piece Average', icon: 'trending-up-outline', fmt: 'dec' },
  { key: 'scoring_percentage', label: 'Scoring %', icon: 'stats-chart-outline', fmt: 'pct' },
  { key: 'reliability', label: 'Reliability', icon: 'shield-checkmark-outline', fmt: 'pct' },
  { key: 'active_bas', label: 'BAs in business', icon: 'person-outline', fmt: 'int' },
  { key: 'bas_in_field', label: 'BA in the field', icon: 'walk-outline', fmt: 'int' },
  { key: 'scoring_bas', label: 'Scoring BAs', icon: 'flame-outline', fmt: 'int' },
  { key: 'days_in_field', label: 'Days in the field', icon: 'calendar-outline', fmt: 'dec' },
];
const ACTIVITY: { key: string; label: string; icon: Icon }[] = [
  { key: 'doors_knocked', label: 'Doors Knocked', icon: 'home-outline' },
  { key: 'spoken_to', label: 'Spoken to', icon: 'chatbubble-ellipses-outline' },
  { key: 'pitches_commenced', label: 'Pitch Commenced', icon: 'play-circle-outline' },
  { key: 'pitches_closed', label: 'Pitch Closed', icon: 'checkmark-circle-outline' },
  { key: 'sales', label: 'Sales', icon: 'flag-outline' },
  { key: 'points', label: 'Points', icon: 'podium-outline' },
];
const DAY_LETTER = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const num = (n: number) => Math.round(n).toLocaleString('en-GB');
function fmt(v: number | null | undefined, kind: 'int' | 'dec' | 'pct'): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  if (kind === 'pct') return `${Math.round(v)}%`;
  if (kind === 'int') return num(v);
  const s = (Math.round(v * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
const one = (v: number | null | undefined) => (v === null || v === undefined ? '–' : (Math.round(v * 10) / 10).toFixed(1));
function clock(iso?: string | null): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString(APP_LOCALE, { timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}
function weekLabel(w: { week_start: string; week_end: string; label: string | null }): string {
  if (w.label) return w.label;
  const f = (iso: string, withMonth: boolean) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(APP_LOCALE, { day: 'numeric', ...(withMonth ? { month: 'short' } : {}), timeZone: 'UTC' });
  const same = w.week_start.slice(0, 7) === w.week_end.slice(0, 7);
  return `${f(w.week_start, !same)} – ${f(w.week_end, true)}`;
}
const stageShort = (s?: string | null) => { const m = /^stage_(\d+)(_plus)?$/.exec(s || ''); return m ? `${m[1]}${m[2] ? '+' : ''}` : null; };
const initials = (n: string) => (n || '?').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();

// ════════════════════════════════════════════════════════════════════════════
export default function PerformanceHub({ onOpenPerson, onBadges, bottomPad = 24 }: {
  onOpenPerson?: (appUserId: string) => void;
  /** Admins and Coach+: open the ID badge maker. */
  onBadges?: () => void;
  bottomPad?: number;
}) {
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);
  const [picked, setScope] = useState<string>('all');          // 'all' | OwnerIQ team id | 'none'
  const [list, setList] = useState<'teams' | 'bas'>('teams');
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const [sort, setSort] = useState<'name' | 'sales' | 'piece_average' | 'scoring' | 'reliability'>('name');
  const [notSetOnly, setNotSetOnly] = useState(false);
  const [legend, setLegend] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [w, setW] = useState(0);

  const q = useQuery({
    queryKey: ['owneriq-hub', weekStart || 'now', picked],
    queryFn: () => apiService.getOwneriqHub(weekStart, picked === 'all' ? undefined : picked).then((r) => r.data as HubResponse),
    staleTime: 60_000,
    refetchInterval: 180_000,
    placeholderData: (prev) => prev,
  });
  const data = q.data;
  // A Coach never has the office view: the server opens their own team, and
  // that is the scope from then on.
  const restricted = !!data?.restricted;
  const scope = restricted ? (data?.scope || picked) : picked;
  const view = data?.view;
  const weeks = data?.weeks || [];
  const wi = Math.max(0, weeks.findIndex((x) => x.week_start === (data?.week_start || weekStart)));
  const inTeam = scope !== 'all';

  const users = useMemo(() => {
    let rows = [...(view?.users || [])];
    if (notSetOnly) rows = rows.filter((r) => r.goal_status?.not_set);
    if (sort !== 'name') rows.sort((a, b) => ((b.kpis as any)[sort] ?? -1) - ((a.kpis as any)[sort] ?? -1));
    return rows;
  }, [view?.users, sort, notSetOnly]);
  const notSetCount = (view?.users || []).filter((r) => r.goal_status?.not_set).length;

  // The week's availability (who is in each day) as a one-page PDF to print
  // or share. Covers whatever is open: the whole office, or the team.
  const exportAvailability = async () => {
    if (!view || !data || sharing) return;
    setSharing(true);
    try {
      const scopeName = scope === 'all' ? null : scope === 'none' ? 'No Team' : (view.team?.name || '').trim() || null;
      await shareAvailability(view.users || [], data.week_start, scopeName);
    } catch {
      showAlert('Could not make the PDF', 'Try again in a moment.');
    } finally {
      setSharing(false);
    }
  };

  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const cols = w >= 760 ? 4 : 2;
  const gap = 12;
  const tileW = w ? (w - gap * (cols - 1)) / cols : 0;
  const teamCols = w >= 1040 ? 4 : w >= 760 ? 3 : w >= 480 ? 2 : 1;
  const teamW = w ? (w - gap * (teamCols - 1)) / teamCols : 0;
  const wideTable = w >= 860;

  const teams: Team[] = view?.teams || [];
  const pills = view?.available_teams || teams.map((t) => ({ id: t.id as number, name: t.name || '' }));

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: bottomPad }} showsVerticalScrollIndicator={Platform.OS === 'web'}>
      <View style={s.shell}>
        {/* Week + scope bar */}
        <View style={s.bar}>
          <View style={s.weekNav}>
            <Pressable onPress={() => weeks[wi + 1] && setWeekStart(weeks[wi + 1].week_start)} disabled={!weeks[wi + 1]}
              style={[s.navBtn, !weeks[wi + 1] && { opacity: 0.3 }]} accessibilityLabel="Earlier week" hitSlop={6}>
              <Ionicons name="chevron-back" size={16} color={H.text} />
            </Pressable>
            <View style={s.weekPill}>
              <Ionicons name="calendar-outline" size={13} color={H.lime} />
              <Text style={s.weekText}>{weeks[wi] ? weekLabel(weeks[wi]) : 'This week'}</Text>
            </View>
            <Pressable onPress={() => wi > 0 && setWeekStart(weeks[wi - 1].week_start)} disabled={wi <= 0}
              style={[s.navBtn, wi <= 0 && { opacity: 0.3 }]} accessibilityLabel="Later week" hitSlop={6}>
              <Ionicons name="chevron-forward" size={16} color={H.text} />
            </Pressable>
          </View>
          <Pressable onPress={exportAvailability} disabled={!view || sharing} style={[s.pdfBtn, (!view || sharing) && { opacity: 0.5 }]}
            accessibilityLabel="Share this week's availability as a PDF" testID="hub-availability-pdf">
            {sharing ? <ActivityIndicator size="small" color={H.onLime} /> : <Ionicons name="share-outline" size={15} color={H.onLime} />}
            <Text style={s.pdfBtnText}>Availability PDF</Text>
          </Pressable>
          {onBadges ? (
            <Pressable onPress={onBadges} style={s.ghostBtn} accessibilityLabel="Open ID badges" testID="hub-badges">
              <Ionicons name="ribbon-outline" size={15} color={H.text} />
              <Text style={s.ghostBtnText}>Badges</Text>
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }} />
          {q.isFetching ? <ActivityIndicator size="small" color={H.lime} /> : null}
          {view?.fetched_at ? (
            <Text style={[s.updated, view.stale && { color: H.amber }]} numberOfLines={1}>
              {view.stale ? 'Saved copy · ' : 'OwnerIQ · '}{clock(view.fetched_at)}
            </Text>
          ) : null}
        </View>

        {/* Team bar: which team is open */}
        {inTeam && (!restricted || pills.length > 1) && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={s.pillRow}>
            {!restricted && (
            <Pressable onPress={() => { setScope('all'); setList('teams'); }} style={s.backPill} testID="hub-all-teams">
              <Ionicons name="arrow-back" size={13} color={H.onLime} />
              <Text style={s.backPillText}>All teams</Text>
            </Pressable>
            )}
            {pills.map((t) => (
              <Pressable key={t.id} onPress={() => setScope(String(t.id))} style={[s.pill, scope === String(t.id) && s.pillOn]}>
                <Text style={[s.pillText, scope === String(t.id) && { color: H.text }]} numberOfLines={1}>{(t.name || '').trim()}</Text>
              </Pressable>
            ))}
            {!restricted && (
            <Pressable onPress={() => setScope('none')} style={[s.pill, scope === 'none' && s.pillOn]}>
              <Text style={[s.pillText, scope === 'none' && { color: H.text }]}>No Team</Text>
            </Pressable>
            )}
          </ScrollView>
        )}

        <View onLayout={onLayout}>
          {q.isLoading && !view ? (
            <View style={s.centre}><ActivityIndicator color={H.lime} /><Text style={s.note}>Loading from OwnerIQ…</Text></View>
          ) : !view ? (
            <View style={s.centre}>
              <Ionicons name="cloud-offline-outline" size={30} color={H.muted} />
              <Text style={s.note}>{(q.error as any)?.response?.data?.detail || 'The Performance Hub could not be loaded.'}</Text>
              <Pressable onPress={() => q.refetch()} style={s.backPill}><Text style={s.backPillText}>Try again</Text></Pressable>
            </View>
          ) : (
            <>
              <SectionLabel icon="grid-outline" text={inTeam ? `${scope === 'none' ? 'No Team' : (view.team?.name || 'Team').trim()} · performance` : 'Overall performance'} />
              <View style={[s.grid, { gap }]}>
                {KPIS.map((k) => (
                  <KpiTile
                    key={k.key}
                    def={k}
                    kpi={view.kpis?.[k.key]}
                    width={tileW}
                    flipped={!!flipped[k.key]}
                    onFlip={() => setFlipped((f) => ({ ...f, [k.key]: !f[k.key] }))}
                    compact={cols === 2}
                  />
                ))}
              </View>

              <ActivityStrip a={view.activity_kpis} wide={w >= 760} />

              {/* Teams | BAs */}
              <View style={s.listBar}>
                {!inTeam ? (
                  <View style={s.seg}>
                    {(['teams', 'bas'] as const).map((m) => (
                      <Pressable key={m} onPress={() => setList(m)} style={[s.segItem, list === m && s.segOn]} testID={`hub-${m}`}>
                        <Ionicons name={m === 'teams' ? 'people-outline' : 'person-outline'} size={14} color={list === m ? H.onLime : H.muted} />
                        <Text style={[s.segText, list === m && { color: H.onLime }]}>{m === 'teams' ? 'Teams' : 'BAs'}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <SectionLabel icon="people-outline" text="Brand Ambassadors" style={{ marginBottom: 0, marginTop: 0 }} />
                )}
                <View style={{ flex: 1 }} />
                {(inTeam || list === 'bas') && (
                  <>
                    {notSetCount > 0 && (
                      <Pressable onPress={() => setNotSetOnly((v) => !v)} style={[s.chipBtn, notSetOnly && s.chipBtnRed]}>
                        <Ionicons name="warning-outline" size={13} color={H.redText} />
                        <Text style={[s.chipBtnText, { color: H.redText }]}>Not Set {notSetCount}</Text>
                      </Pressable>
                    )}
                    <Pressable onPress={() => setLegend(true)} style={s.chipBtn} testID="hub-legend">
                      <Ionicons name="information-circle-outline" size={14} color={H.text} />
                      <Text style={s.chipBtnText}>Legend</Text>
                    </Pressable>
                  </>
                )}
              </View>

              {!inTeam && list === 'teams' ? (
                <View style={[s.grid, { gap }]}>
                  {teams.map((t) => <TeamCard key={String(t.id)} team={t} width={teamW} slim={teamCols === 1} onPress={() => setScope(String(t.id))} />)}
                  {view.no_team ? <TeamCard team={{ ...view.no_team, name: 'No Team' }} width={teamW} slim={teamCols === 1} onPress={() => setScope('none')} /> : null}
                </View>
              ) : (
                <BaTable
                  rows={users}
                  totals={view.daily_totals || []}
                  wide={wideTable}
                  sort={sort}
                  onSort={setSort}
                  showTeam={!inTeam}
                  appUsers={data?.app_users || {}}
                  onOpenPerson={onOpenPerson}
                />
              )}
            </>
          )}
        </View>
      </View>

      <Legend open={legend} onClose={() => setLegend(false)} />
    </ScrollView>
  );
}

function SectionLabel({ icon, text, style }: { icon: Icon; text: string; style?: any }) {
  return (
    <View style={[s.section, style]}>
      <Ionicons name={icon} size={12} color={H.muted} />
      <Text style={s.sectionText} numberOfLines={1}>{text}</Text>
    </View>
  );
}

// ── A KPI tile that flips to its day-by-day view ────────────────────────────
function KpiTile({ def, kpi, width, flipped, onFlip, compact }: {
  def: typeof KPIS[number]; kpi?: Kpi; width: number; flipped: boolean; onFlip: () => void; compact: boolean;
}) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(turn, { toValue: flipped ? 1 : 0, duration: 380, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [flipped, turn]);
  const all = kpi?.segments?.all;
  const main = all?.value ?? kpi?.value ?? null;
  const trend = all?.trend_percent ?? kpi?.trend_percent ?? null;
  const dir = all?.trend_direction ?? kpi?.trend_direction ?? null;
  const goal = kpi?.segments?.goal_setters;
  const noGoal = kpi?.segments?.non_goal_setters;
  const daily = all?.daily || kpi?.daily || [];
  const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ });
  const up = dir === 'up', down = dir === 'down';
  const front = { transform: [{ perspective: 900 }, { rotateY: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] };
  const back = { transform: [{ perspective: 900 }, { rotateY: turn.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '360deg'] }) }] };
  const Trend = (
    <View style={[s.trend, up && s.trendUp, down && s.trendDown]}>
      <Text style={[s.trendText, up && { color: H.green }, down && { color: H.redText }]}>
        {trend === null ? '–' : `${trend > 0 ? '+' : ''}${trend}%`}
      </Text>
      <Ionicons name={up ? 'arrow-up' : down ? 'arrow-down' : 'remove'} size={10} color={up ? H.green : down ? H.redText : H.muted} />
    </View>
  );
  return (
    <Pressable onPress={onFlip} style={{ width, height: compact ? 122 : 128 }} accessibilityRole="button"
      accessibilityLabel={`${def.label} ${fmt(main, def.fmt)}. Tap for each day.`} testID={`hub-kpi-${def.key}`}>
      {/* Front: the week */}
      <Animated.View style={[s.tile, s.face, front]} pointerEvents={flipped ? 'none' : 'auto'}>
        <View style={s.tileHead}>
          <Text style={s.tileLabel} numberOfLines={1}>{def.label}</Text>
          <View style={s.tileIcon}><Ionicons name={def.icon} size={15} color={H.lime} /></View>
        </View>
        <View style={{ flex: 1 }} />
        <View style={s.tileBottom}>
          <View style={{ flexShrink: 1 }}>
            <Text style={[s.tileValue, compact && { fontSize: 24 }]} numberOfLines={1}>{fmt(main, def.fmt)}</Text>
            {Trend}
          </View>
          {goal || noGoal ? (
            <View style={s.split}>
              <View style={s.splitRow}>
                <Text style={s.splitTop}>{fmt(noGoal?.value, def.fmt)}</Text>
                <Ionicons name="remove-circle-outline" size={11} color={H.faint} />
              </View>
              <View style={s.splitRow}>
                <Text style={s.splitBottom} numberOfLines={1}>
                  {fmt(goal?.value, def.fmt)}{goal?.target != null ? `/${num(goal.target)}` : ''}
                </Text>
                <Ionicons name="locate-outline" size={11} color={H.faint} />
              </View>
            </View>
          ) : null}
        </View>
      </Animated.View>
      {/* Back: each day */}
      <Animated.View style={[s.tile, s.face, back]} pointerEvents={flipped ? 'auto' : 'none'}>
        <View style={s.tileHead}>
          <Ionicons name={def.icon} size={14} color={H.lime} />
          <Text style={[s.tileLabel, { flex: 1 }]} numberOfLines={1}>{def.label}</Text>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.backValue}>{fmt(main, def.fmt)}</Text>
            {Trend}
          </View>
        </View>
        <View style={{ flex: 1 }} />
        <View style={s.days}>
          {DAY_LETTER.map((d, i) => {
            const day = daily[i];
            const isToday = day?.date === todayIso;
            return (
              <View key={i} style={s.dayCol}>
                <Text style={[s.dayLetter, isToday && { color: H.text }]}>{d}</Text>
                <View style={[s.dayRule, isToday && { backgroundColor: H.lime }]} />
                <Text style={[s.dayValue, day?.value == null && { color: H.faint }]} numberOfLines={1}>
                  {day?.value == null ? '–' : def.fmt === 'dec' ? String(Math.round(day.value * 100) / 100) : fmt(day.value, def.fmt)}
                </Text>
              </View>
            );
          })}
        </View>
      </Animated.View>
    </Pressable>
  );
}

// ── First knock … points, with the per-BA average ───────────────────────────
function ActivityStrip({ a, wide }: { a?: View_['activity_kpis']; wide: boolean }) {
  const cells: { label: string; icon: Icon; value: string; avg: string | null }[] = [
    { label: 'First Knock', icon: 'hand-left-outline', value: clock(a?.first_knock_at), avg: null },
    { label: 'Last Knock', icon: 'hand-right-outline', value: clock(a?.last_knock_at), avg: null },
    ...ACTIVITY.map((c) => ({
      label: c.label, icon: c.icon,
      value: a?.totals?.[c.key] != null ? num(a.totals[c.key]) : '–',
      avg: a?.averages?.[c.key] != null ? num(a.averages[c.key]) : '–',
    })),
  ];
  const body = (
    <View style={[s.strip, !wide && { minWidth: 760 }]}>
      <View style={s.stripRow}>
        {cells.map((c) => (
          <View key={c.label} style={s.stripCell}>
            <Ionicons name={c.icon} size={15} color={H.lime} />
            <Text style={s.stripLabel} numberOfLines={1}>{c.label}</Text>
            <Text style={s.stripValue}>{c.value}</Text>
          </View>
        ))}
      </View>
      <View style={[s.stripRow, s.stripAvg]}>
        {cells.map((c, i) => (
          <View key={c.label} style={s.stripCell}>
            <Text style={i === 0 ? s.stripAvgLabel : s.stripAvgValue}>{i === 0 ? 'Average' : c.avg ?? ''}</Text>
          </View>
        ))}
      </View>
    </View>
  );
  return wide ? <View style={{ marginTop: 14 }}>{body}</View>
    : <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 14 }}>{body}</ScrollView>;
}

function Avatar({ p, size = 34, ring }: { p?: Person | null; size?: number; ring?: boolean }) {
  const st = stageShort(p?.stage);
  return (
    <View style={{ width: size, height: size }}>
      {p?.avatar_url ? (
        <Image source={{ uri: p.avatar_url }} style={{ width: size, height: size, borderRadius: size / 2, borderWidth: ring ? 1.5 : 0, borderColor: H.lime }} />
      ) : (
        <View style={[s.avatarFallback, { width: size, height: size, borderRadius: size / 2 }, ring && { borderWidth: 1.5, borderColor: H.lime }]}>
          <Text style={[s.avatarText, { fontSize: size * 0.36 }]}>{initials(p?.full_name || '')}</Text>
        </View>
      )}
      {st ? <View style={s.stageDot}><Text style={s.stageDotText}>{st}</Text></View> : null}
    </View>
  );
}

function TeamCard({ team, width, onPress, slim }: { team: Team; width: number; onPress: () => void; slim?: boolean }) {
  const seg = team.sales_segments || {};
  const members = team.members || [];
  const count = members.length + (team.extra_member_count || 0);
  // One team to a line (a phone): a slim row with the same facts.
  if (slim) {
    const goal = seg.goal_setters;
    return (
      <Pressable onPress={onPress} style={[s.teamSlim, { width }]} testID={`hub-team-${team.id ?? 'none'}`}
        accessibilityLabel={`${(team.name || 'No Team').trim()}: ${num(seg.all?.value ?? team.sales_actual ?? 0)} sales, ${count} Brand Ambassadors`}>
        {team.avatar_url ? <Image source={{ uri: team.avatar_url }} style={s.teamSlimLogo} />
          : <View style={[s.teamSlimLogo, s.avatarFallback]}><Ionicons name="people" size={17} color={H.lime} /></View>}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.teamName, { marginTop: 0 }]} numberOfLines={1}>{(team.name || 'No Team').trim()}</Text>
          <Text style={s.teamSlimSub} numberOfLines={1}>
            {team.leader ? `${team.leader.full_name} · ` : ''}{count} {count === 1 ? 'BA' : 'BAs'}
            {team.not_set_count ? <Text style={{ color: H.redText }}>{`  ·  ${team.not_set_count} not set`}</Text> : null}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.teamSlimSales}>{num(seg.all?.value ?? team.sales_actual ?? 0)}</Text>
          <Text style={s.teamSlimTarget}>{goal?.target != null ? `of ${num(goal.target)}` : 'sales'}</Text>
        </View>
        <Ionicons name="chevron-forward" size={15} color={H.faint} />
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} style={(st: any) => [s.team, { width }, st.hovered && s.teamHover]} testID={`hub-team-${team.id ?? 'none'}`}>
      <View style={s.teamTop}>
        {team.avatar_url ? <Image source={{ uri: team.avatar_url }} style={s.teamLogo} />
          : <View style={[s.teamLogo, s.avatarFallback]}><Ionicons name="people" size={20} color={H.lime} /></View>}
        <Ionicons name="chevron-forward" size={16} color={H.faint} />
      </View>
      <Text style={s.teamName} numberOfLines={1}>{(team.name || 'No Team').trim()}</Text>
      {team.leader ? (
        <>
          <Text style={s.teamCaption}>Team Lead</Text>
          <View style={s.teamLead}>
            <Avatar p={team.leader} size={30} ring />
            <Text style={s.teamLeadName} numberOfLines={1}>{team.leader.full_name}</Text>
          </View>
        </>
      ) : null}
      <Text style={s.teamCaption}>Brand Ambassadors ({count})</Text>
      <View style={s.memberRow}>
        {members.slice(0, 3).map((m, i) => <View key={String(m.id)} style={{ marginLeft: i ? -8 : 0 }}><Avatar p={{ ...m, stage: null }} size={22} /></View>)}
        {count > 3 ? <Text style={s.more}>+{count - 3}</Text> : null}
        <View style={{ flex: 1 }} />
        {team.not_set_count ? (
          <View style={s.notSet}><Ionicons name="warning-outline" size={11} color={H.redText} /><Text style={s.notSetText}>{team.not_set_count} Not Set</Text></View>
        ) : null}
      </View>
      <View style={s.teamBottom}>
        <Text style={s.teamSales}>{num(seg.all?.value ?? team.sales_actual ?? 0)}<Text style={s.teamSalesUnit}> Sales</Text></Text>
        <View style={s.split}>
          <View style={s.splitRow}><Text style={s.splitTop}>{num(seg.non_goal_setters?.value ?? 0)}</Text><Ionicons name="remove-circle-outline" size={11} color={H.faint} /></View>
          <View style={s.splitRow}>
            <Text style={s.splitBottom}>{num(seg.goal_setters?.value ?? 0)}{seg.goal_setters?.target != null ? `/${num(seg.goal_setters.target)}` : ''}</Text>
            <Ionicons name="locate-outline" size={11} color={H.faint} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// ── One tile per day of a BA's week ─────────────────────────────────────────
function DayTile({ d, i, small }: { d?: Day; i: number; small: boolean }) {
  const label = DAY_SHORT[i];
  let box: any = s.dtPlan, top: React.ReactNode, lab = label, labStyle: any = s.dtLabel;
  const st = d?.status;
  if (!d || st === 'na') {
    box = s.dtDim; top = <Ionicons name="ban-outline" size={13} color={H.faint} />; lab = 'N/A'; labStyle = [s.dtLabel, { color: H.faint }];
  } else if (st === 'not_set') {
    box = s.dtRed; lab = 'Not Set'; labStyle = [s.dtLabel, { color: H.redText }];
    top = <Text style={[s.dtNum, { color: H.redText }]}>{d.in_field ? d.sales_count ?? 0 : '–'}</Text>;
  } else if (st === 'present') {
    if (d.has_sale) { box = s.dtGreen; top = <Text style={[s.dtNum, { color: H.green }]}>{d.sales_count ?? 0}</Text>; labStyle = [s.dtLabel, { color: H.green }]; }
    else { box = s.dtRed; top = <Text style={[s.dtNum, { color: H.redText }]}>0</Text>; labStyle = [s.dtLabel, { color: H.redText }]; }
  } else if (st === 'absent') {
    box = s.dtAmber; top = <Ionicons name="close" size={14} color={H.amber} />; lab = small ? 'Abs' : 'Absent'; labStyle = [s.dtLabel, { color: H.amber }];
  } else if (st === 'not_present' || st === 'planned_out') {
    box = s.dtDim; top = <Ionicons name={st === 'planned_out' ? 'calendar-clear-outline' : 'ban-outline'} size={13} color={H.faint} />; labStyle = [s.dtLabel, { color: H.faint }];
  } else {   // planned_in (a day still to come)
    top = <Ionicons name="calendar-outline" size={13} color={H.text} />;
  }
  if (small && lab === 'Not Set') lab = 'N/S';
  return (
    <View style={[s.dt, box, small && { height: 44 }]}>
      {top}
      <Text style={labStyle} numberOfLines={1}>{lab}</Text>
    </View>
  );
}

function BaTable({ rows, totals, wide, sort, onSort, showTeam, appUsers, onOpenPerson }: {
  rows: UserRow[]; totals: NonNullable<View_['daily_totals']>; wide: boolean;
  sort: string; onSort: (k: any) => void; showTeam: boolean;
  appUsers: Record<string, { id: string }>; onOpenPerson?: (id: string) => void;
}) {
  const cols: { key: 'sales' | 'piece_average' | 'scoring' | 'reliability'; icon: Icon; label: string }[] = [
    { key: 'sales', icon: 'flag-outline', label: 'Sales' },
    { key: 'piece_average', icon: 'trending-up-outline', label: 'PA' },
    { key: 'scoring', icon: 'flame-outline', label: 'Scoring' },
    { key: 'reliability', icon: 'shield-checkmark-outline', label: 'Reliab.' },
  ];
  const cell = (r: UserRow, k: string) => {
    const v = (r.kpis as any)[k];
    if (k === 'sales') return v == null ? '–' : String(v);
    if (k === 'piece_average') return one(v);
    return v == null ? '–' : `${Math.round(v)}%`;
  };
  const Head = (
    <View style={[s.th, !wide && { flexDirection: 'column', alignItems: 'stretch', gap: 8 }]}>
      <View style={[{ flexDirection: 'row', alignItems: 'center' }, wide && { flex: 1 }]}>
        <Pressable onPress={() => onSort('name')} style={{ flex: 1, minWidth: wide ? 200 : 0 }}>
          <Text style={[s.thText, sort === 'name' && { color: H.lime }]}>Name {sort === 'name' ? '↓' : ''}</Text>
        </Pressable>
        {cols.map((c) => (
          <Pressable key={c.key} onPress={() => onSort(c.key)} style={s.kcol} accessibilityLabel={`Sort by ${c.label}`}>
            <Ionicons name={c.icon} size={14} color={sort === c.key ? H.lime : H.muted} />
            {!wide && <Text style={[s.kcolCap, sort === c.key && { color: H.lime }]}>{c.label}</Text>}
          </Pressable>
        ))}
      </View>
      <View style={[s.tiles, wide && { width: 7 * 62 + 6 * 6 }]}>
        {DAY_LETTER.map((d, i) => {
          const t = totals[i];
          const past = t?.days_in != null;
          return (
            <View key={i} style={s.dhead}>
              <Text style={s.dheadLetter}>{d}</Text>
              <Text style={s.dheadCount} numberOfLines={1}>
                {past ? <Text style={(t!.days_in ?? 0) < (t!.planned_in ?? 0) ? { color: H.redText } : { color: H.text }}>{t!.days_in}</Text> : null}
                {past ? ' /' : ''}{t?.planned_in ?? '–'}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
  return (
    <View style={s.table}>
      {Head}
      {rows.length === 0 ? <Text style={[s.note, { padding: 18 }]}>Nobody to show.</Text> : null}
      {rows.map((r) => {
        const app = appUsers[String(r.user.id)];
        const open = app && onOpenPerson ? () => onOpenPerson(app.id) : undefined;
        return (
          <Pressable key={String(r.user.id)} onPress={open} disabled={!open}
            style={(st: any) => [s.tr, !wide && { flexDirection: 'column', alignItems: 'stretch', gap: 8 }, st.hovered && open && { backgroundColor: 'rgba(238,244,230,0.04)' }]}
            testID={`hub-ba-${r.user.id}`}>
            <View style={[{ flexDirection: 'row', alignItems: 'center' }, wide && { flex: 1 }]}>
              <View style={[s.person, { minWidth: wide ? 200 : 0 }]}>
                <Avatar p={r.user} size={36} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.personName} numberOfLines={1}>{r.user.full_name}</Text>
                  <View style={s.tags}>
                    {r.goal_status?.not_set ? <View style={s.notSet}><Ionicons name="warning-outline" size={10} color={H.redText} /><Text style={s.notSetText}>Not Set</Text></View> : null}
                    {r.team_leader ? <View style={s.leadTag}><Text style={s.leadTagText}>Team Leader</Text></View> : null}
                    {showTeam && r.team?.name ? <View style={s.teamTag}><Text style={s.teamTagText} numberOfLines={1}>{r.team.name.trim()}</Text></View> : null}
                  </View>
                </View>
              </View>
              {cols.map((c) => <Text key={c.key} style={s.kcell}>{cell(r, c.key)}</Text>)}
            </View>
            <View style={[s.tiles, wide && { width: 7 * 62 + 6 * 6 }]}>
              {DAY_LETTER.map((_, i) => <DayTile key={i} d={r.days?.[i]} i={i} small={!wide} />)}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function Legend({ open, onClose }: { open: boolean; onClose: () => void }) {
  const items: { d: Day; i: number; title: string; text: string }[] = [
    { d: { date: '', weekday: '', phase: 'past', status: 'present', has_sale: true, sales_count: 4 }, i: 0, title: 'In & made sales', text: 'The BA was in the field. The green number is their sign-ups.' },
    { d: { date: '', weekday: '', phase: 'past', status: 'present', has_sale: false, sales_count: 0 }, i: 1, title: 'In & no sales', text: 'The BA was in the field. A red 0 means no sign-ups.' },
    { d: { date: '', weekday: '', phase: 'past', status: 'not_present' }, i: 2, title: 'Not in', text: 'Planned out and stayed out.' },
    { d: { date: '', weekday: '', phase: 'past', status: 'absent' }, i: 3, title: 'Absent', text: 'Planned in but did not go out.' },
    { d: { date: '', weekday: '', phase: 'past', status: 'na' }, i: 4, title: 'Not applicable', text: 'The BA could not set this day. Left out of the figures.' },
    { d: { date: '', weekday: '', phase: 'past', status: 'not_set', in_field: true, sales_count: 1 }, i: 5, title: 'Not set', text: 'No plan was set. A red number means they went out and that is their sign-ups.' },
    { d: { date: '', weekday: '', phase: 'future', status: 'planned_in' }, i: 6, title: 'Planned in', text: 'A day still to come that they plan to work.' },
  ];
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.modalBack} onPress={onClose}>
        <Pressable style={s.modal} onPress={() => {}}>
          <Text style={s.modalTitle}>Legend</Text>
          <Text style={s.note}>What the day tiles mean.</Text>
          {items.map((it) => (
            <View key={it.title} style={s.legendRow}>
              <View style={{ width: 56 }}><DayTile d={it.d} i={it.i} small={false} /></View>
              <View style={{ flex: 1 }}>
                <Text style={s.legendTitle}>{it.title}</Text>
                <Text style={s.legendText}>{it.text}</Text>
              </View>
            </View>
          ))}
          <Text style={[s.legendText, { marginTop: 10 }]}>
            On a tile: top right is BAs without a goal set, bottom right is BAs with a goal (against target for Sales).
          </Text>
          <Pressable onPress={onClose} style={[s.backPill, { alignSelf: 'flex-end', marginTop: 12 }]}><Text style={s.backPillText}>Close</Text></Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  shell: { width: '100%', maxWidth: 1240, alignSelf: 'center', backgroundColor: H.canvas, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: H.lineSoft },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
  weekNav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navBtn: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: H.tile, borderWidth: 1, borderColor: H.lineSoft },
  weekPill: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingHorizontal: 12, borderRadius: 10, backgroundColor: H.tile, borderWidth: 1, borderColor: H.line, minWidth: 128, justifyContent: 'center' },
  weekText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: H.text },
  pdfBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 10, backgroundColor: H.lime },
  pdfBtnText: { fontFamily: fonts.bodyBold, fontSize: 12.5, color: H.onLime },
  ghostBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 10, backgroundColor: H.tile, borderWidth: 1, borderColor: H.line },
  ghostBtnText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: H.text },
  updated: { fontFamily: fonts.mono, fontSize: 10.5, color: H.muted, letterSpacing: 0.4 },
  pillRow: { gap: 6, alignItems: 'center' },
  backPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, minHeight: 34, borderRadius: 999, backgroundColor: H.lime },
  backPillText: { fontFamily: fonts.bodyBold, fontSize: 12.5, color: H.onLime },
  pill: { paddingHorizontal: 12, minHeight: 34, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: H.lineSoft, maxWidth: 180 },
  pillOn: { backgroundColor: H.raised, borderColor: H.lime },
  pillText: { fontFamily: fonts.bodySemibold, fontSize: 12, color: H.muted },
  centre: { alignItems: 'center', gap: 10, paddingVertical: 60 },
  note: { fontFamily: fonts.body, fontSize: 12.5, color: H.muted, textAlign: 'center' },
  section: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10, marginTop: 2 },
  sectionText: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.4, textTransform: 'uppercase', color: H.muted },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },

  tile: { backgroundColor: H.tile, borderRadius: 14, borderWidth: 1, borderColor: H.lineSoft, padding: 12 },
  face: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backfaceVisibility: 'hidden' },
  tileHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  tileLabel: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 12.5, color: H.muted },
  tileIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(183,223,88,0.08)' },
  tileBottom: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  tileValue: { fontFamily: fonts.display, fontSize: 28, letterSpacing: -0.8, color: H.text, fontVariant: ['tabular-nums'] as any },
  backValue: { fontFamily: fonts.display, fontSize: 20, color: H.text, fontVariant: ['tabular-nums'] as any },
  trend: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start', marginTop: 5, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(238,244,230,0.07)' },
  trendUp: { backgroundColor: 'rgba(52,211,153,0.12)' },
  trendDown: { backgroundColor: 'rgba(248,113,113,0.12)' },
  trendText: { fontFamily: fonts.mono, fontSize: 10.5, color: H.muted },
  split: { marginLeft: 'auto', paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: H.lineSoft, alignItems: 'flex-end', gap: 6 },
  splitRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  splitTop: { fontFamily: fonts.bodySemibold, fontSize: 14, color: H.text, fontVariant: ['tabular-nums'] as any },
  splitBottom: { fontFamily: fonts.bodyBold, fontSize: 14.5, color: H.text, fontVariant: ['tabular-nums'] as any },
  days: { flexDirection: 'row' },
  dayCol: { flex: 1, alignItems: 'center', minWidth: 0 },
  dayLetter: { fontFamily: fonts.bodySemibold, fontSize: 11, color: H.muted },
  dayRule: { width: 16, height: 2, borderRadius: 1, marginTop: 5, marginBottom: 7, backgroundColor: 'transparent' },
  dayValue: { fontFamily: fonts.mono, fontSize: 11.5, color: H.text },

  strip: { borderRadius: 14, borderWidth: 1, borderColor: H.line, overflow: 'hidden', backgroundColor: H.tile },
  stripRow: { flexDirection: 'row' },
  stripCell: { flex: 1, alignItems: 'center', paddingVertical: 11, paddingHorizontal: 4, gap: 3, minWidth: 0 },
  stripLabel: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: H.text },
  stripValue: { fontFamily: fonts.mono, fontSize: 12.5, color: H.muted },
  stripAvg: { backgroundColor: H.raised, borderTopWidth: 1, borderTopColor: H.line },
  stripAvgLabel: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: H.text },
  stripAvgValue: { fontFamily: fonts.bodyBold, fontSize: 15, color: H.text, fontVariant: ['tabular-nums'] as any },

  listBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18, marginBottom: 12, flexWrap: 'wrap' },
  seg: { flexDirection: 'row', backgroundColor: H.tile, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: H.lineSoft },
  segItem: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, minHeight: 34, borderRadius: 9 },
  segOn: { backgroundColor: H.lime },
  segText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: H.muted },
  chipBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, minHeight: 34, borderRadius: 10, borderWidth: 1, borderColor: H.lineSoft, backgroundColor: H.tile },
  chipBtnRed: { borderColor: H.red, backgroundColor: H.redBg },
  chipBtnText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: H.text },

  team: { backgroundColor: H.tile, borderRadius: 14, borderWidth: 1, borderColor: H.lineSoft, padding: 14 },
  teamSlim: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 62, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: H.tile, borderRadius: 14, borderWidth: 1, borderColor: H.lineSoft },
  teamSlimLogo: { width: 38, height: 38, borderRadius: 19 },
  teamSlimSub: { fontFamily: fonts.body, fontSize: 11.5, color: H.muted, marginTop: 2 },
  teamSlimSales: { fontFamily: fonts.display, fontSize: 20, color: H.text, fontVariant: ['tabular-nums'] as any },
  teamSlimTarget: { fontFamily: fonts.mono, fontSize: 10, color: H.muted },
  teamHover: { borderColor: H.lime, boxShadow: '0 0 0 1px rgba(183,223,88,0.35), 0 12px 30px rgba(0,0,0,0.35)' } as any,
  teamTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  teamLogo: { width: 46, height: 46, borderRadius: 23 },
  teamName: { fontFamily: fonts.displayWide, fontSize: 13.5, letterSpacing: 0.4, color: H.text, marginTop: 12, textTransform: 'uppercase' },
  teamCaption: { fontFamily: fonts.body, fontSize: 11, color: H.muted, marginTop: 12, marginBottom: 6 },
  teamLead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  teamLeadName: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13.5, color: H.text },
  memberRow: { flexDirection: 'row', alignItems: 'center', minHeight: 24 },
  more: { fontFamily: fonts.mono, fontSize: 10.5, color: H.muted, marginLeft: 6 },
  teamBottom: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: H.lineSoft },
  teamSales: { fontFamily: fonts.display, fontSize: 32, letterSpacing: -1, color: H.text },
  teamSalesUnit: { fontFamily: fonts.body, fontSize: 12, letterSpacing: 0, color: H.muted },
  notSet: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: H.redBg, borderWidth: 1, borderColor: 'rgba(248,113,113,0.4)' },
  notSetText: { fontFamily: fonts.bodySemibold, fontSize: 10, color: H.redText },

  avatarFallback: { backgroundColor: H.raised, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bodyBold, color: H.text },
  stageDot: { position: 'absolute', right: -4, bottom: -3, minWidth: 16, height: 15, paddingHorizontal: 3, borderRadius: 8, backgroundColor: H.canvas, borderWidth: 1, borderColor: H.lime, alignItems: 'center', justifyContent: 'center' },
  stageDotText: { fontFamily: fonts.bodyBold, fontSize: 8.5, color: H.text },

  table: { borderRadius: 14, borderWidth: 1, borderColor: H.line, backgroundColor: H.panel, overflow: 'hidden' },
  th: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: H.line, backgroundColor: H.tile },
  thText: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: H.muted },
  tr: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: H.lineSoft },
  person: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11 },
  personName: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: H.text },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4, overflow: 'hidden' },
  leadTag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: H.text },
  leadTagText: { fontFamily: fonts.bodySemibold, fontSize: 9.5, color: H.onLime },
  teamTag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(238,244,230,0.08)', maxWidth: '100%' },
  teamTagText: { fontFamily: fonts.bodySemibold, fontSize: 9.5, letterSpacing: 0.3, color: H.text },
  kcol: { width: 54, alignItems: 'center', gap: 2 },
  kcolCap: { fontFamily: fonts.mono, fontSize: 8.5, color: H.muted },
  kcell: { width: 54, textAlign: 'center', fontFamily: fonts.bodySemibold, fontSize: 13, color: H.text, fontVariant: ['tabular-nums'] as any },
  tiles: { flexDirection: 'row', gap: 6 },
  dhead: { flex: 1, alignItems: 'center', minWidth: 0 },
  dheadLetter: { fontFamily: fonts.bodyBold, fontSize: 12, color: H.text },
  dheadCount: { fontFamily: fonts.mono, fontSize: 9.5, color: H.muted, marginTop: 2 },
  dt: { flex: 1, minWidth: 0, height: 50, borderRadius: 9, alignItems: 'center', justifyContent: 'center', gap: 2, borderWidth: 1 },
  dtPlan: { backgroundColor: 'rgba(238,244,230,0.10)', borderColor: 'rgba(238,244,230,0.10)' },
  dtDim: { backgroundColor: 'rgba(238,244,230,0.03)', borderColor: 'rgba(238,244,230,0.05)' },
  dtGreen: { backgroundColor: H.greenBg, borderColor: 'rgba(52,211,153,0.55)' },
  dtRed: { backgroundColor: H.redBg, borderColor: 'rgba(248,113,113,0.55)' },
  dtAmber: { backgroundColor: 'rgba(231,182,92,0.12)', borderColor: 'rgba(231,182,92,0.5)' },
  dtNum: { fontFamily: fonts.bodyBold, fontSize: 15, lineHeight: 17 },
  dtLabel: { fontFamily: fonts.bodySemibold, fontSize: 9.5, color: H.text },

  modalBack: { flex: 1, backgroundColor: 'rgba(3,12,8,0.7)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modal: { width: '100%', maxWidth: 460, backgroundColor: H.panel, borderRadius: 18, borderWidth: 1, borderColor: H.line, padding: 18 },
  modalTitle: { fontFamily: fonts.display, fontSize: 19, color: H.text, marginBottom: 2 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  legendTitle: { fontFamily: fonts.bodySemibold, fontSize: 13, color: H.text },
  legendText: { fontFamily: fonts.body, fontSize: 12, lineHeight: 17, color: H.muted },
});
