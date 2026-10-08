/**
 * Timeline — sign-ups hour by hour, who brings them in, and what the best
 * weeks have in common.
 *
 *   • Dates: Today, Yesterday, This week, Last week, Last 4 weeks, or any
 *     From and To.
 *   • Teams (Admins and Coach+): the whole office, or any teams together. A
 *     Coach gets their own team. The choice is remembered on this device.
 *   • Sign-ups by hour: a bar for each hour of the field day. Tap a bar for
 *     that hour's sign-ups, how many BAs were out, and who signed people up.
 *   • BAs: sign-ups, sign-ups per hour in the field, best hour, and a strip
 *     of their own hours.
 *   • An average day: first door, last door, time in the field, sector break
 *     (last door of lap 1 to first door of lap 2).
 *   • Patterns: the last 12 weeks ranked by sign-ups and cut into best,
 *     average and low, with the same day facts for each.
 *
 * With `userId` it is one person's own timeline (the person page); `embedded`
 * drops the page scroll and shell so it sits inside another card.
 *
 * Everything comes from GET /insights/field. Dark forest green in both themes,
 * like the Performance Hub it sits beside.
 */
import React, { createElement, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, LayoutChangeEvent, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fonts } from '../../theme/ThemeContext';
import { apiService } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { addDays, hourLabel, prettyDate, rangeLabel, startOfWeek, todayISO } from '../../utils/calendarDates';
import DateField from '../ui/DateField';

const T = {
  canvas: '#07170f',
  tile: '#102d25',
  raised: '#163a2d',
  inset: 'rgba(5,15,11,0.45)',
  line: 'rgba(183,223,88,0.14)',
  lineSoft: 'rgba(238,244,230,0.07)',
  text: '#eef4e6',
  muted: '#9fb8a8',
  faint: 'rgba(159,184,168,0.55)',
  lime: '#b7df58',
  onLime: '#102d25',
  amber: '#e7b65c',
};

type Icon = React.ComponentProps<typeof Ionicons>['name'];
type Hour = { hour: number; sales: number; doors: number; spoken: number; pitched: number; ba_hours: number; people: number; per_ba_hour: number };
type Ba = {
  oid: string; name: string; days: number; sales: number; doors: number; spoken: number;
  hours: Record<string, { sales: number; doors: number; n: number }>;
  field_hours: number; per_hour: number; best_hour: number | null; team?: string | null; user_id?: string | null;
};
type DayFacts = { first_min: number | null; last_min: number | null; field_minutes: number | null; break_minutes: number | null; doors: number | null; spoken: number | null; sales: number | null };
type Band = DayFacts & { key: 'best' | 'average' | 'low'; label: string; weeks: number; sales_min: number; sales_max: number; sales_per_week: number; days_per_week: number };
type Insights = {
  from: string; to: string;
  scope: { person: { id: string; name: string; linked: boolean } | null; teams: string[]; office_wide: boolean };
  teams: { id: string; name: string }[]; can_pick_no_team: boolean;
  hours: Hour[]; peak_hour: number | null; bas: Ba[];
  totals: { sales: number; doors: number; ba_days: number; people: number };
  averages: DayFacts;
  patterns: { weeks: number; bands: Band[]; from: string; to: string };
  data_from: string | null;
};

type Preset = 'today' | 'yesterday' | 'week' | 'last_week' | '4w' | 'custom';
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'last_week', label: 'Last week' },
  { key: '4w', label: 'Last 4 weeks' },
  { key: 'custom', label: 'Custom' },
];

function rangeOf(preset: Preset, custom: { from: string; to: string }, today: string): { from: string; to: string } {
  const monday = startOfWeek(today);
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last_week': return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case '4w': return { from: addDays(today, -27), to: today };
    case 'custom': return custom.from <= custom.to ? custom : { from: custom.to, to: custom.from };
    default: return { from: monday, to: today };
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Minutes since midnight → '14:53' (the Performance Hub's clock). */
function clockOf(min: number | null | undefined): string {
  if (min === null || min === undefined) return '–';
  const m = Math.round(min);
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}
/** Minutes → '5h 19m' or '40 min'. */
function spanOf(min: number | null | undefined): string {
  if (min === null || min === undefined) return '–';
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad2(m % 60)}m` : `${m} min`;
}
const one = (n: number | null | undefined, dp = 1) => (n === null || n === undefined ? '–' : Number(n).toFixed(dp).replace(/\.0+$/, ''));
const plural = (n: number, word: string) => `${one(n)} ${word}${n === 1 ? '' : 's'}`;
/** '3pm to 4pm' */
const hourSpan = (h: number) => `${hourLabel(h)} to ${hourLabel((h + 1) % 24)}`;

/** What the best weeks did differently from the low weeks, in plain words. */
function differences(best?: Band, low?: Band): string[] {
  if (!best || !low) return [];
  const out: string[] = [];
  const gap = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round(a - b));
  const first = gap(best.first_min, low.first_min);
  if (first !== null && Math.abs(first) >= 5) out.push(`First door ${Math.abs(first)} min ${first < 0 ? 'earlier' : 'later'}`);
  const last = gap(best.last_min, low.last_min);
  if (last !== null && Math.abs(last) >= 5) out.push(`Last door ${Math.abs(last)} min ${last > 0 ? 'later' : 'earlier'}`);
  const field = gap(best.field_minutes, low.field_minutes);
  if (field !== null && Math.abs(field) >= 10) out.push(`${spanOf(Math.abs(field))} ${field > 0 ? 'longer' : 'less'} in the field`);
  const brk = gap(best.break_minutes, low.break_minutes);
  if (brk !== null && Math.abs(brk) >= 5) out.push(`Sector break ${Math.abs(brk)} min ${brk < 0 ? 'shorter' : 'longer'}`);
  const doors = gap(best.doors, low.doors);
  if (doors !== null && Math.abs(doors) >= 5) out.push(`${Math.abs(doors)} ${doors > 0 ? 'more' : 'fewer'} doors a day`);
  return out;
}

export default function FieldInsights({ userId, embedded, bottomPad = 24, onOpenPerson }: {
  userId?: string;
  embedded?: boolean;
  bottomPad?: number;
  onOpenPerson?: (id: string) => void;
}) {
  const { user } = useAuth();
  const today = todayISO();
  const [w, setW] = useState(0);
  const [preset, setPreset] = useState<Preset>(userId ? '4w' : 'week');
  const [custom, setCustom] = useState({ from: addDays(today, -6), to: today });
  const [teams, setTeams] = useState<string[]>([]);
  const [hour, setHour] = useState<number | null>(null);
  const [sort, setSort] = useState<'sales' | 'rate'>('sales');
  const [showAll, setShowAll] = useState(false);

  // The office view remembers its dates and teams on this device.
  const storeKey = userId ? null : `vh.timeline.v1:${user?.id || ''}`;
  const [ready, setReady] = useState(!storeKey);
  useEffect(() => {
    if (!storeKey) return;
    let live = true;
    AsyncStorage.getItem(storeKey)
      .then((raw) => {
        if (!live || !raw) return;
        const v = JSON.parse(raw);
        if (PRESETS.some((p) => p.key === v?.preset)) setPreset(v.preset);
        if (/^\d{4}-\d\d-\d\d$/.test(v?.from || '') && /^\d{4}-\d\d-\d\d$/.test(v?.to || '')) setCustom({ from: v.from, to: v.to });
        if (Array.isArray(v?.teams)) setTeams(v.teams.map(String));
      })
      .catch(() => {})
      .finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [storeKey]);
  useEffect(() => {
    if (!storeKey || !ready) return;
    AsyncStorage.setItem(storeKey, JSON.stringify({ preset, from: custom.from, to: custom.to, teams })).catch(() => {});
  }, [storeKey, ready, preset, custom, teams]);

  const range = rangeOf(preset, custom, today);
  const q = useQuery({
    queryKey: ['field-insights', userId || '', range.from, range.to, teams.join(',')],
    queryFn: async () => (await apiService.getFieldInsights({ from: range.from, to: range.to, teams, userId })).data as Insights,
    enabled: ready,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const d = q.data;

  // A remembered team that no longer exists is dropped.
  useEffect(() => {
    if (!d || userId) return;
    const known = new Set([...d.teams.map((t) => t.id), ...(d.can_pick_no_team ? ['none'] : [])]);
    if (teams.some((t) => !known.has(t))) setTeams(teams.filter((t) => known.has(t)));
  }, [d, teams, userId]);

  // Every hour between the first and the last, so the bars read as a clock.
  const hours = useMemo<Hour[]>(() => {
    const got = d?.hours || [];
    if (!got.length) return [];
    const by = new Map(got.map((h) => [h.hour, h]));
    const out: Hour[] = [];
    for (let h = got[0].hour; h <= got[got.length - 1].hour; h++) {
      out.push(by.get(h) || { hour: h, sales: 0, doors: 0, spoken: 0, pitched: 0, ba_hours: 0, people: 0, per_ba_hour: 0 });
    }
    return out;
  }, [d]);
  const top = Math.max(1, ...hours.map((h) => h.sales));
  const sel = hours.find((h) => h.hour === hour) || hours.find((h) => h.hour === d?.peak_hour) || null;

  const bas = useMemo(() => {
    const list = [...(d?.bas || [])];
    if (sort === 'rate') list.sort((a, b) => b.per_hour - a.per_hour || b.sales - a.sales || a.name.localeCompare(b.name));
    return list;
  }, [d, sort]);
  const inHour = useMemo(() => {
    if (!sel || !d) return [];
    return d.bas
      .map((b) => ({ b, n: b.hours[String(sel.hour)]?.sales || 0 }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || a.b.name.localeCompare(b.b.name));
  }, [d, sel]);

  const wide = w >= 760;
  const person = !!userId;
  const Block = embedded ? st.blockIn : st.block;
  const toggleTeam = (id: string) => setTeams((cur) => (cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id]));
  const teamChips = d && !person ? [...d.teams, ...(d.can_pick_no_team ? [{ id: 'none', name: 'No team' }] : [])] : [];
  const pickTeams = !!d && !person && (d.scope.office_wide || d.teams.length > 1);
  const scopeWord = person ? '' : teams.length
    ? teamChips.filter((t) => teams.includes(t.id)).map((t) => t.name).join(' + ')
    : d?.scope.office_wide ? 'Whole office' : (d?.teams || []).map((t) => t.name).join(' + ') || 'My team';
  const best = d?.patterns.bands.find((b) => b.key === 'best');
  const low = d?.patterns.bands.find((b) => b.key === 'low');
  const diffs = differences(best, low);
  const hasDays = !!d && d.totals.ba_days > 0;

  const body = (
    <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} testID="timeline">
      {/* ── Dates ─────────────────────────────────────────────────────── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.rowScroll} contentContainerStyle={st.chipRow}>
        {PRESETS.map((p) => (
          <Pressable key={p.key} onPress={() => { setPreset(p.key); setHour(null); }} style={[st.chip, preset === p.key && st.chipOn]}
            accessibilityRole="button" accessibilityState={{ selected: preset === p.key }} testID={`timeline-range-${p.key}`}>
            {p.key === 'custom' ? <Ionicons name="calendar-outline" size={12} color={preset === p.key ? T.onLime : T.muted} /> : null}
            <Text style={[st.chipText, preset === p.key && st.chipTextOn]}>{p.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {preset === 'custom' && (
        <View style={st.customRow}>
          <DatePill label="From" value={custom.from} max={today} onChange={(v) => v && setCustom((c) => ({ from: v, to: c.to < v ? v : c.to }))} testID="timeline-from" />
          <DatePill label="To" value={custom.to} max={today} onChange={(v) => v && setCustom((c) => ({ from: c.from > v ? v : c.from, to: v }))} testID="timeline-to" />
        </View>
      )}

      {/* ── Teams ─────────────────────────────────────────────────────── */}
      {pickTeams && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.rowScroll} contentContainerStyle={st.chipRow}>
          <Pressable onPress={() => setTeams([])} style={[st.team, !teams.length && st.teamOn]} accessibilityRole="button"
            accessibilityState={{ selected: !teams.length }} testID="timeline-team-all">
            <Ionicons name="business-outline" size={12} color={!teams.length ? T.lime : T.muted} />
            <Text style={[st.teamText, !teams.length && { color: T.text }]}>{d?.scope.office_wide ? 'Whole office' : 'All my teams'}</Text>
          </Pressable>
          {teamChips.map((t) => {
            const on = teams.includes(t.id);
            return (
              <Pressable key={t.id} onPress={() => toggleTeam(t.id)} style={[st.team, on && st.teamOn]} accessibilityRole="button"
                accessibilityState={{ selected: on }} testID={`timeline-team-${t.id}`}>
                {on ? <Ionicons name="checkmark" size={12} color={T.lime} /> : null}
                <Text style={[st.teamText, on && { color: T.text }]} numberOfLines={1}>{t.name}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      <View style={st.caption}>
        <Text style={st.captionText} numberOfLines={2}>
          {range.from === range.to ? prettyDate(range.from) : rangeLabel(range.from, range.to)}{scopeWord ? ` · ${scopeWord}` : ''}
        </Text>
        {q.isFetching ? <ActivityIndicator size="small" color={T.lime} /> : null}
      </View>

      {!d ? (
        q.isError ? (
          <View style={st.centre}>
            <Ionicons name="alert-circle-outline" size={26} color={T.muted} />
            <Text style={st.note}>Couldn't load the timeline. Check your connection and try again.</Text>
            <Pressable onPress={() => q.refetch()} style={st.retry}><Text style={st.retryText}>Try again</Text></Pressable>
          </View>
        ) : (
          <View style={st.centre}><ActivityIndicator color={T.lime} /></View>
        )
      ) : person && d.scope.person && !d.scope.person.linked ? (
        <Text style={st.empty}>{d.scope.person.name.split(' ')[0]} isn't linked to OwnerIQ yet, so there are no door logs to show. Add their badge number in Admin.</Text>
      ) : !hasDays ? (
        <View style={st.centre} testID="timeline-empty">
          <Ionicons name="time-outline" size={26} color={T.muted} />
          <Text style={st.note}>
            No door logs for these dates.{' '}
            {d.data_from ? `Door logs are kept from ${prettyDate(d.data_from)}; earlier weeks are still being copied across from OwnerIQ.` : 'Door logs are being copied across from OwnerIQ, a day at a time. Check back shortly.'}
          </Text>
        </View>
      ) : (
        <>
          {/* ── Headline figures ──────────────────────────────────────── */}
          <View style={st.grid}>
            <Stat wide={wide} embedded={embedded} label="Sign-ups" value={String(d.totals.sales)}
              sub={person ? plural(d.totals.ba_days, 'day') + ' out' : `${plural(d.totals.people, 'BA')} · ${plural(d.totals.ba_days, 'day')} out`} />
            <Stat wide={wide} embedded={embedded} label="Best hour" value={d.peak_hour === null ? '–' : hourLabel(d.peak_hour)}
              sub={d.peak_hour === null ? 'No sign-ups yet' : `to ${hourLabel((d.peak_hour + 1) % 24)} · ${plural(hours.find((h) => h.hour === d.peak_hour)?.sales || 0, 'sign-up')}`} lime />
            <Stat wide={wide} embedded={embedded} label="Sign-ups a day out" value={one(d.averages.sales, 2)} sub={`${one(d.averages.doors, 0)} doors a day`} />
            <Stat wide={wide} embedded={embedded} label="Time in the field" value={spanOf(d.averages.field_minutes)} sub={`${clockOf(d.averages.first_min)} to ${clockOf(d.averages.last_min)}`} />
          </View>

          {/* ── Sign-ups by hour ──────────────────────────────────────── */}
          <View style={Block}>
            <Head icon="bar-chart-outline" text="Sign-ups by hour" hint="Tap an hour" />
            <View style={st.chart}>
              {hours.map((h) => {
                const on = sel?.hour === h.hour;
                return (
                  <Pressable key={h.hour} onPress={() => setHour(h.hour)} style={st.col} accessibilityRole="button"
                    accessibilityLabel={`${hourSpan(h.hour)}: ${plural(h.sales, 'sign-up')}`} accessibilityState={{ selected: on }} testID={`timeline-hour-${h.hour}`}>
                    <Text style={[st.barValue, on && { color: T.lime }]}>{h.sales ? h.sales : ''}</Text>
                    <View style={st.barTrack}>
                      <View style={[st.bar, { height: `${Math.max((h.sales / top) * 100, 2)}%` }, on && st.barOn]} />
                    </View>
                    <Text style={[st.barLabel, on && { color: T.text }]} numberOfLines={1}>{hourLabel(h.hour)}</Text>
                  </Pressable>
                );
              })}
            </View>
            {sel && (
              <View style={st.hourBox} testID="timeline-hour-detail">
                <View style={st.hourHead}>
                  <Text style={st.hourTitle}>{hourSpan(sel.hour)}</Text>
                  {sel.hour === d.peak_hour ? <View style={st.tag}><Text style={st.tagText}>Best hour</Text></View> : null}
                </View>
                <View style={st.factRow}>
                  <Mini value={String(sel.sales)} label={sel.sales === 1 ? 'sign-up' : 'sign-ups'} />
                  <Mini value={String(person ? sel.ba_hours : sel.people)} label={person ? (sel.ba_hours === 1 ? 'day out' : 'days out') : (sel.people === 1 ? 'BA out' : 'BAs out')} />
                  <Mini value={one(sel.per_ba_hour, 2)} label={person ? 'a day' : 'per BA'} />
                  <Mini value={String(sel.doors)} label="doors" />
                </View>
                {!person && (
                  inHour.length ? (
                    <View style={st.whoRow}>
                      {inHour.slice(0, 8).map(({ b, n }) => (
                        <Pressable key={b.oid} disabled={!b.user_id || !onOpenPerson} onPress={() => b.user_id && onOpenPerson?.(b.user_id)} style={st.who}>
                          <Text style={st.whoName} numberOfLines={1}>{b.name}</Text>
                          <Text style={st.whoN}>{n}</Text>
                        </Pressable>
                      ))}
                      {inHour.length > 8 ? <Text style={st.more}>+{inHour.length - 8} more</Text> : null}
                    </View>
                  ) : (
                    <Text style={st.empty}>Nobody signed anyone up in this hour.</Text>
                  )
                )}
              </View>
            )}
          </View>

          {/* ── BAs ───────────────────────────────────────────────────── */}
          {!person && (
            <View style={Block} testID="timeline-bas">
              <View style={st.headRow}>
                <Head icon="people-outline" text="BAs" flush />
                <View style={st.seg}>
                  {([['sales', 'Sign-ups'], ['rate', 'Per hour']] as const).map(([k, label]) => (
                    <Pressable key={k} onPress={() => setSort(k)} style={[st.segBtn, sort === k && st.segOn]} accessibilityRole="button"
                      accessibilityState={{ selected: sort === k }} testID={`timeline-sort-${k}`}>
                      <Text style={[st.segText, sort === k && { color: T.onLime }]}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              {wide ? (
                <View style={[st.baRow, st.baHeadRow]}>
                  <Text style={[st.th, { width: 26 }]}>#</Text>
                  <Text style={[st.th, { flex: 1.3, textAlign: 'left' }]}>BA</Text>
                  <View style={{ flex: 1.5, minWidth: 0 }}><StripAxis hours={hours} /></View>
                  <Text style={[st.th, st.num]}>Sign-ups</Text>
                  <Text style={[st.th, st.num]}>Per hour</Text>
                  <Text style={[st.th, st.num]}>Best hour</Text>
                </View>
              ) : (
                <View style={st.axisPhone}><StripAxis hours={hours} /></View>
              )}
              {(showAll ? bas : bas.slice(0, 10)).map((b, i) => {
                const open = b.user_id && onOpenPerson ? () => onOpenPerson(b.user_id as string) : undefined;
                const strip = <Strip ba={b} hours={hours} />;
                return wide ? (
                  <Pressable key={b.oid} onPress={open} disabled={!open} style={st.baRow} testID={`timeline-ba-${b.oid}`}>
                    <Text style={st.rank}>{i + 1}</Text>
                    <View style={{ flex: 1.3, minWidth: 0 }}>
                      <Text style={st.baName} numberOfLines={1}>{b.name}</Text>
                      <Text style={st.baSub} numberOfLines={1}>{b.team || 'No team'} · {plural(b.days, 'day')} out</Text>
                    </View>
                    <View style={{ flex: 1.5, minWidth: 0 }}>{strip}</View>
                    <Text style={[st.num, st.big]}>{b.sales}</Text>
                    <Text style={[st.num, st.cell]}>{one(b.per_hour, 2)}</Text>
                    <Text style={[st.num, st.cell]}>{b.best_hour === null ? '–' : hourLabel(b.best_hour)}</Text>
                  </Pressable>
                ) : (
                  <Pressable key={b.oid} onPress={open} disabled={!open} style={st.baCard} testID={`timeline-ba-${b.oid}`}>
                    <View style={st.baCardTop}>
                      <Text style={st.rank}>{i + 1}</Text>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={st.baName} numberOfLines={2}>{b.name}</Text>
                        <Text style={st.baSub} numberOfLines={1}>{b.team || 'No team'} · {plural(b.days, 'day')} out</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={st.big}>{b.sales}</Text>
                        <Text style={st.baSub}>{one(b.per_hour, 2)} an hour</Text>
                      </View>
                    </View>
                    {strip}
                  </Pressable>
                );
              })}
              {bas.length > 10 && (
                <Pressable onPress={() => setShowAll((v) => !v)} style={st.moreBtn} accessibilityRole="button" testID="timeline-show-all">
                  <Text style={st.moreBtnText}>{showAll ? 'Show the top 10' : `Show all ${bas.length}`}</Text>
                  <Ionicons name={showAll ? 'chevron-up' : 'chevron-down'} size={13} color={T.muted} />
                </Pressable>
              )}
              <Text style={st.foot}>Per hour is sign-ups for each hour in the field, first door to last door.</Text>
            </View>
          )}

          {/* ── An average day ────────────────────────────────────────── */}
          <View style={Block} testID="timeline-day">
            <Head icon="sunny-outline" text="An average day" hint={`${plural(d.totals.ba_days, 'day')} out`} />
            <View style={st.factRow}>
              <Mini value={clockOf(d.averages.first_min)} label="first door" />
              <Mini value={clockOf(d.averages.last_min)} label="last door" />
              <Mini value={spanOf(d.averages.field_minutes)} label="in the field" />
              <Mini value={spanOf(d.averages.break_minutes)} label="sector break" />
            </View>
            <Text style={st.foot}>Sector break is the last door of lap 1 to the first door of lap 2.</Text>
          </View>
        </>
      )}

      {/* ── Patterns: best, average and low weeks ───────────────────── */}
      {d && !(person && d.scope.person && !d.scope.person.linked) && (d.patterns.weeks > 0 || hasDays) && (
        <View style={Block} testID="timeline-patterns">
          <Head icon="git-compare-outline" text="Patterns" hint="Last 12 weeks" />
          {best && low ? (
            <>
              <Text style={st.lead}>
                {person ? 'Their weeks' : "Every BA's week"}, ranked by sign-ups and cut into thirds. {plural(d.patterns.weeks, person ? 'week' : 'BA week')}.
              </Text>
              <View style={[st.pRow, st.pHead]}>
                <Text style={[st.pLabel, st.th, { textAlign: 'left' }]}> </Text>
                {d.patterns.bands.map((b) => (
                  <View key={b.key} style={st.pCol}>
                    <Text style={[st.pBand, b.key === 'best' && { color: T.lime }, b.key === 'low' && { color: T.amber }]}>{b.key === 'best' ? 'Best' : b.key === 'low' ? 'Low' : 'Average'}</Text>
                    <Text style={st.pBandSub}>{b.sales_min === b.sales_max ? b.sales_min : `${b.sales_min}–${b.sales_max}`} a week</Text>
                  </View>
                ))}
              </View>
              {([
                ['Sign-ups a week', (b: Band) => one(b.sales_per_week)],
                ['Days out a week', (b: Band) => one(b.days_per_week)],
                ['First door', (b: Band) => clockOf(b.first_min)],
                ['Last door', (b: Band) => clockOf(b.last_min)],
                ['Time in the field', (b: Band) => spanOf(b.field_minutes)],
                ['Sector break', (b: Band) => spanOf(b.break_minutes)],
                ['Doors a day', (b: Band) => one(b.doors, 0)],
                ['Spoken to a day', (b: Band) => one(b.spoken, 0)],
              ] as [string, (b: Band) => string][]).map(([label, get]) => (
                <View key={label} style={st.pRow}>
                  <Text style={st.pLabel} numberOfLines={1}>{label}</Text>
                  {d.patterns.bands.map((b) => (
                    <Text key={b.key} style={[st.pCol, st.pValue, b.key === 'best' && { color: T.text, fontFamily: fonts.bodyBold }]}>{get(b)}</Text>
                  ))}
                </View>
              ))}
              {diffs.length ? (
                <View style={st.diffBox}>
                  <Text style={st.diffTitle}>Best weeks against low weeks</Text>
                  {diffs.map((t) => (
                    <View key={t} style={st.diffRow}>
                      <Ionicons name="arrow-forward" size={12} color={T.lime} />
                      <Text style={st.diffText}>{t}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={st.foot}>The best and the low weeks look alike on these measures so far.</Text>
              )}
            </>
          ) : (
            <Text style={st.empty}>
              Patterns compare the best, average and low weeks, and need at least three {person ? 'weeks' : 'BA weeks'} of door logs. So far there {d.patterns.weeks === 1 ? 'is' : 'are'} {d.patterns.weeks}.
            </Text>
          )}
        </View>
      )}

      {d?.data_from && !embedded ? <Text style={st.updated}>Door logs from OwnerIQ, kept from {prettyDate(d.data_from)}</Text> : null}
    </View>
  );

  if (embedded) return body;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: bottomPad }} showsVerticalScrollIndicator={Platform.OS === 'web'}>
      <View style={st.shell}>{body}</View>
    </ScrollView>
  );
}

function Head({ icon, text, hint, flush }: { icon: Icon; text: string; hint?: string; flush?: boolean }) {
  return (
    <View style={[st.head, flush && { marginBottom: 0 }]}>
      <Ionicons name={icon} size={12} color={T.muted} />
      <Text style={st.headText}>{text}</Text>
      {hint ? <Text style={st.headHint}>{hint}</Text> : null}
    </View>
  );
}

function Stat({ label, value, sub, wide, embedded, lime }: { label: string; value: string; sub: string; wide: boolean; embedded?: boolean; lime?: boolean }) {
  return (
    <View style={{ width: wide ? '25%' : '50%', padding: 4 }}>
      <View style={[st.stat, embedded && { backgroundColor: T.inset }]}>
        <Text style={st.statLabel} numberOfLines={1}>{label}</Text>
        <Text style={[st.statValue, lime && { color: T.lime }]} numberOfLines={1}>{value}</Text>
        <Text style={st.statSub} numberOfLines={1}>{sub}</Text>
      </View>
    </View>
  );
}

function Mini({ value, label }: { value: string; label: string }) {
  return (
    <View style={st.mini}>
      <Text style={st.miniValue} numberOfLines={1}>{value}</Text>
      <Text style={st.miniLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

/** One BA's sign-ups for each hour on the chart: the stronger the lime, the more. */
function Strip({ ba, hours }: { ba: Ba; hours: Hour[] }) {
  const most = Math.max(1, ...Object.values(ba.hours).map((h) => h.sales));
  return (
    <View style={st.strip}>
      {hours.map((h) => {
        const cell = ba.hours[String(h.hour)];
        const n = cell?.sales || 0;
        return (
          <View key={h.hour} style={[st.stripCell, cell ? { backgroundColor: 'rgba(238,244,230,0.07)' } : null,
            n > 0 ? { backgroundColor: `rgba(183,223,88,${0.3 + 0.7 * (n / most)})` } : null]}>
            <Text style={[st.stripText, n > 0 && { color: T.onLime }]}>{n > 0 ? n : ''}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** The hours the strips line up under. */
function StripAxis({ hours }: { hours: Hour[] }) {
  return (
    <View style={st.strip}>
      {hours.map((h) => <Text key={h.hour} style={st.axisText} numberOfLines={1}>{hourLabel(h.hour)}</Text>)}
    </View>
  );
}

/** A date pill for the dark canvas. On the web it is the browser's own date
 *  picker stretched, unseen, over the pill. */
function DatePill({ label, value, onChange, max, testID }: { label: string; value: string; onChange: (iso: string) => void; max?: string; testID?: string }) {
  if (Platform.OS !== 'web') return <DateField label={label} value={value} onChange={onChange} maxDate={max} testID={testID} />;
  return (
    <View style={st.datePill}>
      <Text style={st.dateLabel}>{label}</Text>
      <Text style={st.dateText}>{prettyDate(value)}</Text>
      <Ionicons name="chevron-down" size={12} color={T.muted} />
      {createElement('input', {
        type: 'date',
        value,
        max: max || undefined,
        onChange: (e: any) => onChange(e.target.value || ''),
        // Desktop browsers only open the calendar from its own little icon,
        // which is unseen here: open it on any click.
        onClick: (e: any) => {
          const el = e.currentTarget;
          if (typeof el?.showPicker === 'function') { try { el.showPicker(); } catch { /* not supported */ } }
        },
        'data-testid': testID,
        'aria-label': label,
        // 16px stops iOS Safari zooming in on focus.
        style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', opacity: 0, border: 'none', margin: 0, padding: 0, cursor: 'pointer', fontSize: 16, colorScheme: 'dark' },
      })}
    </View>
  );
}

const tab = { fontVariant: ['tabular-nums'] as any };
const st = StyleSheet.create({
  shell: { width: '100%', maxWidth: 1240, alignSelf: 'center', backgroundColor: T.canvas, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: T.lineSoft },
  rowScroll: { flexGrow: 0, marginBottom: 8 },
  chipRow: { gap: 6, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34, paddingHorizontal: 13, borderRadius: 10, backgroundColor: T.tile, borderWidth: 1, borderColor: T.lineSoft },
  chipOn: { backgroundColor: T.lime, borderColor: T.lime },
  chipText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: T.muted },
  chipTextOn: { color: T.onLime, fontFamily: fonts.bodyBold },
  customRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  datePill: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingHorizontal: 12, borderRadius: 10, backgroundColor: T.tile, borderWidth: 1, borderColor: T.line },
  dateLabel: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: T.muted },
  dateText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: T.text },
  team: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: T.lineSoft, maxWidth: 200 },
  teamOn: { backgroundColor: T.raised, borderColor: T.lime },
  teamText: { fontFamily: fonts.bodySemibold, fontSize: 12, color: T.muted },
  caption: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 22, marginTop: 2, marginBottom: 8 },
  captionText: { flex: 1, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.4, color: T.muted },

  centre: { alignItems: 'center', gap: 10, paddingVertical: 44, paddingHorizontal: 12 },
  note: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: T.muted, textAlign: 'center', maxWidth: 420 },
  retry: { minHeight: 38, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: T.line, backgroundColor: T.raised, justifyContent: 'center' },
  retryText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: T.text },
  empty: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: T.muted, marginTop: 6 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', margin: -4, marginBottom: 8 },
  stat: { borderRadius: 14, borderWidth: 1, borderColor: T.lineSoft, backgroundColor: T.tile, padding: 12 },
  statLabel: { fontFamily: fonts.bodySemibold, fontSize: 12, color: T.muted },
  statValue: { fontFamily: fonts.display, fontSize: 26, letterSpacing: -0.6, color: T.text, marginTop: 4, ...tab },
  statSub: { fontFamily: fonts.body, fontSize: 11, color: T.faint, marginTop: 2 },

  block: { backgroundColor: T.tile, borderRadius: 14, borderWidth: 1, borderColor: T.lineSoft, padding: 14, marginBottom: 12 },
  blockIn: { backgroundColor: T.inset, borderRadius: 14, borderWidth: 1, borderColor: T.lineSoft, padding: 12, marginBottom: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  headText: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.4, textTransform: 'uppercase', color: T.muted },
  headHint: { marginLeft: 'auto', fontFamily: fonts.body, fontSize: 11, color: T.faint },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 },

  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 172 },
  col: { flex: 1, minWidth: 0, alignItems: 'center', height: '100%', justifyContent: 'flex-end' },
  barValue: { fontFamily: fonts.bodyBold, fontSize: 12, color: T.muted, minHeight: 17, ...tab },
  barTrack: { width: '86%', maxWidth: 96, height: 124, justifyContent: 'flex-end', borderRadius: 6, backgroundColor: 'rgba(238,244,230,0.03)' },
  bar: { width: '100%', borderRadius: 6, backgroundColor: 'rgba(183,223,88,0.34)' },
  barOn: { backgroundColor: T.lime },
  barLabel: { fontFamily: fonts.mono, fontSize: 10, color: T.muted, marginTop: 7, height: 14 },
  hourBox: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(183,223,88,0.06)', borderWidth: 1, borderColor: T.line },
  hourHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  hourTitle: { fontFamily: fonts.display, fontSize: 17, color: T.text },
  tag: { paddingHorizontal: 8, height: 20, borderRadius: 10, justifyContent: 'center', backgroundColor: T.lime },
  tagText: { fontFamily: fonts.bodyBold, fontSize: 10.5, color: T.onLime },
  factRow: { flexDirection: 'row' },
  mini: { flex: 1, minWidth: 0, alignItems: 'center' },
  miniValue: { fontFamily: fonts.display, fontSize: 19, color: T.text, ...tab },
  miniLabel: { fontFamily: fonts.body, fontSize: 11, color: T.muted, marginTop: 1 },
  whoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12, alignItems: 'center' },
  who: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 30, paddingLeft: 11, paddingRight: 4, borderRadius: 15, backgroundColor: T.raised, maxWidth: '100%' },
  whoName: { flexShrink: 1, fontFamily: fonts.bodySemibold, fontSize: 12.5, color: T.text },
  whoN: { minWidth: 22, height: 22, borderRadius: 11, textAlign: 'center', lineHeight: 22, overflow: 'hidden', fontFamily: fonts.bodyBold, fontSize: 12, color: T.onLime, backgroundColor: T.lime },
  more: { fontFamily: fonts.body, fontSize: 12, color: T.muted },

  seg: { flexDirection: 'row', padding: 3, borderRadius: 11, backgroundColor: 'rgba(5,15,11,0.55)', borderWidth: 1, borderColor: T.lineSoft },
  segBtn: { minHeight: 30, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: T.lime },
  segText: { fontFamily: fonts.bodySemibold, fontSize: 12, color: T.muted },
  baRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  baHeadRow: { minHeight: 28, paddingVertical: 0 },
  baCard: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.lineSoft, gap: 8 },
  baCardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  th: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: T.muted },
  rank: { width: 26, fontFamily: fonts.mono, fontSize: 11.5, color: T.faint, ...tab },
  baName: { fontFamily: fonts.bodySemibold, fontSize: 13.5, lineHeight: 18, color: T.text },
  baSub: { fontFamily: fonts.body, fontSize: 11, color: T.muted, marginTop: 1 },
  num: { width: 74, textAlign: 'right' },
  big: { fontFamily: fonts.display, fontSize: 18, color: T.text, ...tab },
  cell: { fontFamily: fonts.body, fontSize: 13, color: T.muted, ...tab },
  strip: { flexDirection: 'row', gap: 2 },
  stripCell: { flex: 1, minWidth: 0, height: 20, borderRadius: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(238,244,230,0.025)' },
  stripText: { fontFamily: fonts.bodyBold, fontSize: 10.5, color: T.muted },
  axisText: { flex: 1, minWidth: 0, textAlign: 'center', fontFamily: fonts.mono, fontSize: 9, color: T.faint },
  axisPhone: { paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  moreBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 40, marginTop: 4 },
  moreBtnText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: T.muted },
  foot: { fontFamily: fonts.body, fontSize: 11, lineHeight: 16, color: T.faint, marginTop: 10 },

  lead: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18, color: T.muted, marginBottom: 6 },
  pRow: { flexDirection: 'row', alignItems: 'center', minHeight: 36, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  pHead: { minHeight: 46, alignItems: 'flex-end', paddingBottom: 6 },
  pLabel: { flex: 1.5, minWidth: 0, fontFamily: fonts.body, fontSize: 12.5, color: T.muted },
  pCol: { flex: 1, minWidth: 0, alignItems: 'flex-end' },
  pBand: { fontFamily: fonts.bodyBold, fontSize: 13, color: T.text },
  pBandSub: { fontFamily: fonts.mono, fontSize: 9.5, color: T.faint, marginTop: 1 },
  pValue: { textAlign: 'right', fontFamily: fonts.body, fontSize: 13, color: T.muted, ...tab },
  diffBox: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(183,223,88,0.06)', borderWidth: 1, borderColor: T.line, gap: 6 },
  diffTitle: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.2, textTransform: 'uppercase', color: T.muted, marginBottom: 2 },
  diffRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  diffText: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13, color: T.text },
  updated: { fontFamily: fonts.mono, fontSize: 10.5, color: T.faint, textAlign: 'center', letterSpacing: 0.4, marginTop: 2 },
});
