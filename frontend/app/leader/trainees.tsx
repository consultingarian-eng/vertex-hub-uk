/**
 * Grading roster — picker screen for leaders & admins.
 *
 *   • Leader  → only their direct trainees (subtree, role='trainee')
 *   • Admin   → ALL trainees AND leaders within accessible offices, grouped
 *                with role badges so the admin can drill into either
 *
 * Tapping a person opens /leader/trainee/[id] which renders the stage tabs
 * appropriate for that person's role (Stage 2 for trainees; Stage 2/3/4 for
 * leaders, since admins can override every stage).
 */
import React, { useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, RefreshControl,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../src/theme/ThemeContext';
import { apiService } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { BrandLoader } from '../../src/components/ui/BrandLoader';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { usePullToRefresh } from '../../src/components/ui/PullRefresh';

export default function MyTraineesScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const tabBarClearance = useTabBarClearance();
  const { user } = useAuth();
  const isAdmin = (user?.role || '').toLowerCase() === 'admin';
  const [refreshing, setRefreshing] = React.useState(false);

  const traineesQ = useQuery({
    queryKey: ['my-trainees'],
    queryFn: () => apiService.listMyTrainees().then(r => r.data.trainees),
  });

  const unassignedQ = useQuery({
    queryKey: ['unassigned-hires'],
    queryFn: () => apiService.listUnassignedHires().then(r => r.data.hires),
    enabled: isAdmin,
  });

  const { pullIndicator } = usePullToRefresh(async () => {
    await traineesQ.refetch();
    if (isAdmin) await unassignedQ.refetch();
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await traineesQ.refetch();
    if (isAdmin) await unassignedQ.refetch();
    setRefreshing(false);
  };

  if (traineesQ.isLoading) {
    return (
      <View style={styles.loader}>
        <BrandLoader size={56} />
      </View>
    );
  }

  const people = traineesQ.data || [];
  // Bucket by role for admins; leaders only ever see one bucket so we still
  // show it under a single section header.
  const trainees = people.filter((p: any) => (p.role || 'trainee') === 'trainee');
  const leaders = people.filter((p: any) => p.role === 'leader');

  const renderUnassigned = (h: any) => (
    <TouchableOpacity
      key={h.hire_id}
      style={styles.row}
      onPress={() => router.push(`/leader/trainee/${h.hire_id}?mode=hire`)}
    >
      <View style={[styles.avatar, { backgroundColor: '#d97706' }]}>
        <Text style={styles.avatarText}>{(h.name || '?').charAt(0).toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.name}>{h.name || '(Unnamed)'}</Text>
          <View style={[styles.roleBadge, { backgroundColor: '#d9770620' }]}>
            <Text style={[styles.roleBadgeText, { color: '#d97706' }]}>UNASSIGNED</Text>
          </View>
        </View>
        <Text style={styles.email}>Day {h.current_day ?? 1} · {h.campaign || 'No campaign'}{h.start_date ? ` · Started ${h.start_date}` : ''}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </TouchableOpacity>
  );

  const renderPerson = (t: any) => (
    <TouchableOpacity
      key={t.id}
      style={styles.row}
      onPress={() => router.push(`/leader/trainee/${t.id}`)}
      testID={`trainee-row-${t.id}`}
    >
      <View style={[styles.avatar, t.role === 'leader' && { backgroundColor: '#2F6A4B' }]}>
        <Text style={styles.avatarText}>
          {(t.name || t.email || '?').charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.name}>{t.name || '(Unnamed)'}</Text>
          {/* Role badge — useful for admin's mixed list */}
          <View style={[
            styles.roleBadge,
            t.role === 'leader' ? styles.roleBadgeLeader : styles.roleBadgeTrainee,
          ]}>
            <Text style={[
              styles.roleBadgeText,
              { color: t.role === 'leader' ? '#2F6A4B' : '#0ea5e9' },
            ]}>
              {t.role === 'leader' ? 'COACH' : 'BA'}
            </Text>
          </View>
        </View>
        <Text style={styles.email}>{t.email}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </TouchableOpacity>
  );

  return (
    <View style={{ flex: 1 }}>
      {pullIndicator}
      <Stack.Screen
        options={{
          title: isAdmin ? 'Grade People' : 'My BAs',
          headerShown: true,
        }}
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Text style={styles.subtitle}>
          {isAdmin
            ? 'Tap anyone to drill into their stages and override scores. You can grade BAs on Stage 2 and coaches on Stage 3 / 4.'
            : 'Tap a BA to grade them on Stage 2 modules.'}
        </Text>

        {people.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={36} color={colors.textMuted} />
            <Text style={styles.emptyText}>No one to grade yet.</Text>
            <Text style={styles.emptyHint}>
              Once BAs and/or coaches are added to your scope they'll appear here.
            </Text>
          </View>
        )}

        {isAdmin && (unassignedQ.data?.length ?? 0) > 0 && (
          <>
            <Text style={styles.sectionHeader}>
              Unassigned (BA Academy) · {unassignedQ.data!.length}
            </Text>
            {unassignedQ.data!.map(renderUnassigned)}
          </>
        )}

        {trainees.length > 0 && (
          <>
            <Text style={styles.sectionHeader}>
              BAs · {trainees.length}
            </Text>
            {trainees.map(renderPerson)}
          </>
        )}

        {leaders.length > 0 && (
          <>
            <Text style={styles.sectionHeader}>
              Coaches · {leaders.length}
            </Text>
            {leaders.map(renderPerson)}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  content: { padding: 16 },
  subtitle: { fontSize: 13, color: colors.textSecondary, marginBottom: 14, lineHeight: 18 },
  sectionHeader: {
    fontSize: 11, fontWeight: '900', color: colors.textMuted,
    letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 16, marginBottom: 8, paddingHorizontal: 4,
  },
  empty: { padding: 36, alignItems: 'center' },
  emptyText: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 12 },
  emptyHint: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: 6, lineHeight: 17, maxWidth: 280 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14,
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    marginBottom: 10,
  },
  avatar: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primaryDark,
    alignItems: 'center', justifyContent: 'center',
  },
  // White initials on every avatar fill (primaryDark / leader green / hire amber).
  avatarText: { color: '#FFFFFF', fontWeight: '900', fontSize: 16 },
  name: { fontSize: 15, fontWeight: '700', color: colors.text },
  email: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  roleBadge: {
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4,
  },
  roleBadgeTrainee: { backgroundColor: '#0ea5e91a' },
  roleBadgeLeader: { backgroundColor: '#8A2BC21a' },
  roleBadgeText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
});
