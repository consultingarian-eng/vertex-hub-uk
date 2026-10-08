/**
 * Per-person grading view — drill-ins by stage tab.
 *
 *   • Trainee target  → [Orientation (Day 1-2), Field (Day 3-8), Stage 1 (COD), Stage 2]
 *   • Leader target   → [Stage 2, Stage 3, Stage 4]
 *
 * Days 1-2 (Orientation) and Days 3-8 (Field) reuse the same daily-assessment
 * grading flow trainees see — tapping a day opens the existing
 * `/assessment/[id]` screen for editing. Stage 2/3/4 modules use the
 * `/module/[id]?trainee_id=X` flow.
 *
 * Admin can grade all visible stages. Leaders are limited by the backend's
 * subtree gates.
 */
import React, { useMemo, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../../src/theme/ThemeContext';
import { apiService } from '../../../src/api/client';
import { useAuth } from '../../../src/auth/AuthContext';
import { getStatusColor } from '../../../src/theme/colors';
import TraineeProductExamCard from '../../../src/components/TraineeProductExamCard';
import { SalesPathPanel } from '../../../src/components/salespath/SalesPathPanel';
import { useTabBarClearance } from '../../../src/customization/CustomTabBar';
import { usePullToRefresh } from '../../../src/components/ui/PullRefresh';
import { sortCodStages } from '../../../src/components/cod/stageOrder';
import { APP_LOCALE } from '../../../src/utils/appTime';

type TabKey = 'orientation' | 'field' | 'stage1' | 'stage2' | 'stage3' | 'stage4' | 'stage5' | 'sales';

const ORIENT_DAYS = [1, 2];
const FIELD_DAYS = [3, 4, 5, 6, 7, 8];

const TAB_META: Record<TabKey, { title: string; subtitle: string }> = {
  orientation: { title: 'BA Academy — Days 1-2', subtitle: 'BA Academy grading' },
  field:       { title: 'Field — Days 3-8',       subtitle: 'In-field training grading' },
  stage1:      { title: 'Stage 1 — Foundation',   subtitle: 'COD sheet — build your core competencies' },
  stage2:      { title: 'Stage 2 — Self Management', subtitle: 'Operate like a professional' },
  stage3:      { title: 'Stage 3 — Leader',          subtitle: 'Creating success in others' },
  stage4:      { title: 'Stage 4 — Team Builder',    subtitle: 'Systems, standards & independence' },
  stage5:      { title: 'Stage SL — Sector Leader',  subtitle: 'Performance management' },
  sales:       { title: 'Sales Path',                subtitle: '30-day ramp + proficiency ladder — the second of the two ladders' },
};

export default function TraineeProgressScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const tabBarClearance = useTabBarClearance();
  const { id, mode, tab: tabParam } = useLocalSearchParams<{ id: string; mode?: string; tab?: string }>();
  const { user } = useAuth();
  const isAdmin = (user?.role || '').toLowerCase() === 'admin';
  const [refreshing, setRefreshing] = useState(false);

  // mode=hire means `id` IS the hire_id directly (unassigned trainee flow).
  // No user account lookup needed — assessments are keyed by hire_id.
  const isHireMode = mode === 'hire';

  const traineesQ = useQuery({
    queryKey: ['my-trainees'],
    queryFn: () => apiService.listMyTrainees().then(r => r.data.trainees),
    enabled: !isHireMode,
  });
  const trainee = isHireMode ? null : (traineesQ.data || []).find((t: any) => t.id === id);
  const targetIsLeader = trainee?.role === 'leader';
  // In hire mode, id IS the hire_id. Otherwise get it from the trainee record.
  const hireId: string | undefined = isHireMode ? id : trainee?.new_hire_id;

  // The Sales Development Path tab only exists where the feature is live —
  // the viewer's stage-status carries the office flag (targets share the
  // viewer's office for leaders/admins).
  const stageStatusQ = useQuery({
    queryKey: ['stage-status'],
    queryFn: () => apiService.getStageStatus().then((r) => r.data),
  });
  const salesPathOn = !!stageStatusQ.data?.sales_path_enabled;

  // Build the available tab list based on the target's role.
  //   Leader target → Stage 2/3/4 (+ Sales Path)
  //   Trainee target / hire mode → Orientation, Field, Stage 2 (+ Sales Path)
  const availableTabs: TabKey[] = useMemo(() => {
    if (isHireMode) return ['orientation', 'field'];
    const withSales = (tabs: TabKey[]): TabKey[] => (salesPathOn ? [...tabs, 'sales'] : tabs);
    if (!trainee) return withSales(['orientation', 'field', 'stage1', 'stage2']);
    if (trainee.role === 'leader') {
      // SL sign-off is admin territory (_dims_user_can_grade) — showing the
      // tab to plain leaders would just 403 on every request.
      // Stage tabs in COD display order — Stage SL (stored as 5) sits
      // between Stage 3 and Stage 4. See stageOrder.ts.
      return withSales(isAdmin
        ? sortCodStages([2, 3, 4, 5]).map((n) => `stage${n}` as TabKey)
        : sortCodStages([2, 3]).map((n) => `stage${n}` as TabKey));
    }
    return withSales(['orientation', 'field', 'stage1', 'stage2']);
  }, [trainee, isHireMode, salesPathOn]);

  const [tab, setTab] = useState<TabKey>('orientation');
  // Auto-select default tab when target resolves. A ?tab= param (e.g. the
  // My Team dropdown's separate "Assessments" / "COD" links) wins when it
  // names a tab this target actually has.
  useEffect(() => {
    if (isHireMode) { setTab('orientation'); return; }
    // Honor ?tab= BEFORE the trainee guard: admin-role targets never appear
    // in listMyTrainees, so `trainee` stays undefined and a ?tab=sales link
    // from the leadership hub would otherwise be ignored forever.
    if (tabParam && (availableTabs as string[]).includes(tabParam)) {
      setTab(tabParam as TabKey);
      return;
    }
    if (!trainee) return;
    setTab(targetIsLeader ? 'stage3' : 'orientation');
  }, [targetIsLeader, trainee?.id, isHireMode, tabParam, availableTabs]);

  // Map active tab → stage number for module queries (stage tabs only)
  const stageForTab: 1 | 2 | 3 | 4 | 5 | null =
    tab === 'stage1' ? 1 : tab === 'stage2' ? 2 : tab === 'stage3' ? 3 : tab === 'stage4' ? 4 : tab === 'stage5' ? 5 : null;

  // ── Data fetches ─────────────────────────────────────────────────────────
  // Daily assessments (Day 1-8) — only for trainee targets
  const assessmentsQ = useQuery({
    queryKey: ['trainee-assessments', hireId],
    queryFn: () => apiService.getAssessments(String(hireId)).then(r => r.data || []),
    enabled: !!hireId && !targetIsLeader,
  });

  const modulesQ = useQuery({
    queryKey: ['stage-modules', stageForTab],
    queryFn: () => apiService.listModules(stageForTab as 1 | 2 | 3 | 4 | 5).then(r => r.data.modules),
    enabled: !!stageForTab,
  });
  const progressQ = useQuery({
    queryKey: ['trainee-module-progress', id, stageForTab],
    queryFn: () => apiService.getTraineeModuleProgress(String(id), stageForTab as 1 | 2 | 3 | 4 | 5).then(r => r.data.progress),
    enabled: !!id && !!stageForTab && !isHireMode,
  });

  // Sales Development Path — fetched lazily when its tab is opened.
  const salesQ = useQuery({
    queryKey: ['sales-path-user', id],
    queryFn: () => apiService.getSalesPathFor(String(id)).then(r => r.data),
    enabled: tab === 'sales' && !!id && !isHireMode,
  });

  // Web pull-to-refresh (react-native-web's RefreshControl is a no-op).
  const { pullIndicator } = usePullToRefresh(async () => {
    await Promise.all([
      modulesQ.refetch(),
      progressQ.refetch(),
      assessmentsQ.refetch(),
      ...(tab === 'sales' ? [salesQ.refetch()] : []),
    ]);
  });

  // In hire mode, derive name from the first assessment doc (always populated)
  const hireName: string = isHireMode
    ? (assessmentsQ.data as any)?.[0]?.new_hire_name || 'Unassigned New Starter'
    : trainee?.name || 'Person';

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      modulesQ.refetch(),
      progressQ.refetch(),
      assessmentsQ.refetch(),
      ...(tab === 'sales' ? [salesQ.refetch()] : []),
    ]);
    setRefreshing(false);
  };

  // Refetch every time the screen regains focus — fixes "trainee submitted but
  // leader still sees Pending" caused by stale React Query cache when the
  // admin/leader returns from the assessment detail or another tab.
  useFocusEffect(
    React.useCallback(() => {
      assessmentsQ.refetch();
      progressQ.refetch();
      modulesQ.refetch();
      if (tab === 'sales') salesQ.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hireId, stageForTab, tab])
  );

  // ── Derived data ─────────────────────────────────────────────────────────
  const assessments = (assessmentsQ.data || []) as any[];
  const orientAsmts = assessments
    .filter((a) => ORIENT_DAYS.includes(a.day_number))
    .sort((a, b) => a.day_number - b.day_number);
  const fieldAsmts = assessments
    .filter((a) => FIELD_DAYS.includes(a.day_number))
    .sort((a, b) => a.day_number - b.day_number);

  const orientDone = orientAsmts.filter((a) => a.completed).length;
  const fieldDone = fieldAsmts.filter((a) => a.completed).length;

  const mods = modulesQ.data || [];
  const progressById: Record<string, any> = {};
  (progressQ.data || []).forEach((p: any) => { progressById[p.module_id] = p; });
  const byCat: Record<string, any[]> = {};
  const catOrder: string[] = [];
  mods.forEach((m: any) => {
    const c = m.category || 'General';
    if (!(c in byCat)) { byCat[c] = []; catOrder.push(c); }
    byCat[c].push(m);
  });
  const totalDoneStage = (progressQ.data || []).filter((p: any) => p.completed).length;

  // Stat-box content depends on which tab is active
  const headerStat = (() => {
    if (tab === 'orientation') return { value: `${orientDone}/${ORIENT_DAYS.length}`, label: 'days' };
    if (tab === 'field') return { value: `${fieldDone}/${FIELD_DAYS.length}`, label: 'days' };
    if (tab === 'sales') return { value: `L${salesQ.data?.path?.level ?? '–'}`, label: 'sales path level' };
    return { value: `${totalDoneStage}/${mods.length}`, label: 'modules' };
  })();

  const isLoading = stageForTab
    ? (modulesQ.isLoading || progressQ.isLoading)
    : assessmentsQ.isLoading;

  // ── Score helpers ────────────────────────────────────────────────────────
  const getScoreColor = (score: number | null) => {
    if (score === null) return colors.textMuted;
    if (score >= 9) return (colors as any).green || '#22c55e';
    if (score >= 7) return (colors as any).yellow || '#eab308';
    return (colors as any).red || '#ef4444';
  };

  // ── Render helpers ───────────────────────────────────────────────────────
  const renderDayRow = (a: any, idx: number, total: number, isOrient: boolean) => {
    const localDay = isOrient ? a.day_number : a.day_number - 2;
    return (
      <TouchableOpacity
        key={a.id}
        style={[styles.row, idx === total - 1 && { borderBottomWidth: 0 }]}
        onPress={() => router.push(`/assessment/${a.id}`)}
        testID={`grade-day-row-${a.day_number}`}
      >
        <View style={[
          styles.statusIcon,
          a.completed && { backgroundColor: a.passed_off ? '#2F6A4B' : '#22c55e' },
        ]}>
          {a.completed ? (
            <Ionicons
              name={a.passed_off ? 'shield-checkmark' : 'checkmark'}
              size={16}
              color="#fff"
            />
          ) : (
            <Text style={styles.dayNum}>{localDay}</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.modTitle}>Day {localDay}</Text>
          <Text style={styles.modSub} numberOfLines={1}>
            {a.completed
              ? `Completed${a.assessment_date ? ` • ${new Date(a.assessment_date).toLocaleDateString(APP_LOCALE)}` : ''}`
              : (a.status === 'In Progress' ? 'In progress…' : 'Awaiting assessment')}
          </Text>
        </View>
        {a.completed && a.overall_score != null ? (
          <View style={styles.dayScoreSection}>
            <Text style={[styles.dayScore, { color: getScoreColor(a.overall_score) }]}>
              {Number(a.overall_score).toFixed(1)}
            </Text>
            {a.status && (
              <View style={[styles.miniStatus, { backgroundColor: getStatusColor(a.status).bg }]}>
                <Text style={[styles.miniStatusText, { color: getStatusColor(a.status).text }]}>
                  {a.status}
                </Text>
              </View>
            )}
          </View>
        ) : (
          <Text style={styles.pendingText}>{a.status === 'In Progress' ? 'In progress' : 'Pending'}</Text>
        )}
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      {pullIndicator}
      <Stack.Screen options={{ title: hireName, headerShown: true }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Header card */}
        <View style={styles.summary}>
          <View style={[styles.avatar, targetIsLeader && { backgroundColor: '#2F6A4B' }, isHireMode && { backgroundColor: '#d97706' }]}>
            <Text style={styles.avatarText}>
              {hireName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{hireName}</Text>
            <Text style={styles.email}>{isHireMode ? 'No coach assigned yet' : trainee?.email}</Text>
            <View style={[
              styles.roleBadge,
              isHireMode ? { backgroundColor: '#d9770620' } : targetIsLeader ? styles.roleBadgeLeader : styles.roleBadgeTrainee,
              { marginTop: 4, alignSelf: 'flex-start' },
            ]}>
              <Text style={[
                styles.roleBadgeText,
                { color: isHireMode ? '#d97706' : targetIsLeader ? '#2F6A4B' : '#0ea5e9' },
              ]}>
                {isHireMode ? 'UNASSIGNED' : targetIsLeader ? 'COACH' : 'BA'}
              </Text>
            </View>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{headerStat.value}</Text>
            <Text style={styles.statLabel}>{headerStat.label}</Text>
          </View>
        </View>

        {/* Tab switcher */}
        {availableTabs.length > 1 && (
          <View style={styles.stageTabs}>
            {availableTabs.map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.stageTab, tab === t && styles.stageTabActive]}
                onPress={() => setTab(t)}
                testID={`tab-${t}`}
              >
                <Text style={[styles.stageTabText, tab === t && styles.stageTabTextActive]}>
                  {t === 'orientation' ? 'Academy' :
                   t === 'field' ? 'Field' :
                   t === 'stage1' ? 'Stage 1' :
                   t === 'stage2' ? 'Stage 2' :
                   t === 'stage3' ? 'Stage 3' :
                   t === 'stage4' ? 'Stage 4' :
                   t === 'sales' ? 'Sales' : 'SL'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <Text style={styles.sectionTitle}>{TAB_META[tab].title}</Text>
        <Text style={styles.sectionSubtitle}>{TAB_META[tab].subtitle}</Text>

        {tab === 'sales' ? (
          salesQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
          ) : salesQ.data?.path && salesQ.data?.meta ? (
            <SalesPathPanel
              path={salesQ.data.path}
              meta={salesQ.data.meta}
              // Coach affordances only for a leader/admin looking at someone
              // ELSE — the server rejects self-signing, so the buttons must
              // not render on a self-view either.
              viewerIsCoach={['leader', 'admin'].includes((user?.role || '').toLowerCase()) && String(id) !== String(user?.id)}
              viewerIsAdmin={isAdmin}
              targetUserId={String(id)}
              content={salesQ.data.content}
              canEdit={!!salesQ.data.can_edit}
              onChanged={() => salesQ.refetch()}
            />
          ) : (
            <View style={styles.empty}>
              <Ionicons name="trending-up-outline" size={32} color={colors.textMuted} />
              <Text style={styles.emptyText}>No sales path yet</Text>
              <Text style={styles.emptyHint}>
                Their path appears after their first bells week is saved.
              </Text>
            </View>
          )
        ) : isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : (tab === 'orientation' || tab === 'field') ? (
          // ── Day-1-8 grading ──
          <>
          {!hireId ? (
            <View style={styles.empty}>
              <Ionicons name="alert-circle-outline" size={32} color={colors.textMuted} />
              <Text style={styles.emptyText}>No new-starter record</Text>
              <Text style={styles.emptyHint}>
                This BA isn't linked to a new-starter record yet, so Day 1-8 assessments aren't available.
              </Text>
            </View>
          ) : (
            <View style={styles.daysCard}>
              {(() => {
                const list = tab === 'orientation' ? orientAsmts : fieldAsmts;
                if (list.length === 0) {
                  return (
                    <View style={{ padding: 20, alignItems: 'center' }}>
                      <Text style={{ color: colors.textMuted, fontSize: 13 }}>
                        No assessments yet for this phase.
                      </Text>
                    </View>
                  );
                }
                return list.map((a, idx) => renderDayRow(a, idx, list.length, tab === 'orientation'));
              })()}
            </View>
          )}
          {tab === 'orientation' && id ? <TraineeProductExamCard traineeId={String(id)} /> : null}
          </>
        ) : mods.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="document-text-outline" size={32} color={colors.textMuted} />
            <Text style={styles.emptyText}>No modules at this stage yet.</Text>
            <Text style={styles.emptyHint}>
              Modules can be added via the Manual Editor (admin) at /api/manual-editor.
            </Text>
          </View>
        ) : (
          // ── Stage module grading ──
          <>
          <TouchableOpacity
            style={styles.sheetBtn}
            activeOpacity={0.85}
            onPress={() => router.push(`/cod-sheet?stage=${stageForTab}&user_id=${id}&name=${encodeURIComponent(trainee?.name || '')}`)}
          >
            <Ionicons name="grid-outline" size={16} color={colors.primary} />
            <Text style={styles.sheetBtnText}>View the COD sheet — the K·D·D·T·S grid at a glance</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>
          {catOrder.map((cat) => (
            <View key={cat}>
              <Text style={styles.catHeader}>{cat}</Text>
              {byCat[cat].map((m: any, idx: number) => {
                const p = progressById[m.id];
                const completed = !!p?.completed;
                const passedOff = !!p?.passed_off;
                const scores = p ? [p.knowledge, p.skill, p.consistency, p.independence].filter((x: any) => typeof x === 'number') : [];
                const avg = scores.length ? scores.reduce((s: number, n: number) => s + n, 0) / scores.length : null;
                const RUNGS = ['', 'Know', 'Do', 'Deliver', 'Teach', 'Systemize'];
                const rung = p?.ladder ? RUNGS[p.ladder] : null;
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.row, idx === byCat[cat].length - 1 && { borderBottomWidth: 0 }]}
                    onPress={() => router.push(`/module/${m.id}?trainee_id=${id}`)}
                    testID={`grade-row-${m.id}`}
                  >
                    <View style={[
                      styles.statusIcon,
                      completed && { backgroundColor: passedOff ? (colors as any).purple || '#2F6A4B' : (colors as any).green || '#22c55e' },
                    ]}>
                      <Ionicons
                        name={passedOff ? 'shield-checkmark' : (completed ? 'checkmark' : 'create-outline')}
                        size={16}
                        color={completed ? '#fff' : colors.textSecondary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modTitle} numberOfLines={1}>{m.topic}</Text>
                      <Text style={styles.modSub} numberOfLines={1}>
                        {p?.last_assessed_at ? `Last graded ${new Date(p.last_assessed_at).toLocaleDateString(APP_LOCALE)}` : 'Not graded yet'}
                      </Text>
                    </View>
                    {(rung || avg !== null) && (
                      <View style={styles.scorePill}>
                        <Text style={styles.scoreText}>{rung ?? avg!.toFixed(1)}</Text>
                      </View>
                    )}
                    <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
          </>
        )}

        {/* Admin-only hint about override capability */}
        {isAdmin && (
          <View style={styles.adminHint}>
            <Ionicons name="shield-checkmark" size={16} color={colors.primary} />
            <Text style={styles.adminHintText}>
              You're an admin — every assessment supports override grading and pass-off, regardless of stage.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  content: { padding: 16 },
  summary: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14,
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    marginBottom: 14,
  },
  avatar: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primaryDark,
    alignItems: 'center', justifyContent: 'center',
  },
  // White initials on every avatar fill (primaryDark / leader green / hire amber).
  avatarText: { color: '#FFFFFF', fontWeight: '900', fontSize: 18 },
  name: { fontSize: 16, fontWeight: '800', color: colors.text },
  email: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  roleBadge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  roleBadgeTrainee: { backgroundColor: '#0ea5e91a' },
  roleBadgeLeader: { backgroundColor: '#8A2BC21a' },
  roleBadgeText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  statBox: { alignItems: 'center', paddingHorizontal: 8 },
  statValue: { fontSize: 17, fontWeight: '900', color: colors.primary },
  statLabel: { fontSize: 10, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', marginTop: 2 },

  stageTabs: {
    flexDirection: 'row', gap: 6, marginBottom: 16,
    backgroundColor: colors.surface, padding: 4, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  stageTab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 7 },
  stageTabActive: { backgroundColor: colors.primary },
  stageTabText: { fontSize: 13, fontWeight: '800', color: colors.textSecondary },
  stageTabTextActive: { color: colors.onPrimary },

  sectionTitle: { fontSize: 16, fontWeight: '900', color: colors.text },
  sectionSubtitle: { fontSize: 11.5, color: colors.textSecondary, marginTop: 2, marginBottom: 4 },
  catHeader: {
    fontSize: 11, fontWeight: '900', color: colors.primary,
    letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 14, marginBottom: 6, paddingHorizontal: 4,
  },
  daysCard: {
    backgroundColor: colors.surface, borderRadius: 12, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border, marginTop: 8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 12,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  statusIcon: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: colors.background,
    alignItems: 'center', justifyContent: 'center',
  },
  dayNum: { color: colors.textSecondary, fontWeight: '900', fontSize: 14 },
  modTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  modSub: { fontSize: 11.5, color: colors.textSecondary, marginTop: 2 },
  scorePill: {
    backgroundColor: colors.background, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  scoreText: { fontSize: 13, fontWeight: '800', color: colors.text },

  dayScoreSection: { alignItems: 'flex-end', gap: 4 },
  dayScore: { fontSize: 17, fontWeight: '900' },
  miniStatus: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  miniStatusText: { fontSize: 9, fontWeight: '800' },
  pendingText: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },

  sheetBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginTop: 12, padding: 13, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },

  sheetBtnText: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: { fontSize: 14, fontWeight: '700', color: colors.text, marginTop: 10 },
  emptyHint: { fontSize: 11.5, color: colors.textMuted, textAlign: 'center', marginTop: 4, lineHeight: 16, maxWidth: 280 },

  adminHint: {
    marginTop: 18, padding: 12, borderRadius: 10,
    backgroundColor: (colors.primary || '#244C3B') + '14',
    borderWidth: 1, borderColor: (colors.primary || '#244C3B') + '33',
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  adminHintText: { fontSize: 11.5, color: colors.primary, fontWeight: '700', flex: 1, lineHeight: 16 },
});
