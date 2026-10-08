/**
 * OwnerIQ Sync (admin-only) — point-and-click for the OwnerIQ write-back:
 *   • Check alignment (read-only reconcile dry-run) — shows drift + whether
 *     writes are enabled.
 *   • Apply alignment (reconcile for real) — only offered when writes are on.
 * The lifecycle hooks (promote/deactivate/reparent/team) fire automatically;
 * this screen is the manual reconcile + status surface.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation } from '@tanstack/react-query';
import { api } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { showAlert } from '../src/utils/showAlert';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { APP_NAME } from '../src/theme/brand';

const PLAN_LABEL: Record<string, (v: any) => string> = {
  set_active: (v) => (v ? 'reactivate' : 'deactivate'),
  reparent: (v) => `move under ${v}`,
  set_stage: (v) => `set stage ${v}`,
};

export default function OwnerIqAdminScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useAuth();
  const [data, setData] = useState<any>(null);

  const run = useMutation({
    mutationFn: async (dry: boolean) =>
      (await api.post('/owneriq/reconcile', {}, { params: { dry_run: dry } })).data,
    onSuccess: (d) => setData(d),
    onError: (e: any) => showAlert('Reconcile failed', e?.response?.data?.detail || 'Try again.'),
  });

  const apply = () => {
    showAlert(
      'Apply alignment?',
      `This will write ${data?.candidates ?? 0} change(s) to OwnerIQ (parent / active / stage).`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Apply', style: 'destructive', onPress: () => run.mutate(false) },
      ],
    );
  };

  const writesOn = data?.writes_enabled;
  const actions: any[] = data?.actions || [];

  // Screen-level guard to match the server: reconcile touches every office,
  // so it is owner (super admin) only. The URL is directly reachable on web.
  // Placed after every hook.
  if (user && (user.role !== 'admin' || !user.is_super_admin)) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, gap: 8, padding: 32 }}>
        <Stack.Screen options={{ title: 'OwnerIQ Sync' }} />
        <Ionicons name="lock-closed-outline" size={32} color={colors.textMuted} />
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>Owner only</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'OwnerIQ Sync', headerTitleStyle: { fontFamily: fonts.display, color: colors.text } }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: tabBarClearance + 32 }}>
        <Text style={styles.intro}>
          Aligns OwnerIQ to {APP_NAME} (coach/parent, active status, coach stage) for every badge-linked rep.
          “Check” is read-only; nothing changes until you Apply.
        </Text>

        <TouchableOpacity style={styles.btn} disabled={run.isPending} onPress={() => run.mutate(true)}>
          {run.isPending && run.variables === true ? <ActivityIndicator color={colors.onPrimary} />
            : <><Ionicons name="search" size={16} color={colors.onPrimary} /><Text style={styles.btnTxt}>Check alignment</Text></>}
        </TouchableOpacity>

        {data && (
          <>
            <View style={styles.statusRow}>
              <View style={[styles.pill, { backgroundColor: writesOn ? '#dcfce7' : colors.surfaceAlt }]}>
                <Ionicons name={writesOn ? 'flash' : 'flash-off'} size={13} color={writesOn ? '#16a34a' : colors.textMuted} />
                <Text style={[styles.pillTxt, { color: writesOn ? '#16a34a' : colors.textMuted }]}>
                  Writes {writesOn ? 'ON' : 'OFF'}
                </Text>
              </View>
              <Text style={styles.count}>{data.candidates} to align</Text>
            </View>
            {!writesOn && (
              <Text style={styles.hint}>Writes are off — set OWNERIQ_WRITES_ENABLED in host secrets to apply. Check still works.</Text>
            )}

            {data.candidates === 0 ? (
              <View style={styles.okBox}>
                <Ionicons name="checkmark-circle" size={30} color="#16a34a" />
                <Text style={styles.okTxt}>Everything's in sync.</Text>
              </View>
            ) : (
              <>
                {actions.map((a) => (
                  <View key={a.owneriq_user_id} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName}>{a.name || a.owneriq_user_id}</Text>
                      <Text style={styles.rowPlan}>
                        {(a.plan || []).map((p: any[]) => (PLAN_LABEL[p[0]] ? PLAN_LABEL[p[0]](p[1]) : p[0])).join(' · ')}
                      </Text>
                    </View>
                  </View>
                ))}
                {writesOn && (
                  <TouchableOpacity style={[styles.btn, styles.applyBtn]} disabled={run.isPending} onPress={apply}>
                    {run.isPending && run.variables === false ? <ActivityIndicator color={colors.onPrimary} />
                      : <><Ionicons name="git-merge" size={16} color={colors.onPrimary} /><Text style={styles.btnTxt}>Apply alignment ({data.candidates})</Text></>}
                  </TouchableOpacity>
                )}
              </>
            )}

            {typeof data.applied === 'number' && data.applied > 0 && (
              <Text style={styles.applied}>✅ Applied {data.applied} change(s).</Text>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  intro: { fontFamily: fonts.body, fontSize: 13, color: c.textSecondary, lineHeight: 19, marginBottom: 16 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.primary, borderRadius: 12, paddingVertical: 13 },
  applyBtn: { marginTop: 16, backgroundColor: '#16a34a' },
  btnTxt: { fontFamily: fonts.bodyBold, fontSize: 15, color: c.onPrimary },

  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  pillTxt: { fontFamily: fonts.bodyBold, fontSize: 12 },
  count: { fontFamily: fonts.display, fontSize: 15, color: c.text },
  hint: { fontFamily: fonts.body, fontSize: 11.5, color: c.textMuted, marginTop: 8 },

  okBox: { alignItems: 'center', gap: 10, marginTop: 30 },
  okTxt: { fontFamily: fonts.bodySemibold, fontSize: 14, color: c.text },

  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 12, marginTop: 8 },
  rowName: { fontFamily: fonts.bodySemibold, fontSize: 14, color: c.text },
  rowPlan: { fontFamily: fonts.body, fontSize: 12, color: c.textMuted, marginTop: 2 },
  applied: { fontFamily: fonts.bodySemibold, fontSize: 13, color: '#16a34a', textAlign: 'center', marginTop: 16 },
});
