/**
 * Orientation mass-grader — the admin's Day-1/Day-2 "mark the class" screen.
 *
 * 99/100 orientation days are simply "Excellent and Learnt", so instead of
 * grading each trainee one-by-one this screen loads the whole ungraded cohort
 * (active hires started in the last 8 days whose Day-N assessment isn't
 * completed), ticks everyone by default, and one Confirm submission
 * mass-grades them with the Excellent preset — behaviours (and Day-2 skills)
 * at 10, every checklist row "Learnt". Untick anyone who wasn't there
 * (nothing is written for them), or tap the pencil to override one person's
 * assessment in a bottom sheet WITHOUT leaving the flow — edited people get
 * an amber chip and their overrides ride on top of the preset.
 *
 * Reached from the 6 PM "orientation_grading" push (category: grading)
 * and from the amber banner on My Team → Unassigned. ?day=1|2 overrides the
 * app-time-weekday default (Monday→1, Tuesday→2, otherwise 2 = catch-up).
 */
import React, { useMemo, useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Pressable, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { format } from 'date-fns';
import { useColors, lightColors, fonts } from '../src/theme/ThemeContext';
import { GRADIENT } from '../src/theme/brand';
import { apiService, DeliveryChecklist } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { useActiveOffice } from '../src/office/ActiveOfficeContext';
import { haptics } from '../src/utils/haptics';
import { showAlert } from '../src/utils/showAlert';
import { RatingChips } from '../src/components/assessment/RatingChips';
import { EmptyState } from '../src/components/ui/EmptyState';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { ConfettiCelebration, ConfettiCelebrationHandle } from '../src/components/ui/ConfettiCelebration';
import OfficeToggle from '../src/components/ui/OfficeToggle';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { Breathe } from '../src/components/ui/Breathe';
import { APP_LOCALE, APP_TZ } from '../src/utils/appTime';

// Same field names as the single grader (app/assessment/[id].tsx).
// No Customer Service here — orientation days 1-2 are office days and that
// expectation only applies on field days.
const BEHAVIOURS = [
  ['behaviour_engagement', '100% Effort'],
  ['behaviour_attitude', 'Positive Attitude'],
  ['behaviour_coachability', 'Student Mentality'],
  ['behaviour_image', 'Professional Image'],
  ['behaviour_comfort_zones', 'Breaking Comfort Zones'],
  ['behaviour_punctuality', 'Punctuality'],
] as const;

const SKILLS = [
  ['skill_intro', 'Intro'],
  ['skill_presentation', 'Presentation'],
  ['skill_short_story', 'Short Story'],
  ['skill_close', 'Close'],
  ['skill_signup', 'Signup'],
  ['skill_rehash', 'Rehash'],
] as const;

const gradeColor = (g: string | null, colors: any) => {
  if (g === 'Excellent' || g === 'Competent' || g === 'Independent' || g === 'Done' || g === 'Learnt' || g === 'Met' || g === 'Well Above' || g === 'Promote' || g === 'Advance')
    return { bg: '#10b98118', text: '#10b981' };
  if (g === 'Average' || g === 'Extend Training' || g === 'Needs More Time' || g === 'Below')
    return { bg: '#f59e0b18', text: '#d97706' };
  if (g === 'Below Average' || g === 'Not Learnt' || g === 'Incompetent' || g === 'Not Done' || g === 'Release')
    return { bg: '#ef444418', text: '#dc2626' };
  return { bg: colors.surfaceAlt, text: colors.textMuted };
};

/** The "Learnt" preset grade for a checklist row (falls back to the row's best option). */
const presetGrade = (row: Pick<DeliveryChecklist, 'grade_options'>): string =>
  row.grade_options && row.grade_options.includes('Learnt')
    ? 'Learnt'
    : (row.grade_options && row.grade_options[0]) || 'Excellent';

type CohortItem = { hire_id: string; assessment_id: string; name: string; start_date: string; has_leader: boolean };
type Override = { assessment?: Record<string, number>; checklist?: Record<string, string> };
type BulkResult = { graded: number; skipped: number; results: Array<{ hire_id: string; ok: boolean; detail: string | null }> };

export default function OrientationGradingScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { officeId, canSwitch } = useActiveOffice();
  const confettiRef = useRef<ConfettiCelebrationHandle>(null);

  // ?day=1|2 wins; otherwise the app-time weekday decides (Mon→1, Tue→2, else 2) —
  // but Day 1 left ungraded must never hide behind the weekday default, so
  // once both cohorts load we auto-focus the EARLIEST day with people
  // waiting (unless the admin picked a day themselves).
  const params = useLocalSearchParams<{ day?: string }>();
  const initialDay: 1 | 2 = useMemo(() => {
    if (params.day === '1') return 1;
    if (params.day === '2') return 2;
    const wd = new Intl.DateTimeFormat(APP_LOCALE, { timeZone: APP_TZ, weekday: 'short' }).format(new Date());
    return wd === 'Mon' ? 1 : 2;
  }, [params.day]);
  const [day, setDay] = useState<1 | 2>(initialDay);
  const dayChosenRef = useRef(!!params.day); // explicit ?day= counts as a choice

  // Switching day drops any staged ticks/edits (they belong to the other
  // day's assessments) — warn only when real work would be lost.
  const switchDay = (next: 1 | 2, opts?: { silent?: boolean }) => {
    if (next === day) return;
    const apply = () => {
      dayChosenRef.current = true;
      setUnticked({});
      setOverrides({});
      setResults(null);
      setDay(next);
    };
    const staged = Object.keys(overrides).length + Object.keys(unticked).length;
    if (staged > 0 && !opts?.silent) {
      showAlert(
        `Switch to Day ${next}?`,
        'Your unsaved ticks and edits for this day will be cleared.',
        [
          { text: 'Stay', style: 'cancel' },
          { text: `Switch to Day ${next}`, onPress: apply },
        ],
      );
      return;
    }
    apply();
  };

  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin' || user?.is_super_admin === true;

  const cohortQ1 = useQuery({
    queryKey: ['orientation-cohort', 1, canSwitch ? officeId : 'home'],
    queryFn: () => apiService.getOrientationCohort(1, canSwitch ? officeId : undefined).then((r) => r.data),
    enabled: isAdmin,
    retry: false,
  });
  const cohortQ2 = useQuery({
    queryKey: ['orientation-cohort', 2, canSwitch ? officeId : 'home'],
    queryFn: () => apiService.getOrientationCohort(2, canSwitch ? officeId : undefined).then((r) => r.data),
    enabled: isAdmin,
    retry: false,
  });
  const activeQ = day === 1 ? cohortQ1 : cohortQ2;
  const { data: cohort, isLoading, isError } = activeQ;
  const refetch = () => { cohortQ1.refetch(); cohortQ2.refetch(); };
  const count1 = cohortQ1.data?.items?.length ?? 0;
  const count2 = cohortQ2.data?.items?.length ?? 0;
  useEffect(() => {
    if (dayChosenRef.current) return;
    if (!cohortQ1.data || !cohortQ2.data) return;
    const earliest: 1 | 2 | null = count1 > 0 ? 1 : count2 > 0 ? 2 : null;
    if (earliest && earliest !== day) setDay(earliest);
    dayChosenRef.current = true; // decide once per entry
  }, [cohortQ1.data, cohortQ2.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const items: CohortItem[] = cohort?.items || [];

  // ── Selection + overrides (exact bulk-grade contract shape) ───────────────
  const [unticked, setUnticked] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [results, setResults] = useState<BulkResult | null>(null);

  const tickedItems = items.filter((i) => !unticked[i.hire_id]);
  const toggleTick = (hireId: string) => {
    haptics.light();
    setUnticked((p) => ({ ...p, [hireId]: !p[hireId] }));
  };

  // ── Edit sheet (bottom sheet — never navigates away) ───────────────────────
  const [editing, setEditing] = useState<CohortItem | null>(null);
  const [sheetScores, setSheetScores] = useState<Record<string, number>>({});
  const [sheetGrades, setSheetGrades] = useState<Record<string, string>>({});
  const seededGradesFor = useRef<string | null>(null);

  const { data: editAssessment, isLoading: sheetALoading } = useQuery({
    queryKey: ['assessment', editing?.assessment_id],
    queryFn: () => apiService.getAssessment(editing!.assessment_id).then((r) => r.data),
    enabled: !!editing,
  });
  const { data: editChecklist, isLoading: sheetCLoading } = useQuery<DeliveryChecklist[]>({
    queryKey: ['checklist', editing?.assessment_id],
    queryFn: () => apiService.getChecklist(editing!.assessment_id).then((r) => r.data),
    enabled: !!editing,
  });
  const sheetDay = editAssessment?.day_number ?? day;
  const sheetFields = sheetDay >= 2 ? [...BEHAVIOURS, ...SKILLS] : [...BEHAVIOURS];

  // Seed ratings the moment the sheet opens: Excellent preset (10s) + any
  // previously saved override for this hire on top.
  useEffect(() => {
    if (!editing) return;
    const ov = overrides[editing.hire_id];
    const s: Record<string, number> = {};
    for (const [f] of [...BEHAVIOURS, ...SKILLS]) s[f] = ov?.assessment?.[f] ?? 10;
    setSheetScores(s);
    seededGradesFor.current = null;
    setSheetGrades({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Seed checklist grades once the rows arrive (guarded so a background
  // refetch never clobbers in-progress edits).
  useEffect(() => {
    if (!editing || !editChecklist || seededGradesFor.current === editing.hire_id) return;
    seededGradesFor.current = editing.hire_id;
    const ov = overrides[editing.hire_id];
    const g: Record<string, string> = {};
    for (const row of editChecklist) g[row.id] = ov?.checklist?.[row.id] ?? presetGrade(row);
    setSheetGrades(g);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, editChecklist]);

  const resetSheetToExcellent = () => {
    haptics.medium();
    const s: Record<string, number> = {};
    for (const [f] of [...BEHAVIOURS, ...SKILLS]) s[f] = 10;
    setSheetScores(s);
    if (editChecklist) {
      const g: Record<string, string> = {};
      for (const row of editChecklist) g[row.id] = presetGrade(row);
      setSheetGrades(g);
    }
  };

  // Save keeps ONLY the deltas from the preset — an untouched sheet leaves the
  // row on the clean "Excellent + Learnt" path with no Edited chip.
  const saveSheet = () => {
    if (!editing) return;
    const a: Record<string, number> = {};
    for (const [f] of sheetFields) {
      const v = sheetScores[f];
      if (v != null && v !== 10) a[f] = v;
    }
    const c: Record<string, string> = {};
    for (const row of editChecklist || []) {
      const g = sheetGrades[row.id];
      if (g && g !== presetGrade(row)) c[row.id] = g;
    }
    haptics.medium();
    setOverrides((p) => {
      const next = { ...p };
      if (!Object.keys(a).length && !Object.keys(c).length) {
        delete next[editing.hire_id];
      } else {
        const ov: Override = {};
        if (Object.keys(a).length) ov.assessment = a;
        if (Object.keys(c).length) ov.checklist = c;
        next[editing.hire_id] = ov;
      }
      return next;
    });
    // Editing someone means they were there — make sure they're ticked.
    setUnticked((p) => ({ ...p, [editing.hire_id]: false }));
    setEditing(null);
  };

  // ── Confirm submission ─────────────────────────────────────────────────────
  const bulkMut = useMutation({
    mutationFn: (payload: { day: 1 | 2; hire_ids: string[]; overrides: Record<string, Override> }) =>
      apiService.bulkGradeOrientation(payload).then((r) => r.data),
    onSuccess: (res: BulkResult) => {
      setResults(res);
      if (res.graded > 0) {
        haptics.success();
        confettiRef.current?.fire();
      }
      queryClient.invalidateQueries({ queryKey: ['orientation-cohort'] });
      queryClient.invalidateQueries({ queryKey: ['new-hires'] });
      queryClient.invalidateQueries({ queryKey: ['assessments'] });
      queryClient.invalidateQueries({ queryKey: ['leader-today'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
    },
    onError: (e: any) => {
      showAlert('Submission failed', e?.response?.data?.detail || 'Nothing was graded — check your connection and try again.');
    },
  });

  const confirmSubmission = () => {
    const hireIds = tickedItems.map((i) => i.hire_id);
    if (!hireIds.length) return;
    const ov: Record<string, Override> = {};
    for (const id of hireIds) if (overrides[id]) ov[id] = overrides[id];
    haptics.medium();
    bulkMut.mutate({ day, hire_ids: hireIds, overrides: ov });
  };

  const nameFor = (hireId: string) => items.find((i) => i.hire_id === hireId)?.name || 'New BA';

  // ── Guard: admin-only (URL is directly reachable on web) ──────────────────
  if (user && !isAdmin) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Ionicons name="lock-closed-outline" size={32} color={colors.textMuted} />
        <Text style={styles.guardText}>Admins only</Text>
      </View>
    );
  }

  // ── Success state ──────────────────────────────────────────────────────────
  if (results) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
        <ConfettiCelebration ref={confettiRef} />
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 40 }]}>
          <Text style={styles.successEmoji}>🎉</Text>
          <Text style={styles.successTitle}>{results.graded} new BA{results.graded === 1 ? '' : 's'} graded</Text>
          <Text style={styles.successSub}>
            BA Academy Day {day} locked in
            {results.skipped > 0 ? ` · ${results.skipped} skipped` : ''}.
          </Text>
          {(day === 1 ? count2 : count1) > 0 && (
            <TouchableOpacity activeOpacity={0.8}
              style={styles.nextDayBtn}
              onPress={() => switchDay(day === 1 ? 2 : 1, { silent: true })}
              testID="grade-other-day"
            >
              <Ionicons name="arrow-forward-circle" size={18} color={colors.onPrimary} />
              <Text style={styles.nextDayBtnText}>
                Day {day === 1 ? 2 : 1} is also waiting — grade it next
              </Text>
            </TouchableOpacity>
          )}
          <View style={styles.card}>
            {results.results.map((r) => {
              const isSkip = !r.ok && (r.detail || '').toLowerCase().includes('already');
              const tone = r.ok ? colors.green : isSkip ? colors.yellow : colors.red;
              return (
                <View key={r.hire_id} style={styles.resultRow}>
                  <Ionicons
                    name={r.ok ? 'checkmark-circle' : isSkip ? 'time' : 'alert-circle'}
                    size={18}
                    color={tone}
                  />
                  <Text style={styles.resultName} numberOfLines={1}>{nameFor(r.hire_id)}</Text>
                  <Text style={[styles.resultDetail, { color: tone }]} numberOfLines={1}>
                    {r.ok ? (overrides[r.hire_id] ? 'Graded with edits' : 'Excellent + Learnt') : (r.detail || 'Failed')}
                  </Text>
                </View>
              );
            })}
          </View>
          <TouchableOpacity style={{ marginTop: 18 }} onPress={() => router.back()} activeOpacity={0.85}>
            <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.confirmBtn}>
              <Ionicons name="checkmark" size={18} color="#fff" />
              <Text style={styles.confirmBtnText}>Done</Text>
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <ConfettiCelebration ref={confettiRef} />

      {/* ── Header (headerShown:false — we own the chrome) ── */}
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>BA Academy — Day {day}</Text>
          <Text style={styles.subtitle}>Mark the class in one go</Text>
        </View>
      </View>
      {/* Day switcher — Day 1 must never hide behind the weekday default. */}
      <View style={styles.daySwitchRow}>
        {([1, 2] as const).map((d) => {
          const n = d === 1 ? count1 : count2;
          const active = day === d;
          return (
            <TouchableOpacity activeOpacity={0.8}
              key={d}
              style={[styles.daySwitchPill, active && styles.daySwitchPillActive]}
              onPress={() => switchDay(d)}
              testID={`orientation-day-${d}`}
            >
              <Text style={[styles.daySwitchText, active && styles.daySwitchTextActive]}>
                Day {d}{n > 0 ? ` · ${n}` : ''}
              </Text>
              {n > 0 && !active ? <View style={styles.daySwitchDot} /> : null}
            </TouchableOpacity>
          );
        })}
      </View>
      {canSwitch ? (
        <View style={{ paddingHorizontal: 16, marginBottom: 4 }}>
          <OfficeToggle />
        </View>
      ) : null}

      {isLoading ? (
        <View style={styles.center}>
          <BrandLoader size={64} label="Loading the cohort" />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <EmptyState
            icon="cloud-offline-outline"
            title="Couldn't load the cohort"
            subtitle="Check your connection — or the backend may still be deploying."
            actionLabel="Retry"
            onAction={() => refetch()}
          />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <EmptyState
            emoji="🎓"
            title="Everyone's graded — nothing waiting."
            subtitle={`No ungraded BA Academy Day ${day} assessments in this office.`}
          />
        </View>
      ) : (
        <>
          {/* ── Summary bar ── */}
          <View style={styles.summaryBar}>
            <Text style={styles.summaryText}>
              <Text style={styles.summaryCount}>{tickedItems.length}/{items.length}</Text> selected
            </Text>
            <View style={styles.summaryPill}>
              <Ionicons name="sparkles" size={12} color={colors.green} />
              <Text style={styles.summaryPillText}>Mark as excellent</Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 120 }]}>
            {items.map((item) => {
              const ticked = !unticked[item.hire_id];
              const edited = !!overrides[item.hire_id];
              return (
                <TouchableOpacity
                  key={item.hire_id}
                  style={[styles.row, !ticked && styles.rowUnticked]}
                  onPress={() => toggleTick(item.hire_id)}
                  activeOpacity={0.75}
                  testID={`orientation-row-${item.hire_id}`}
                >
                  <View style={[styles.checkbox, ticked && styles.checkboxTicked]}>
                    {ticked && <Ionicons name="checkmark" size={18} color={colors.onPrimary} />}
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={styles.nameRow}>
                      <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                      {!item.has_leader && (
                        <View style={styles.noLeaderChip}>
                          <Text style={styles.noLeaderText}>No coach</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.rowDate}>
                      Started {(() => { try { return format(new Date(item.start_date), 'EEE, MMM d'); } catch { return item.start_date; } })()}
                    </Text>
                    {ticked ? (
                      edited ? (
                        <View style={[styles.stagePill, styles.editedPill]}>
                          <Ionicons name="create-outline" size={11} color={colors.yellow} />
                          <Text style={[styles.stagePillText, { color: colors.yellow }]}>Edited</Text>
                        </View>
                      ) : (
                        <View style={[styles.stagePill, styles.excellentPill]}>
                          <Ionicons name="checkmark-circle" size={11} color={colors.green} />
                          <Text style={[styles.stagePillText, { color: colors.green }]}>Excellent + Learnt</Text>
                        </View>
                      )
                    ) : (
                      <Text style={styles.skippedText}>Wasn't there — nothing will be written</Text>
                    )}
                  </View>
                  <TouchableOpacity
                    style={styles.editBtn}
                    onPress={() => setEditing(item)}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    testID={`orientation-edit-${item.hire_id}`}
                  >
                    <Ionicons name="pencil" size={16} color={colors.primary} />
                  </TouchableOpacity>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* ── Confirm submission (bottom-fixed) ── */}
          <View style={[styles.actionBar, { paddingBottom: tabBarClearance + 12 }]}>
            <Breathe>
            <TouchableOpacity
              onPress={confirmSubmission}
              disabled={bulkMut.isPending || tickedItems.length === 0}
              activeOpacity={0.85}
              testID="orientation-confirm"
            >
              <LinearGradient
                colors={GRADIENT}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={[styles.confirmBtn, (bulkMut.isPending || tickedItems.length === 0) && { opacity: 0.6 }]}
              >
                {bulkMut.isPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="checkmark-done" size={19} color="#fff" />
                )}
                <Text style={styles.confirmBtnText}>
                  {bulkMut.isPending ? 'Grading…' : `Confirm submission · ${tickedItems.length}`}
                </Text>
              </LinearGradient>
            </TouchableOpacity>
            </Breathe>
          </View>
        </>
      )}

      {/* ── Edit sheet — overrides one person without leaving the flow ── */}
      <Modal visible={!!editing} animationType="slide" transparent onRequestClose={() => setEditing(null)}>
        <Pressable style={styles.backdrop} onPress={() => setEditing(null)} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
          <View style={styles.grabber} />
          <View style={styles.sheetHead}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.sheetTitle} numberOfLines={1}>{editing?.name}</Text>
              <Text style={styles.sheetSub}>Adjust their Day {sheetDay} — everyone else stays Excellent</Text>
            </View>
            <TouchableOpacity onPress={() => setEditing(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {sheetALoading || sheetCLoading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}>
              <BrandLoader size={48} label="Loading their day" />
            </View>
          ) : (
            <>
              <ScrollView contentContainerStyle={styles.sheetContent}>
                <TouchableOpacity style={styles.resetChip} onPress={resetSheetToExcellent}>
                  <Ionicons name="refresh" size={13} color={colors.primary} />
                  <Text style={styles.resetChipText}>Reset to excellent</Text>
                </TouchableOpacity>

                <Text style={styles.sheetSection}>BEHAVIOURS</Text>
                <View style={styles.card}>
                  {BEHAVIOURS.map(([field, label]) => (
                    <RatingChips
                      key={field}
                      label={label}
                      value={sheetScores[field]}
                      onChange={(v) => setSheetScores((p) => ({ ...p, [field]: v }))}
                    />
                  ))}
                </View>

                {sheetDay >= 2 && (
                  <>
                    <Text style={styles.sheetSection}>SKILLS</Text>
                    <View style={styles.card}>
                      {SKILLS.map(([field, label]) => (
                        <RatingChips
                          key={field}
                          label={label}
                          value={sheetScores[field]}
                          onChange={(v) => setSheetScores((p) => ({ ...p, [field]: v }))}
                        />
                      ))}
                    </View>
                  </>
                )}

                {(editChecklist || []).length > 0 && (
                  <>
                    <Text style={styles.sheetSection}>SKILL GRADING</Text>
                    {Object.entries(
                      (editChecklist || []).reduce((acc, row) => {
                        const cat = row.category || 'General';
                        (acc[cat] = acc[cat] || []).push(row);
                        return acc;
                      }, {} as Record<string, DeliveryChecklist[]>),
                    ).map(([category, rows]) => (
                      <View key={category} style={styles.gradeCategory}>
                        <Text style={styles.gradeCategoryTitle}>{category}</Text>
                        {rows.map((row) => {
                          const options = row.grade_options && row.grade_options.length > 0
                            ? row.grade_options
                            : ['Excellent', 'Average', 'Below Average'];
                          const many = options.length > 3;
                          return (
                            <View key={row.id} style={styles.gradeItem}>
                              <Text style={styles.gradeTopic}>{row.topic}</Text>
                              <View style={[styles.gradeBtnRow, many && { flexWrap: 'wrap' }]}>
                                {options.map((g) => {
                                  const selected = sheetGrades[row.id] === g;
                                  const gc = gradeColor(g, colors);
                                  return (
                                    <TouchableOpacity
                                      key={g}
                                      style={[
                                        styles.gradeBtn,
                                        many && styles.gradeBtnWide,
                                        selected && { backgroundColor: gc.bg, borderColor: gc.text },
                                      ]}
                                      onPress={() => { haptics.light(); setSheetGrades((p) => ({ ...p, [row.id]: g })); }}
                                    >
                                      <Text style={[styles.gradeBtnText, selected && { color: gc.text, fontWeight: '700' }]} numberOfLines={1}>
                                        {g}
                                      </Text>
                                    </TouchableOpacity>
                                  );
                                })}
                              </View>
                            </View>
                          );
                        })}
                      </View>
                    ))}
                  </>
                )}
              </ScrollView>

              <View style={styles.sheetFooter}>
                <TouchableOpacity onPress={saveSheet} activeOpacity={0.85} testID="orientation-sheet-save">
                  <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.confirmBtn}>
                    <Ionicons name="checkmark" size={18} color="#fff" />
                    <Text style={styles.confirmBtnText}>Save for {editing?.name?.split(' ')[0] || 'them'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </Modal>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, gap: 8, padding: 24 },
  guardText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  content: { padding: 16, paddingTop: 8 },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fonts.display, fontSize: 20, fontWeight: '900', color: colors.text },
  subtitle: { fontSize: 12.5, color: colors.textSecondary, marginTop: 1 },
  daySwitchRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 8 },
  daySwitchPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 22,
    backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
  },
  daySwitchPillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  daySwitchText: { fontSize: 13.5, fontWeight: '700', color: colors.textSecondary },
  daySwitchTextActive: { color: colors.onPrimary },
  daySwitchDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.yellow },

  summaryBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: 16, marginBottom: 4, paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: colors.background, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
  },
  summaryText: { fontSize: 13, color: colors.textSecondary },
  summaryCount: { fontFamily: fonts.mono, fontSize: 13, fontWeight: '800', color: colors.text },
  summaryPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
    backgroundColor: '#10b98118', borderWidth: 1, borderColor: '#10b98140',
  },
  summaryPillText: { fontSize: 11.5, fontWeight: '800', color: colors.green },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.background, borderRadius: 14, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  rowUnticked: { opacity: 0.55 },
  checkbox: {
    width: 28, height: 28, borderRadius: 8, borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface,
  },
  checkboxTicked: { backgroundColor: colors.primary, borderColor: colors.primary },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { fontFamily: fonts.bodySemibold, fontSize: 15, fontWeight: '700', color: colors.text, flexShrink: 1 },
  noLeaderChip: { paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 5, backgroundColor: colors.yellow + '20' },
  noLeaderText: { fontSize: 9.5, fontWeight: '800', color: colors.yellow },
  rowDate: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  stagePill: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 2.5, borderRadius: 999, marginTop: 5,
  },
  excellentPill: { backgroundColor: '#10b98114', borderWidth: 1, borderColor: '#10b98133' },
  editedPill: { backgroundColor: colors.yellow + '18', borderWidth: 1, borderColor: colors.yellow + '44' },
  stagePillText: { fontSize: 10.5, fontWeight: '800' },
  skippedText: { fontSize: 11, color: colors.textMuted, fontStyle: 'italic', marginTop: 5 },
  editBtn: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.primary + '55', backgroundColor: colors.primary + '12',
  },

  actionBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 16, paddingTop: 12,
    backgroundColor: colors.background, borderTopWidth: 1, borderTopColor: colors.border,
  },
  confirmBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 12,
  },
  confirmBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  card: { backgroundColor: colors.background, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14 },

  // Success
  successEmoji: { fontSize: 44, textAlign: 'center', marginTop: 24 },
  successTitle: { fontFamily: fonts.display, fontSize: 22, fontWeight: '900', color: colors.text, textAlign: 'center', marginTop: 8 },
  successSub: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 18 },
  nextDayBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12,
    paddingHorizontal: 18, marginBottom: 16, alignSelf: 'center',
  },
  nextDayBtnText: { color: colors.onPrimary, fontSize: 14, fontWeight: '700' },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  resultName: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text },
  resultDetail: { fontSize: 11.5, fontWeight: '700', maxWidth: 150 },

  // Edit sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    maxHeight: '88%', paddingTop: 8,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 8 },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 16, paddingBottom: 10 },
  sheetTitle: { fontFamily: fonts.display, fontSize: 17, fontWeight: '900', color: colors.text },
  sheetSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  sheetContent: { paddingHorizontal: 16, paddingBottom: 16 },
  sheetSection: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.primary, letterSpacing: 1.2, marginTop: 14, marginBottom: 7 },
  sheetFooter: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  resetChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, marginTop: 4,
    borderWidth: 1, borderColor: colors.primary + '55', backgroundColor: colors.primary + '10',
  },
  resetChipText: { fontSize: 12, fontWeight: '700', color: colors.primary },

  gradeCategory: {
    backgroundColor: colors.background, borderRadius: 14, marginBottom: 10, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
  },
  gradeCategoryTitle: {
    fontFamily: fonts.display, fontSize: 13.5, fontWeight: '800', color: colors.text,
    paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.surfaceAlt,
  },
  gradeItem: { paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  gradeTopic: { fontSize: 13.5, fontWeight: '600', color: colors.text, marginBottom: 8 },
  gradeBtnRow: { flexDirection: 'row', gap: 6 },
  gradeBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8, paddingHorizontal: 6, borderRadius: 9,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, minWidth: 70,
  },
  gradeBtnWide: { flex: 0, width: '48%' },
  gradeBtnText: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
