/**
 * Product Knowledge pass-off card — shown on the leader/admin trainee
 * detail screen under the Orientation tab. Displays the trainee's latest
 * exam attempt (if any) and a pass-off / un-pass-off button.
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { showAlert } from '../utils/showAlert';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { apiService } from '../api/client';
import { useColors } from '../theme/ThemeContext';
import { toast } from '../utils/toast';
import { APP_LOCALE } from '../utils/appTime';

type Props = { traineeId: string };

export default function TraineeProductExamCard({ traineeId }: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: d } = await apiService.productKnowledgeTraineeExam(traineeId);
      setData(d);
    } catch (e: any) {
      // 403 = not authorised — silently hide
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [traineeId]);

  useEffect(() => { load(); }, [load]);

  const togglePassOff = (next: boolean) => {
    showAlert(
      next ? 'Pass off campaign exam?' : 'Un-pass-off?',
      next
        ? 'Confirm this BA has demonstrated solid campaign knowledge.'
        : 'Remove the pass-off mark on this exam attempt?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: next ? 'Pass off' : 'Un-pass-off', style: next ? 'default' : 'destructive', onPress: async () => {
          setBusy(true);
          try {
            await apiService.productKnowledgePassOff(traineeId, next);
            toast.success(next ? 'Passed off!' : 'Pass-off removed');
            await load();
          } catch (e: any) {
            showAlert('Failed', e?.response?.data?.detail || e?.message || '');
          } finally {
            setBusy(false);
          }
        }},
      ],
    );
  };

  if (loading) return null;

  const latest = data?.latest;
  const hasAttempt = !!latest;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={[styles.iconBox, { backgroundColor: `${colors.primary}1a` }]}>
          <Ionicons name="storefront" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Campaign Exam</Text>
          <Text style={styles.sub}>
            Campaign training · available from day one
          </Text>
        </View>
      </View>

      {!hasAttempt ? (
        <View style={styles.empty}>
          <Ionicons name="time-outline" size={20} color={colors.textMuted} />
          <Text style={styles.emptyText}>
            This BA hasn't taken the exam yet.{'\n'}It's open to them from day one — nudge them to run the lessons.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.row}>
            <Text style={styles.label}>Score</Text>
            <Text style={[styles.value, { fontSize: 16, fontWeight: '900', color: latest.score_pct >= 80 ? '#10b981' : '#f59e0b' }]}>
              {latest.score_pct}% ({latest.score_correct}/{latest.score_total})
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Submitted</Text>
            <Text style={styles.value}>
              {latest.submitted_at ? new Date(latest.submitted_at).toLocaleDateString(APP_LOCALE) : '—'}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Status</Text>
            <View style={[styles.statusPill, { backgroundColor: '#10b98115', borderColor: '#10b98155' }]}>
              <Ionicons name="shield-checkmark" size={12} color="#10b981" />
              <Text style={[styles.statusText, { color: '#10b981' }]}>Complete</Text>
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 10, marginTop: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconBox: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 14, fontWeight: '900', color: colors.text },
  sub: { fontSize: 11, color: colors.textMuted, marginTop: 1, fontWeight: '600' },
  empty: { padding: 14, borderRadius: 8, backgroundColor: colors.background, flexDirection: 'row', alignItems: 'center', gap: 10 },
  emptyText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  label: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  value: { fontSize: 13, fontWeight: '700', color: colors.text },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  statusText: { fontSize: 11, fontWeight: '800' },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10, marginTop: 4 },
  btnText: { fontSize: 13, fontWeight: '800' },
});
