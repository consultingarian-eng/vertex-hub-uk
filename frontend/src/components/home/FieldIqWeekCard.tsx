/**
 * FieldIqWeekCard — this week from OwnerIQ / Field IQ's Performance Hub.
 *
 *   • Everyone: their own sign-ups against the weekly target they set in Field
 *     IQ, their day-by-day attendance (present / not present / absent / not
 *     set) and reliability / scoring.
 *   • Coaches and admins: the same sign-ups-vs-target line for everyone under
 *     them (admins: the whole office).
 *
 * Synced hourly by the server (owneriq_performance.py); read-only here.
 * Data: GET /api/owneriq/performance/week.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useColors, fonts } from '../../theme/ThemeContext';
import { DepthCard } from '../ui/DepthCard';
import { prettyDate } from '../../utils/bulletinWeek';

type Day = { date: string; weekday: string; status?: string | null; sales_count?: number | null };
type Row = { user_id: string; name?: string; team_name?: string | null; sales?: number | null;
  sales_target?: number | null; days: Day[] };

const DAY_LABEL: Record<string, string> = {
  monday: 'M', tuesday: 'T', wednesday: 'W', thursday: 'T', friday: 'F', saturday: 'S', sunday: 'S',
};
const STATUS_LABEL: Record<string, string> = {
  present: 'In', not_present: 'Not in', absent: 'Absent', not_set: 'Not set', na: '—',
};
const TEAM_PREVIEW = 6;

export default function FieldIqWeekCard() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({
    queryKey: ['owneriq-performance-week'],
    queryFn: async () => (await api.get('/owneriq/performance/week')).data,
    staleTime: 5 * 60 * 1000,
  });
  const raw = q.data?.me;
  // Skip the personal block for someone with nothing this week (an owner or
  // admin who doesn't knock doors): no target, no sign-ups, no attendance.
  const me = raw && (raw.kpis?.sales_target || raw.kpis?.sales
    || (raw.days || []).some((d: Day) => d.status && !['na', 'not_set'].includes(d.status))) ? raw : null;
  const team: Row[] = q.data?.team || [];
  if (!q.data || (!me && team.length === 0)) return null;

  const statusColour = (s?: string | null) =>
    s === 'present' ? colors.green : s === 'absent' ? colors.red : s === 'not_present' ? colors.textMuted
      : 'transparent';
  const k = me?.kpis || {};
  const target = k.sales_target;
  const sales = k.sales ?? 0;
  const pct = target ? Math.min(1, sales / target) : 0;
  const rows = showAll ? team : team.slice(0, TEAM_PREVIEW);

  return (
    <DepthCard style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>Field IQ this week</Text>
        <Text style={styles.sub}>w/e {prettyDate(q.data.week_ending)}</Text>
      </View>

      {me ? (
        <View>
          <View style={styles.goalRow}>
            <Text style={styles.big}>{sales}</Text>
            <Text style={styles.goalText}>
              {target ? `of your ${target} sign-up target` : 'sign-ups · no weekly target set in Field IQ'}
            </Text>
          </View>
          {target ? (
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.round(pct * 100)}%` }]} />
            </View>
          ) : null}
          <View style={styles.days}>
            {(me.days || []).slice(0, 6).map((d: Day) => (
              <View key={d.date} style={styles.dayCol}>
                <View style={[styles.dot, { backgroundColor: statusColour(d.status),
                  borderColor: d.status === 'not_set' ? colors.textMuted : statusColour(d.status) }]}>
                  {d.sales_count ? <Text style={styles.dotText}>{d.sales_count}</Text> : null}
                </View>
                <Text style={styles.dayLabel}>{DAY_LABEL[d.weekday] || ''}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.legend}>
            Green: in · grey: not in · red: absent · outline: not set. Numbers are sign-ups.
          </Text>
          <View style={styles.stats}>
            <Text style={styles.stat}>Reliability <Text style={styles.statVal}>{k.reliability ?? '—'}%</Text></Text>
            <Text style={styles.stat}>Scoring <Text style={styles.statVal}>{k.scoring ?? '—'}%</Text></Text>
            {me.team_name ? <Text style={styles.stat}>{me.team_name}</Text> : null}
          </View>
        </View>
      ) : null}

      {team.length > 0 ? (
        <View style={[styles.teamBlock, me ? styles.teamDivider : null]}>
          <Text style={styles.teamTitle}>Your team · sign-ups vs target</Text>
          {rows.map((r) => {
            const t = r.sales_target;
            const p = t ? Math.min(1, (r.sales || 0) / t) : 0;
            const todayStatus = (r.days || []).find((d) => d.status && d.status !== 'na' && d.date === q.data.today)?.status;
            return (
              <View key={r.user_id} style={styles.teamRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.teamName} numberOfLines={1}>{r.name || 'Unknown'}</Text>
                  <View style={styles.trackSmall}>
                    <View style={[styles.fill, { width: `${Math.round(p * 100)}%` }]} />
                  </View>
                </View>
                <Text style={styles.teamNum}>
                  {r.sales ?? 0}{t ? ` / ${t}` : ''}
                </Text>
                {todayStatus ? <Text style={styles.teamStatus}>{STATUS_LABEL[todayStatus] || ''}</Text> : null}
              </View>
            );
          })}
          {team.length > TEAM_PREVIEW ? (
            <TouchableOpacity onPress={() => setShowAll((v) => !v)} accessibilityRole="button">
              <Text style={styles.more}>{showAll ? 'Show fewer' : `Show all ${team.length}`}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </DepthCard>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  card: { borderRadius: 16, marginBottom: 12, padding: 14 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 },
  title: { fontFamily: fonts.displayWide, fontSize: 12.5, letterSpacing: 0.9, textTransform: 'uppercase', color: c.text },
  sub: { fontFamily: fonts.mono, fontSize: 11, color: c.textMuted },
  goalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  big: { fontFamily: fonts.displayBlack, fontSize: 30, color: c.text },
  goalText: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: c.textMuted },
  track: { height: 8, borderRadius: 4, backgroundColor: c.trackBg, overflow: 'hidden', marginTop: 8 },
  trackSmall: { height: 5, borderRadius: 3, backgroundColor: c.trackBg, overflow: 'hidden', marginTop: 4 },
  fill: { height: '100%', backgroundColor: c.primary, borderRadius: 4 },
  days: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  dayCol: { alignItems: 'center', gap: 4 },
  dot: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  dotText: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '700', color: '#fff' },
  dayLabel: { fontFamily: fonts.mono, fontSize: 10, color: c.textMuted },
  legend: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, marginTop: 8 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 10 },
  stat: { fontFamily: fonts.body, fontSize: 12, color: c.textMuted },
  statVal: { fontFamily: fonts.mono, fontWeight: '700', color: c.text },
  teamBlock: { marginTop: 4 },
  teamDivider: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border },
  teamTitle: { fontFamily: fonts.mono, fontSize: 11, color: c.textMuted, letterSpacing: 1, marginBottom: 8,
    textTransform: 'uppercase' },
  teamRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  teamName: { fontFamily: fonts.body, fontSize: 14, color: c.text },
  teamNum: { fontFamily: fonts.mono, fontSize: 13, fontWeight: '700', color: c.text, minWidth: 48, textAlign: 'right' },
  teamStatus: { fontFamily: fonts.mono, fontSize: 10, color: c.textMuted, minWidth: 44, textAlign: 'right' },
  more: { fontFamily: fonts.body, fontSize: 13, color: c.primary, marginTop: 6 },
});
