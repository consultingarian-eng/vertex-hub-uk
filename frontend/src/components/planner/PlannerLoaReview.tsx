/**
 * PlannerLoaReview — auto-filled Law-of-Averages review for the team Weekly
 * Planner's "LOAS / sign-up" box. Pulls the OwnerIQ field numbers for the
 * planner's review week and shows two tabs:
 *   • Team — the team's average / rep / day + what it takes to land 1 sign-up.
 *   • Me   — the plan owner's own average / rep / day + their own ratios.
 * No manual entry — it reflects live OwnerIQ data for the week being reviewed.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useColors, fonts } from '../../theme/ThemeContext';

const shiftISO = (iso: string, days: number) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const METRICS = [
  // The owner's Field IQ names.
  { key: 'doors_knocked', h: 'Doors' },
  { key: 'spoken_to', h: 'Spoken' },
  { key: 'pitches_commenced', h: 'Presented' },
  { key: 'pitches_closed', h: 'Closed' },
  { key: 'sales', h: 'Sign-ups' },
];
const RATIO_KEYS = [
  { key: 'doors_knocked', label: 'doors' },
  { key: 'spoken_to', label: 'spoken' },
  { key: 'pitches_commenced', label: 'presented' },
  { key: 'pitches_closed', label: 'closed' },
];
const fmt1 = (n: any) => (n === null || n === undefined ? '—' : Number(n).toFixed(n >= 100 ? 0 : 1));

type Props = {
  /** Sunday ISO that ends the planner week (q.data.week_ending). */
  weekEnding: string;
  /** The plan owner's CG1 user id (targetUserId || current user id). */
  ownerUserId?: string;
};

export default function PlannerLoaReview({ weekEnding, ownerUserId }: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [tab, setTab] = useState<'team' | 'me'>('team');

  // Review week = Monday..Saturday of the week ending on `weekEnding` (Sunday).
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(weekEnding || '');
  const from = valid ? shiftISO(weekEnding, -6) : '';
  const to = valid ? shiftISO(weekEnding, -1) : '';

  // team_of pins the Team tab to the PLAN OWNER's crew (leader → their
  // subtree, admin → their office). Without it the summary is scoped to the
  // viewer, so an owner opening a leader's plan saw office-wide averages.
  const q = useQuery({
    enabled: valid,
    queryKey: ['planner-loa', weekEnding, ownerUserId || 'me'],
    queryFn: async () =>
      (await api.get('/owneriq/summary', {
        params: { from_date: from, to_date: to, ...(ownerUserId ? { team_of: ownerUserId } : {}) },
      })).data,
  });

  const data = q.data;
  const reps: any[] = data?.reps || [];
  const me = ownerUserId ? reps.find((r) => r.cg1_user_id === ownerUserId) : undefined;

  const teamAvg = data?.avg_per_rep_day || {};
  const teamRatios = data?.ratios_to_one_sale || {};
  const meAvg = me?.avg_per_day || {};
  const meSales = me?.totals?.sales || 0;
  const meRatios = (k: string) => (meSales ? Number(me.totals?.[k] || 0) / meSales : null);

  if (!valid) return null;

  const showMe = tab === 'me';
  const avg = showMe ? meAvg : teamAvg;
  const ratioVal = (k: string) => (showMe ? meRatios(k) : teamRatios[k]);
  const hasSales = showMe ? meSales > 0 : (data?.group_totals?.sales || 0) > 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.tabs}>
        {(['team', 'me'] as const).map((t) => (
          <TouchableOpacity key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabOn]}>
            <Text style={[styles.tabTxt, tab === t && styles.tabTxtOn]}>{t === 'team' ? 'Team' : 'Me'}</Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.weekTag}>Wk {from.slice(5)}–{to.slice(5)}</Text>
      </View>

      {q.isLoading ? (
        <ActivityIndicator style={{ marginVertical: 14 }} color={colors.primary} />
      ) : reps.length === 0 ? (
        <Text style={styles.empty}>No OwnerIQ field data for this week yet.</Text>
      ) : showMe && !me ? (
        <Text style={styles.empty}>No linked OwnerIQ figures for this rep this week.</Text>
      ) : (
        <>
          <Text style={styles.lbl}>Average / rep / day</Text>
          <View style={styles.avgRow}>
            {METRICS.map((m, i) => (
              <View key={m.key} style={[styles.avgItem, i < METRICS.length - 1 && styles.avgDivider]}>
                <Text style={styles.avgNum}>{fmt1(avg[m.key])}</Text>
                <Text style={styles.avgLbl}>{m.h}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.lbl}>LOA — to land 1 sign-up</Text>
          {hasSales ? (
            <View style={styles.loaRow}>
              {RATIO_KEYS.map((r) => (
                <View key={r.key} style={styles.loaItem}>
                  <Text style={styles.loaNum}>{fmt1(ratioVal(r.key))}</Text>
                  <Text style={styles.loaLbl}>{r.label}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.empty}>No sign-ups this week — no LOA yet.</Text>
          )}
        </>
      )}
    </View>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  wrap: { marginTop: 10, backgroundColor: c.surfaceAlt, borderRadius: 12, padding: 12 },
  tabs: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  tabOn: { backgroundColor: c.primary, borderColor: c.primary },
  tabTxt: { fontFamily: fonts.bodySemibold, fontSize: 12, color: c.textSecondary },
  tabTxtOn: { color: c.onPrimary },
  weekTag: { marginLeft: 'auto', fontFamily: fonts.body, fontSize: 10, color: c.textMuted },

  lbl: { fontFamily: fonts.bodyBold, fontSize: 9.5, letterSpacing: 0.4, textTransform: 'uppercase', color: c.textMuted, marginTop: 12, marginBottom: 6 },
  avgRow: { flexDirection: 'row', backgroundColor: c.background, borderRadius: 10, paddingVertical: 10 },
  avgItem: { flex: 1, alignItems: 'center' },
  avgDivider: { borderRightWidth: 1, borderRightColor: c.border },
  avgNum: { fontFamily: fonts.mono, fontSize: 15, color: c.primary },
  avgLbl: { fontFamily: fonts.body, fontSize: 9, color: c.textMuted, marginTop: 2 },

  loaRow: { flexDirection: 'row', backgroundColor: c.background, borderRadius: 10, paddingVertical: 10 },
  loaItem: { flex: 1, alignItems: 'center' },
  loaNum: { fontFamily: fonts.mono, fontSize: 15, color: c.text },
  loaLbl: { fontFamily: fonts.body, fontSize: 9, color: c.textMuted, marginTop: 2 },

  empty: { fontFamily: fonts.body, fontSize: 12, color: c.textMuted, marginTop: 10, textAlign: 'center' },
});
