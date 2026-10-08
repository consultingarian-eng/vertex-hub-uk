/**
 * End-of-day assessment — the coach's fast grader.
 *
 * Rebuilt 2026-07 to kill the keyboard: behaviours/skills are one-tap 5-level
 * chips (Poor→Excellent = 2/4/6/8/10, same 0–10 numbers to the backend), KPIs
 * are −/+ steppers vs target, checklist grading stays inline with a per-
 * category "Mark all" quick action, and coaching text is down to two optional
 * fields (Today's win → coaching_actions, Focus for tomorrow). A live score
 * ring + status color updates as the leader taps; "Day guide" opens the full
 * what-to-teach crib sheet for the day. Field day ≈ 15–20 taps total.
 *
 * Same route, same API calls as before (PUT /assessment, PUT /checklist/item)
 * — trainee deep-links with ?readonly=1 still render a disabled view, though
 * trainees now normally use the dedicated /day/[id] screen.
 */
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { showAlert } from '../../src/utils/showAlert';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, useTheme, buildGetStatusColor, fonts, lightColors } from '../../src/theme/ThemeContext';
import { GRADIENT, GRADIENT_PANEL } from '../../src/theme/brand';
import { apiService, DeliveryChecklist } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { haptics } from '../../src/utils/haptics';
import { toast } from '../../src/utils/toast';
import { RatingChips } from '../../src/components/assessment/RatingChips';
import { KpiStepper } from '../../src/components/assessment/KpiStepper';
import { DayGuideSheet } from '../../src/components/assessment/DayGuideSheet';
import { GoalProgressRing } from '../../src/components/ui/GoalProgressRing';
import { GlowOrb } from '../../src/components/ui/Decor';
import { ConfettiCelebration, ConfettiCelebrationHandle } from '../../src/components/ui/ConfettiCelebration';
import { BrandLoader } from '../../src/components/ui/BrandLoader';
import { ParallaxHero, useParallaxScroll } from '../../src/components/ui/Parallax';
import { Aurora } from '../../src/components/ui/Aurora';
import { ScrollReveal } from '../../src/components/ui/ScrollFx';
import { Breathe } from '../../src/components/ui/Breathe';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { displayGrade } from '../../src/manual/utils';

const gradeColor = (g: string | null, colors: any) => {
  if (g === 'Excellent' || g === 'Competent' || g === 'Independent' || g === 'Done' || g === 'Learnt' || g === 'Met' || g === 'Well Above' || g === 'Promote' || g === 'Advance')
    return { bg: '#10b98118', text: '#10b981' };
  if (g === 'Average' || g === 'Extend Training' || g === 'Needs More Time' || g === 'Below')
    return { bg: '#f59e0b18', text: '#d97706' };
  if (g === 'Below Average' || g === 'Not Learnt' || g === 'Incompetent' || g === 'Not Done' || g === 'Release')
    return { bg: '#ef444418', text: '#dc2626' };
  return { bg: colors.surfaceAlt, text: colors.textMuted };
};

// The seven graded expectations — mirrors the product-training slides.
// Customer Service only applies on field days (day >= 3).
const BEHAVIOURS = [
  ['behaviour_engagement', '100% Effort'],
  ['behaviour_attitude', 'Positive Attitude'],
  ['behaviour_coachability', 'Student Mentality'],
  ['behaviour_image', 'Professional Image'],
  ['behaviour_customer_service', 'Customer Service'],
  ['behaviour_comfort_zones', 'Breaking Comfort Zones'],
  ['behaviour_punctuality', 'Punctuality'],
] as const;

const behavioursForDay = (day: number) =>
  day >= 3 ? BEHAVIOURS : BEHAVIOURS.filter(([f]) => f !== 'behaviour_customer_service');

const SKILLS = [
  ['skill_intro', 'Intro'],
  ['skill_presentation', 'Presentation'],
  ['skill_short_story', 'Short Story'],
  ['skill_close', 'Close'],
  ['skill_signup', 'Signup'],
  ['skill_rehash', 'Rehash'],
] as const;

// Labels are the owner's Field IQ names. Short Stories has no Field IQ
// equivalent: its day target is 0 everywhere now, so the row is hidden
// whenever its target is 0 (the field itself is kept — old drafts round-trip).
// Maxes sit above the daily ranges (Spoken 80–90, Closed 15–20).
const KPIS: Array<[string, string, string, number]> = [
  // [field, label, targetField, max]
  ['kpi_introductions', 'Spoken', 'target_introductions', 200],
  ['kpi_presentations', 'Presented', 'target_presentations', 60],
  ['kpi_short_stories', 'Short Stories', 'target_short_stories', 30],
  ['kpi_closes', 'Closed', 'target_closes', 50],
  ['kpi_sales', 'Sign-ups', 'target_sales', 20],
];

/** A KPI row with no target (0 / unset) and no Field IQ name is not shown. */
const kpiShown = (field: string, target: unknown): boolean =>
  field !== 'kpi_short_stories' || Number(target) > 0;

type Scores = Record<string, number | null>;

export default function AssessmentScreen() {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const styles = useMemo(() => createStyles2(colors), [colors]);
  const getStatusColor = useMemo(() => buildGetStatusColor(colors), [colors]);

  const { id, readonly } = useLocalSearchParams<{ id: string; readonly?: string }>();
  const isReadOnly = readonly === '1';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();
  const { scrollY, onScroll } = useParallaxScroll();
  const { user } = useAuth();
  const isTrainee = (user?.role || '').toLowerCase() === 'trainee';
  const confettiRef = useRef<ConfettiCelebrationHandle>(null);

  const { data: assessment, isLoading } = useQuery({
    queryKey: ['assessment', id],
    queryFn: () => apiService.getAssessment(id!).then(res => res.data),
    enabled: !!id,
  });

  const { data: targets } = useQuery({
    queryKey: ['targets'],
    queryFn: () => apiService.getTargets().then(res => res.data),
  });

  const { data: checklistItems, refetch: refetchChecklist } = useQuery<(DeliveryChecklist & { what_good_looks_like?: string | null; expected_outcome?: string | null })[]>({
    queryKey: ['checklist', id],
    queryFn: () => apiService.getChecklist(id!).then(res => res.data),
    enabled: !!id,
  });

  // ── Form state ─────────────────────────────────────────────────────────────
  // Numeric ratings/counters live as numbers (null = not yet rated).
  const [scores, setScores] = useState<Scores>({});
  const [notes, setNotes] = useState({ coaching_actions: '', focus_tomorrow: '' });
  // Legacy fields — kept in state so completing an old draft never drops data.
  const legacyRef = useRef({ biggest_weakness: '', leader_notes: '' });
  const [expandedTopics, setExpandedTopics] = useState<Record<string, boolean>>({});
  const [guideOpen, setGuideOpen] = useState(false);
  // "Yesterday's focus" banner — dismissible per visit, deliberately NOT
  // persisted: it should greet the leader again next time they open the day.
  const [focusDismissed, setFocusDismissed] = useState(false);
  const formInitialized = useRef(false);

  useEffect(() => {
    if (assessment && !formInitialized.current) {
      formInitialized.current = true;
      const s: Scores = {};
      const a: any = assessment;
      for (const [f] of [...BEHAVIOURS, ...SKILLS]) s[f] = a[f] ?? null;
      for (const [f] of KPIS) s[f] = a[f] ?? null;
      setScores(s);
      setNotes({
        coaching_actions: assessment.coaching_actions || '',
        focus_tomorrow: assessment.focus_tomorrow || '',
      });
      legacyRef.current = {
        biggest_weakness: assessment.biggest_weakness || '',
        leader_notes: assessment.leader_notes || '',
      };
    }
  }, [assessment]);

  const setScore = (field: string, v: number) => setScores((p) => ({ ...p, [field]: v }));
  const setAll = (fields: ReadonlyArray<readonly [string, string]>, v: number) => {
    haptics.medium();
    setScores((p) => {
      const next = { ...p };
      for (const [f] of fields) next[f] = v;
      return next;
    });
  };

  // ── Checklist grading ──────────────────────────────────────────────────────
  const gradeMutation = useMutation({
    mutationFn: ({ itemId, grade }: { itemId: string; grade: string }) =>
      apiService.updateChecklistItem(itemId, { grade, taught: true, outcome_achieved: grade !== 'Below Average' }),
    onSuccess: () => { refetchChecklist(); },
  });

  const [bulkGrading, setBulkGrading] = useState<string | null>(null);
  const markAllInCategory = async (items: DeliveryChecklist[], category: string) => {
    // Grade every UNGRADED item in the category with its best (first) option.
    const pending = items.filter((i) => !i.grade);
    if (!pending.length) return;
    haptics.medium();
    setBulkGrading(category);
    try {
      for (const item of pending) {
        const best = (item.grade_options && item.grade_options[0]) || 'Excellent';
        await apiService.updateChecklistItem(item.id, { grade: best, taught: true, outcome_achieved: true });
      }
      await refetchChecklist();
    } catch {
      showAlert('Error', 'Some items failed to grade — try again.');
    } finally {
      setBulkGrading(null);
    }
  };

  // ── Save / complete ────────────────────────────────────────────────────────
  const [completing, setCompleting] = useState(false);
  const updateMutation = useMutation({
    mutationFn: (data: any) => apiService.updateAssessment(id!, data),
    onSuccess: (_res, vars: any) => {
      queryClient.invalidateQueries({ queryKey: ['assessment', id] });
      queryClient.invalidateQueries({ queryKey: ['assessments'] });
      queryClient.invalidateQueries({ queryKey: ['new-hires'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      queryClient.invalidateQueries({ queryKey: ['leader-today'] });
      if (vars?.completed) {
        haptics.success();
        confettiRef.current?.fire();
        setCompleting(true);
        setTimeout(() => router.back(), 1400);
      } else {
        toast.success('Draft saved');
        router.back();
      }
    },
    onError: () => {
      showAlert('Error', 'Failed to save assessment');
    },
  });

  const handleSave = (markComplete: boolean = false) => {
    const payload: any = { completed: markComplete };
    for (const [f] of BEHAVIOURS) if (scores[f] != null) payload[f] = scores[f];
    if (assessment && assessment.day_number >= 2) {
      for (const [f] of SKILLS) if (scores[f] != null) payload[f] = scores[f];
    }
    if (assessment && assessment.day_number >= 3) {
      for (const [f] of KPIS) if (scores[f] != null) payload[f] = Math.round(Number(scores[f]));
    }
    if (notes.coaching_actions) payload.coaching_actions = notes.coaching_actions;
    if (notes.focus_tomorrow) payload.focus_tomorrow = notes.focus_tomorrow;
    // Preserve legacy text fields untouched
    if (legacyRef.current.biggest_weakness) payload.biggest_weakness = legacyRef.current.biggest_weakness;
    if (legacyRef.current.leader_notes) payload.leader_notes = legacyRef.current.leader_notes;
    updateMutation.mutate(payload);
  };

  // ── Live score preview (mirrors backend/scoring.py) ────────────────────────
  const dayTarget: any = targets?.find((t: any) => t.day_number === assessment?.day_number);
  const live = useMemo(() => {
    if (!assessment) return null;
    const day = assessment.day_number;
    const vals = (fields: ReadonlyArray<readonly [string, string]>) =>
      fields.map(([f]) => scores[f]).filter((v): v is number => v != null);

    const bVals = vals(behavioursForDay(day));
    const behaviour = bVals.length ? bVals.reduce((a, b) => a + b, 0) / bVals.length : null;

    let skill: number | null = null;
    if (day >= 2) {
      const parts: number[] = [];
      for (const [f, , ] of SKILLS.map(([f, l]) => [f, l, `target_${f.replace('skill_', '')}`] as const)) {
        const v = scores[f];
        const t = dayTarget?.[`target_${f.replace('skill_', '')}`];
        if (v != null && t) parts.push(Math.min((v / t) * 10, 10));
        else if (v != null && !t) parts.push(v);
      }
      skill = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    }

    let kpi: number | null = null;
    if (day >= 3) {
      const parts: number[] = [];
      for (const [f, , tf] of KPIS) {
        const v = scores[f];
        const t = dayTarget?.[tf];
        if (v != null && t) parts.push(Math.min((v / t) * 10, 10));
      }
      kpi = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    }

    let overall: number | null = null;
    if (day === 1) overall = behaviour;
    else if (day === 2) {
      if (behaviour != null && skill != null) overall = behaviour * 0.5 + skill * 0.5;
      else overall = behaviour ?? skill;
    } else {
      const parts = [behaviour, skill, kpi].filter((v): v is number => v != null);
      overall = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    }
    const status = overall == null ? 'Pending'
      : overall >= 10 ? 'S-GREEN' : overall >= 9 ? 'Green' : overall >= 7 ? 'Yellow' : 'Red';
    return { behaviour, skill, kpi, overall, status };
  }, [assessment, scores, dayTarget]);

  const getWeightText = (dayNumber: number) => {
    if (dayNumber === 1) return 'Behaviours 100%';
    if (dayNumber === 2) return 'Behaviours 50% · Skills 50%';
    return 'Behaviours 33% · Skills 33% · KPIs 33%';
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <BrandLoader size={64} label="Loading assessment" />
      </View>
    );
  }

  if (!assessment) {
    return (
      <View style={styles.errorContainer}>
        <Ionicons name="alert-circle" size={48} color={colors.red} />
        <Text style={styles.errorText}>Assessment not found</Text>
      </View>
    );
  }

  const day = assessment.day_number;
  const dayBehaviours = behavioursForDay(day);
  const dayLabel = day <= 2 ? `BA Academy Day ${day}` : `Field Day ${day - 2}`;
  const liveStatusColor = live?.overall != null ? getStatusColor(live.status) : null;
  const gradedCount = (checklistItems || []).filter((i) => i.grade).length;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ConfettiCelebration ref={confettiRef} />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 110 }]}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* ── Yesterday's focus (day N−1's "focus for tomorrow") ── */}
        {!isReadOnly && !focusDismissed && (assessment as any).prev_day_focus ? (
          <View style={styles.prevFocusCard}>
            <Text style={styles.prevFocusEmoji}>🎯</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.prevFocusLabel}>YESTERDAY'S FOCUS</Text>
              <Text style={styles.prevFocusText}>{(assessment as any).prev_day_focus}</Text>
            </View>
            <TouchableOpacity
              onPress={() => setFocusDismissed(true)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              testID="dismiss-prev-focus"
            >
              <Ionicons name="close" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* ── Hero ── */}
        <ParallaxHero scrollY={scrollY} style={styles.heroWrap}>
          <LinearGradient
            colors={isDark ? GRADIENT_PANEL : (['#e1ebce', '#eef4e3', '#f9fbf5'] as const)}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.hero}
          >
            <Aurora dim={!isDark} />
            <GlowOrb size={180} color="#8caf38" opacity={isDark ? 0.45 : 0.22} style={{ top: -70, right: -50 }} />
            <View style={styles.heroRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.traineeName} numberOfLines={1}>{assessment.new_hire_name}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={styles.dayLabel}>{dayLabel}</Text>
                  {(assessment as any).prev_day_acknowledged ? (
                    // Trainee acknowledged their previous graded day's feedback
                    <View style={styles.readChip}>
                      <Ionicons name="checkmark-done" size={10} color={colors.green} />
                      <Text style={styles.readChipText}>read</Text>
                    </View>
                  ) : null}
                </View>
                {dayTarget?.day_objective ? (
                  <Text style={styles.objective} numberOfLines={3}>{dayTarget.day_objective}</Text>
                ) : null}
                <Text style={styles.weightInfo}>{getWeightText(day)}</Text>
              </View>
              <View style={{ alignItems: 'center', gap: 4 }}>
                <GoalProgressRing
                  value={live?.overall ?? 0}
                  target={10}
                  label="Score"
                  accent={liveStatusColor?.text || colors.primary}
                  size={86}
                  stroke={9}
                />
                {live?.overall != null && (
                  <View style={[styles.statusPill, { backgroundColor: liveStatusColor!.bg }]}>
                    <Text style={[styles.statusPillText, { color: liveStatusColor!.text }]}>{live.status}</Text>
                  </View>
                )}
              </View>
            </View>
            <TouchableOpacity style={styles.guideBtn} onPress={() => setGuideOpen(true)} activeOpacity={0.8}>
              <Ionicons name="book-outline" size={14} color={colors.primary} />
              <Text style={styles.guideBtnText}>Day guide — what to teach today</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.primary} />
            </TouchableOpacity>
          </LinearGradient>
        </ParallaxHero>

        {/* ── Behaviours ── */}
        <ScrollReveal scrollY={scrollY}>
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="person" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>Behaviours</Text>
            {live?.behaviour != null && <Text style={styles.sectionScore}>{live.behaviour.toFixed(1)}</Text>}
          </View>
          {!isReadOnly && (
            <View style={styles.quickRow}>
              <TouchableOpacity style={styles.quickChip} onPress={() => setAll(dayBehaviours, 8)}>
                <Text style={styles.quickChipText}>Set all: Good</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.quickChip} onPress={() => setAll(dayBehaviours, 10)}>
                <Text style={styles.quickChipText}>Set all: Excellent</Text>
              </TouchableOpacity>
            </View>
          )}
          <View style={styles.card}>
            {dayBehaviours.map(([field, label]) => (
              <RatingChips
                key={field}
                label={label}
                value={scores[field]}
                onChange={(v) => setScore(field, v)}
                disabled={isReadOnly}
              />
            ))}
          </View>
        </View>
        </ScrollReveal>

        {/* ── Skills (Day 2+) ── */}
        {day >= 2 && (
          <ScrollReveal scrollY={scrollY}>
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="school" size={18} color={colors.primary} />
              <Text style={styles.sectionTitle}>Skills</Text>
              {live?.skill != null && <Text style={styles.sectionScore}>{live.skill.toFixed(1)}</Text>}
            </View>
            {!isReadOnly && (
              <View style={styles.quickRow}>
                <TouchableOpacity style={styles.quickChip} onPress={() => setAll(SKILLS, 8)}>
                  <Text style={styles.quickChipText}>Set all: Good</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.quickChip} onPress={() => setAll(SKILLS, 10)}>
                  <Text style={styles.quickChipText}>Set all: Excellent</Text>
                </TouchableOpacity>
              </View>
            )}
            <View style={styles.card}>
              {SKILLS.map(([field, label]) => (
                <RatingChips
                  key={field}
                  label={label}
                  value={scores[field]}
                  onChange={(v) => setScore(field, v)}
                  disabled={isReadOnly}
                />
              ))}
            </View>
          </View>
          </ScrollReveal>
        )}

        {/* ── KPIs (Day 3+) ── */}
        {day >= 3 && (
          <ScrollReveal scrollY={scrollY}>
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="stats-chart" size={18} color={colors.primary} />
              <Text style={styles.sectionTitle}>KPIs</Text>
              {live?.kpi != null && <Text style={styles.sectionScore}>{live.kpi.toFixed(1)}</Text>}
            </View>
            <View style={styles.card}>
              {KPIS.filter(([field, , targetField]) => kpiShown(field, dayTarget?.[targetField])).map(([field, label, targetField, max]) => (
                <KpiStepper
                  key={field}
                  label={label}
                  value={scores[field]}
                  onChange={(v) => setScore(field, v)}
                  target={dayTarget?.[targetField]}
                  max={max}
                  disabled={isReadOnly}
                />
              ))}
            </View>
          </View>
          </ScrollReveal>
        )}

        {/* ── Skill grading (checklist) ── */}
        {checklistItems && checklistItems.length > 0 && (() => {
          const grouped = checklistItems.reduce((acc, item) => {
            const cat = item.category || 'General';
            if (!acc[cat]) acc[cat] = [];
            acc[cat].push(item);
            return acc;
          }, {} as Record<string, typeof checklistItems>);

          return (
            <ScrollReveal scrollY={scrollY}>
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Ionicons name="star" size={18} color={colors.primary} />
                <Text style={styles.sectionTitle}>Skill Grading</Text>
                <Text style={styles.sectionScore}>{gradedCount}/{checklistItems.length}</Text>
              </View>

              {Object.entries(grouped).map(([category, items]) => {
                const pending = items.filter((i) => !i.grade).length;
                return (
                  <View key={category} style={styles.gradeCategorySection}>
                    <View style={styles.gradeCategoryHeader}>
                      <Text style={styles.gradeCategoryTitle}>{category}</Text>
                      <Text style={styles.gradeCategoryCount}>
                        {items.length - pending}/{items.length}
                      </Text>
                      {!isReadOnly && pending > 0 && (
                        <TouchableOpacity
                          style={styles.markAllBtn}
                          disabled={bulkGrading === category}
                          onPress={() => markAllInCategory(items, category)}
                        >
                          {bulkGrading === category ? (
                            <ActivityIndicator size="small" color={colors.primary} />
                          ) : (
                            <Text style={styles.markAllText}>
                              Mark all: {displayGrade(items.find((i) => !i.grade)?.grade_options?.[0]) || 'Excellent'}
                            </Text>
                          )}
                        </TouchableOpacity>
                      )}
                    </View>
                    {items.map((item) => {
                      const expanded = !!expandedTopics[item.id];
                      const canShowTeach = !isTrainee && !!item.what_good_looks_like;
                      const canShowGood = !!item.expected_outcome;
                      const hasManual = canShowTeach || canShowGood;
                      return (
                        <View key={item.id} style={styles.gradeItem}>
                          <TouchableOpacity
                            onPress={() => hasManual && setExpandedTopics((p) => ({ ...p, [item.id]: !p[item.id] }))}
                            activeOpacity={hasManual ? 0.6 : 1}
                            style={styles.topicTapRow}
                            disabled={!hasManual}
                            testID={`expand-topic-${item.id}`}
                          >
                            <Text style={styles.gradeItemTopic}>{item.topic}</Text>
                            {hasManual && (
                              <Ionicons
                                name={expanded ? 'chevron-up' : 'information-circle-outline'}
                                size={16}
                                color={expanded ? colors.textMuted : colors.primary}
                              />
                            )}
                          </TouchableOpacity>
                          {expanded && hasManual && (
                            <View style={styles.topicExpandBox}>
                              {canShowTeach && (
                                <View style={{ marginBottom: canShowGood ? 8 : 0 }}>
                                  <Text style={styles.topicExpandLabel}>WHAT TO TEACH</Text>
                                  <Text style={styles.topicExpandText}>{item.what_good_looks_like}</Text>
                                </View>
                              )}
                              {canShowGood && (
                                <View>
                                  <Text style={[styles.topicExpandLabel, { color: '#10b981' }]}>WHAT GOOD LOOKS LIKE</Text>
                                  <Text style={styles.topicExpandText}>{item.expected_outcome}</Text>
                                </View>
                              )}
                            </View>
                          )}
                          <View style={[styles.gradeButtonRow, (item.grade_options?.length || 0) > 3 && styles.gradeButtonRowWrap]}>
                            {(item.grade_options && item.grade_options.length > 0 ? item.grade_options : ['Excellent', 'Average', 'Below Average']).map((grade: string) => {
                              const isSelected = item.grade === grade;
                              const gc2 = gradeColor(grade, colors);
                              const manyOptions = (item.grade_options?.length || 0) > 3;
                              return (
                                <TouchableOpacity
                                  key={grade}
                                  testID={`grade-${item.id}-${grade.toLowerCase().replace(/ /g, '-')}`}
                                  style={[
                                    styles.gradeBtn,
                                    manyOptions && styles.gradeBtnWide,
                                    isSelected && { backgroundColor: gc2.bg, borderColor: gc2.text },
                                  ]}
                                  onPress={() => { if (!isReadOnly) { haptics.light(); gradeMutation.mutate({ itemId: item.id, grade }); } }}
                                  disabled={isReadOnly}
                                >
                                  <Text style={[styles.gradeBtnText, isSelected && { color: gc2.text, fontWeight: '700' }]} numberOfLines={1}>
                                    {displayGrade(grade)}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                );
              })}
            </View>
            </ScrollReveal>
          );
        })()}

        {/* ── Coaching (Day 3+, hidden in readonly) ── */}
        {day >= 3 && !isReadOnly && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="chatbubble-ellipses" size={18} color={colors.primary} />
              <Text style={styles.sectionTitle}>Coaching</Text>
              <Text style={styles.sectionScore}>optional</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.textInputLabel}>🏆 Today's win</Text>
              <TextInput
                style={styles.textArea}
                value={notes.coaching_actions}
                onChangeText={(text) => setNotes((p) => ({ ...p, coaching_actions: text }))}
                placeholder="One thing they did well today…"
                placeholderTextColor={colors.textMuted}
                multiline
              />
              <Text style={[styles.textInputLabel, { marginTop: 12 }]}>🎯 Focus for tomorrow</Text>
              <TextInput
                style={styles.textArea}
                value={notes.focus_tomorrow}
                onChangeText={(text) => setNotes((p) => ({ ...p, focus_tomorrow: text }))}
                placeholder="The one thing to work on…"
                placeholderTextColor={colors.textMuted}
                multiline
              />
              {(legacyRef.current.biggest_weakness || legacyRef.current.leader_notes) ? (
                <View style={styles.legacyBox}>
                  <Text style={styles.legacyLabel}>EARLIER NOTES</Text>
                  {legacyRef.current.biggest_weakness ? (
                    <Text style={styles.legacyText}>Weakness: {legacyRef.current.biggest_weakness}</Text>
                  ) : null}
                  {legacyRef.current.leader_notes ? (
                    <Text style={styles.legacyText}>{legacyRef.current.leader_notes}</Text>
                  ) : null}
                </View>
              ) : null}
            </View>
          </View>
        )}
      </ScrollView>

      {/* ── Sticky action bar ── */}
      {!isReadOnly && (
        <View style={[styles.actionBar, { paddingBottom: tabBarClearance + 12 }]}>
          <TouchableOpacity
            style={styles.saveButton}
            onPress={() => handleSave(false)}
            disabled={updateMutation.isPending || completing}
          >
            <Text style={styles.saveButtonText}>Save draft</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ flex: 2 }}
            onPress={() => handleSave(true)}
            disabled={updateMutation.isPending || completing}
            activeOpacity={0.85}
          >
            <Breathe>
            <LinearGradient
              colors={GRADIENT}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={[styles.completeButton, (updateMutation.isPending || completing) && { opacity: 0.7 }]}
            >
              {completing ? (
                <>
                  <Ionicons name="checkmark-circle" size={20} color="#fff" />
                  <Text style={styles.completeButtonText}>Day complete!</Text>
                </>
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={20} color="#fff" />
                  <Text style={styles.completeButtonText}>
                    {updateMutation.isPending ? 'Saving…' : 'Complete day'}
                  </Text>
                </>
              )}
            </LinearGradient>
            </Breathe>
          </TouchableOpacity>
        </View>
      )}

      {/* Day guide crib sheet */}
      <DayGuideSheet
        visible={guideOpen}
        onClose={() => setGuideOpen(false)}
        dayLabel={dayLabel}
        objective={dayTarget?.day_objective}
        items={(checklistItems || []) as any}
      />
    </KeyboardAvoidingView>
  );
}

const createStyles2 = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  scrollView: { flex: 1 },
  content: { padding: 16 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  errorText: { fontSize: 16, color: colors.textSecondary },

  // Yesterday's focus banner
  prevFocusCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 9,
    marginBottom: 12, padding: 13, borderRadius: 12,
    backgroundColor: colors.primary + '10', borderWidth: 1, borderColor: colors.primary + '30',
  },
  prevFocusEmoji: { fontSize: 15 },
  prevFocusLabel: { fontFamily: fonts.mono, fontSize: 9, fontWeight: '700', color: colors.primary, letterSpacing: 1 },
  prevFocusText: { fontSize: 13, color: colors.text, lineHeight: 18, marginTop: 3 },
  readChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 999,
    backgroundColor: colors.greenBg,
  },
  readChipText: { fontSize: 9, fontWeight: '800', color: colors.green },

  // Hero
  heroWrap: {
    borderRadius: 20, marginBottom: 18,
    shadowColor: '#2f6a4b', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.28, shadowRadius: 14, elevation: 5,
  },
  hero: { borderRadius: 20, padding: 16, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  traineeName: { fontFamily: fonts.display, fontSize: 20, fontWeight: '900', color: colors.text },
  dayLabel: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '700', color: colors.primary, letterSpacing: 1, marginTop: 3, textTransform: 'uppercase' },
  objective: { fontSize: 12.5, color: colors.textSecondary, lineHeight: 18, marginTop: 6 },
  weightInfo: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted, marginTop: 6 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  statusPillText: { fontSize: 10.5, fontWeight: '800' },
  guideBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12,
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: colors.primary + '14', borderWidth: 1, borderColor: colors.primary + '33',
  },
  guideBtnText: { flex: 1, fontSize: 12.5, fontWeight: '700', color: colors.primary },

  // Sections
  section: { marginBottom: 22 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  sectionTitle: { flex: 1, fontFamily: fonts.display, fontSize: 16, fontWeight: '800', color: colors.text },
  sectionScore: { fontFamily: fonts.mono, fontSize: 12, fontWeight: '700', color: colors.primary },
  quickRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  quickChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    borderWidth: 1, borderColor: colors.primary + '55', backgroundColor: colors.primary + '10',
  },
  quickChipText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  card: {
    backgroundColor: colors.background, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14,
  },

  // Coaching
  textInputLabel: { fontSize: 13.5, fontWeight: '700', color: colors.text, marginBottom: 7 },
  textArea: {
    backgroundColor: colors.surfaceAlt, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, minHeight: 54,
    textAlignVertical: 'top',
  },
  legacyBox: { marginTop: 12, padding: 10, borderRadius: 10, backgroundColor: colors.surfaceAlt, gap: 4 },
  legacyLabel: { fontFamily: fonts.mono, fontSize: 9, fontWeight: '700', color: colors.textMuted, letterSpacing: 1 },
  legacyText: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },

  // Action bar
  actionBar: {
    flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 12,
    backgroundColor: colors.background, borderTopWidth: 1, borderTopColor: colors.border,
  },
  saveButton: {
    flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  saveButtonText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  completeButton: {
    flexDirection: 'row', paddingVertical: 14, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  completeButtonText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // Checklist
  gradeCategorySection: {
    backgroundColor: colors.background, borderRadius: 14, marginBottom: 12, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
  },
  gradeCategoryHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 11, backgroundColor: colors.surfaceAlt,
  },
  gradeCategoryTitle: { flex: 1, fontFamily: fonts.display, fontSize: 14, fontWeight: '800', color: colors.text },
  gradeCategoryCount: { fontFamily: fonts.mono, fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  markAllBtn: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    backgroundColor: colors.primary + '14', borderWidth: 1, borderColor: colors.primary + '44',
  },
  markAllText: { fontSize: 10.5, fontWeight: '700', color: colors.primary },
  gradeItem: { paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  gradeItemTopic: { fontSize: 14, fontWeight: '600', color: colors.text, flex: 1 },
  topicTapRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  topicExpandBox: {
    backgroundColor: colors.surfaceAlt, padding: 10, borderRadius: 8, marginBottom: 10,
    borderLeftWidth: 3, borderLeftColor: colors.primary,
  },
  topicExpandLabel: { fontFamily: fonts.mono, fontSize: 9, fontWeight: '700', color: colors.primary, letterSpacing: 1, marginBottom: 3 },
  topicExpandText: { fontSize: 13, color: colors.text, lineHeight: 19 },
  gradeButtonRow: { flexDirection: 'row', gap: 6 },
  gradeButtonRowWrap: { flexWrap: 'wrap' },
  gradeBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 9, paddingHorizontal: 6, borderRadius: 9,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, minWidth: 70,
  },
  gradeBtnWide: { flex: 0, width: '48%' },
  gradeBtnText: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles2(lightColors);
