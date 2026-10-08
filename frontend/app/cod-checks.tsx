/**
 * Checks — the coach's sign-off queue.
 *
 * Everyone in your scope who tapped "Ready for check", oldest first. Each
 * card shows the rung being claimed and the What-Good-Looks-Like criteria
 * to check against; the leader panel (how it's measured + coaching notes)
 * unfolds on demand. Two actions, one tap each: Confirm (signs the rung —
 * date stamps itself) or Not yet (sends it back, optional note).
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { apiService } from '../src/api/client';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { toast } from '../src/utils/toast';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { codStageLabel } from '../src/components/cod/stageOrder';

const RUNGS = ['', 'Know', 'Do', 'Deliver', 'Teach', 'Systemize'];

export default function CodChecksScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const tabBarClearance = useTabBarClearance();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [openPanel, setOpenPanel] = useState<string | null>(null);

  const checksQ = useQuery({
    queryKey: ['cod-checks'],
    queryFn: () => apiService.getPendingChecks().then((r) => r.data.checks),
  });

  const done = () => {
    qc.invalidateQueries({ queryKey: ['cod-checks'] });
    qc.invalidateQueries({ queryKey: ['trainee-module-progress'] });
  };
  const confirm = useMutation({
    mutationFn: (c: any) => apiService.upsertModuleProgress(c.module_id, { ladder: c.next_rung }, c.target_user_id).then((r) => r.data),
    onSuccess: (_d, c: any) => { toast.success?.(`${c.target_name} — ${RUNGS[c.next_rung]} signed ✓`); done(); },
    onError: (e: any) => toast.error?.('Could not sign', e?.response?.data?.detail || 'Try again'),
  });
  const notYet = useMutation({
    mutationFn: (c: any) => apiService.setReadyForCheck(c.module_id, { ready: false, target_user_id: c.target_user_id }).then((r) => r.data),
    onSuccess: (_d, c: any) => { toast.info?.(`${c.target_name} — sent back to keep working`); done(); },
    onError: (e: any) => toast.error?.('Could not update', e?.response?.data?.detail || 'Try again'),
  });
  // Sales-path Expert/Mastery claims share this queue (kind: 'sales_level').
  // The server re-validates data eligibility at sign time, so a stale card
  // errors instead of signing.
  const confirmSales = useMutation({
    mutationFn: (c: any) => apiService.signOffSalesPath(c.target_user_id, c.level).then((r) => r.data),
    onSuccess: (_d, c: any) => { toast.success?.(`${c.target_name} — ${c.level_name} signed ✓`); done(); },
    onError: (e: any) => toast.error?.('Could not sign', e?.response?.data?.detail || 'Try again'),
  });
  const notYetSales = useMutation({
    mutationFn: (c: any) => apiService.setSalesPathReady(c.level, false, c.target_user_id).then((r) => r.data),
    onSuccess: (_d, c: any) => { toast.info?.(`${c.target_name} — sent back to keep working`); done(); },
    onError: (e: any) => toast.error?.('Could not update', e?.response?.data?.detail || 'Try again'),
  });

  const { pullIndicator } = usePullToRefresh(async () => { await checksQ.refetch(); });

  const checks = (checksQ.data || []) as any[];

  return (
    <View style={{ flex: 1 }}>
      {pullIndicator}
      <Stack.Screen options={{ title: 'Checks' }} />
      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 40 + tabBarClearance }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary}
          onRefresh={async () => { setRefreshing(true); await checksQ.refetch(); setRefreshing(false); }} />}
      >
        {checksQ.isLoading ? (
          <View style={{ paddingTop: 60, alignItems: 'center' }}><BrandLoader size={56} /></View>
        ) : checks.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="checkmark-done-circle-outline" size={44} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>Queue clear</Text>
            <Text style={styles.emptyText}>When someone taps "Ready for check", it lands here.</Text>
          </View>
        ) : checks.map((c) => {
          // ── Sales-path claim card (Expert / Mastery) ──
          if (c.kind === 'sales_level') {
            const skey = `${c.target_user_id}:sales:${c.level}`;
            const sbusy = confirmSales.isPending || notYetSales.isPending;
            const f = c.form || {};
            return (
              <View key={skey} style={styles.card}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={styles.who}>{c.target_name}</Text>
                  <View style={[styles.rungChip, { backgroundColor: '#0ea5e9' }]}>
                    <Text style={styles.rungChipText}>{c.level_name}</Text>
                  </View>
                </View>
                <Text style={styles.topic}>Sales Proficiency — {c.level_name} claim</Text>
                <Text style={styles.meta}>
                  {`${c.green_weeks ?? 0} Green Weeks · scoring ${f.scoring_pct_20d ?? '—'}% · piece avg ${f.piece_avg_20d ?? '—'}`}
                  {c.data_eligible ? '' : ' · ⚠️ data no longer qualifies'}
                </Text>
                <View style={{ marginTop: 10 }}>
                  {(c.windows || []).map((w: any, i: number) => (
                    <View key={i} style={styles.wgllRow}>
                      <Ionicons name="stats-chart" size={15} color={colors.primary} />
                      <Text style={styles.wgllText}>
                        {`${w.from} → ${w.to}: 2+ sign-ups on ${Math.round((w.scoring_pct / 100) * w.days)} of ${w.days} days, ${w.piece_avg} sign-ups a day`}
                      </Text>
                    </View>
                  ))}
                  <View style={styles.wgllRow}>
                    <Ionicons name="eye-outline" size={15} color={colors.textMuted} />
                    <Text style={styles.wgllText}>
                      {c.level === 6
                        ? 'Mastery also needs the contribution: coached a BA to their first Green Week, or an equivalent you have seen yourself.'
                        : 'Numbers are typed by hand — sanity-check the weeks against reality before signing.'}
                    </Text>
                  </View>
                </View>
                <View style={styles.actions}>
                  <TouchableOpacity style={[styles.confirmBtn, sbusy && { opacity: 0.6 }]} disabled={sbusy}
                    onPress={() => confirmSales.mutate(c)}>
                    {confirmSales.isPending ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Ionicons name="checkmark" size={16} color={colors.onPrimary} />}
                    <Text style={styles.confirmText}>Sign {c.level_name}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.notYetBtn, sbusy && { opacity: 0.6 }]} disabled={sbusy}
                    onPress={() => notYetSales.mutate(c)}>
                    <Text style={styles.notYetText}>Not yet</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          }

          const key = `${c.target_user_id}:${c.module_id}`;
          const busy = confirm.isPending || notYet.isPending;
          return (
            <View key={key} style={styles.card}>
              <TouchableOpacity activeOpacity={0.8}
                onPress={() => router.push(`/module/${c.module_id}?trainee_id=${c.target_user_id}`)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={styles.who}>{c.target_name}</Text>
                  <View style={styles.rungChip}><Text style={styles.rungChipText}>{RUNGS[c.next_rung]}</Text></View>
                </View>
                <Text style={styles.topic}>{c.topic}</Text>
                <Text style={styles.meta}>{`Stage ${codStageLabel(c.stage)} · ${c.category} · currently at ${c.ladder ? RUNGS[c.ladder] : 'not started'}`}</Text>
              </TouchableOpacity>

              {/* The criteria to check against — WGLL with their tick state */}
              <View style={{ marginTop: 10 }}>
                {(c.wgll || []).map((w: string, i: number) => (
                  <View key={i} style={styles.wgllRow}>
                    <Ionicons
                      name={(c.wgll_checked || []).includes(i) ? 'checkbox' : 'square-outline'}
                      size={15}
                      color={(c.wgll_checked || []).includes(i) ? colors.primary : colors.textMuted}
                    />
                    <Text style={styles.wgllText}>{w}</Text>
                  </View>
                ))}
              </View>

              {/* Leader panel — what to look for, on demand */}
              {((c.how_measured || []).length > 0 || (c.coaching_notes || []).length > 0) && (
                <TouchableOpacity style={styles.panelToggle} onPress={() => setOpenPanel(openPanel === key ? null : key)}>
                  <Ionicons name={openPanel === key ? 'chevron-up' : 'chevron-down'} size={14} color={colors.primary} />
                  <Text style={styles.panelToggleText}>What to look for when checking this</Text>
                </TouchableOpacity>
              )}
              {openPanel === key && (
                <View style={styles.panel}>
                  {(c.how_measured || []).map((t: string, i: number) => (
                    <Text key={`m${i}`} style={styles.panelLine}>📊 {t}</Text>
                  ))}
                  {(c.coaching_notes || []).map((t: string, i: number) => (
                    <Text key={`c${i}`} style={styles.panelLine}>💡 {t}</Text>
                  ))}
                </View>
              )}

              <View style={styles.actions}>
                <TouchableOpacity style={[styles.confirmBtn, busy && { opacity: 0.6 }]} disabled={busy}
                  onPress={() => confirm.mutate(c)}>
                  {confirm.isPending ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Ionicons name="checkmark" size={16} color={colors.onPrimary} />}
                  <Text style={styles.confirmText}>Confirm {RUNGS[c.next_rung]}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.notYetBtn, busy && { opacity: 0.6 }]} disabled={busy}
                  onPress={() => notYet.mutate(c)}>
                  <Text style={styles.notYetText}>Not yet</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  empty: { alignItems: 'center', gap: 8, paddingTop: 70 },
  emptyTitle: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.text },
  emptyText: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 14, marginBottom: 12 },
  who: { fontFamily: fonts.bodyBold, fontSize: 15.5, color: colors.text },
  rungChip: { backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 },
  rungChipText: { fontFamily: fonts.bodyBold, fontSize: 10.5, color: colors.onPrimary },
  topic: { fontFamily: fonts.bodyBold, fontSize: 13.5, color: colors.textSecondary, marginTop: 3 },
  meta: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  wgllRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingVertical: 3 },
  wgllText: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18, color: colors.text },
  panelToggle: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  panelToggleText: { fontFamily: fonts.bodyBold, fontSize: 12, color: colors.primary },
  panel: { backgroundColor: colors.surfaceAlt, borderRadius: 10, padding: 10, marginTop: 6 },
  panelLine: { fontFamily: fonts.body, fontSize: 12, lineHeight: 18, color: colors.textSecondary, marginBottom: 3 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  confirmBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 11 },
  confirmText: { fontFamily: fonts.bodyBold, fontSize: 13.5, color: colors.onPrimary },
  notYetBtn: { paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  notYetText: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.textMuted },
});
