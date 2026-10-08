/**
 * Module Detail screen — stages 2/3/4 (rich, narrative training content).
 * Shows trainee_content, what_good_looks_like, how_measured, leader_coaching_notes,
 * and a 4-dimension scoring panel (Knowledge / Skill / Consistency / Independence)
 * on the 1-10 scale (Learning / Developing / Competent / Independent bands).
 *
 * Save-on-tap: each dimension is a horizontal 1-10 picker that PUTs immediately
 * to /api/module-progress/{id} and refreshes the local progress query.
 */
import React, { useMemo, useState, useEffect, createElement } from 'react';
import { showAlert } from '../../src/utils/showAlert';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform,  } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors, useTheme, fonts, GRADIENT } from '../../src/theme/ThemeContext';
import { apiService } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { BrandLoader } from '../../src/components/ui/BrandLoader';
import { ScrollReveal } from '../../src/components/ui/ScrollFx';
import { useParallaxScroll } from '../../src/components/ui/Parallax';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { XPBar } from '../../src/components/ui/XPBar';
import { Keycap } from '../../src/components/ui/Keycap';
import { GlowButton } from '../../src/components/ui/GlowButton';
import { SlidingSegments } from '../../src/components/ui/SlidingSegments';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import DateTimePicker from '@react-native-community/datetimepicker';
import { codStageLabel } from '../../src/components/cod/stageOrder';
import { APP_LOCALE } from '../../src/utils/appTime';

const DIMENSIONS: Array<{ key: 'knowledge' | 'skill' | 'consistency' | 'independence'; label: string; help: string }> = [
  { key: 'knowledge', label: 'Knowledge', help: 'Can explain it clearly' },
  { key: 'skill', label: 'Skill', help: 'Can perform it in roleplay or field' },
  { key: 'consistency', label: 'Consistency', help: 'Can repeat it multiple times' },
  { key: 'independence', label: 'Independence', help: 'Can do it without coach support' },
];

// COD 2026 Proof Ladder — the grader. Mirrors backend LADDER_RUNGS.
const LADDER: Array<{ value: number; label: string; blurb: string; coachOnly: boolean }> = [
  { value: 1, label: 'Know', blurb: 'Can explain it simply', coachOnly: false },
  { value: 2, label: 'Do', blurb: 'Can execute it effectively in the office', coachOnly: false },
  { value: 3, label: 'Deliver', blurb: 'Hits the standard under pressure in the field', coachOnly: true },
  { value: 4, label: 'Teach', blurb: 'Can transfer it to others', coachOnly: true },
  { value: 5, label: 'Systemize', blurb: 'Runs as a system — independent examples of WGLL', coachOnly: true },
];

/** The 3-screen flow, as a sliding-tile segment rail (labels unchanged). */
const SEGMENTS = [
  { key: 'learn', label: 'Learn' },
  { key: 'prove', label: 'Prove' },
  { key: 'ladder', label: 'Ladder' },
];

const RUNG_KEYS = ['know', 'do', 'deliver', 'teach', 'systemize'];
// The ladder grows with the stage: 1-2 top out at Deliver, 3 adds Teach,
// 4 and SL add Systemize.
const maxRungForStage = (stage?: number) => !stage ? 5 : stage <= 2 ? 3 : stage === 3 ? 4 : 5;
function fmtRungDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Color band for any 1-10 score, matching the API's bands
function bandColor(score: number | null | undefined, c: any) {
  if (!score) return c.textMuted;
  if (score >= 9) return c.sgreen || '#16a34a';
  if (score >= 7) return c.green || '#22c55e';
  if (score >= 4) return c.yellow || '#eab308';
  return c.red || '#ef4444';
}
function bandLabel(score: number | null | undefined): string {
  if (!score) return '—';
  if (score >= 9) return 'Independent';
  if (score >= 7) return 'Competent';
  if (score >= 4) return 'Developing';
  return 'Learning';
}

export default function ModuleDetailScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const tabBarClearance = useTabBarClearance();
  const { id, trainee_id } = useLocalSearchParams<{ id: string; trainee_id?: string }>();
  const qc = useQueryClient();
  const { scrollY, onScroll } = useParallaxScroll();
  const { user } = useAuth();
  const role = (user?.role || '').toLowerCase();
  const isTrainee = role === 'trainee';
  const isAdmin = role === 'admin';
  const isLeader = role === 'leader';
  // Grading mode determines who can write scores:
  //  • trainee viewing self → read-only
  //  • leader viewing without trainee_id → self-assess (Stage 3 leader topics)
  //  • leader viewing WITH trainee_id → grading the trainee on Stage 2
  //  • admin → can grade anyone (self for self-assess, target for grading)
  const targetUserId = trainee_id || (isTrainee ? user?.id : undefined);
  const isGradingOnBehalf = !!trainee_id;
  const canAssess = !isTrainee; // trainees never write
  const canPassOff = isAdmin || isLeader; // backend re-checks subtree

  // Per-dimension lock: leaders rating themselves on Stage 3 may write
  // Knowledge & Skill ONLY. Consistency & Independence (and pass-off) come
  // from their direct leader or admin. Backend mirrors this rule defensively.
  const isLeaderSelfStage3 = (
    isLeader
    && (!trainee_id || trainee_id === user?.id)
  );
  // We don't know the stage until moduleQ resolves — recompute it down below.

  const moduleQ = useQuery({
    queryKey: ['module', id],
    queryFn: () => apiService.getModule(String(id)).then(r => r.data),
    enabled: !!id,
  });

  // Stage-status drives the Stage-3 coaching gate: leaders without a junior
  // leader on their team should NOT see how to coach others on Stage 3 topics.
  const stageStatusQ = useQuery({
    queryKey: ['stage-status'],
    queryFn: () => apiService.getStageStatus().then(r => r.data),
  });

  // Fetch the user's progress for this module's stage so we can pre-populate scores.
  // When grading on behalf of a trainee, we fetch the trainee's progress instead.
  const stage = moduleQ.data?.stage as 2 | 3 | 4 | 5 | undefined;
  const progressQ = useQuery({
    queryKey: isGradingOnBehalf
      ? ['trainee-module-progress', trainee_id, stage]
      : ['module-progress', stage],
    queryFn: () => isGradingOnBehalf
      ? apiService.getTraineeModuleProgress(String(trainee_id), stage as 2 | 3 | 4 | 5).then(r => r.data.progress)
      : apiService.getMyModuleProgress(stage!).then(r => r.data.progress),
    enabled: !!stage,
  });

  const myProgress = (progressQ.data || []).find((p: any) => p.module_id === id);

  // Local draft state — synced from server when progress loads
  const [scores, setScores] = useState<Record<string, number | null>>({
    knowledge: null, skill: null, consistency: null, independence: null,
  });
  const [ladder, setLadderState] = useState<number>(0);
  const [ladderDates, setLadderDates] = useState<Record<string, string>>({});
  const [editingRung, setEditingRung] = useState<number | null>(null);
  const [wgll, setWgll] = useState<number[]>([]);
  // 3-screen flow: Learn → Prove → Ladder. Coaches grading someone land on
  // Ladder (that's their job here); learners land on Learn.
  const [segment, setSegment] = useState<'learn' | 'prove' | 'ladder' | null>(null);
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (myProgress) {
      setScores({
        knowledge: myProgress.knowledge ?? null,
        skill: myProgress.skill ?? null,
        consistency: myProgress.consistency ?? null,
        independence: myProgress.independence ?? null,
      });
      if (typeof myProgress.leader_notes === 'string') setNotes(myProgress.leader_notes);
      setLadderState(myProgress.ladder ?? 0);
      setLadderDates(myProgress.ladder_dates || {});
      setWgll(Array.isArray(myProgress.wgll_checked) ? myProgress.wgll_checked : []);
    }
    // Deps include the mutable fields: the quiz auto-award updates the SAME
    // row (same id), so keying on id alone left the Know rung stale.
  }, [myProgress?.id, myProgress?.ladder, myProgress?.quiz_passed, myProgress?.ready_for_check,
      JSON.stringify(myProgress?.ladder_dates || {}), JSON.stringify(myProgress?.wgll_checked || [])]);

  const upsert = useMutation({
    mutationFn: (payload: any) => apiService.upsertModuleProgress(String(id), payload, trainee_id).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['module-progress', stage] });
      qc.invalidateQueries({ queryKey: ['trainee-module-progress', trainee_id, stage] });
      qc.invalidateQueries({ queryKey: ['stage-status'] });
    },
    onError: (e: any) => showAlert('Save failed', e?.response?.data?.detail || 'Could not save score'),
  });

  const readyMut = useMutation({
    mutationFn: (ready: boolean) => apiService.setReadyForCheck(String(id), { ready }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['module-progress', stage] });
    },
    onError: (e: any) => showAlert('Could not update', e?.response?.data?.detail || 'Try again'),
  });

  const passOff = useMutation({
    mutationFn: (passedOff: boolean) =>
      apiService.passOffModule(String(id), String(targetUserId), passedOff).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['module-progress', stage] });
      qc.invalidateQueries({ queryKey: ['trainee-module-progress', trainee_id, stage] });
      showAlert('Saved', myProgress?.passed_off ? 'Pass-off removed' : 'Section passed off ✅');
    },
    onError: (e: any) => showAlert('Pass-off failed', e?.response?.data?.detail || 'Could not pass off'),
  });

  // Dimensions a leader-self-on-Stage-3 may NOT write. Empty set otherwise.
  const lockedDims = useMemo(() => {
    const m = moduleQ.data;
    if (m && isLeaderSelfStage3 && m.stage === 3) {
      return new Set(['consistency', 'independence']);
    }
    return new Set<string>();
  }, [moduleQ.data, isLeaderSelfStage3]);
  const passOffLocked = lockedDims.size > 0; // same trigger as locked dims

  // Self-assessment (leader/admin viewing their own module) may claim Know
  // and Do; Deliver+ are coach sign-offs — mirrors the printed sheet's
  // COACH SIGN-OFF box. Admins grade anyone in full.
  const selfLadderOnly = canAssess && !isGradingOnBehalf && !isAdmin;
  const setLadder = (v: number) => {
    if (!canAssess) return;
    if (selfLadderOnly && v > 2) return;
    setLadderState(v);
    // Optimistic date boxes — server recomputes authoritatively on save.
    const today = new Date().toISOString().slice(0, 10);
    setLadderDates((prev) => {
      const next: Record<string, string> = {};
      RUNG_KEYS.forEach((k, i) => {
        if (i + 1 <= v) next[k] = prev[k] || today;
      });
      return next;
    });
    upsert.mutate({ ladder: v });
  };
  const toggleWgll = (i: number) => {
    if (!canAssess) return;
    const next = wgll.includes(i) ? wgll.filter((x) => x !== i) : [...wgll, i].sort((a, b) => a - b);
    setWgll(next);
    upsert.mutate({ wgll_checked: next });
  };
  const setRungDate = (rung: number, iso: string) => {
    const key = RUNG_KEYS[rung - 1];
    setLadderDates((prev) => ({ ...prev, [key]: iso }));
    upsert.mutate({ ladder_dates: { [key]: iso } });
  };

  const setScore = (dim: string, v: number) => {
    if (!canAssess) return; // trainees cannot grade themselves
    if (lockedDims.has(dim)) return; // locked-for-self
    const next = { ...scores, [dim]: v };
    setScores(next);
    upsert.mutate({ [dim]: v });
  };
  const saveNotes = () => {
    if (!canAssess) return;
    upsert.mutate({ leader_notes: notes });
  };

  if (moduleQ.isLoading) {
    return (
      <View style={styles.loader}>
        <BrandLoader size={56} />
      </View>
    );
  }
  if (moduleQ.isError || !moduleQ.data) {
    return (
      <View style={styles.loader}>
        <Text style={{ color: colors.text }}>Module not found.</Text>
        <TouchableOpacity onPress={() => router.back()} style={[styles.btn, { marginTop: 16 }]}>
          <Text style={styles.btnText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }
  const m = moduleQ.data as any;
  const seg = segment ?? (isGradingOnBehalf ? 'ladder' : 'learn');

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <Stack.Screen options={{ title: m.topic, headerShown: true, headerBackTitle: 'Back' }} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 80 + tabBarClearance }}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* Header band — the printed ink block: category kicker, the TOPIC,
            "Stage n · Week n" and the pills. Stays OPAQUE (spec §2.5) — it is
            this screen's own header bar.

            The topic MUST be printed here: the navigator Masthead renders it
            with numberOfLines={1} and `adjustsFontSizeToFit` is a no-op on
            react-native-web, so any topic over ~22 chars is ellipsised up
            there ("Seeks Support Early & Proa…"). The band is the only place
            the full name is guaranteed to be readable; the masthead's
            scroll-condense answers the repetition. */}
        <View style={styles.header}>
          <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.headerRule} />
          <Text style={styles.cat}>{(m.category || '').toUpperCase()}</Text>
          <Text style={styles.title}>{m.topic}</Text>
          <Text style={styles.meta}>
            Stage {codStageLabel(m.stage)}{m.week ? ` · Week ${m.week}` : ''}
          </Text>
          {!!myProgress?.completed && (
            <View style={styles.completedPill}>
              <Ionicons name="checkmark-circle" size={14} color="#fff" />
              <Text style={styles.completedPillText}>
                {(myProgress?.ladder ?? 0) >= 3
                  ? `${LADDER.find(r => r.value === myProgress.ladder)?.label ?? 'Deliver'} ✓`
                  : myProgress?.passed_off ? 'Passed off ✓' : 'Competent or higher'}
              </Text>
            </View>
          )}
          {/* "Grading on behalf" banner — appears when leader/admin opens the
              module via /module/{id}?trainee_id=<userid>. Makes the context
              extremely obvious so they don't accidentally self-grade. */}
          {isGradingOnBehalf && (
            <View style={styles.gradingBanner}>
              <Ionicons name="people" size={14} color={colors.onPrimary} />
              <Text style={styles.gradingBannerText}>Grading on their behalf — your scores apply to them</Text>
            </View>
          )}
        </View>

        {/* 3-screen flow switcher — ink rail with one sliding tile (spec §3.13) */}
        <SlidingSegments
          style={styles.segBar}
          value={seg}
          onChange={(k) => setSegment(k as 'learn' | 'prove' | 'ladder')}
          items={SEGMENTS}
        />

        {/* ── LEARN — the lesson + the questions. Passing them ticks Know. ── */}
        {seg === 'learn' && !!m.trainee_content && (
          <ScrollReveal scrollY={scrollY}>
            <Section title="📘 What to Learn" colors={colors}>
              <Text style={styles.bodyText}>{m.trainee_content}</Text>
            </Section>
          </ScrollReveal>
        )}

        {/* What good looks like */}
        {seg === 'prove' && Array.isArray(m.what_good_looks_like) && m.what_good_looks_like.length > 0 && (
          <Section
            title={`✨ What Good Looks Like · ${wgll.length}/${m.what_good_looks_like.length} measured`}
            colors={colors}
          >
            {/* The back page's tick boxes: each WGLL line gets checked off as
                it's hit AND measured. Trainees see the state read-only; their
                coach ticks. */}
            {m.what_good_looks_like.map((it: string, i: number) => {
              const checked = wgll.includes(i);
              return (
                <TouchableOpacity
                  key={i}
                  activeOpacity={canAssess ? 0.7 : 1}
                  onPress={() => toggleWgll(i)}
                  style={styles.wgllRow}
                >
                  <Keycap size={24} radius={7} tone={checked ? 'gradient' : 'paper'} style={styles.wgllBox}>
                    {checked ? <Ionicons name="checkmark" size={13} color="#fff" /> : null}
                  </Keycap>
                  <Text style={[styles.wgllText, checked && styles.wgllTextChecked]}>{it}</Text>
                </TouchableOpacity>
              );
            })}
            {!canAssess && (
              <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 6, fontStyle: 'italic' }}>
                Your coach ticks these off as each one is hit and measured.
              </Text>
            )}
          </Section>
        )}

        {/* Check your understanding — 3-question quiz (Product-Knowledge
            style). Hidden while grading someone else; the quiz belongs to
            the learner. */}
        {seg === 'learn' && !isGradingOnBehalf && (
          <ScrollReveal scrollY={scrollY}>
            <ModuleQuiz
              moduleId={String(id)}
              myProgress={myProgress}
              colors={colors}
              onRecorded={() => qc.invalidateQueries({ queryKey: ['module-progress'] })}
            />
          </ScrollReveal>
        )}

        {/* Leader panel — coach context at the moment of signing. Never
            shown on the learner's own view (that was the word-heaviness). */}
        {seg === 'ladder' && isGradingOnBehalf && Array.isArray(m.how_measured) && m.how_measured.length > 0 && (
          <ScrollReveal scrollY={scrollY}>
            <Section title="📊 How It's Measured" colors={colors}>
              {m.how_measured.map((it: string, i: number) => (
                <BulletRow key={i} text={it} colors={colors} icon="trending-up" />
              ))}
            </Section>
          </ScrollReveal>
        )}

        {/* Leader coaching notes — hidden from trainees. For Stage 3 modules
            ALSO require team_has_junior_leader (the spec: leaders only get
            "how to teach Stage 3" once they have a leader on their team). */}
        {seg === 'ladder' && isGradingOnBehalf && Array.isArray(m.leader_coaching_notes) && m.leader_coaching_notes.length > 0 && (
          (m.stage !== 3 || isAdmin || stageStatusQ.data?.team_has_junior_leader) ? (
            <Section title="🎯 Coaching Notes" colors={colors}>
              {m.leader_coaching_notes.map((it: string, i: number) => (
                <BulletRow key={i} text={it} colors={colors} icon="bulb" />
              ))}
            </Section>
          ) : (
            <Section title="🔒 Coaching Notes" colors={colors}>
              <Text style={{ color: colors.textSecondary, fontSize: 12.5, lineHeight: 18, fontStyle: 'italic' }}>
                Coaching guidance unlocks once you have at least one coach on your team. Until then, focus on your own growth on this topic.
              </Text>
            </Section>
          )
        )}

        {/* Scoring panel */}
        {seg === 'ladder' && (
        <Section title={isGradingOnBehalf ? '📝 Sign-off' : '📝 My Ladder'} colors={colors}>
          {/* Self-rate-Stage-3 explainer for leaders without juniors */}
          {passOffLocked && (
            <View style={styles.selfRateBanner}>
              <Ionicons name="information-circle" size={16} color={colors.primary} />
              <Text style={styles.selfRateBannerText}>
                Self-rate mode — you can score <Text style={{ fontWeight: '800' }}>Knowledge</Text> and <Text style={{ fontWeight: '800' }}>Skill</Text>. Consistency, Independence and pass-off come from your direct coach or admin.
              </Text>
            </View>
          )}
          {isTrainee ? (
            <Text style={styles.scaleHelp}>
              Your coach signs off each rung of the proof ladder as you prove it. Deliver is the standard — Teach and Systemize take it further.
            </Text>
          ) : selfLadderOnly ? (
            <View style={styles.selfRateBanner}>
              <Ionicons name="information-circle" size={16} color={colors.primary} />
              <Text style={styles.selfRateBannerText}>
                Pass the questions on the Learn screen to tick <Text style={{ fontWeight: '800' }}>Know</Text>. For every rung after that, tap <Text style={{ fontWeight: '800' }}>Ready for check</Text> below — your coach confirms it with you, and the date stamps itself.
              </Text>
            </View>
          ) : (
            <Text style={styles.scaleHelp}>
              Tick the highest rung this person has proven — evidence, not vibes. Deliver marks the capability as met.
            </Text>
          )}
          {/* How far up the ladder this capability is — the one XP bar on this screen. */}
          <XPBar
            value={Math.max(0, Math.min(1, ladder / maxRungForStage(stage)))}
            height={10}
            style={styles.ladderBar}
          />
          {LADDER.filter((r) => r.value <= maxRungForStage(stage)).map((r) => {
            const achieved = ladder >= r.value;
            const isCurrent = ladder === r.value;
            const locked = selfLadderOnly && r.coachOnly;
            // One primary action per screen: on your OWN view the ladder is a
            // status display — progress happens via quiz (Know) and the
            // Ready-for-check button below. Coaches tap rungs directly, and
            // admins may also sign their own (nobody sits above them).
            const interactive = canAssess && (isGradingOnBehalf || isAdmin) && !locked;
            return (
              <TouchableOpacity
                key={r.value}
                activeOpacity={interactive ? 0.7 : 1}
                onPress={() => {
                  if (!interactive) return;
                  // Tap the current rung to step back down; tap any rung to set it.
                  setLadder(isCurrent ? r.value - 1 : r.value);
                }}
                style={[styles.ladderRow, achieved && styles.ladderRowDone]}
              >
                {/* The printed sheet's sign-off box, as a keycap (spec §3.12) */}
                <Keycap size={32} radius={10} tone={achieved ? 'gradient' : 'paper'}>
                  {achieved
                    ? <Ionicons name="checkmark" size={16} color="#fff" />
                    : locked
                      ? <Ionicons name="lock-closed" size={13} color={colors.textMuted} />
                      : <Text style={styles.ladderCircleNum}>{r.value}</Text>}
                </Keycap>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={[styles.ladderLabel, achieved && { color: colors.primary }]}>{r.label}</Text>
                    {r.value === 3 && <View style={styles.ladderMetChip}><Text style={styles.ladderMetChipText}>THE STANDARD</Text></View>}
                    {locked && <Text style={styles.ladderCoachTag}>coach sign-off</Text>}
                  </View>
                  <Text style={styles.ladderBlurb}>{r.blurb}</Text>
                  {achieved && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                      <Ionicons name="calendar-outline" size={11} color={colors.textMuted} />
                      {interactive ? (
                        Platform.OS === 'web' ? (
                          <View style={{ position: 'relative' }}>
                            <Text style={styles.ladderDate}>{fmtRungDate(ladderDates[RUNG_KEYS[r.value - 1]]) || 'Set date'}</Text>
                            {createElement('input', {
                              type: 'date',
                              value: ladderDates[RUNG_KEYS[r.value - 1]] || '',
                              max: new Date().toISOString().slice(0, 10),
                              onChange: (e: any) => { if (e.target.value) setRungDate(r.value, e.target.value); },
                              onClick: (e: any) => { e.stopPropagation(); const el = e.currentTarget; if (typeof el?.showPicker === 'function') { try { el.showPicker(); } catch { /* ignore */ } } },
                              'aria-label': `Date ${r.label} was proven`,
                              style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', opacity: 0, border: 'none', margin: 0, padding: 0, cursor: 'pointer', fontSize: 16 },
                            })}
                          </View>
                        ) : (
                          <TouchableOpacity onPress={(e: any) => { e.stopPropagation?.(); setEditingRung(r.value); }} hitSlop={8}>
                            <Text style={styles.ladderDate}>{fmtRungDate(ladderDates[RUNG_KEYS[r.value - 1]]) || 'Set date'}</Text>
                          </TouchableOpacity>
                        )
                      ) : (
                        <Text style={styles.ladderDate}>{fmtRungDate(ladderDates[RUNG_KEYS[r.value - 1]])}</Text>
                      )}
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
          {/* The one primary action on your own view: ask your coach to
              check the next rung. Trainee, leader, admin — same button. */}
          {!isGradingOnBehalf && ladder < maxRungForStage(stage) && (
            myProgress?.ready_for_check ? (
              <View style={styles.readyPending}>
                <Ionicons name="hourglass-outline" size={16} color={colors.primary} />
                <Text style={styles.readyPendingText}>
                  Check requested — your coach will confirm {LADDER.find((r) => r.value === ladder + 1)?.label} with you.
                </Text>
                <TouchableOpacity onPress={() => readyMut.mutate(false)} hitSlop={8}>
                  <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700' }}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <GlowButton
                style={styles.readyBtn}
                disabled={readyMut.isPending}
                onPress={() => readyMut.mutate(true)}
              >
                {readyMut.isPending ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="hand-right-outline" size={17} color="#fff" />}
                <Text style={styles.readyBtnText}>
                  Ready for check — {LADDER.find((r) => r.value === ladder + 1)?.label}
                </Text>
              </GlowButton>
            )
          )}

          {/* Grading history from the pre-2026 1-10 system, shown only when
              this capability has old scores but no ladder rung yet. */}
          {ladder === 0 && DIMENSIONS.some((d) => scores[d.key] != null) && (
            <Text style={{ color: colors.textMuted, fontSize: 11.5, marginTop: 10, fontStyle: 'italic' }}>
              Previous grading (pre-2026 COD): {DIMENSIONS.filter((d) => scores[d.key] != null).map((d) => `${d.label} ${scores[d.key]}/10`).join(' · ')}
            </Text>
          )}

          {/* Native rung-date picker — web uses the inline <input type="date"> overlay */}
          {editingRung != null && Platform.OS !== 'web' && (
            <DateTimePicker
              value={(() => { const v = ladderDates[RUNG_KEYS[editingRung - 1]]; const d = v ? new Date(v + 'T00:00:00') : new Date(); return isNaN(d.getTime()) ? new Date() : d; })()}
              mode="date"
              maximumDate={new Date()}
              onChange={(_e: any, d?: Date) => {
                setEditingRung(null);
                if (d) setRungDate(editingRung, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
              }}
            />
          )}

          {/* Coach note — grading view only; learners' own view stays light */}
          {isGradingOnBehalf && (
            <View style={{ marginTop: 18 }}>
              <Text style={styles.notesLabel}>Coach notes (optional)</Text>
              <TextInput
                style={styles.notes}
                multiline
                placeholder="Coaching notes, blockers, or wins to remember…"
                placeholderTextColor={colors.textMuted}
                value={notes}
                onChangeText={setNotes}
                onBlur={saveNotes}
              />
            </View>
          )}

          {/* Trainee read-only message when no scores yet */}
          {isTrainee && !myProgress && (
            <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
              <Text style={{ color: colors.textSecondary, fontSize: 12.5, lineHeight: 18, fontStyle: 'italic' }}>
                Your coach hasn't assessed you on this topic yet. Keep working on it — focus on the "What Good Looks Like" checklist above.
              </Text>
            </View>
          )}

          {upsert.isPending && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Saving…</Text>
            </View>
          )}

          {/* Pass-off button removed per product spec (2026-05): pass-off
              equates to completing all assessments, no separate manual step.
              The data field is preserved for legacy badges that still display
              "passed off ✓" when set, but the UI no longer offers it. */}
          {false && canPassOff && targetUserId && !passOffLocked && (
            <View style={styles.passOffWrap}>
              <TouchableOpacity
                style={[
                  styles.passOffBtn,
                  myProgress?.passed_off && styles.passOffBtnActive,
                ]}
                onPress={() => {
                  const next = !myProgress?.passed_off;
                  showAlert(
                    next ? 'Pass off this section?' : 'Remove pass-off?',
                    next
                      ? 'This marks the entire module as complete without changing the 1–10 scores. Use when you want to override and approve the BA/coach on this section.'
                      : 'Removes the pass-off flag. The completion state will revert to whatever the 1–10 scores compute to.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: next ? 'Pass off ✓' : 'Remove', onPress: () => passOff.mutate(next) },
                    ]
                  );
                }}
                disabled={passOff.isPending}
              >
                <Ionicons
                  name={myProgress?.passed_off ? 'shield-checkmark' : 'ribbon-outline'}
                  size={18}
                  color={myProgress?.passed_off ? '#fff' : colors.primary}
                />
                <Text style={[
                  styles.passOffBtnText,
                  myProgress?.passed_off && { color: '#fff' },
                ]}>
                  {myProgress?.passed_off ? 'Section passed off ✓ (tap to undo)' : 'Pass off this section'}
                </Text>
              </TouchableOpacity>
              <Text style={styles.passOffHelp}>
                Override the 1–10 scoring and mark this module as complete. Reserved for admins and coaches.
              </Text>
            </View>
          )}
        </Section>
        )}

        {seg === 'ladder' && !!myProgress?.last_assessed_at && (
          <Text style={styles.lastSaved}>
            Last saved {new Date(myProgress.last_assessed_at).toLocaleString(APP_LOCALE)}
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * ModuleQuiz — "Check your understanding" (the Product-Knowledge pattern in
 * miniature). 3 AI-generated multiple-choice questions per module, graded
 * server-side; passing 2 of 3 banks the module on the journey path. Answer
 * a question and it auto-advances; the last answer submits.
 */
function ModuleQuiz({ moduleId, myProgress, colors, onRecorded }: {
  moduleId: string; myProgress: any; colors: any; onRecorded: () => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'active' | 'result'>('idle');
  const [quiz, setQuiz] = useState<{ quiz_id: string; questions: Array<{ id: string; question: string; choices: string[] }> } | null>(null);
  const [qIdx, setQIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<any>(null);
  const [unavailable, setUnavailable] = useState(false);
  const passed = !!myProgress?.quiz_passed;

  const start = async () => {
    setPhase('loading');
    try {
      const r = await apiService.getModuleQuiz(moduleId);
      setQuiz(r.data); setQIdx(0); setAnswers({}); setResult(null); setPhase('active');
    } catch (e: any) {
      if (e?.response?.status === 404) { setUnavailable(true); setPhase('idle'); }
      else { showAlert('Quiz unavailable', e?.response?.data?.detail || 'Try again in a moment.'); setPhase('idle'); }
    }
  };
  const choose = async (choiceIdx: number) => {
    if (!quiz) return;
    const q = quiz.questions[qIdx];
    const next = { ...answers, [q.id]: choiceIdx };
    setAnswers(next);
    if (qIdx < quiz.questions.length - 1) {
      setQIdx(qIdx + 1);
      return;
    }
    setPhase('loading');
    try {
      const r = await apiService.submitModuleQuiz(moduleId, { quiz_id: quiz.quiz_id, answers: next });
      setResult(r.data); setPhase('result'); onRecorded();
    } catch (e: any) {
      showAlert('Could not submit', e?.response?.data?.detail || 'Try again.');
      setPhase('active');
    }
  };

  if (unavailable) return null;

  const qz = {
    btn: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 7, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12 },
    btnText: { color: colors.onPrimary, fontSize: 13.5, fontWeight: '800' as const },
    ghost: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 6, borderRadius: 12, paddingVertical: 11, borderWidth: 1, borderColor: colors.border, marginTop: 8 },
    ghostText: { color: colors.textSecondary, fontSize: 12.5, fontWeight: '700' as const },
    choice: { borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surfaceAlt, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 8 },
    choiceText: { color: colors.text, fontSize: 13.5, lineHeight: 19, fontWeight: '600' as const },
  };

  return (
    <Section title="🧠 Check Your Understanding" colors={colors}>
      {phase === 'idle' && (
        <>
          {passed ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.greenBg || '#dcfce7', borderRadius: 10, padding: 10, marginBottom: 8 }}>
              <Ionicons name="checkmark-circle" size={18} color={colors.green || '#16a34a'} />
              <Text style={{ flex: 1, color: colors.green || '#166534', fontSize: 13, fontWeight: '800' }}>
                Quiz passed {myProgress?.quiz_score != null ? `· ${myProgress.quiz_score}/${myProgress.quiz_total}` : ''} — this module is banked 🎉
              </Text>
            </View>
          ) : (
            <Text style={{ color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 10 }}>
              3 quick questions on what you just read — get 2 right to bank this module on your journey.
            </Text>
          )}
          <TouchableOpacity style={passed ? qz.ghost : qz.btn} onPress={start} testID="module-quiz-start">
            <Ionicons name={passed ? 'refresh' : 'play'} size={15} color={passed ? colors.textSecondary : '#fff'} />
            <Text style={passed ? qz.ghostText : qz.btnText}>{passed ? 'Retake the quiz' : 'Start the quiz'}</Text>
          </TouchableOpacity>
        </>
      )}

      {phase === 'loading' && (
        <View style={{ alignItems: 'center', paddingVertical: 18 }}>
          <ActivityIndicator color={colors.primary} />
          <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 8 }}>One moment…</Text>
        </View>
      )}

      {phase === 'active' && quiz && (
        <>
          <View style={{ flexDirection: 'row', gap: 5, marginBottom: 10 }}>
            {quiz.questions.map((_, i) => (
              i <= qIdx
                ? <LinearGradient key={i} colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1, height: 5, borderRadius: 3 }} />
                : <View key={i} style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: colors.trackBg }} />
            ))}
          </View>
          <Text style={{ fontFamily: fonts.displayWide, color: colors.textSecondary, fontSize: 11, letterSpacing: 1.4, marginBottom: 6 }}>
            QUESTION {qIdx + 1} OF {quiz.questions.length}
          </Text>
          <Text style={{ fontFamily: fonts.display, color: colors.text, fontSize: 16, lineHeight: 22, marginBottom: 12 }}>
            {quiz.questions[qIdx].question}
          </Text>
          {quiz.questions[qIdx].choices.map((c, ci) => (
            <TouchableOpacity key={ci} style={qz.choice} onPress={() => choose(ci)} activeOpacity={0.7}>
              <Text style={qz.choiceText}>{c}</Text>
            </TouchableOpacity>
          ))}
        </>
      )}

      {phase === 'result' && result && quiz && (
        <>
          <View style={{ alignItems: 'center', paddingVertical: 6, marginBottom: 10 }}>
            <Text style={{ fontSize: 34 }}>{result.passed ? '🎉' : '💪'}</Text>
            <Text style={{ color: result.passed ? (colors.green || '#16a34a') : colors.text, fontSize: 18, fontWeight: '900', marginTop: 4 }}>
              {result.score}/{result.total} {result.passed ? '— banked!' : '— almost'}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12.5, marginTop: 2, textAlign: 'center' }}>
              {result.passed ? 'This module now glows on your journey path.' : 'Skim the content again and retake — you need 2 right.'}
            </Text>
          </View>
          {quiz.questions.map((q, i) => {
            const r = (result.results || []).find((x: any) => x.id === q.id);
            const ok = !!r?.ok;
            return (
              <View key={q.id} style={{ borderRadius: 10, borderWidth: 1, borderColor: ok ? (colors.green || '#22c55e') + '55' : (colors.red || '#ef4444') + '55', backgroundColor: ok ? (colors.greenBg || '#dcfce7') + '66' : (colors.redBg || '#fee2e2') + '55', padding: 10, marginBottom: 8 }}>
                <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '700', marginBottom: 3 }}>{i + 1}. {q.question}</Text>
                <Text style={{ color: ok ? (colors.green || '#166534') : (colors.red || '#b91c1c'), fontSize: 12, fontWeight: '700' }}>
                  {ok ? `✓ ${q.choices[r.chosen]}` : `✗ You picked: ${q.choices[r?.chosen] ?? '—'}`}
                </Text>
                {!ok && r && (
                  <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                    Correct: {q.choices[r.correct]}
                  </Text>
                )}
              </View>
            );
          })}
          <TouchableOpacity style={result.passed ? qz.ghost : qz.btn} onPress={start}>
            <Ionicons name="refresh" size={15} color={result.passed ? colors.textSecondary : '#fff'} />
            <Text style={result.passed ? qz.ghostText : qz.btnText}>Retake</Text>
          </TouchableOpacity>
        </>
      )}
    </Section>
  );
}

function Section({ title, children, colors }: { title: string; children: React.ReactNode; colors: any }) {
  const styles = createStyles(colors);
  const { effective } = useTheme();
  return (
    <DepthCard style={styles.section}>
      <View style={[styles.sectionHeadBar, { backgroundColor: effective === 'dark' ? colors.surfaceAlt : colors.surface }]}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.sectionRule} />
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </DepthCard>
  );
}
function BulletRow({ text, icon, colors }: { text: string; icon: any; colors: any }) {
  return (
    <View style={{ flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginBottom: 7 }}>
      <Ionicons name={icon} size={16} color={colors.primary} style={{ marginTop: 2 }} />
      <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: colors.text }}>{text}</Text>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // The screen's own header bar — OPAQUE by design (spec §2.5), now the
  // printed ink block. Children use inkText / inkMuted.
  header: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 18, backgroundColor: colors.ink },
  headerRule: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3 },
  cat: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.inkMuted, letterSpacing: 1.6, textTransform: 'uppercase' },
  // The module's name, printed in full (wraps — never truncated). Unbounded-Black
  // — never stack fontWeight on displayBlack.
  title: {
    fontFamily: fonts.displayBlack, fontSize: 24, lineHeight: 30,
    letterSpacing: -0.6, color: colors.inkText, marginTop: 6,
  },
  // Meta face under the title: mono, muted — a caption, not a headline.
  meta: { fontFamily: fonts.mono, fontSize: 12, color: colors.inkMuted, marginTop: 8, letterSpacing: 0.4 },
  completedPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    backgroundColor: colors.green || '#22c55e', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, marginTop: 10,
  },
  completedPillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  gradingBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    backgroundColor: colors.primary || '#244C3B', paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 14, marginTop: 8,
  },
  gradingBannerText: { color: colors.onPrimary, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  passOffWrap: { marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border },
  passOffBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.primary,
    paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10,
  },
  passOffBtnActive: { backgroundColor: colors.green || '#22c55e', borderColor: colors.green || '#22c55e' },
  passOffBtnText: { color: colors.primary, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
  passOffHelp: { fontSize: 11.5, color: colors.textMuted, marginTop: 8, lineHeight: 16, fontStyle: 'italic' },
  section: { marginTop: 14, marginHorizontal: 12, borderRadius: 18, overflow: 'hidden' },
  // The card's printed head tab. The fill is set per theme by <Section>:
  // `surfaceAlt` (#E4EBDB) is a hair off the light page field (#F0F4E9), so in
  // light the head read as a strip of background and the card looked like it
  // started at its white body. Light tints from the card face instead
  // (`surface`), dark keeps `surfaceAlt` (a real step up from the #102D25 face).
  sectionHeadBar: { paddingHorizontal: 14, paddingVertical: 13 },
  sectionRule: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2 },
  sectionTitle: { fontFamily: fonts.displayWide, fontSize: 12, color: colors.text, letterSpacing: 0.6 },
  sectionBody: { padding: 15 },
  bodyText: { fontFamily: fonts.body, fontSize: 14.5, lineHeight: 23, color: colors.text },
  scaleHelp: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18, color: colors.textSecondary, marginBottom: 10 },
  ladderBar: { marginBottom: 14 },
  ladderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  ladderRowDone: { opacity: 1 },
  ladderCircleNum: { fontFamily: fonts.displayWide, fontSize: 13, color: colors.textMuted },
  ladderLabel: { fontFamily: fonts.display, fontSize: 15, color: colors.text },
  ladderBlurb: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18, color: colors.textSecondary, marginTop: 2 },
  ladderMetChip: { backgroundColor: colors.primary + '1A', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2.5 },
  // Below the >=11px Unbounded floor (spec §2.4) — mono instead. `primary`
  // (not primaryDark) so the chip clears 4.5:1 in dark too: primaryDark
  // #2f6a4b on the dark card measured 2.7:1.
  ladderMetChipText: { fontFamily: fonts.monoSemibold, fontSize: 9.5, letterSpacing: 0.8, color: colors.primary },
  segBar: { marginHorizontal: 14, marginTop: 14 },
  readyBtn: { marginTop: 18, borderRadius: 14 },
  readyBtnText: { fontFamily: fonts.bodyBold, fontSize: 14.5, color: '#fff' },
  readyPending: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surfaceAlt, borderColor: colors.borderDark, borderWidth: 1, borderRadius: 14, padding: 13, marginTop: 16 },
  readyPendingText: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18, color: colors.text },
  wgllRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, paddingVertical: 8 },
  wgllBox: { marginTop: 1 },
  wgllText: { flex: 1, fontFamily: fonts.body, fontSize: 13.5, lineHeight: 20, color: colors.text },
  wgllTextChecked: { color: colors.textSecondary },
  ladderDate: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.textSecondary, textDecorationLine: 'underline' },
  ladderCoachTag: { fontFamily: fonts.mono, fontSize: 9.5, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8 },
  dimRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  dimHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dimLabel: { fontSize: 14, fontWeight: '800', color: colors.text },
  dimHelp: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  dimScorePill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 12, borderWidth: 1, minWidth: 40, alignItems: 'center' },
  dimScoreText: { fontWeight: '900', fontSize: 16 },
  pickerRow: { gap: 6, paddingVertical: 8, paddingHorizontal: 2 },
  pickerCell: { width: 34, height: 34, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  pickerCellText: { color: colors.text, fontWeight: '700' },
  bandTag: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4, alignSelf: 'flex-end', marginTop: 2 },
  notesLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginBottom: 6 },
  notes: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, minHeight: 80, padding: 12, color: colors.text, backgroundColor: colors.background, fontSize: 14, textAlignVertical: 'top' },
  lastSaved: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 10, fontStyle: 'italic' },
  btn: { backgroundColor: colors.primary, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  btnText: { color: colors.onPrimary, fontWeight: '800' },
  // Locked-dim chip + helper box (leader self-rating Stage 3 — Consistency / Independence)
  dimLockChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: colors.background,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
    borderWidth: 1, borderColor: colors.border,
  },
  dimLockChipText: { fontSize: 9, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.3 },
  dimLockedBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.background,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
    marginTop: 8, marginBottom: 2,
  },
  dimLockedHint: { flex: 1, color: colors.textSecondary, fontSize: 11.5, lineHeight: 16, fontStyle: 'italic' },
  // Self-rate-Stage-3 explainer banner
  selfRateBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: (colors.primary || '#244C3B') + '14',
    borderWidth: 1, borderColor: (colors.primary || '#244C3B') + '33',
    padding: 10, borderRadius: 10, marginBottom: 12,
  },
  selfRateBannerText: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.primary, fontWeight: '600' },
});
