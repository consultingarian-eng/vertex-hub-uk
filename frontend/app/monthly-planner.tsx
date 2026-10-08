/**
 * Monthly Goal Planner — per-user monthly self-assessment + planning.
 * Mirrors the printed "Monthly Goal Planner".
 *
 * Routes:
 *   /monthly-planner                      → my latest month
 *   /monthly-planner?user_id=...&month=...→ admin/leader viewing somebody else's
 *
 * Sections:
 *   • Goals (Short/Medium/Long × Business/Personal)
 *   • Monthly Planning (Sales Impacts, Development, Recruitment, Networking)
 *   • What am I learning & who from
 *   • Budget calculator (NEEDS / WANTS, sale value → total sales required)
 *   • SWOT (manual entry — fresh each month, never auto-filled)
 *   • Gap Analysis radar (leader/admin only — hidden for trainees)
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { showAlert } from '../src/utils/showAlert';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, RefreshControl, Switch,  } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Polygon, Line, Circle, Text as SvgText, G } from 'react-native-svg';
import { colors } from '../src/theme/colors';
import { lightColors } from '../src/theme/ThemeContext';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { apiService } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { rescheduleMonthlyPlannerReminder } from '../src/utils/monthlyPlannerReminders';
import { GoalProgressRing } from '../src/components/ui/GoalProgressRing';
import { MonthlyTargetsBlock } from '../src/components/planner/MonthlyTargetsBlock';
import { GoalBuilder, isV2Goals } from '../src/components/planner/GoalBuilder';
import { printOrSharePlanner } from '../src/components/planner/printPlanner';
import { haptics } from '../src/utils/haptics';
import { toast } from '../src/utils/toast';
import { useScrollGuard } from '../src/utils/scrollGuard';
import { ScrollReveal } from '../src/components/ui/ScrollFx';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { AnimatedNumber } from '../src/components/ui/AnimatedNumber';
import { Breathe } from '../src/components/ui/Breathe';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { APP_LOCALE, formatMoney } from '../src/utils/appTime';

// ── Helpers ─────────────────────────────────────────────────────────────
function thisMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function prevMonth(m: string): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function nextMonth(m: string): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function prettyMonth(m: string): string {
  if (!m) return '';
  const [y, mm] = m.split('-').map(Number);
  return new Date(y, mm - 1, 1).toLocaleString(APP_LOCALE, { month: 'long', year: 'numeric' });
}
function isLastNDaysOfMonth(n: number = 3): boolean {
  const today = new Date();
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  return today.getDate() >= last - n + 1;
}

const GOAL_FIELDS: { key: string; label: string; group: 'Short Term' | 'Medium Term' | 'Long Term'; sub: 'Business' | 'Personal' }[] = [
  { key: 'short_business', label: 'Short Term · Business', group: 'Short Term', sub: 'Business' },
  { key: 'short_personal', label: 'Short Term · Personal', group: 'Short Term', sub: 'Personal' },
  { key: 'medium_business', label: 'Medium Term · Business', group: 'Medium Term', sub: 'Business' },
  { key: 'medium_personal', label: 'Medium Term · Personal', group: 'Medium Term', sub: 'Personal' },
  { key: 'long_business', label: 'Long Term · Business', group: 'Long Term', sub: 'Business' },
  { key: 'long_personal', label: 'Long Term · Personal', group: 'Long Term', sub: 'Personal' },
];

const SWOT_FIELDS: { key: 'strengths' | 'weaknesses' | 'opportunities' | 'threats'; label: string; helpful: boolean }[] = [
  { key: 'strengths', label: 'Strengths', helpful: true },
  { key: 'weaknesses', label: 'Weaknesses', helpful: false },
  { key: 'opportunities', label: 'Opportunities', helpful: true },
  { key: 'threats', label: 'Threats', helpful: false },
];

// ── Component ───────────────────────────────────────────────────────────
export default function MonthlyPlannerScreen() {
  const colors = useColors();
  const s = useMemo(() => createS(colors), [colors]);
  // Taps during scroll/momentum must stop the scroll, not focus a note field.
  const { scrollProps, contentProps } = useScrollGuard();
  const { scrollY, onScroll } = useParallaxScroll();

  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const router = useRouter();
  const params = useLocalSearchParams<{ user_id?: string; month?: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const userId = (params.user_id as string) || undefined;
  const [month, setMonth] = useState<string>((params.month as string) || thisMonthKey());

  // Traits list (radar labels)
  const traitsQ = useQuery({
    queryKey: ['monthly-traits'],
    queryFn: () => apiService.monthlyPlannerTraits().then((r) => r.data?.traits || []),
    staleTime: 1000 * 60 * 60,
  });

  const q = useQuery({
    queryKey: ['monthly-planner', userId || 'me', month],
    queryFn: () => apiService.getMonthlyPlanner(month, userId).then((r) => r.data),
  });

  const myMonthsQ = useQuery({
    queryKey: ['monthly-planner-list', userId || 'me'],
    queryFn: () => apiService.listMonthlyPlanners(userId).then((r) => r.data),
  });

  // Web pull-to-refresh (react-native-web's RefreshControl is a no-op).
  const { pullIndicator } = usePullToRefresh(() => q.refetch());

  // ── Local working draft, autosave (debounced) when can_edit ─────────────
  const [draft, setDraft] = useState<any>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const debounceRef = useRef<any>(null);

  useEffect(() => {
    if (!q.data) return;
    setDraft(q.data.planner);
  }, [q.data]);

  // Re-evaluate the local push reminder whenever this user's planner list
  // changes. The util is no-op on web / when permission is denied / when
  // next-month already exists, so it's safe to call cheaply.
  useEffect(() => {
    if (userId) return; // viewing someone else — don't touch the owner's reminder
    const months = (myMonthsQ.data?.items || []).map((it: any) => it.month).filter(Boolean) as string[];
    rescheduleMonthlyPlannerReminder(months).catch(() => {});
  }, [myMonthsQ.data, userId]);

  const saveMut = useMutation({
    mutationFn: (payload: any) => apiService.upsertMonthlyPlanner(month, payload).then((r) => r.data),
    onMutate: () => setSavingState('saving'),
    onSuccess: () => {
      setSavingState('saved');
      queryClient.invalidateQueries({ queryKey: ['monthly-planner-list', userId || 'me'] });
      setTimeout(() => setSavingState((s) => (s === 'saved' ? 'idle' : s)), 1500);
    },
    onError: () => setSavingState('error'),
  });

  const startMut = useMutation({
    mutationFn: () => apiService.startMonthlyPlanner(month).then((r) => r.data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['monthly-planner', userId || 'me', month] });
      queryClient.invalidateQueries({ queryKey: ['monthly-planner-list', userId || 'me'] });
      if (data?.planner) setDraft(data.planner);
    },
    onError: (e: any) => showAlert('Could not start', e?.response?.data?.detail || 'Try again'),
  });

  const update = (mutator: (cur: any) => any) => {
    setDraft((cur: any) => {
      const next = mutator(cur);
      if (q.data?.can_edit) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => saveMut.mutate({
          goals: next.goals, swot: next.swot, monthly_planning: next.monthly_planning,
          learning: next.learning, budget: next.budget, gap_analysis: next.gap_analysis,
          targets: next.targets,
        }), 1100);
      }
      return next;
    });
  };

  // ── Reminder banner (last 3 days of the current month) ──────────────────
  const showReminder = useMemo(() => {
    if (userId) return false; // viewing someone else
    if (!isLastNDaysOfMonth(3)) return false;
    // Already created next month?
    const items = (myMonthsQ.data?.items || []) as { month: string }[];
    const nm = nextMonth(thisMonthKey());
    return !items.find((x) => x.month === nm);
  }, [myMonthsQ.data, userId]);

  const isOwner = !userId || userId === user?.id;
  const canEdit = !!q.data?.can_edit;
  const targetRole = q.data?.target_role || user?.role || 'trainee';
  const showGap = targetRole !== 'trainee';

  // ── Print / Export PDF ──────────────────────────────────────────────────
  const [printing, setPrinting] = useState(false);
  const handlePrint = async () => {
    if (!draft) return;
    setPrinting(true);
    try {
      haptics.tap();
      await printOrSharePlanner({
        ownerName: userId ? (myMonthsQ.data?.user?.name || 'Planner') : (user?.name || 'My Planner'),
        month,
        draft,
        traits: (traitsQ.data || []) as string[],
        showGap,
      });
    } catch (e: any) {
      toast.error('Print failed', e?.message || 'Try again');
    } finally {
      setPrinting(false);
    }
  };

  // ── (AI Coach removed per user request) ─────────────────────────────────

  // ── Progress ring metrics — % complete of each section ──────────────────
  const completion = useMemo(() => {
    const goals = draft?.goals || {};
    // v2: count filled KPIs + Rocks toward a 7-goal target; legacy: 6 boxes.
    let goalsFilled: number;
    let goalsTarget: number;
    if (isV2Goals(goals)) {
      const kf = (goals.kpis || []).filter((k: any) => (k?.name || '').toString().trim().length > 0).length;
      const rf = (goals.rocks || []).filter((r: any) => (r?.name || '').toString().trim().length > 0).length;
      goalsFilled = Math.min(kf + rf, 7);
      goalsTarget = 7;
    } else {
      goalsFilled = GOAL_FIELDS.filter((f) => (goals[f.key] || '').toString().trim().length > 0).length;
      goalsTarget = GOAL_FIELDS.length;
    }
    const swot = draft?.swot || {};
    const swotFilled = SWOT_FIELDS.filter((f) => (swot[f.key] || '').toString().trim().length > 0).length;
    const scores = draft?.gap_analysis?.scores || {};
    const gapTraits = (traitsQ.data || []) as string[];
    const gapFilled = gapTraits.filter((t) => Number(scores[t] || 0) > 0).length;
    return {
      goals: { value: goalsFilled, target: goalsTarget },
      swot: { value: swotFilled, target: SWOT_FIELDS.length },
      gap: { value: gapFilled, target: gapTraits.length || 16 },
    };
  }, [draft, traitsQ.data]);

  // Loading state
  if (!draft) {
    return (
      <View style={{ flex: 1 }}>
        <Stack.Screen options={{ title: 'Monthly Goal Planner' }} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.textMuted }}>Loading…</Text>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      {pullIndicator}
      <Stack.Screen options={{ title: 'Monthly Goal Planner' }} />
      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 80 + tabBarClearance }}
        refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => q.refetch()} tintColor={colors.primary} />}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
        {...scrollProps}
      >
        {/* Guard wrapper: while scrolling, taps land here (stopping the scroll)
            instead of focusing whatever input happens to be under the finger. */}
        <View {...contentProps}>
        {/* The month, whose planner it is, and Print: one line. (The page's
            name is in the masthead.) */}
        <View style={s.header}>
          <View style={s.monthNav}>
            <TouchableOpacity style={s.monthBtn} onPress={() => setMonth(prevMonth(month))} accessibilityLabel="Previous month">
              <Ionicons name="chevron-back" size={16} color={colors.text} />
            </TouchableOpacity>
            <View style={s.monthPill}>
              <Ionicons name="calendar-outline" size={13} color={colors.primary} />
              <Text style={s.monthLabel}>{prettyMonth(month)}{q.data?.exists === false ? ' · new' : ''}</Text>
            </View>
            <TouchableOpacity style={s.monthBtn} onPress={() => setMonth(nextMonth(month))} accessibilityLabel="Next month">
              <Ionicons name="chevron-forward" size={16} color={colors.text} />
            </TouchableOpacity>
          </View>
          {userId ? <Text style={s.subtitle} numberOfLines={1}>{myMonthsQ.data?.user?.name || 'Planner'}</Text> : null}
          <View style={{ flex: 1 }} />
          {savingState === 'saving' && <View style={s.savePill}><Text style={s.savePillText}>Saving…</Text></View>}
          {savingState === 'saved' && <View style={[s.savePill, { backgroundColor: '#dcfce7' }]}><Text style={[s.savePillText, { color: '#166534' }]}>Saved</Text></View>}
          {!canEdit && q.data?.exists && (
            <View style={[s.savePill, { backgroundColor: '#EDF3E4' }]}>
              <Ionicons name="lock-closed" size={12} color={colors.textMuted} />
              <Text style={[s.savePillText, { color: colors.textMuted }]}>{isOwner ? 'Locked' : 'Read only'}</Text>
            </View>
          )}
          {/* Print / Export PDF — visible whenever a planner exists for the current view */}
          {q.data?.exists !== false && (
            <TouchableOpacity
              style={[s.printBtn, printing && { opacity: 0.6 }]}
              onPress={handlePrint}
              disabled={printing}
              accessibilityLabel="Print or export PDF"
            >
              <Ionicons
                name={printing ? 'hourglass-outline' : (Platform.OS === 'web' ? 'print-outline' : 'share-outline')}
                size={15}
                color={colors.text}
              />
              <Text style={s.printBtnText}>{printing ? 'Preparing…' : (Platform.OS === 'web' ? 'Print' : 'Export PDF')}</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Reminder — last 3 days of month, owner only */}
        {showReminder && (
          <View style={s.reminder}>
            <Ionicons name="notifications" size={18} color="#92400e" />
            <View style={{ flex: 1 }}>
              <Text style={s.reminderTitle}>The next month is about to start</Text>
              <Text style={s.reminderText}>Take a few minutes to fill out your {prettyMonth(nextMonth(thisMonthKey()))} planner.</Text>
            </View>
            <TouchableOpacity
              style={s.reminderBtn}
              onPress={() => {
                const nm = nextMonth(thisMonthKey());
                setMonth(nm);
              }}
            >
              <Text style={s.reminderBtnText}>Open</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Goal Progress Rings — visualizes how complete the planner is */}
        {q.data?.exists !== false && (
          <View style={s.ringsCard}>
            <Text style={s.ringsTitle}>Planner Progress</Text>
            <View style={s.ringsRow}>
              <GoalProgressRing
                value={completion.goals.value}
                target={completion.goals.target}
                label="Goals"
                accent={colors.primary}
                size={88}
                stroke={9}
              />
              <GoalProgressRing
                value={completion.swot.value}
                target={completion.swot.target}
                label="SWOT"
                accent="#22c55e"
                size={88}
                stroke={9}
              />
              {showGap && (
                <GoalProgressRing
                  value={completion.gap.value}
                  target={completion.gap.target}
                  label="Gap"
                  accent="#f59e0b"
                  size={88}
                  stroke={9}
                />
              )}
            </View>
          </View>
        )}

        {/* If not exists yet (owner viewing future/empty month) → start CTA */}
        {q.data?.exists === false && isOwner && (
          <View style={s.startCard}>
            <Ionicons name="sparkles-outline" size={22} color={colors.primary} />
            <Text style={s.startTitle}>Start {prettyMonth(month)}</Text>
            <Text style={s.startText}>
              We'll auto-fill your GAP scores, budget rows, and goals from your previous month so you can just edit deltas. Your SWOT stays fresh — fill it in for THIS month.
              {(myMonthsQ.data?.items || []).length > 0 ? ' Earlier months will become read-only.' : ''}
            </Text>
            <Breathe>
              <TouchableOpacity style={s.startBtn} onPress={() => startMut.mutate()} disabled={startMut.isPending}>
                <Ionicons name="add-circle" size={16} color={colors.onPrimary} />
                <Text style={s.startBtnText}>{startMut.isPending ? 'Creating…' : `Create ${prettyMonth(month)}`}</Text>
              </TouchableOpacity>
            </Breathe>
          </View>
        )}

        {/* If not exists, requester is leader/admin viewing somebody else */}
        {q.data?.exists === false && !isOwner && (
          <View style={s.empty}>
            <Ionicons name="document-outline" size={32} color={colors.textMuted} />
            <Text style={s.emptyText}>{myMonthsQ.data?.user?.name || 'This person'} hasn't created a planner for {prettyMonth(month)}.</Text>
          </View>
        )}

        {/* === SECTIONS === Show only when planner exists OR owner has unsaved seed */}
        {(q.data?.exists || isOwner) && (
          <>
            {/* Targets */}
            <Section icon="trending-up" title="Targets" subtitle="Monthly Sales Focus & personal best · auto-tracks against your bells">
              <MonthlyTargetsBlock
                month={month}
                canEdit={canEdit}
                targets={draft.targets || {}}
                onChange={(t) => update((c) => ({ ...c, targets: t }))}
              />
            </Section>

            {/* Goals — guided KPI/Rock builder (v2) or the legacy free-text grid */}
            <ScrollReveal scrollY={scrollY}>
            <Section
              icon="flag"
              title="Goals"
              subtitle={isV2Goals(draft.goals) ? 'KPIs & Rocks · SMART goals with rewards' : 'Short / Medium / Long term · Business + Personal'}
            >
              {isV2Goals(draft.goals) ? (
                <GoalBuilder
                  goals={draft.goals}
                  canEdit={canEdit}
                  onChange={(g) => update((c: any) => ({ ...c, goals: g }))}
                />
              ) : (
                <View style={s.goalsGrid}>
                  {GOAL_FIELDS.map((f) => (
                    <View key={f.key} style={s.goalCell}>
                      <Text style={s.goalCellLabel}>{f.label}</Text>
                      <TextInput
                        multiline
                        scrollEnabled={false}
                        editable={canEdit}
                        style={[s.goalInput, !canEdit && s.disabled]}
                        placeholder="Write a goal…"
                        placeholderTextColor={colors.textMuted}
                        value={(draft.goals?.[f.key]) || ''}
                        onChangeText={(v) => update((c) => ({ ...c, goals: { ...(c.goals || {}), [f.key]: v } }))}
                      />
                    </View>
                  ))}
                </View>
              )}
            </Section>
            </ScrollReveal>

            {/* Monthly Planning */}
            <ScrollReveal scrollY={scrollY}>
            <Section icon="calendar" title="Monthly Planning">
              {/* Sales Impacts */}
              <Text style={s.subSect}>Sales Impacts <Text style={s.subSectMuted}>(Who · When · What)</Text></Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {(['coach_others', 'still_to_master'] as const).map((k) => (
                  <View key={k} style={{ flex: 1 }}>
                    <Text style={s.smallLabel}>{k === 'coach_others' ? 'Coach others' : 'Still to master'}</Text>
                    <TextInput
                      multiline
                      scrollEnabled={false}
                      editable={canEdit}
                      style={[s.boxInput, !canEdit && s.disabled]}
                      value={draft.monthly_planning?.sales_impacts?.[k] || ''}
                      onChangeText={(v) => update((c) => ({
                        ...c,
                        monthly_planning: {
                          ...(c.monthly_planning || {}),
                          sales_impacts: { ...(c.monthly_planning?.sales_impacts || {}), [k]: v },
                        },
                      }))}
                    />
                  </View>
                ))}
              </View>
              {/* Tables */}
              {(['development', 'recruitment', 'networking'] as const).map((tk) => (
                <PlanningTable
                  key={tk}
                  title={tk === 'development' ? 'Development – COD' : tk === 'recruitment' ? 'Recruitment' : 'Networking – Travelling & Conference Calls'}
                  rows={draft.monthly_planning?.[tk] || []}
                  canEdit={canEdit}
                  onChange={(rows) => update((c) => ({
                    ...c,
                    monthly_planning: { ...(c.monthly_planning || {}), [tk]: rows },
                  }))}
                />
              ))}
            </Section>
            </ScrollReveal>

            {/* Learning */}
            <Section icon="school" title="What am I learning this month & who from">
              <TextInput
                multiline
                scrollEnabled={false}
                editable={canEdit}
                style={[s.boxInput, !canEdit && s.disabled]}
                placeholder="Topics, mentors, resources, key takeaways…"
                placeholderTextColor={colors.textMuted}
                value={draft.learning?.summary || ''}
                onChangeText={(v) => update((c) => ({ ...c, learning: { ...(c.learning || {}), summary: v } }))}
              />
              <Text style={[s.subSect, { marginTop: 12 }]}>Learning items</Text>
              {(draft.learning?.items || []).map((it: any, idx: number) => (
                <View key={it.id || idx} style={s.learnRow}>
                  <TextInput
                    placeholder="Topic" placeholderTextColor={colors.textMuted}
                    style={[s.learnInput, { flex: 2 }, !canEdit && s.disabled]}
                    editable={canEdit}
                    value={it.topic || ''}
                    onChangeText={(v) => update((c) => ({
                      ...c,
                      learning: {
                        ...(c.learning || {}),
                        items: (c.learning?.items || []).map((r: any, i: number) => i === idx ? { ...r, topic: v } : r),
                      },
                    }))}
                  />
                  <TextInput
                    placeholder="From whom" placeholderTextColor={colors.textMuted}
                    style={[s.learnInput, { flex: 1.3 }, !canEdit && s.disabled]}
                    editable={canEdit}
                    value={it.mentor || ''}
                    onChangeText={(v) => update((c) => ({
                      ...c,
                      learning: {
                        ...(c.learning || {}),
                        items: (c.learning?.items || []).map((r: any, i: number) => i === idx ? { ...r, mentor: v } : r),
                      },
                    }))}
                  />
                  {canEdit && (
                    <TouchableOpacity
                      onPress={() => update((c) => ({
                        ...c,
                        learning: {
                          ...(c.learning || {}),
                          items: (c.learning?.items || []).filter((_: any, i: number) => i !== idx),
                        },
                      }))}
                    >
                      <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                  )}
                </View>
              ))}
              {canEdit && (
                <TouchableOpacity
                  style={s.addRowBtn}
                  onPress={() => update((c) => ({
                    ...c,
                    learning: {
                      ...(c.learning || {}),
                      items: [...(c.learning?.items || []), { id: `tmp-${Date.now()}`, topic: '', mentor: '', notes: '' }],
                    },
                  }))}
                >
                  <Ionicons name="add" size={14} color={colors.primary} />
                  <Text style={s.addRowText}>Add learning item</Text>
                </TouchableOpacity>
              )}
            </Section>

            {/* Budget */}
            <BudgetSection
              budget={draft.budget || {}}
              canEdit={canEdit}
              onChange={(b) => update((c) => ({ ...c, budget: b }))}
            />

            {/* SWOT */}
            <ScrollReveal scrollY={scrollY}>
            <Section
              icon="bookmark"
              title="SWOT Analysis"
              subtitle="Reflect on this month — your personal strengths, weaknesses, opportunities, threats"
            >
              <View style={s.swotGrid}>
                {SWOT_FIELDS.map((f) => (
                  <View key={f.key} style={[s.swotCell, { borderColor: f.helpful ? '#16a34a' : '#dc2626' }]}>
                    <Text style={[s.swotLabel, { color: f.helpful ? '#15803d' : '#991b1b' }]}>{f.label}</Text>
                    <TextInput
                      multiline
                      scrollEnabled={false}
                      editable={canEdit}
                      style={[s.swotInput, !canEdit && s.disabled]}
                      value={draft.swot?.[f.key] || ''}
                      onChangeText={(v) => update((c) => ({ ...c, swot: { ...(c.swot || {}), [f.key]: v } }))}
                    />
                  </View>
                ))}
              </View>
            </Section>
            </ScrollReveal>

            {/* GAP Analysis */}
            {showGap && (
              <Section
                icon="podium"
                title="Coach Gap Analysis"
                subtitle="Score 1–5 honestly — tap a low score for AI tips"
              >
                <GapAnalysisRadar
                  traits={traitsQ.data || []}
                  scores={draft.gap_analysis?.scores || {}}
                  canEdit={canEdit}
                  onChange={(scores) => update((c) => ({ ...c, gap_analysis: { ...(c.gap_analysis || {}), scores } }))}
                />
              </Section>
            )}

            {/* Months list */}
            {(myMonthsQ.data?.items || []).length > 1 && (
              <Section icon="archive" title="All months">
                {(myMonthsQ.data?.items || []).map((it: any) => (
                  <TouchableOpacity
                    key={it.month}
                    style={[s.monthRow, it.month === month && s.monthRowActive]}
                    onPress={() => setMonth(it.month)}
                  >
                    <Text style={s.monthRowText}>{prettyMonth(it.month)}</Text>
                    {it.locked && <Ionicons name="lock-closed" size={12} color={colors.textMuted} />}
                    {!it.locked && it.month === month && <Ionicons name="pencil" size={12} color={colors.primary} />}
                  </TouchableOpacity>
                ))}
              </Section>
            )}
          </>
        )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── Section wrapper ─────────────────────────────────────────────────────
function Section({ icon, title, subtitle, children, right }: { icon: any; title: string; subtitle?: string; children: any; right?: React.ReactNode }) {
  const colors = useColors();
  const s = useMemo(() => createS(colors), [colors]);

  return (
    <View style={s.section}>
      <View style={s.sectionHeader}>
        <Ionicons name={icon} size={16} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={s.sectionTitle}>{title}</Text>
          {subtitle && <Text style={s.sectionSubtitle}>{subtitle}</Text>}
        </View>
        {right}
      </View>
      <View>{children}</View>
    </View>
  );
}

// ── Planning Table (Topic / Who / When / Done) ───────────────────────────
function PlanningTable({ title, rows, canEdit, onChange }: { title: string; rows: any[]; canEdit: boolean; onChange: (rows: any[]) => void }) {
  // Without these this component fell back to the module-level light-mode
  // styles, so in dark mode the section title (colors.text = near-black) went
  // invisible against the dark card and the inputs kept a light background.
  const colors = useColors();
  const s = useMemo(() => createS(colors), [colors]);

  return (
    <View style={{ marginTop: 12 }}>
      <Text style={s.subSect}>{title}</Text>
      <View style={s.tblHeader}>
        <Text style={[s.tblHCell, { flex: 2 }]}>Topic</Text>
        <Text style={[s.tblHCell, { flex: 1.2 }]}>Who</Text>
        <Text style={[s.tblHCell, { flex: 0.9 }]}>When</Text>
        <Text style={[s.tblHCell, { width: 50, textAlign: 'center' }]}>Done</Text>
      </View>
      {rows.map((r, idx) => (
        <View key={r.id || idx} style={s.tblRow}>
          <TextInput
            style={[s.tblInput, { flex: 2 }, !canEdit && s.disabled]} editable={canEdit}
            placeholder="—" placeholderTextColor={colors.textMuted}
            value={r.topic || ''}
            onChangeText={(v) => onChange(rows.map((x, i) => i === idx ? { ...x, topic: v } : x))}
          />
          <TextInput
            style={[s.tblInput, { flex: 1.2 }, !canEdit && s.disabled]} editable={canEdit}
            placeholder="—" placeholderTextColor={colors.textMuted}
            value={r.who || ''}
            onChangeText={(v) => onChange(rows.map((x, i) => i === idx ? { ...x, who: v } : x))}
          />
          <TextInput
            style={[s.tblInput, { flex: 0.9 }, !canEdit && s.disabled]} editable={canEdit}
            placeholder="—" placeholderTextColor={colors.textMuted}
            value={r.when || ''}
            onChangeText={(v) => onChange(rows.map((x, i) => i === idx ? { ...x, when: v } : x))}
          />
          <View style={{ width: 50, alignItems: 'center', justifyContent: 'center' }}>
            <Switch
              value={!!r.completed}
              disabled={!canEdit}
              onValueChange={(v) => onChange(rows.map((x, i) => i === idx ? { ...x, completed: v } : x))}
            />
          </View>
        </View>
      ))}
      {canEdit && (
        <TouchableOpacity
          style={s.addRowBtn}
          onPress={() => onChange([...rows, { id: `tmp-${Date.now()}`, topic: '', who: '', when: '', completed: false }])}
        >
          <Ionicons name="add" size={14} color={colors.primary} />
          <Text style={s.addRowText}>Add row</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Budget Section ──────────────────────────────────────────────────────
function BudgetSection({ budget, canEdit, onChange }: { budget: any; canEdit: boolean; onChange: (b: any) => void }) {
  // Same theming gap as PlanningTable — see the note there.
  const colors = useColors();
  const s = useMemo(() => createS(colors), [colors]);

  const updateRow =(group: 'needs' | 'wants', idx: number, field: 'label' | 'amount' | 'sales', v: string) => {
    const list = (budget[group] || []).map((r: any, i: number) => i === idx ? { ...r, [field]: v } : r);
    onChange({ ...budget, [group]: list });
  };
  const addRow = (group: 'needs' | 'wants') => {
    onChange({ ...budget, [group]: [...(budget[group] || []), { id: `tmp-${Date.now()}`, label: '', amount: '', sales: '' }] });
  };
  const removeRow = (group: 'needs' | 'wants', idx: number) => {
    onChange({ ...budget, [group]: (budget[group] || []).filter((_: any, i: number) => i !== idx) });
  };

  // Derive totals for live display (server also recomputes on save)
  const num = (x: any) => parseFloat(String(x || '').replace(/[£$,]/g, '')) || 0;
  const tmN = (budget.needs || []).reduce((acc: number, r: any) => acc + num(r.amount), 0);
  const tmW = (budget.wants || []).reduce((acc: number, r: any) => acc + num(r.amount), 0);
  const sv = num(budget.sale_value);
  const totalSales = sv > 0 ? Math.round((tmN + tmW) / sv) : ((budget.needs || []).reduce((a: number, r: any) => a + num(r.sales), 0) + (budget.wants || []).reduce((a: number, r: any) => a + num(r.sales), 0));

  return (
    <Section icon="calculator" title="Budget · Break-Even Calculator">
      {(['needs', 'wants'] as const).map((group) => (
        <View key={group} style={{ marginBottom: 14 }}>
          <Text style={s.subSect}>{group === 'needs' ? 'NEEDS' : 'WANTS'}</Text>
          <View style={s.tblHeader}>
            <Text style={[s.tblHCell, { flex: 2 }]}>Item</Text>
            <Text style={[s.tblHCell, { flex: 1, textAlign: 'right' }]}>Amount £</Text>
            <Text style={[s.tblHCell, { flex: 1, textAlign: 'right' }]}># Sign-ups</Text>
            {canEdit && <View style={{ width: 24 }} />}
          </View>
          {(budget[group] || []).map((r: any, idx: number) => (
            <View key={r.id || idx} style={s.tblRow}>
              <TextInput
                style={[s.tblInput, { flex: 2 }, !canEdit && s.disabled]} editable={canEdit}
                placeholder={group === 'needs' ? 'Phone / Rent / …' : 'Savings / …'}
                placeholderTextColor={colors.textMuted}
                value={r.label || ''}
                onChangeText={(v) => updateRow(group, idx, 'label', v)}
              />
              <TextInput
                style={[s.tblInput, { flex: 1, textAlign: 'right' }, !canEdit && s.disabled]} editable={canEdit}
                placeholder="0" placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
                value={r.amount || ''}
                onChangeText={(v) => updateRow(group, idx, 'amount', v)}
              />
              <TextInput
                style={[s.tblInput, { flex: 1, textAlign: 'right' }, !canEdit && s.disabled]} editable={canEdit}
                placeholder="0" placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
                value={r.sales || ''}
                onChangeText={(v) => updateRow(group, idx, 'sales', v)}
              />
              {canEdit && (
                <TouchableOpacity onPress={() => removeRow(group, idx)} style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          ))}
          {canEdit && (
            <TouchableOpacity style={s.addRowBtn} onPress={() => addRow(group)}>
              <Ionicons name="add" size={14} color={colors.primary} />
              <Text style={s.addRowText}>Add {group === 'needs' ? 'need' : 'want'}</Text>
            </TouchableOpacity>
          )}
          <View style={s.tblTotal}>
            <Text style={s.tblTotalLabel}>Total {group === 'needs' ? 'NEEDS' : 'WANTS'}</Text>
            <Text style={s.tblTotalNum}>{formatMoney(group === 'needs' ? tmN : tmW, 2)}</Text>
          </View>
        </View>
      ))}

      {/* Sale value + summary */}
      <View style={s.summaryCard}>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>Each sign-up is worth £</Text>
          <TextInput
            style={[s.summaryInput, !canEdit && s.disabled]} editable={canEdit}
            placeholder="0.00" placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
            value={budget.sale_value || ''}
            onChangeText={(v) => onChange({ ...budget, sale_value: v })}
          />
        </View>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>Total £ needed (Needs + Wants)</Text>
          <Text style={s.summaryValue}>{formatMoney(tmN + tmW, 2)}</Text>
        </View>
        <View style={[s.summaryRow, { backgroundColor: 'rgba(58, 122, 86,0.08)', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, marginTop: 4 }]}>
          <Text style={[s.summaryLabel, { color: colors.primary, fontWeight: '800' }]}>Total sign-ups required to break even</Text>
          <AnimatedNumber value={totalSales} decimals={0} style={[s.summaryValue, { color: colors.primary, fontSize: 18 }]} />
        </View>
      </View>
    </Section>
  );
}

// ── Gap Analysis Radar ──────────────────────────────────────────────────
function GapAnalysisRadar({ traits, scores, canEdit, onChange, onAskAI }: { traits: string[]; scores: Record<string, number>; canEdit: boolean; onChange: (s: Record<string, number>) => void; onAskAI?: (trait: string, score: number) => void }) {
  const colors = useColors();
  const s = useMemo(() => createS(colors), [colors]);
  if (!traits.length) return <Text style={{ color: colors.textMuted }}>Loading traits…</Text>;
  // Tightened viewBox so the radar fills the available area instead of
  // floating in empty space. Labels still get ~110px margin past the
  // chart radius so long trait names don't clip.
  const VB_W = 520;             // virtual viewBox width
  const VB_H = 360;             // virtual viewBox height
  const cx = VB_W / 2;
  const cy = VB_H / 2;
  const R = 145;                // chart radius — bigger so the radar is readable
  const ringValues = [1, 2, 3, 4, 5];
  const gridStroke = colors.border;

  const points = traits.map((t, i) => {
    const a = (Math.PI * 2 * i) / traits.length - Math.PI / 2;
    const v = Math.max(0, Math.min(5, Number(scores[t] || 0)));
    const r = (v / 5) * R;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, t, a, v };
  });
  const polyPoints = points.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <View>
      <View style={{ alignItems: 'center', marginBottom: 14 }}>
        <Svg width="100%" height={320} viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid meet">
          {/* Concentric grid rings */}
          {ringValues.map((rv) => {
            const r = (rv / 5) * R;
            const ringPoly = traits.map((_, i) => {
              const a = (Math.PI * 2 * i) / traits.length - Math.PI / 2;
              return `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`;
            }).join(' ');
            return <Polygon key={rv} points={ringPoly} fill="none" stroke={gridStroke} strokeWidth={1} />;
          })}
          {/* Spokes */}
          {traits.map((_, i) => {
            const a = (Math.PI * 2 * i) / traits.length - Math.PI / 2;
            return <Line key={i} x1={cx} y1={cy} x2={cx + Math.cos(a) * R} y2={cy + Math.sin(a) * R} stroke={gridStroke} strokeWidth={1} />;
          })}
          {/* Score polygon */}
          <Polygon points={polyPoints} fill={`${colors.primary}40`} stroke={colors.primary} strokeWidth={2} />
          {/* Score dots */}
          {points.map((p, i) => <Circle key={i} cx={p.x} cy={p.y} r={3.5} fill={colors.primary} />)}
          {/* Trait labels — anchored so long names don't clip */}
          {traits.map((t, i) => {
            const a = (Math.PI * 2 * i) / traits.length - Math.PI / 2;
            const lr = R + 14;
            const x = cx + Math.cos(a) * lr;
            const y = cy + Math.sin(a) * lr;
            // textAnchor: based on x relative to center (with a small dead-zone for top/bottom)
            const anchor = x > cx + 6 ? 'start' : x < cx - 6 ? 'end' : 'middle';
            return (
              <SvgText key={i} x={x} y={y} fontSize={11} fill={colors.text} textAnchor={anchor}>
                {t}
              </SvgText>
            );
          })}
        </Svg>
      </View>
      {/* Score steppers */}
      <View style={{ gap: 6 }}>
        {traits.map((t) => {
          const score = Number(scores[t] || 0);
          return (
            <View key={t} style={s.gapRow}>
              <Text style={s.gapLabel}>{t}</Text>
              <View style={s.gapSteppers}>
                {[1, 2, 3, 4, 5].map((v) => {
                  const sel = score === v;
                  return (
                    <TouchableOpacity
                      key={v}
                      disabled={!canEdit}
                      onPress={() => { haptics.light(); onChange({ ...scores, [t]: v }); }}
                      style={[s.gapPill, sel && s.gapPillActive, !canEdit && { opacity: 0.6 }]}
                    >
                      <Text style={[s.gapPillText, sel && s.gapPillTextActive]}>{v}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {onAskAI && score > 0 && (
                <TouchableOpacity
                  onPress={() => onAskAI(t, score)}
                  style={[s.aiBtnInline, score <= 2 && { borderColor: colors.yellow, backgroundColor: colors.yellowBg }]}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <Ionicons name="sparkles" size={11} color={score <= 2 ? colors.yellow : colors.primary} />
                </TouchableOpacity>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────
const createS = (colors: any) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  title: { fontFamily: fonts.bodyBold, fontSize: 22, color: colors.text },
  subtitle: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.textSecondary },
  savePill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, backgroundColor: 'rgba(58, 122, 86,0.1)' },
  savePillText: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.primary },
  printBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  printBtnText: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: colors.text },
  monthNav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  monthPill: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 36, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  monthBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  monthLabel: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.text },
  monthSubLabel: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 1 },
  reminder: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.yellowBg, borderWidth: 1, borderColor: colors.yellow, marginBottom: 12 },
  ringsCard: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, marginBottom: 12 },
  ringsTitle: { fontFamily: fonts.bodyBold, fontSize: 11, color: colors.textMuted, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 10 },
  ringsRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  aiBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: colors.primary, backgroundColor: `${colors.primary}1A` },
  aiBtnText: { fontFamily: fonts.bodyBold, fontSize: 11, color: colors.primary },
  aiBtnInline: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary, backgroundColor: `${colors.primary}1A`, marginLeft: 6 },
  reminderTitle: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.yellow },
  reminderText: { fontFamily: fonts.body, fontSize: 12, color: colors.text, marginTop: 1 },
  reminderBtn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.yellow },
  reminderBtnText: { fontFamily: fonts.bodySemibold, fontSize: 12, color: '#fff' },
  startCard: { alignItems: 'center', padding: 20, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 8, marginBottom: 14 },
  startTitle: { fontFamily: fonts.bodyBold, fontSize: 17, color: colors.text },
  startText: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, textAlign: 'center', lineHeight: 17 },
  startBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, backgroundColor: colors.primary, marginTop: 4 },
  startBtnText: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.onPrimary },
  empty: { alignItems: 'center', padding: 30, gap: 10 },
  emptyText: { color: colors.textMuted, fontFamily: fonts.body, fontSize: 13, textAlign: 'center' },
  section: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, marginBottom: 12 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionTitle: { fontFamily: fonts.bodyBold, fontSize: 15, color: colors.text },
  sectionSubtitle: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 1 },
  goalsGrid: { gap: 10 },
  goalCell: { gap: 4 },
  goalCellLabel: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },
  goalInput: { minWidth: 0, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, fontFamily: fonts.body, fontSize: 13, color: colors.text, minHeight: 50, textAlignVertical: 'top' },
  disabled: { backgroundColor: colors.surfaceAlt, color: colors.textMuted },
  subSect: { fontFamily: fonts.bodyBold, fontSize: 12, color: colors.text, marginBottom: 6, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.3 },
  subSectMuted: { color: colors.textMuted, fontFamily: fonts.body, fontSize: 11, textTransform: 'none' },
  smallLabel: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 },
  boxInput: { minWidth: 0, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, fontFamily: fonts.body, fontSize: 13, color: colors.text, minHeight: 60, textAlignVertical: 'top' },
  tblHeader: { flexDirection: 'row', gap: 6, paddingHorizontal: 4, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  tblHCell: { fontFamily: fonts.bodyBold, fontSize: 10, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  tblRow: { flexDirection: 'row', gap: 6, paddingVertical: 4, alignItems: 'center' },
  tblInput: { minWidth: 0, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingVertical: 7, paddingHorizontal: 8, fontFamily: fonts.body, fontSize: 12, color: colors.text },
  tblTotal: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.border },
  tblTotalLabel: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.textMuted },
  tblTotalNum: { fontFamily: fonts.bodyBold, fontSize: 14, color: colors.text },
  addRowBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8, marginTop: 6, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, backgroundColor: 'rgba(58, 122, 86,0.04)' },
  addRowText: { fontFamily: fonts.bodySemibold, fontSize: 12, color: colors.primary },
  swotGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  swotCell: { width: '48%', borderWidth: 2, borderRadius: 10, padding: 8, backgroundColor: colors.background },
  swotLabel: { fontFamily: fonts.bodyBold, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  swotInput: { minWidth: 0, fontFamily: fonts.body, fontSize: 12, color: colors.text, minHeight: 80, textAlignVertical: 'top' },
  summaryCard: { backgroundColor: colors.background, borderRadius: 10, padding: 12, gap: 8, borderWidth: 1, borderColor: colors.border },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel: { fontFamily: fonts.body, fontSize: 12, color: colors.text, flex: 1 },
  summaryValue: { fontFamily: fonts.bodyBold, fontSize: 14, color: colors.text },
  summaryInput: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 10, fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.text, minWidth: 100, textAlign: 'right' },
  gapRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  gapLabel: { flex: 1, fontFamily: fonts.body, fontSize: 12, color: colors.text },
  gapSteppers: { flexDirection: 'row', gap: 4 },
  gapPill: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  gapPillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  gapPillText: { fontFamily: fonts.bodySemibold, fontSize: 12, color: colors.textMuted },
  gapPillTextActive: { color: colors.onPrimary },
  monthRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8 },
  monthRowActive: { backgroundColor: 'rgba(58, 122, 86,0.08)' },
  monthRowText: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.text },
  learnRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  learnInput: { minWidth: 0, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingVertical: 7, paddingHorizontal: 8, fontFamily: fonts.body, fontSize: 12, color: colors.text },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const s = createS(lightColors);
