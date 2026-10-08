import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import PressableScale from '../src/components/ui/PressableScale';
import { useAuth } from '../src/auth/AuthContext';
import { apiService } from '../src/api/client';
import { showAlert } from '../src/utils/showAlert';
import { toast } from '../src/utils/toast';
import OfficeToggle from '../src/components/ui/OfficeToggle';
import { useActiveOffice } from '../src/office/ActiveOfficeContext';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { APP_LOCALE } from '../src/utils/appTime';

// ──────────────────────────────────────────────────────────────────────────
// Absence Approvals — the office owner's inbox for crew absences that
// leaders pre-declared in the Weekly Planner. Approving stamps the Ab days
// straight onto the member's Bells row; the requesting leader gets a push
// either way. Only pending requests are actionable; the rest is history.
// ──────────────────────────────────────────────────────────────────────────

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function shortDate(iso?: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' });
}
function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function AbsenceApprovalsScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const tabBarClearance = useTabBarClearance();
  const [actingId, setActingId] = useState<string | null>(null);

  // Approvals are scoped to ONE office. A super admin switches with the
  // selector above the list; a single-office admin only ever sees their own
  // (the server pins them regardless of what's sent).
  const { officeId, canSwitch, offices } = useActiveOffice();
  const officeName = offices.find((o) => o.id === officeId)?.name;

  const q = useQuery({
    queryKey: ['absence-requests', officeId || 'home'],
    queryFn: () => apiService.listAbsenceRequests(officeId ? { office_id: officeId } : undefined).then((r) => r.data),
    enabled: user?.role === 'admin',
  });

  const { pullIndicator } = usePullToRefresh(() => q.refetch());

  const decideMut = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'deny' }) =>
      apiService.decideAbsenceRequest(id, action).then((r) => r.data),
    onMutate: ({ id }) => setActingId(id),
    onSuccess: (_d, { action }) => {
      toast.success(action === 'approve' ? 'Absence approved — Bells updated' : 'Request denied — the coach was notified');
      queryClient.invalidateQueries({ queryKey: ['absence-requests'] });
      queryClient.invalidateQueries({ queryKey: ['absence-pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['weekly-planner-stats'] });
      queryClient.invalidateQueries({ queryKey: ['bells'] });
    },
    onError: (e: any) => showAlert('Could not save', e?.response?.data?.detail || 'Try again'),
    onSettled: () => setActingId(null),
  });

  const onDeny = (req: any) => {
    showAlert(
      'Deny absence request?',
      `${req.target_name} — ${(req.day_indices || []).map((i: number) => DAY_SHORT[i]).join(', ')} (WE ${shortDate(req.week_ending)}). ${req.requester_name} will be notified.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Deny', style: 'destructive', onPress: () => decideMut.mutate({ id: req.id, action: 'deny' }) },
      ],
    );
  };

  if (user?.role !== 'admin') {
    return (
      <View style={styles.center}>
        <Ionicons name="lock-closed-outline" size={32} color={colors.textMuted} />
        <Text style={styles.emptyTitle}>Admins only</Text>
        <Text style={styles.emptyText}>Absence approvals are handled by the office owner.</Text>
      </View>
    );
  }
  if (q.isLoading) {
    return <View style={styles.center}><BrandLoader size={48} /></View>;
  }

  const items: any[] = q.data?.items || [];
  const pending = items.filter((x) => x.status === 'pending');
  const history = items.filter((x) => x.status !== 'pending').slice(0, 30);

  const ReqCard = ({ req, actionable }: { req: any; actionable: boolean }) => (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.memberName}>{req.target_name}</Text>
          <Text style={styles.metaText}>
            Requested by {req.requester_name} · {timeAgo(req.created_at)} · WE {shortDate(req.week_ending)}
          </Text>
        </View>
        {!actionable && (
          <View style={[
            styles.statusChip,
            req.status === 'approved' && styles.statusChipApproved,
            req.status === 'denied' && styles.statusChipDenied,
          ]}>
            <Text style={[
              styles.statusChipText,
              req.status === 'approved' && { color: '#166534' },
              req.status === 'denied' && { color: '#991b1b' },
            ]}>{req.status}</Text>
          </View>
        )}
      </View>
      <View style={styles.dayRow}>
        {(req.day_indices || []).map((i: number) => (
          <View key={i} style={styles.dayChip}><Text style={styles.dayChipText}>{DAY_SHORT[i]}</Text></View>
        ))}
      </View>
      {!!req.reason && (
        <View style={styles.reasonBox}>
          <Ionicons name="chatbubble-ellipses-outline" size={13} color={colors.textMuted} />
          <Text style={styles.reasonText}>{req.reason}</Text>
        </View>
      )}
      {!actionable && !!req.decided_by_name && (
        <Text style={styles.metaText}>
          {req.status === 'cancelled' ? 'Withdrawn by the coach' : `${req.status} by ${req.decided_by_name} · ${timeAgo(req.decided_at)}`}
          {req.decision_note ? ` — “${req.decision_note}”` : ''}
        </Text>
      )}
      {actionable && (
        <View style={styles.btnRow}>
          <TouchableOpacity
            style={styles.denyBtn}
            onPress={() => onDeny(req)}
            disabled={actingId === req.id}
          >
            <Ionicons name="close" size={15} color="#dc2626" />
            <Text style={styles.denyBtnText}>Deny</Text>
          </TouchableOpacity>
          <PressableScale
            style={[styles.approveBtn, actingId === req.id && { opacity: 0.6 }]}
            onPress={() => decideMut.mutate({ id: req.id, action: 'approve' })}
            disabled={actingId === req.id}
          >
            {actingId === req.id
              ? <ActivityIndicator size="small" color="#fff" />
              : <Ionicons name="checkmark" size={15} color="#fff" />}
            <Text style={styles.approveBtnText}>Approve — mark Ab on Bells</Text>
          </PressableScale>
        </View>
      )}
    </View>
  );

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 14, paddingBottom: 60 + tabBarClearance }}
      refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => q.refetch()} tintColor={colors.primary} />}
    >
      <OfficeToggle style={{ marginBottom: 12 }} />

      <Text style={styles.sectionHead}>
        Awaiting your decision{pending.length ? ` · ${pending.length}` : ''}
        {canSwitch && officeName ? ` · ${officeName}` : ''}
      </Text>
      {pending.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons name="checkmark-done-outline" size={26} color={colors.textMuted} />
          <Text style={styles.emptyText}>
            No pending absence requests{canSwitch && officeName ? ` for ${officeName}` : ''}. Coaches request absences from their Weekly Planner's crew step.
          </Text>
        </View>
      ) : (
        pending.map((req) => <ReqCard key={req.id} req={req} actionable />)
      )}

      {history.length > 0 && (
        <>
          <Text style={[styles.sectionHead, { marginTop: 18 }]}>History</Text>
          {history.map((req) => <ReqCard key={req.id} req={req} actionable={false} />)}
        </>
      )}
    </ScrollView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, gap: 8, paddingHorizontal: 32 },
  emptyTitle: { fontFamily: fonts.display, fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 6 },
  emptyText: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, textAlign: 'center', lineHeight: 18 },
  emptyCard: { alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 22 },

  sectionHead: { fontFamily: fonts.bodySemibold, fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8, paddingHorizontal: 2 },

  card: { backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 10, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  memberName: { fontFamily: fonts.display, fontSize: 15, fontWeight: '800', color: colors.text },
  metaText: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },

  statusChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  statusChipApproved: { backgroundColor: '#dcfce7', borderColor: '#bbf7d0' },
  statusChipDenied: { backgroundColor: '#fee2e2', borderColor: '#fecaca' },
  statusChipText: { fontSize: 9.5, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.4, textTransform: 'uppercase' },

  dayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 9 },
  dayChip: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8, backgroundColor: '#fee2e2', borderWidth: 1, borderColor: '#fecaca' },
  dayChipText: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '800', color: '#dc2626' },

  reasonBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: colors.surfaceAlt, borderRadius: 10, padding: 10, marginTop: 9, borderWidth: 1, borderColor: colors.border },
  reasonText: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, color: colors.text, lineHeight: 18 },

  btnRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  denyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 11, paddingHorizontal: 16, borderRadius: 11, borderWidth: 1, borderColor: '#fecaca', backgroundColor: '#fef2f2' },
  denyBtnText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, fontWeight: '800', color: '#dc2626' },
  approveBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: 11, backgroundColor: '#16a34a' },
  approveBtnText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, fontWeight: '800', color: '#fff' },
});
