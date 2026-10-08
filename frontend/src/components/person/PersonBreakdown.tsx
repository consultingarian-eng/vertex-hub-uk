/**
 * One person, on one page — what an Admin gets by tapping a name.
 *
 *   • Who they are: role, stage, Coach, team, badge number, how to reach them.
 *   • Their week in the field (Field IQ, as the hourly OwnerIQ sync stored it):
 *     sign-ups against target, piece average, scoring, reliability, points and
 *     a tile for each day. Opens on this week; the arrows step back through
 *     earlier weeks.
 *   • Law of averages: doors → spoken → presented → closed → sign-ups, per day
 *     in the field, beside the office's average, with how each step converts
 *     and how many of each it takes to get one sign-up.
 *   • COD: the stage they are working on and how much of every stage has been
 *     marked off; Days 1-8 for a new start.
 *   • Their ID badge: preview and print it, or make one, without leaving.
 *
 * Everything comes from GET /people/{id}/breakdown. Dark forest green in both
 * themes, like the Performance Hub it sits beside.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Image, ScrollView, ActivityIndicator, LayoutChangeEvent, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { fonts } from '../../theme/ThemeContext';
import { apiService } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useTabBarClearance } from '../../customization/CustomTabBar';
import { APP_LOCALE, APP_TZ, formatMoney } from '../../utils/appTime';
import { DAY_SHORT, dowOf, rangeLabel } from '../../utils/calendarDates';
import { PersonBadgeFlow } from '../badges/BadgeStudio';
import FieldInsights from '../insights/FieldInsights';

const P = {
  canvas: '#07170f',
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
  redText: '#fca5a5',
  redBg: 'rgba(248,113,113,0.14)',
  amber: '#e7b65c',
  amberBg: 'rgba(231,182,92,0.14)',
};

type Icon = React.ComponentProps<typeof Ionicons>['name'];
type Loa = {
  from: string; to: string; active_days: number;
  totals: Record<string, number>; avg_per_day: Record<string, number>;
  steps: { from: string; to: string; pct: number | null }[];
  to_one_sale: Record<string, number | null>;
  office_avg_per_day: Record<string, number> | null;
};
type Stage = { stage: number; label: string; name: string; done: number; met: number; total: number; complete: boolean; current: boolean };

// `th` is the column heading in the day-by-day table, where a phone leaves
// each column about 55px: "Presented" shortens to "Pres." there only.
const FUNNEL: { key: string; label: string; th: string; one: string; icon: Icon }[] = [
  { key: 'doors_knocked', label: 'Doors', th: 'Doors', one: 'doors', icon: 'home-outline' },
  { key: 'spoken_to', label: 'Spoken', th: 'Spoken', one: 'spoken to', icon: 'chatbubbles-outline' },
  { key: 'pitches_commenced', label: 'Presented', th: 'Pres.', one: 'presented', icon: 'easel-outline' },
  { key: 'pitches_closed', label: 'Closed', th: 'Closed', one: 'closed', icon: 'hand-left-outline' },
  { key: 'sales', label: 'Sign-ups', th: 'Signed', one: 'sign-ups', icon: 'ribbon-outline' },
];

const ROLE_WORD: Record<string, string> = { trainee: 'BA', leader: 'Coach', admin: 'Admin' };
// A Coach looking at a new start who isn't theirs gets `limited`: development
// only (COD and Days 1-8). Badges show only when the server says `can_badge`
// (Admins and Coach+).
const initials = (n: string) => (n || '?').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
const num = (v: number | null | undefined, dp = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toLocaleString(APP_LOCALE, { maximumFractionDigits: dp });
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v)}%`);
const ukDate = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(APP_LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const shortDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY_SHORT[dowOf(iso)]} ${d.toLocaleDateString(APP_LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
};
const clockTime = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(APP_LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: APP_TZ });
};

export function PersonBreakdown({ id }: { id: string }) {
  const pad = useTabBarClearance();
  const { user } = useAuth();
  const [w, setW] = useState(0);
  const [range, setRange] = useState<'week' | 'recent'>('recent');
  const [daysOpen, setDaysOpen] = useState(false);
  const [badgeOpen, setBadgeOpen] = useState(false);
  const [weekAt, setWeekAt] = useState(0);   // 0 = this week, 1 = last week…
  const q = useQuery({
    enabled: !!id,
    queryKey: ['person-breakdown', id],
    queryFn: () => apiService.getPersonBreakdown(id).then((r) => r.data),
    staleTime: 60_000,
  });
  const d: any = q.data;
  const wide = w >= 820;

  if (q.isLoading) {
    return <View style={[s.page, s.centre]}><ActivityIndicator color={P.lime} /><Text style={s.note}>Loading…</Text></View>;
  }
  if (q.isError || !d) {
    const detail = (q.error as any)?.response?.data?.detail;
    return (
      <View style={[s.page, s.centre]}>
        <Ionicons name="alert-circle-outline" size={30} color={P.muted} />
        <Text style={s.note}>{typeof detail === 'string' ? detail : "Couldn't load this person. Check your connection and try again."}</Text>
        <Pressable onPress={() => q.refetch()} style={s.btnGhost}><Text style={s.btnGhostText}>Try again</Text></Pressable>
      </View>
    );
  }

  const p = d.person;
  const isSelf = String(user?.id) === String(p.id);
  const badge = (d.badges || [])[0] || null;
  const role = p.is_super_admin ? 'Owner' : p.coach_plus ? 'Coach+' : ROLE_WORD[p.role] || p.role;
  const limited = !!d.limited;
  const canBadge = !!d.can_badge;
  const cod = d.cod || { stages: [] };
  const ns = cod.new_start;
  const current: Stage | undefined = (cod.stages || []).find((x: Stage) => x.current);
  const canOpenCod = !isSelf && !!d.can_open_cod;
  const loa: Loa = limited ? ({} as Loa) : d.loa[range];
  const weeks: any[] = d.weeks || [];
  const week = weeks[Math.min(weekAt, weeks.length - 1)] || { week_start: d.today, week_ending: d.week_ending, days: [] };
  const isThisWeek = week.week_ending === d.week_ending;
  const kpis = week.kpis || null;
  const teamName = weeks.find((x) => x.team_name)?.team_name;
  const pastWeeks = weeks.filter((x) => x.kpis);

  return (
    <ScrollView style={s.page} contentContainerStyle={{ padding: 12, paddingBottom: pad + 24 }} showsVerticalScrollIndicator={Platform.OS === 'web'}>
      <View style={s.shell} onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>

        {/* ── Who they are ─────────────────────────────────────────────── */}
        <View style={[s.card, s.head, wide && { flexDirection: 'row', alignItems: 'center' }]}>
          <View style={s.headMain}>
            {p.profile_image ? (
              <Image source={{ uri: p.profile_image }} style={s.avatar} />
            ) : (
              <View style={[s.avatar, s.avatarFallback]}><Text style={s.avatarText}>{initials(p.name)}</Text></View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.name} testID="person-name">{p.name}</Text>
              <View style={s.chips}>
                <Chip text={role} tone="lime" />
                {p.stage ? <Chip text={`Stage ${p.stage}`} /> : null}
                {teamName ? <Chip text={teamName} icon="people-outline" /> : null}
                {!p.is_active ? <Chip text="Inactive" tone="red" /> : null}
                {p.on_starter_password ? <Chip text="Still on the starter password" tone="amber" icon="key-outline" /> : null}
              </View>
            </View>
          </View>
          <View style={[s.actions, wide && { marginTop: 0, justifyContent: 'flex-end' }]}>
            {canBadge && (
            <Pressable onPress={() => setBadgeOpen(true)} style={s.btn} accessibilityRole="button" testID="person-badge-btn">
              <Ionicons name={badge ? 'print-outline' : 'add-circle-outline'} size={16} color={P.onLime} />
              <Text style={s.btnText}>{badge ? 'Print badge' : 'Create badge'}</Text>
            </Pressable>
            )}
            {canOpenCod && (
              <Pressable onPress={() => router.push(`/leader/trainee/${p.id}` as never)} style={s.btnGhost} accessibilityRole="button" testID="person-open-cod">
                <Ionicons name="trending-up-outline" size={15} color={P.text} />
                <Text style={s.btnGhostText}>Open COD</Text>
              </Pressable>
            )}
            {!!ns?.next_assessment_id && (
              <Pressable onPress={() => router.push(`/assessment/${ns.next_assessment_id}` as never)} style={s.btnGhost} accessibilityRole="button">
                <Ionicons name="clipboard-outline" size={15} color={P.text} />
                <Text style={s.btnGhostText}>Grade a day</Text>
              </Pressable>
            )}
          </View>
        </View>

        <View style={[s.cols, wide && { flexDirection: 'row' }]}>
          <View style={[s.card, wide && { flex: 1 }]}>
            <Section icon="person-outline" text="Details" />
            <Fact label="Coach" value={p.coach?.name || 'No Coach assigned'} muted={!p.coach}
              onPress={p.coach && canBadge ? () => router.push(`/person/${p.coach.id}` as never) : undefined} />
            {p.office_name ? <Fact label="Office" value={p.office_name} /> : null}
            {(p.role !== 'trainee' || p.team.total > 0) && (
              <Fact label="Team" value={p.team.total ? `${p.team.direct} direct · ${p.team.total} in all` : 'Nobody under them yet'} muted={!p.team.total} />
            )}
            <Fact label="Started" value={ukDate(p.start_date) || 'Not recorded'} muted={!p.start_date} last={limited} />
            {!limited && (
              <>
            <Fact label="Badge number" value={p.badge_numbers.length ? p.badge_numbers.join(', ') : 'Not added yet'} muted={!p.badge_numbers.length} />
            <Fact label="Email" value={p.email || 'None'} muted={!p.email} onPress={p.email ? () => Linking.openURL(`mailto:${p.email}`).catch(() => {}) : undefined} />
            <Fact label="Phone" value={p.phone || 'No phone number'} muted={!p.phone} last
              onPress={p.phone ? () => Linking.openURL(`tel:${String(p.phone).replace(/[^\d+]/g, '')}`).catch(() => {}) : undefined} />
              </>
            )}
          </View>

          {/* ── COD ───────────────────────────────────────────────────── */}
          <View style={[s.card, wide && { flex: 1.25 }]} testID="person-cod">
            <Section icon="trending-up-outline" text="COD" />
            <Text style={s.lead}>
              {current ? `Working on COD ${current.label} · ${current.name}` : (cod.stages || []).length ? 'Every stage marked off' : 'No COD modules set up yet'}
            </Text>
            {current ? <Text style={s.sub}>{current.done} of {current.total} marked off by a Coach{current.met > current.done ? ` · ${current.met} at the standard` : ''}</Text> : null}
            {ns && (
              <View style={s.days8}>
                <Text style={s.days8Label}>Days 1–8 · Day {Math.min(ns.current_day, 8)} · {ns.days_done}/{ns.days_total} graded</Text>
                <View style={s.dotRow}>
                  {Array.from({ length: 8 }, (_, i) => {
                    const row = (ns.days || []).find((x: any) => x.day === i + 1);
                    const on = !!row?.completed;
                    return (
                      <View key={i} style={[s.dayDot, on && s.dayDotOn, !on && i + 1 === ns.current_day && s.dayDotNow]}>
                        <Text style={[s.dayDotText, on && { color: P.onLime }]}>{i + 1}</Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}
            <View style={{ marginTop: 12, gap: 10 }}>
              {(cod.stages || []).map((st: Stage) => (
                <View key={st.stage} accessibilityLabel={`COD ${st.label}, ${st.name}: ${st.done} of ${st.total} marked off`}>
                  <View style={s.stageHead}>
                    <Text style={[s.stageName, st.current && { color: P.text }]}>COD {st.label} · {st.name}</Text>
                    <Text style={[s.stageValue, st.complete && { color: P.lime }]}>{st.complete ? 'Marked off' : `${st.done}/${st.total}`}</Text>
                  </View>
                  <View style={s.track}>
                    <View style={[s.fillMet, { width: `${Math.min(100, (st.met / st.total) * 100)}%` as any }]} />
                    <View style={[s.fill, { width: `${Math.min(100, (st.done / st.total) * 100)}%` as any }]} />
                  </View>
                </View>
              ))}
            </View>
          </View>
        </View>

        {limited ? (
          <Text style={s.updated}>You're seeing {p.name.split(' ')[0]}'s development. Their field numbers are with their own Coach.</Text>
        ) : (
        <>
        {/* ── This week ────────────────────────────────────────────────── */}
        <View style={s.card} testID="person-week">
          <View style={s.rowBetween}>
            <Section icon="calendar-outline" text={`${isThisWeek ? 'This week' : weekAt === 1 ? 'Last week' : 'Week'} · ${rangeLabel(week.week_start, week.week_ending)}`} />
            {weeks.length > 1 && (
              <View style={s.weekNav}>
                <Pressable onPress={() => setWeekAt((i) => Math.min(weeks.length - 1, i + 1))} disabled={weekAt >= weeks.length - 1}
                  style={[s.navBtn, weekAt >= weeks.length - 1 && { opacity: 0.3 }]} accessibilityLabel="Week before" hitSlop={6} testID="person-week-prev">
                  <Ionicons name="chevron-back" size={16} color={P.text} />
                </Pressable>
                <Pressable onPress={() => setWeekAt((i) => Math.max(0, i - 1))} disabled={weekAt === 0}
                  style={[s.navBtn, weekAt === 0 && { opacity: 0.3 }]} accessibilityLabel="Week after" hitSlop={6} testID="person-week-next">
                  <Ionicons name="chevron-forward" size={16} color={P.text} />
                </Pressable>
              </View>
            )}
          </View>
          {kpis ? (
            <>
              <View style={s.grid}>
                <Kpi label="Sign-ups" value={num(kpis.sales)} sub={kpis.sales_target ? `Target ${num(kpis.sales_target)}` : 'No target set'}
                  good={kpis.sales_target ? (kpis.sales || 0) >= kpis.sales_target : undefined} wide={wide} />
                <Kpi label="Piece average" value={num(kpis.piece_average, 2)} sub="Sign-ups per day in" wide={wide} />
                <Kpi label="Scoring" value={pct(kpis.scoring)} sub="Days with a sign-up" wide={wide} />
                <Kpi label="Reliability" value={pct(kpis.reliability)} sub="Days in vs planned" wide={wide} />
                <Kpi label="Points" value={num(kpis.points)} sub="Field IQ" wide={wide} />
              </View>
              <View style={s.dayRow}>
                {(week.days || []).map((day: any) => {
                  const future = day.date > d.today;
                  const worked = !!(day.in_field || day.checked_in);
                  const tone = day.has_sale ? s.dayGood : worked ? s.dayIn : null;
                  return (
                    <View key={day.date} style={[s.day, tone, day.date === d.today && s.dayToday]}
                      accessibilityLabel={`${DAY_SHORT[dowOf(day.date)]}: ${future ? (day.planned ? 'planned in' : 'not planned') : worked ? `${day.sales_count || 0} sign-ups` : 'not in'}`}>
                      <Text style={s.dayName}>{DAY_SHORT[dowOf(day.date)]}</Text>
                      <Text style={[s.dayValue, !worked && { color: P.faint }]}>{worked ? num(day.sales_count || 0) : future && day.planned ? '·' : '–'}</Text>
                      <Text style={s.dayNote} numberOfLines={1}>{worked ? 'in' : future ? (day.planned ? 'planned' : '') : 'not in'}</Text>
                    </View>
                  );
                })}
              </View>
            </>
          ) : (
            <Text style={s.empty}>
              No Field IQ numbers for {isThisWeek ? 'this week yet' : 'that week'}. They arrive with the hourly OwnerIQ sync once {p.name.split(' ')[0]} is in OwnerIQ and has been out in the field.
              {isThisWeek && pastWeeks.length ? ' Use the arrows for earlier weeks.' : ''}
            </Text>
          )}
          {week.sign_ups && (week.sign_ups.standard_count + week.sign_ups.target_count) > 0 ? (
            <View style={s.fees}>
              <Ionicons name="cash-outline" size={15} color={P.lime} />
              <Text style={s.feesText}>
                Sign-up fees{isThisWeek ? ' so far' : ''}: <Text style={s.feesStrong}>{formatMoney(week.sign_ups.sign_up_fees)}</Text>
                {`  (${week.sign_ups.standard_count} × £12 · ${week.sign_ups.target_count} × £15+, from Bells)`}
              </Text>
            </View>
          ) : null}
        </View>

        {/* ── Law of averages ──────────────────────────────────────────── */}
        <View style={s.card} testID="person-loa">
          <View style={s.rowBetween}>
            <Section icon="funnel-outline" text="Law of averages" />
            <View style={s.seg}>
              {([['week', 'This week'], ['recent', `Last ${Math.round(d.loa.recent_days / 7)} weeks`]] as const).map(([k, label]) => (
                <Pressable key={k} onPress={() => setRange(k)} style={[s.segBtn, range === k && s.segOn]} accessibilityRole="button" accessibilityState={{ selected: range === k }} testID={`person-loa-${k}`}>
                  <Text style={[s.segText, range === k && { color: P.onLime }]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          {loa.active_days ? (
            <>
              <Text style={s.sub}>
                Per day in the field · {loa.active_days} {loa.active_days === 1 ? 'day' : 'days'} in, {rangeLabel(loa.from, loa.to)}
                {loa.office_avg_per_day ? ' · office average beside it' : ''}
              </Text>
              <View style={{ marginTop: 12, gap: 4 }}>
                {FUNNEL.map((m, i) => {
                  const mine = loa.avg_per_day[m.key] || 0;
                  const office = loa.office_avg_per_day ? loa.office_avg_per_day[m.key] : null;
                  const top = Math.max(loa.avg_per_day.doors_knocked || 0, loa.office_avg_per_day?.doors_knocked || 0, 1);
                  const step = i > 0 ? loa.steps[i - 1] : null;
                  return (
                    <View key={m.key}>
                      {step ? (
                        <View style={s.stepRow}>
                          <Ionicons name="arrow-down" size={11} color={P.faint} />
                          <Text style={s.stepText}>{step.pct === null ? '–' : `${step.pct}%`} go on to {m.one}</Text>
                        </View>
                      ) : null}
                      <View style={s.funnelRow}>
                        <View style={s.funnelIcon}><Ionicons name={m.icon} size={14} color={P.lime} /></View>
                        <View style={{ flex: 1 }}>
                          <View style={s.stageHead}>
                            <Text style={s.funnelLabel}>{m.label}</Text>
                            <Text style={s.funnelValue}>
                              {num(mine, 1)}
                              {office !== null && office !== undefined ? <Text style={s.funnelOffice}>{`   office ${num(office, 1)}`}</Text> : null}
                            </Text>
                          </View>
                          <View style={s.track}>
                            {office !== null && office !== undefined ? <View style={[s.fillMet, { width: `${Math.min(100, (office / top) * 100)}%` as any }]} /> : null}
                            <View style={[s.fill, { width: `${Math.min(100, (mine / top) * 100)}%` as any, opacity: 0.9 }]} />
                          </View>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>
              <View style={s.oneSale}>
                <Text style={s.oneSaleTitle}>To get one sign-up</Text>
                {loa.totals.sales ? (
                  <View style={s.oneSaleRow}>
                    {FUNNEL.slice(0, 4).map((m) => (
                      <View key={m.key} style={s.oneSaleCell}>
                        <Text style={s.oneSaleValue}>{num(loa.to_one_sale[m.key], 1)}</Text>
                        <Text style={s.oneSaleLabel}>{m.one}</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={s.empty}>No sign-ups in this range yet, so there is no ratio to show.</Text>
                )}
              </View>
              <Pressable onPress={() => setDaysOpen((v) => !v)} style={s.toggle} accessibilityRole="button" testID="person-days-toggle">
                <Ionicons name={daysOpen ? 'chevron-up' : 'chevron-down'} size={14} color={P.muted} />
                <Text style={s.toggleText}>{daysOpen ? 'Hide' : 'Show'} day by day</Text>
              </Pressable>
              {daysOpen && (
                <View>
                    <View style={[s.tr, s.th]}>
                      <Text style={[s.td, s.tdDay, s.thText]}>Day</Text>
                      {FUNNEL.map((m) => <Text key={m.key} style={[s.td, s.thText]} numberOfLines={1}>{wide ? m.label : m.th}</Text>)}
                    </View>
                    {(d.loa.days || []).filter((r: any) => r.date >= loa.from).map((r: any) => (
                      <View key={r.date} style={s.tr}>
                        <Text style={[s.td, s.tdDay]} numberOfLines={1}>{shortDay(r.date)}</Text>
                        {FUNNEL.map((m) => <Text key={m.key} style={[s.td, m.key === 'sales' && r.sales > 0 && { color: P.lime, fontFamily: fonts.bodyBold }]}>{num(r[m.key])}</Text>)}
                      </View>
                    ))}
                </View>
              )}
            </>
          ) : (
            <Text style={s.empty}>No door numbers {range === 'week' ? 'this week' : `in the last ${Math.round(d.loa.recent_days / 7)} weeks`} yet.</Text>
          )}
        </View>

        {/* ── Timeline: their sign-ups hour by hour, and their patterns ── */}
        <View style={s.card} testID="person-timeline">
          <Section icon="time-outline" text="Timeline" />
          <FieldInsights userId={String(p.id)} embedded />
        </View>

        {/* ── Recent weeks ─────────────────────────────────────────────── */}
        {pastWeeks.length > 0 && (
          <View style={s.card} testID="person-weeks">
            <Section icon="stats-chart-outline" text="Recent weeks" />
            <View style={[s.tr, s.th]}>
              <Text style={[s.td, s.tdDate, s.thText]}>Week ending</Text>
              <Text style={[s.td, s.thText]}>Sign-ups</Text>
              <Text style={[s.td, s.thText]}>Piece avg</Text>
              <Text style={[s.td, s.thText]}>Scoring</Text>
              <Text style={[s.td, s.thText]}>Reliability</Text>
            </View>
            {pastWeeks.map((wk: any) => (
              <Pressable key={wk.week_ending} onPress={() => setWeekAt(weeks.indexOf(wk))} accessibilityRole="button"
                accessibilityLabel={`Show the week ending ${ukDate(wk.week_ending)}`}
                style={[s.tr, wk.week_ending === week.week_ending && s.trOn]}>
                <Text style={[s.td, s.tdDate]}>{ukDate(wk.week_ending)}</Text>
                <Text style={[s.td, { color: P.text, fontFamily: fonts.bodyBold }]}>{num(wk.kpis.sales)}{wk.kpis.sales_target ? <Text style={s.tdSoft}>{` / ${num(wk.kpis.sales_target)}`}</Text> : null}</Text>
                <Text style={s.td}>{num(wk.kpis.piece_average, 2)}</Text>
                <Text style={s.td}>{pct(wk.kpis.scoring)}</Text>
                <Text style={s.td}>{pct(wk.kpis.reliability)}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* ── Badge (Admins and Coach+) ────────────────────────────────── */}
        {canBadge && (
        <View style={s.card} testID="person-badge">
          <Section icon="ribbon-outline" text="ID badge" />
          {badge ? (
            <View style={s.badgeRow}>
              <View style={{ flex: 1, minWidth: 180 }}>
                <Text style={s.lead}>{badge.full_name} · {badge.badge_number}</Text>
                <Text style={s.sub}>Expires {badge.expiry_date}{badge.created_by_name ? ` · made by ${badge.created_by_name}` : ''}</Text>
              </View>
              <Pressable onPress={() => setBadgeOpen(true)} style={s.btn} accessibilityRole="button">
                <Ionicons name="print-outline" size={16} color={P.onLime} />
                <Text style={s.btnText}>Preview and print</Text>
              </Pressable>
            </View>
          ) : (
            <View style={s.badgeRow}>
              <Text style={[s.empty, { flex: 1, minWidth: 180, marginTop: 0 }]}>No badge made for {p.name.split(' ')[0]} yet. Their name{p.badge_numbers.length ? ' and badge number are' : ' is'} filled in for you; add a photo and it is ready to print.</Text>
              <Pressable onPress={() => setBadgeOpen(true)} style={s.btn} accessibilityRole="button">
                <Ionicons name="add-circle-outline" size={16} color={P.onLime} />
                <Text style={s.btnText}>Create badge</Text>
              </Pressable>
            </View>
          )}
        </View>

        )}

        {clockTime(d.synced_at) ? <Text style={s.updated}>Field numbers last synced from OwnerIQ {clockTime(d.synced_at)}</Text> : null}
        </>
        )}
      </View>

      {badgeOpen && canBadge && (
        <PersonBadgeFlow
          badgeId={badge?.id}
          prefill={{ full_name: p.name, badge_number: p.badge_numbers[0], user_id: p.id }}
          onClose={() => setBadgeOpen(false)}
          onChanged={() => q.refetch()}
        />
      )}
    </ScrollView>
  );
}

function Section({ icon, text }: { icon: Icon; text: string }) {
  return (
    <View style={s.section}>
      <Ionicons name={icon} size={12} color={P.muted} />
      <Text style={s.sectionText}>{text}</Text>
    </View>
  );
}

function Chip({ text, tone, icon }: { text: string; tone?: 'lime' | 'amber' | 'red'; icon?: Icon }) {
  const fg = tone === 'lime' ? P.onLime : tone === 'amber' ? P.amber : tone === 'red' ? P.redText : P.text;
  const bg = tone === 'lime' ? P.lime : tone === 'amber' ? P.amberBg : tone === 'red' ? P.redBg : P.raised;
  return (
    <View style={[s.chip, { backgroundColor: bg }]}>
      {icon ? <Ionicons name={icon} size={11} color={fg} /> : null}
      <Text style={[s.chipText, { color: fg }]} numberOfLines={1}>{text}</Text>
    </View>
  );
}

function Fact({ label, value, muted, last, onPress }: { label: string; value: string; muted?: boolean; last?: boolean; onPress?: () => void }) {
  const body = (
    <View style={[s.fact, last && { borderBottomWidth: 0 }]}>
      <Text style={s.factLabel}>{label}</Text>
      <Text style={[s.factValue, muted && { color: P.faint, fontFamily: fonts.body }, !!onPress && { color: P.lime }]} numberOfLines={1}>{value}</Text>
      {onPress ? <Ionicons name="chevron-forward" size={13} color={P.faint} /> : null}
    </View>
  );
  return onPress ? <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`}>{body}</Pressable> : body;
}

function Kpi({ label, value, sub, good, wide }: { label: string; value: string; sub: string; good?: boolean; wide: boolean }) {
  return (
    <View style={[s.kpi, { width: wide ? '20%' : '50%' }]}>
      <View style={s.kpiIn}>
        <Text style={s.kpiLabel} numberOfLines={1}>{label}</Text>
        <Text style={[s.kpiValue, good === true && { color: P.lime }]}>{value}</Text>
        <Text style={s.kpiSub} numberOfLines={1}>{sub}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: P.canvas },
  shell: { width: '100%', maxWidth: 1080, alignSelf: 'center', gap: 12 },
  centre: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  note: { fontFamily: fonts.body, fontSize: 13, color: P.muted, textAlign: 'center', maxWidth: 360 },
  cols: { gap: 12 },
  card: { backgroundColor: P.tile, borderRadius: 18, borderWidth: 1, borderColor: P.line, padding: 16 },
  rowBetween: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  section: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  sectionText: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.4, textTransform: 'uppercase', color: P.muted },

  head: { gap: 14 },
  headMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14, minWidth: 0 },
  avatar: { width: 64, height: 64, borderRadius: 32, borderWidth: 2, borderColor: P.lime },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: P.raised },
  avatarText: { fontFamily: fonts.display, fontSize: 22, color: P.lime },
  name: { fontFamily: fonts.displayWide, fontSize: 19, lineHeight: 25, color: P.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, height: 24, borderRadius: 12, maxWidth: '100%' },
  chipText: { fontFamily: fonts.bodyBold, fontSize: 11 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 42, paddingHorizontal: 16, borderRadius: 12, backgroundColor: P.lime },
  btnText: { fontFamily: fonts.bodyBold, fontSize: 13.5, color: P.onLime },
  btnGhost: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 42, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: P.line, backgroundColor: P.raised },
  btnGhostText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: P.text },

  fact: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, borderBottomWidth: 1, borderBottomColor: P.lineSoft },
  factLabel: { width: 104, fontFamily: fonts.body, fontSize: 12.5, color: P.muted },
  factValue: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13.5, color: P.text, textAlign: 'right' },

  lead: { fontFamily: fonts.display, fontSize: 17, lineHeight: 23, color: P.text },
  sub: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18, color: P.muted, marginTop: 3 },
  empty: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: P.muted, marginTop: 4 },
  days8: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(5,15,11,0.45)', borderWidth: 1, borderColor: P.lineSoft },
  days8Label: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: P.text },
  dotRow: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  dayDot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: P.lineSoft, backgroundColor: P.raised },
  dayDotOn: { backgroundColor: P.lime, borderColor: P.lime },
  dayDotNow: { borderColor: P.lime },
  dayDotText: { fontFamily: fonts.bodyBold, fontSize: 11.5, color: P.muted },
  stageHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  stageName: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 12.5, color: P.muted },
  stageValue: { fontFamily: fonts.mono, fontSize: 11.5, color: P.muted, fontVariant: ['tabular-nums'] as any },
  track: { height: 7, borderRadius: 4, backgroundColor: 'rgba(238,244,230,0.08)', overflow: 'hidden', marginTop: 5 },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4, backgroundColor: P.lime },
  fillMet: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4, backgroundColor: 'rgba(183,223,88,0.28)' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', margin: -4 },
  kpi: { padding: 4 },
  kpiIn: { borderRadius: 14, borderWidth: 1, borderColor: P.lineSoft, backgroundColor: 'rgba(5,15,11,0.45)', padding: 12 },
  kpiLabel: { fontFamily: fonts.bodySemibold, fontSize: 12, color: P.muted },
  kpiValue: { fontFamily: fonts.display, fontSize: 28, letterSpacing: -0.8, color: P.text, marginTop: 4, fontVariant: ['tabular-nums'] as any },
  kpiSub: { fontFamily: fonts.body, fontSize: 11, color: P.faint, marginTop: 2 },
  dayRow: { flexDirection: 'row', gap: 6, marginTop: 12 },
  day: { flex: 1, minWidth: 0, alignItems: 'center', paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: P.lineSoft, backgroundColor: 'rgba(5,15,11,0.45)' },
  dayIn: { borderColor: 'rgba(231,182,92,0.45)' },
  dayGood: { borderColor: 'rgba(52,211,153,0.5)', backgroundColor: P.greenBg },
  dayToday: { borderColor: P.lime, borderWidth: 1.5 },
  dayName: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: P.muted },
  dayValue: { fontFamily: fonts.display, fontSize: 18, color: P.text, marginTop: 2, fontVariant: ['tabular-nums'] as any },
  dayNote: { fontFamily: fonts.body, fontSize: 9.5, color: P.faint, minHeight: 12 },
  fees: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 10, borderRadius: 12, backgroundColor: 'rgba(183,223,88,0.07)' },
  feesText: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18, color: P.muted },
  feesStrong: { fontFamily: fonts.bodyBold, color: P.text },

  seg: { flexDirection: 'row', padding: 3, borderRadius: 11, backgroundColor: 'rgba(5,15,11,0.55)', borderWidth: 1, borderColor: P.lineSoft },
  segBtn: { minHeight: 30, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: P.lime },
  segText: { fontFamily: fonts.bodySemibold, fontSize: 12, color: P.muted },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 44, marginVertical: 2 },
  stepText: { fontFamily: fonts.mono, fontSize: 10.5, color: P.muted },
  funnelRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  funnelIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: P.line, backgroundColor: 'rgba(183,223,88,0.06)' },
  funnelLabel: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13, color: P.text },
  funnelValue: { fontFamily: fonts.display, fontSize: 17, color: P.text, fontVariant: ['tabular-nums'] as any },
  funnelOffice: { fontFamily: fonts.mono, fontSize: 10.5, color: P.muted },
  oneSale: { marginTop: 16, padding: 12, borderRadius: 14, backgroundColor: 'rgba(5,15,11,0.45)', borderWidth: 1, borderColor: P.lineSoft },
  oneSaleTitle: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.2, textTransform: 'uppercase', color: P.muted },
  oneSaleRow: { flexDirection: 'row', marginTop: 8 },
  oneSaleCell: { flex: 1, alignItems: 'center' },
  oneSaleValue: { fontFamily: fonts.display, fontSize: 22, color: P.lime, fontVariant: ['tabular-nums'] as any },
  oneSaleLabel: { fontFamily: fonts.body, fontSize: 11, color: P.muted, marginTop: 1 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 36, marginTop: 8 },
  toggleText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: P.muted },

  tr: { flexDirection: 'row', alignItems: 'center', minHeight: 36, borderBottomWidth: 1, borderBottomColor: P.lineSoft },
  trOn: { backgroundColor: 'rgba(183,223,88,0.07)' },
  weekNav: { flexDirection: 'row', gap: 6, marginTop: -6 },
  navBtn: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: P.raised, borderWidth: 1, borderColor: P.lineSoft },
  th: { minHeight: 30 },
  thText: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: P.muted },
  td: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, color: P.muted, textAlign: 'right', fontVariant: ['tabular-nums'] as any },
  tdDate: { flex: 1.5, textAlign: 'left', color: P.text },
  tdDay: { flex: 1.9, textAlign: 'left', color: P.text },
  tdSoft: { fontFamily: fonts.body, color: P.faint },

  badgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  updated: { fontFamily: fonts.mono, fontSize: 10.5, color: P.faint, textAlign: 'center', letterSpacing: 0.4 },
});
