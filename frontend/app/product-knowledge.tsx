/**
 * Campaign Knowledge — the office playbook (route: /product-knowledge).
 *
 * A self-serve learning experience:
 *   • HUB    — optional lessons + final exam + the playbook library
 *   • LESSON — click-through cards with pop-quiz checks + instant feedback
 *   • EXAM   — the backend exam (up to 12 questions, capstone)
 *   • RESULT — score + per-question review, leader pass-off unchanged
 *
 * Available to everyone from day one. Lessons are a static bundle in
 * src/pk/lessons.ts (ships empty). Playbook topics come from the backend
 * (seeded from backend/seed/product_knowledge_topics.json on a fresh
 * database), grouped by their category in the seeded order; bodies are
 * markdown rendered by src/pk/MarkdownBody. Exam questions start empty, so
 * the exam shows its not-set-up state until an admin adds some. Lesson
 * progress persists locally (AsyncStorage).
 */
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { showAlert } from '../src/utils/showAlert';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiService } from '../src/api/client';
import { useColors, useTheme, fonts } from '../src/theme/ThemeContext';
import TapToRefresh from '../src/components/web/TapToRefresh';
import { GRADIENT, GRADIENT_TEXT, GRADIENT_XP } from '../src/theme/brand';
import { haptics } from '../src/utils/haptics';
import { Stagger, Reveal } from '../src/components/ui/Reveal';
import { ConfettiCelebration, ConfettiCelebrationHandle } from '../src/components/ui/ConfettiCelebration';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { StreakFlame } from '../src/components/ui/StreakFlame';
import { useParallaxScroll } from '../src/components/ui/Parallax';
// ── "Ink & Cube" visual system (spec §3) ────────────────────────────────────
import { Masthead } from '../src/components/nav/Masthead';
import { DepthCard } from '../src/components/ui/DepthCard';
import { EditorialHero } from '../src/components/ui/EditorialHero';
import { SectionHead } from '../src/components/ui/SectionHead';
import { XPBar } from '../src/components/ui/XPBar';
import { GlowButton } from '../src/components/ui/GlowButton';
import { HexCoin } from '../src/components/ui/HexCoin';
import { GradientText } from '../src/components/ui/GradientText';
import { recordLearningActivity } from '../src/gamification/streak';
import { LESSONS, Lesson, LessonCard, QuizCard, TOTAL_MINUTES } from '../src/pk/lessons';
import { MarkdownBody } from '../src/pk/MarkdownBody';
import { useTabBarClearance } from '../src/customization/CustomTabBar';

type Topic = {
  id: string; slug: string; title: string; category: string;
  summary: string; body: string; key_facts: string[];
  source_url?: string; order?: number;
};
type Question = {
  id: string; topic_slug?: string; kind: 'mc' | 'tf';
  question: string; choices: string[];
};
type Status = {
  is_visible: boolean;
  is_admin: boolean;
  is_trainee: boolean;
  day2_passed: boolean | null;
  latest_attempt: any | null;
  topic_count: number;
  question_count: number;
};
type GradedAnswer = {
  question_id: string; topic_slug?: string;
  question: string; kind: 'mc' | 'tf';
  response: any; correct: boolean;
  correct_index?: number; correct_answer?: boolean;
  explanation?: string; choices?: string[];
};

// ── Local lesson progress ────────────────────────────────────────────────────
type LessonProgress = Record<string, { done: boolean; correct: number; total: number }>;
const PROGRESS_KEY = 'cg1.pk.lessonProgress';

export default function ProductKnowledgeScreen() {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ start?: string }>();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [mode, setMode] = useState<'hub' | 'lesson' | 'exam' | 'result'>('hub');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [expandedTopic, setExpandedTopic] = useState<string | null>(null);
  // With no lessons bundled, the playbook IS the page — start it open.
  const [libraryOpen, setLibraryOpen] = useState(LESSONS.length === 0);

  // Lesson state
  const [activeLesson, setActiveLesson] = useState<Lesson | null>(null);
  const [progress, setProgress] = useState<LessonProgress>({});

  // Exam state
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [currentIdx, setCurrentIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Result state
  const [resultScore, setResultScore] = useState<{ correct: number; total: number; pct: number } | null>(null);
  const [resultAnswers, setResultAnswers] = useState<GradedAnswer[]>([]);

  const loadAll = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        apiService.productKnowledgeStatus(),
        apiService.productKnowledgeTopics().catch(() => ({ data: { topics: [] } })),
      ]);
      setStatus(s.data);
      setTopics(t.data?.topics || []);
    } catch (e: any) {
      showAlert('Failed to load', e?.response?.data?.detail || e?.message || '');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  // Load persisted lesson progress
  useEffect(() => {
    AsyncStorage.getItem(PROGRESS_KEY).then((v) => {
      if (v) try { setProgress(JSON.parse(v)); } catch {}
    }).catch(() => {});
  }, []);

  const recordLessonDone = useCallback((lessonId: string, correct: number, total: number) => {
    setProgress((prev) => {
      const next = { ...prev, [lessonId]: { done: true, correct, total } };
      AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  // Any learning action (quiz answer, lesson finish, exam submit) feeds the
  // daily streak flame. No milestone celebrations or badges by design —
  // rewarding consecutive-day activity would incentivize never taking a day
  // off (owner call); the flame chip stays a quiet personal marker.
  const logLearning = useCallback(async () => {
    try {
      await recordLearningActivity();
    } catch { /* streak is best-effort */ }
  }, []);

  // Auto-start exam if route param ?start=1
  useEffect(() => {
    if (!loading && params?.start === '1' && mode === 'hub') {
      void startExam();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, params?.start]);

  const startExam = async () => {
    haptics.medium();
    try {
      setLoading(true);
      const { data } = await apiService.productKnowledgeStartExam();
      setAttemptId(data.attempt_id);
      setQuestions(data.questions || []);
      setAnswers({});
      setCurrentIdx(0);
      setMode('exam');
    } catch (e: any) {
      showAlert('Failed to start exam', e?.response?.data?.detail || e?.message || '');
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    if (!attemptId) return;
    setSubmitting(true);
    try {
      const payload = questions.map((q) => ({
        question_id: q.id,
        response: q.kind === 'tf' ? !!answers[q.id] : Number(answers[q.id] ?? -1),
      }));
      const { data } = await apiService.productKnowledgeSubmitExam(attemptId, payload);
      setResultScore({
        correct: data.score_correct,
        total: data.score_total,
        pct: data.score_pct,
      });
      setResultAnswers(data.answers || []);
      setMode('result');
      haptics.success();
      void logLearning();
      void loadAll();
    } catch (e: any) {
      showAlert('Submit failed', e?.response?.data?.detail || e?.message || '');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && mode === 'hub' && !status) {
    return (
      <SafeAreaView style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]}>
        <BrandLoader size={60} label="Loading the playbook" />
      </SafeAreaView>
    );
  }

  const doneCount = LESSONS.filter((l) => progress[l.id]?.done).length;

  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right']}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Header — the app-wide editorial masthead (this route hides the
          navigator header, so it mounts the standalone variant itself). */}
      <Masthead
        standalone
        title="Campaign Knowledge"
        onBack={() => (mode === 'hub' ? router.back() : setMode('hub'))}
        right={mode === 'hub' ? (
          <TouchableOpacity onPress={loadAll} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="refresh" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      />
      <View style={styles.subheader}>
        <Text style={styles.subtitle}>
          {mode === 'hub' && (LESSONS.length > 0
            ? `${doneCount}/${LESSONS.length} lessons · ~${TOTAL_MINUTES} min total`
            : `${status?.topic_count ?? topics.length} playbook topics`)}
          {mode === 'lesson' && (activeLesson?.title ?? '')}
          {mode === 'exam' && `Question ${currentIdx + 1} of ${questions.length}`}
          {mode === 'result' && 'Your score'}
        </Text>
      </View>

      {mode === 'hub' && (
        <HubView
          status={status}
          topics={topics}
          progress={progress}
          isDark={isDark}
          expandedTopic={expandedTopic}
          setExpandedTopic={setExpandedTopic}
          libraryOpen={libraryOpen}
          setLibraryOpen={setLibraryOpen}
          onOpenLesson={(l: Lesson) => { haptics.light(); setActiveLesson(l); setMode('lesson'); }}
          onStartExam={startExam}
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); void loadAll(); }}
          colors={colors}
        />
      )}

      {mode === 'lesson' && activeLesson && (
        <LessonView
          lesson={activeLesson}
          colors={colors}
          isDark={isDark}
          insetsBottom={insets.bottom}
          onExit={() => setMode('hub')}
          onActivity={logLearning}
          onComplete={(correct: number, total: number) => {
            recordLessonDone(activeLesson.id, correct, total);
            void logLearning();
          }}
        />
      )}

      {mode === 'exam' && (
        <ExamView
          questions={questions}
          currentIdx={currentIdx}
          setCurrentIdx={setCurrentIdx}
          answers={answers}
          setAnswers={setAnswers}
          onSubmit={submit}
          submitting={submitting}
          colors={colors}
          insetsBottom={insets.bottom}
        />
      )}

      {mode === 'result' && resultScore && (
        <ResultView
          score={resultScore}
          answers={resultAnswers}
          onRetake={() => { setMode('hub'); setExpandedTopic(null); }}
          onDone={() => router.back()}
          colors={colors}
        />
      )}
    </SafeAreaView>
  );
}


// ────────────────────── Hub view ───────────────────────────────────────────
function HubView({
  status, topics, progress, isDark, expandedTopic, setExpandedTopic,
  libraryOpen, setLibraryOpen, onOpenLesson, onStartExam, refreshing, onRefresh, colors,
}: any) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const latest = status?.latest_attempt;
  const doneCount = LESSONS.filter((l) => progress[l.id]?.done).length;
  const hasLessons = LESSONS.length > 0;
  const allDone = hasLessons && doneCount === LESSONS.length;
  // The backend exam needs at least 4 questions in the bank.
  const examReady = (status?.question_count ?? 0) >= 4;
  const examLength = Math.min(12, status?.question_count ?? 12);
  const { scrollY, onScroll } = useParallaxScroll();
  const tabBarClearance = useTabBarClearance();
  // Topics arrive sorted by `order`; group them by category in first-seen
  // order. Admin edits lower-case the category, so match case-insensitively.
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: Topic[] }[] = [];
    const at: Record<string, number> = {};
    for (const t of (topics || []) as Topic[]) {
      const label = (t.category || 'General').trim() || 'General';
      const key = label.toLowerCase();
      if (at[key] === undefined) { at[key] = out.length; out.push({ key, label, items: [] }); }
      out[at[key]].items.push(t);
    }
    return out;
  }, [topics]);

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, paddingBottom: 100 + tabBarClearance }}
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      <Stagger>
      {/* web fallback: RefreshControl's pull gesture is a no-op with a mouse */}
      <TapToRefresh onPress={onRefresh} busy={refreshing} label="Refresh" />
      {/* Hero — full-bleed ink block with the live brand cube (spec §3.5) */}
      <EditorialHero
        variant="ink"
        scrollY={scrollY}
        cube={{ size: 148 }}
        kicker={(
          <View style={styles.heroKickerRow}>
            <Text style={styles.heroKicker}>CAMPAIGN KNOWLEDGE</Text>
            <StreakFlame compact />
          </View>
        )}
        title={(
          <GradientText
            colors={GRADIENT_TEXT}
            numberOfLines={3}
            style={styles.heroTitle}
          >
            {'Your campaign\nplaybook'}
          </GradientText>
        )}
        lede={hasLessons
          ? 'Short lessons on the campaign and how to talk about it. Then prove it on the exam.'
          : 'The pitch, the quality standards, the Welcome Call and the Cycle of Development — all in one place.'}
      >
        {hasLessons && (
        <View style={styles.heroProgressRow}>
          <XPBar
            value={Math.max(0.04, doneCount / LESSONS.length)}
            height={12}
            // tip stays (the one glowing tip on the hub); glow gates the
            // ShineSweep loop — off to stay inside the 6-loop budget.
            glow={false}
            style={{ flex: 1 }}
          />
          <Text style={styles.heroProgressText}>{doneCount}/{LESSONS.length}</Text>
        </View>
        )}
      </EditorialHero>

      {/* Lessons (only when the bundle has any) */}
      {hasLessons && <SectionHead style={styles.sectionHead}>LESSONS</SectionHead>}
      {hasLessons && (
      <View style={{ gap: 10 }}>
        {LESSONS.map((l, i) => {
          const p = progress[l.id];
          const quizCount = l.cards.filter((c) => c.kind === 'quiz').length;
          return (
            <DepthCard key={l.id} index={i} sheen={false} style={styles.lessonCardWrap}>
              <TouchableOpacity style={styles.lessonCard} activeOpacity={0.8} onPress={() => onOpenLesson(l)}>
                <HexCoin size={46} tint={p?.done ? 'gold' : 'purple'} animate={false}>
                  <Ionicons
                    name={(p?.done ? 'checkmark' : l.icon) as any}
                    size={19}
                    color={p?.done ? '#150a26' : '#ffffff'}
                  />
                </HexCoin>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.lessonTitle}>{i + 1}. {l.title}</Text>
                  <Text style={styles.lessonSub} numberOfLines={1}>{l.subtitle}</Text>
                  <View style={styles.lessonMetaRow}>
                    <View style={styles.metaChip}>
                      <Ionicons name="time-outline" size={11} color={colors.textMuted} />
                      <Text style={styles.metaChipText}>{l.minutes} min</Text>
                    </View>
                    <View style={styles.metaChip}>
                      <Ionicons name="help-circle-outline" size={11} color={colors.textMuted} />
                      <Text style={styles.metaChipText}>{quizCount} checks</Text>
                    </View>
                    {p?.done && (
                      <View style={[styles.metaChip, { backgroundColor: '#10b98118' }]}>
                        <Text style={[styles.metaChipText, { color: '#10b981' }]}>{p.correct}/{p.total} correct</Text>
                      </View>
                    )}
                  </View>
                </View>
                <Ionicons name={p?.done ? 'refresh' : 'play'} size={18} color={colors.primary} />
              </TouchableOpacity>
            </DepthCard>
          );
        })}
      </View>
      )}

      {/* Final exam */}
      <SectionHead style={styles.sectionHead}>FINAL EXAM</SectionHead>
      <DepthCard variant="ink" edge="gradient" style={styles.examCard}>
        <View style={styles.examTopRow}>
          <View style={styles.examIcon}>
            <Ionicons name="trophy" size={22} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.examTitle}>{examReady ? `${examLength}-question exam` : 'Final exam'}</Text>
            <Text style={styles.examSub}>
              {!examReady
                ? 'Not set up yet — your admin adds the exam questions.'
                : latest?.submitted_at
                  ? `Last score: ${latest.score_pct}%${latest.passed_off ? ' · Passed off ✓' : ''}`
                  : !hasLessons
                    ? 'Read the playbook first for your best shot.'
                    : allDone
                      ? 'Lessons done — you’re ready.'
                      : 'Finish the lessons first for your best shot.'}
            </Text>
          </View>
        </View>
        {examReady && (
        <GlowButton onPress={onStartExam} sheen={false} style={styles.examBtn}>
          {latest?.submitted_at ? 'Retake' : 'Start'}
        </GlowButton>
        )}
      </DepthCard>

      {/* The playbook library — grouped by category, in the seeded order */}
      <TouchableOpacity style={styles.libraryToggle} onPress={() => setLibraryOpen(!libraryOpen)} activeOpacity={0.7}>
        <Ionicons name="library-outline" size={16} color={colors.textMuted} />
        <Text style={styles.libraryToggleText}>
          Playbook ({status?.topic_count ?? topics.length} topics)
        </Text>
        <Ionicons name={libraryOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
      </TouchableOpacity>
      {libraryOpen && topics.length === 0 && (
        <Text style={[styles.examSub, { marginTop: 8, color: colors.textMuted }]}>
          No playbook topics yet — your admin adds them.
        </Text>
      )}
      {libraryOpen && topics.length > 0 && (
        <View style={{ marginTop: 8 }}>
          {groups.map((g) => (
          <View key={g.key}>
          <Text style={styles.groupHead}>{g.label.toUpperCase()} · {g.items.length}</Text>
          {g.items.map((t: Topic) => {
            const expanded = expandedTopic === t.id;
            return (
              <View key={t.id} style={styles.topicCard}>
                <TouchableOpacity
                  onPress={() => setExpandedTopic(expanded ? null : t.id)}
                  activeOpacity={0.7}
                  style={styles.topicHeader}
                >
                  <View style={[styles.topicIcon, { backgroundColor: `${colors.primary}1a` }]}>
                    <Ionicons name="book" size={16} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.topicTitle} numberOfLines={2}>{t.title}</Text>
                    {!!t.summary && !expanded && (
                      <Text style={styles.topicSummary} numberOfLines={1}>{t.summary}</Text>
                    )}
                  </View>
                  <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
                </TouchableOpacity>
                {expanded && (
                  <View style={styles.topicBody}>
                    {t.summary ? <Text style={styles.bodySummary}>{t.summary}</Text> : null}
                    {t.key_facts?.length > 0 && (
                      <View style={styles.factsBox}>
                        <Text style={styles.factsLabel}>KEY FACTS</Text>
                        {t.key_facts.map((kf, i) => (
                          <View key={i} style={styles.factRow}>
                            <View style={[styles.factDot, { backgroundColor: colors.primary }]} />
                            <Text style={styles.factText}>{kf}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                    {t.body ? <MarkdownBody text={t.body} colors={colors} title={t.title} /> : null}
                  </View>
                )}
              </View>
            );
          })}
          </View>
          ))}
        </View>
      )}
      </Stagger>
    </ScrollView>
  );
}


// ────────────────────── Lesson player ──────────────────────────────────────
function LessonView({ lesson, colors, isDark, insetsBottom, onExit, onActivity, onComplete }: any) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tabBarClearance = useTabBarClearance();
  const [idx, setIdx] = useState(0);
  const [finished, setFinished] = useState(false);
  // Per-quiz state: chosen index (null until answered)
  const [chosen, setChosen] = useState<Record<number, number>>({});
  const correctRef = useRef(0);
  const confettiRef = useRef<ConfettiCelebrationHandle>(null);
  const quizTotal = (lesson.cards as LessonCard[]).filter((c) => c.kind === 'quiz').length;

  // Confetti burst when the lesson completes
  useEffect(() => {
    if (finished) confettiRef.current?.fire();
  }, [finished]);

  const card: LessonCard = lesson.cards[idx];
  const isQuiz = card.kind === 'quiz';
  const answered = isQuiz ? chosen[idx] !== undefined : true;
  const isLast = idx === lesson.cards.length - 1;

  const choose = (choiceIdx: number) => {
    if (chosen[idx] !== undefined) return; // lock after first answer
    haptics.light();
    const q = card as QuizCard;
    if (choiceIdx === q.correctIndex) {
      correctRef.current += 1;
      haptics.success();
    }
    setChosen({ ...chosen, [idx]: choiceIdx });
    onActivity?.(); // every answered check keeps today's streak alive
  };

  const next = () => {
    haptics.light();
    if (isLast) {
      onComplete(correctRef.current, quizTotal);
      setFinished(true);
    } else {
      setIdx(idx + 1);
    }
  };

  if (finished) {
    const correct = correctRef.current;
    const perfect = correct === quizTotal;
    return (
      <View style={{ flex: 1 }}>
        <ConfettiCelebration ref={confettiRef} />
        <View style={[styles.doneWrap, { paddingBottom: tabBarClearance + 24 }]}>
          <Reveal index={0}>
            <HexCoin size={104} tint={perfect ? 'gold' : 'purple'} animate glow style={{ alignSelf: 'center' }}>
              <Ionicons name={perfect ? 'trophy' : 'checkmark-circle'} size={40} color={perfect ? '#150a26' : '#fff'} />
            </HexCoin>
          </Reveal>
          <Reveal index={1}>
            <Text style={styles.doneTitle}>Lesson complete!</Text>
          </Reveal>
          <Reveal index={2}>
            <Text style={styles.doneScore}>
              {quizTotal > 0 ? `${correct}/${quizTotal} checks correct` : 'Nice work'}
              {perfect && quizTotal > 0 ? ' — perfect!' : ''}
            </Text>
          </Reveal>
          <Reveal index={3}>
            <GlowButton onPress={onExit} sheen={false} style={styles.doneBtn}>
              <Text style={styles.doneBtnText}>Back to lessons</Text>
            </GlowButton>
          </Reveal>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
        {/* Progress dots */}
        <View style={styles.dotRow}>
          {(lesson.cards as LessonCard[]).map((c, i) => (
            i === idx ? (
              <LinearGradient
                key={i}
                colors={GRADIENT_XP}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={[styles.dot, styles.dotActive]}
              />
            ) : (
              <View
                key={i}
                style={[styles.dot, i < idx && { backgroundColor: colors.primary }]}
              />
            )
          ))}
        </View>

        {card.kind === 'info' ? (
          <Reveal key={idx} index={0}>
            <DepthCard edge="gradient" style={styles.infoCard}>
              <Text style={styles.infoTitle}>{card.title}</Text>
              <View style={{ gap: 12, marginTop: 14 }}>
                {card.points.map((p, i) => (
                  <View key={i} style={styles.pointRow}>
                    <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.pointDot} />
                    <Text style={styles.pointText}>{p}</Text>
                  </View>
                ))}
              </View>
              {card.sayIt ? (
                <View style={styles.sayItBox}>
                  <Text style={styles.sayItLabel}>SAY IT AT THE DOOR</Text>
                  <Text style={styles.sayItText}>{card.sayIt}</Text>
                </View>
              ) : null}
            </DepthCard>
          </Reveal>
        ) : (
          <Reveal key={idx} index={0}>
            <DepthCard edge="gradient" style={styles.infoCard}>
              <Text style={styles.quizKicker}>QUICK CHECK</Text>
              <Text style={styles.infoTitle}>{(card as QuizCard).question}</Text>
              <View style={{ gap: 10, marginTop: 16 }}>
                {(card as QuizCard).choices.map((c, i) => {
                  const q = card as QuizCard;
                  const picked = chosen[idx];
                  const isPicked = picked === i;
                  const revealed = picked !== undefined;
                  const isCorrect = i === q.correctIndex;
                  return (
                    <TouchableOpacity
                      key={i}
                      onPress={() => choose(i)}
                      disabled={revealed}
                      style={[
                        styles.choice,
                        revealed && isCorrect && { borderColor: '#10b981', backgroundColor: '#10b98115' },
                        revealed && isPicked && !isCorrect && { borderColor: '#ef4444', backgroundColor: '#ef444415' },
                      ]}
                    >
                      <View style={[
                        styles.radioOuter,
                        revealed && isCorrect && { borderColor: '#10b981', backgroundColor: '#10b981' },
                        revealed && isPicked && !isCorrect && { borderColor: '#ef4444', backgroundColor: '#ef4444' },
                      ]}>
                        {revealed && isCorrect && <Ionicons name="checkmark" size={12} color="#fff" />}
                        {revealed && isPicked && !isCorrect && <Ionicons name="close" size={12} color="#fff" />}
                      </View>
                      <Text style={styles.choiceText}>{c}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {answered && (
                <View style={[
                  styles.explainBox,
                  { borderColor: chosen[idx] === (card as QuizCard).correctIndex ? '#10b98155' : '#ef444455' },
                ]}>
                  <Ionicons
                    name={chosen[idx] === (card as QuizCard).correctIndex ? 'checkmark-circle' : 'information-circle'}
                    size={16}
                    color={chosen[idx] === (card as QuizCard).correctIndex ? '#10b981' : '#ef4444'}
                  />
                  <Text style={styles.explainText}>{(card as QuizCard).explanation}</Text>
                </View>
              )}
            </DepthCard>
          </Reveal>
        )}
      </ScrollView>

      {/* Bottom nav */}
      <View style={[styles.examNav, { paddingBottom: 8 + tabBarClearance }]}>
        <TouchableOpacity
          onPress={() => setIdx(Math.max(0, idx - 1))}
          disabled={idx === 0}
          style={[styles.navBtn, idx === 0 && { opacity: 0.4 }]}
        >
          <Ionicons name="chevron-back" size={18} color={colors.text} />
          <Text style={styles.navBtnText}>Back</Text>
        </TouchableOpacity>
        <GlowButton onPress={next} disabled={!answered} style={styles.navGlowBtn}>
          <Text style={styles.navBtnPrimaryText}>{isLast ? 'Finish lesson' : isQuiz ? 'Continue' : 'Got it'}</Text>
          <Ionicons name={isLast ? 'checkmark' : 'chevron-forward'} size={18} color="#fff" />
        </GlowButton>
      </View>
    </View>
  );
}


// ────────────────────── Exam view ──────────────────────────────────
function ExamView({ questions, currentIdx, setCurrentIdx, answers, setAnswers, onSubmit, submitting, colors, insetsBottom }: any) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tabBarClearance = useTabBarClearance();
  const q: Question = questions[currentIdx];
  if (!q) return null;
  const isAnswered = answers[q.id] !== undefined;
  const isLast = currentIdx === questions.length - 1;
  const allAnswered = questions.every((qq: Question) => answers[qq.id] !== undefined);
  const choose = (val: any) => {
    haptics.light();
    setAnswers({ ...answers, [q.id]: val });
  };
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
        {/* Progress */}
        <XPBar value={(currentIdx + 1) / questions.length} height={8} animateOnEnter={false} glow={false} />
        <Text style={styles.qNum}>QUESTION {currentIdx + 1} / {questions.length}</Text>
        <Text style={styles.qText}>{q.question}</Text>

        {/* Choices */}
        <View style={{ gap: 10, marginTop: 14 }}>
          {q.kind === 'tf' ? (
            ['True', 'False'].map((label, idx) => {
              const val = idx === 0;
              const selected = answers[q.id] === val;
              return (
                <TouchableOpacity
                  key={label}
                  onPress={() => choose(val)}
                  style={[styles.choice, selected && { borderColor: colors.primary, backgroundColor: `${colors.primary}10` }]}
                >
                  <View style={[styles.radioOuter, selected && { borderColor: colors.primary, backgroundColor: colors.primary }]}>
                    {selected && <Ionicons name="checkmark" size={12} color={colors.onPrimary} />}
                  </View>
                  <Text style={styles.choiceText}>{label}</Text>
                </TouchableOpacity>
              );
            })
          ) : (
            q.choices.map((c, idx) => {
              const selected = answers[q.id] === idx;
              return (
                <TouchableOpacity
                  key={idx}
                  onPress={() => choose(idx)}
                  style={[styles.choice, selected && { borderColor: colors.primary, backgroundColor: `${colors.primary}10` }]}
                >
                  <View style={[styles.radioOuter, selected && { borderColor: colors.primary, backgroundColor: colors.primary }]}>
                    {selected && <Ionicons name="checkmark" size={12} color={colors.onPrimary} />}
                  </View>
                  <Text style={styles.choiceText}>{c}</Text>
                </TouchableOpacity>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* Bottom nav */}
      <View style={[styles.examNav, { paddingBottom: 8 + tabBarClearance }]}>
        <TouchableOpacity
          onPress={() => setCurrentIdx(Math.max(0, currentIdx - 1))}
          disabled={currentIdx === 0}
          style={[styles.navBtn, currentIdx === 0 && { opacity: 0.4 }]}
        >
          <Ionicons name="chevron-back" size={18} color={colors.text} />
          <Text style={styles.navBtnText}>Back</Text>
        </TouchableOpacity>
        {!isLast ? (
          <GlowButton
            onPress={() => setCurrentIdx(currentIdx + 1)}
            disabled={!isAnswered}
            sheen={false}
            style={styles.navGlowBtn}
          >
            <Text style={styles.navBtnPrimaryText}>Next</Text>
            <Ionicons name="chevron-forward" size={18} color="#fff" />
          </GlowButton>
        ) : (
          <GlowButton
            onPress={onSubmit}
            disabled={!allAnswered || submitting}
            sheen={false}
            style={styles.navGlowBtn}
          >
            {submitting ? <ActivityIndicator color="#fff" size="small" /> : (
              <>
                <Text style={styles.navBtnPrimaryText}>Submit</Text>
                <Ionicons name="checkmark" size={18} color="#fff" />
              </>
            )}
          </GlowButton>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}


// ────────────────────── Result view ────────────────────────────────
function ResultView({ score, answers, onRetake, onDone, colors }: any) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tabBarClearance = useTabBarClearance();
  const passed = score.pct >= 80;
  const confettiRef = useRef<ConfettiCelebrationHandle>(null);
  useEffect(() => {
    if (passed) confettiRef.current?.fire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: tabBarClearance + 24 }}>
      {passed && <ConfettiCelebration ref={confettiRef} />}
      <DepthCard fill={passed ? '#10b981' : '#f59e0b'} style={styles.scoreCard}>
        <Ionicons name={passed ? 'trophy' : 'analytics'} size={36} color="#fff" />
        <Text style={styles.scoreTitle}>{score.pct}%</Text>
        <Text style={styles.scoreSub}>{score.correct} of {score.total} correct</Text>
        <Text style={styles.scoreNote}>
          {passed ? 'Nice work — share with your coach for pass-off.' : 'Below 80% — run back through the playbook and retake when ready.'}
        </Text>
      </DepthCard>

      <SectionHead style={styles.sectionHead}>REVIEW</SectionHead>
      {answers.map((a: GradedAnswer, i: number) => (
        <DepthCard key={a.question_id} sheen={false} index={i} style={[styles.answerCard, { borderColor: a.correct ? '#10b98155' : '#dc262655' }]}>
          <View style={styles.answerHeader}>
            <View style={[styles.answerBadge, { backgroundColor: a.correct ? '#10b98115' : '#dc262615' }]}>
              <Ionicons name={a.correct ? 'checkmark' : 'close'} size={14} color={a.correct ? '#10b981' : '#dc2626'} />
            </View>
            <Text style={styles.answerNum}>Q{i + 1}</Text>
          </View>
          <Text style={styles.answerQ}>{a.question}</Text>
          <Text style={styles.answerLine}>
            <Text style={styles.answerKey}>Your answer: </Text>
            {a.kind === 'tf'
              ? (a.response ? 'True' : 'False')
              : (a.choices?.[a.response] ?? '—')}
          </Text>
          {!a.correct && (
            <Text style={[styles.answerLine, { color: '#10b981' }]}>
              <Text style={styles.answerKey}>Correct: </Text>
              {a.kind === 'tf'
                ? (a.correct_answer ? 'True' : 'False')
                : (a.choices?.[a.correct_index ?? -1] ?? '—')}
            </Text>
          )}
          {a.explanation ? <Text style={styles.answerExp}>{a.explanation}</Text> : null}
        </DepthCard>
      ))}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <TouchableOpacity onPress={onRetake} style={[styles.outlineBtn, { borderColor: colors.border }]}>
          <Ionicons name="refresh" size={16} color={colors.text} />
          <Text style={styles.outlineBtnText}>Back to lessons</Text>
        </TouchableOpacity>
        <GlowButton onPress={onDone} sheen={false} style={styles.primaryBtn}>
          <Text style={styles.primaryBtnText}>Done</Text>
        </GlowButton>
      </View>
    </ScrollView>
  );
}


const createStyles = (colors: any) => StyleSheet.create({
  screen: { flex: 1 },
  // Mode line under the masthead — mono kicker on the page field.
  subheader: { paddingHorizontal: 18, paddingTop: 6, paddingBottom: 4 },
  subtitle: {
    fontFamily: fonts.mono, fontSize: 10.5, color: colors.textMuted,
    letterSpacing: 1.4, textTransform: 'uppercase',
  },

  // Hub hero (EditorialHero ink block)
  // flex-start (NOT space-between): the hero cube is drawn at the block's right
  // edge, so a pushed-right StreakFlame lands on its front face.
  heroKickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 10 },
  heroKicker: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.inkMuted, letterSpacing: 1.8 },
  // The authored copy is two lines ('Your campaign\nplaybook'), but on web
  // GradientText draws a raw <span> (GradientText.web.tsx) so the \n collapses
  // to a space and the line box does the breaking. At 28px / -1.4 in the
  // hero's 326px column, 'Your campaign' (13 chars) fits on line one and the
  // free wrap lands on the authored break (the old 17-char 'Learn the
  // product' measured 303.8px). numberOfLines stays 3 on the GradientText as
  // a net, so a wider face re-wraps instead of truncating.
  // Never stack fontWeight on displayBlack.
  heroTitle: { fontFamily: fonts.displayBlack, fontSize: 28, lineHeight: 33, letterSpacing: -1.4, marginTop: 10 },
  heroProgressRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18 },
  heroProgressText: { fontFamily: fonts.mono, fontSize: 13, fontWeight: '700', color: colors.inkText },

  // Lesson cards
  lessonCardWrap: { borderRadius: 18 },
  lessonCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13 },
  lessonTitle: { fontFamily: fonts.display, fontSize: 14.5, fontWeight: '800', color: colors.text },
  lessonSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  lessonMetaRow: { flexDirection: 'row', gap: 6, marginTop: 7, flexWrap: 'wrap' },
  metaChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 999, backgroundColor: colors.surfaceAlt,
  },
  metaChipText: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted, fontWeight: '600' },

  // Final exam — ink block with a gradient rim and the screen's primary CTA
  examCard: { borderRadius: 20, padding: 16, gap: 14 },
  examTopRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  examIcon: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
  },
  examTitle: { fontFamily: fonts.display, color: colors.inkText, fontSize: 16, fontWeight: '900' },
  examSub: { color: colors.inkMuted, fontSize: 12, marginTop: 3, lineHeight: 17 },
  examBtn: { alignSelf: 'stretch', borderRadius: 14 },

  // Reference library
  libraryToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 22,
    paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
  },
  libraryToggleText: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.textMuted },

  primaryBtn: { flex: 1, borderRadius: 12, paddingVertical: 12 },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  outlineBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12, borderWidth: 1, backgroundColor: colors.background },
  outlineBtnText: { color: colors.text, fontSize: 14, fontWeight: '700' },

  sectionHead: { marginTop: 26, marginBottom: 12 },

  topicCard: { backgroundColor: colors.background, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 8 },
  topicHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  topicIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  topicTitle: { fontSize: 14, fontWeight: '800', color: colors.text },
  topicSummary: { fontSize: 12, color: colors.textSecondary, marginTop: 3, lineHeight: 16 },
  groupHead: {
    fontFamily: fonts.mono, fontSize: 10.5, fontWeight: '700', color: colors.primary,
    letterSpacing: 1.2, marginTop: 14, marginBottom: 8,
  },
  topicBody: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 12, paddingTop: 12, gap: 12 },
  bodySummary: { fontSize: 13, color: colors.text, fontWeight: '600', lineHeight: 19 },

  factsBox: { backgroundColor: colors.surfaceAlt, padding: 10, borderRadius: 10, gap: 6 },
  factsLabel: { fontSize: 10, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.5 },
  factRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  factDot: { width: 5, height: 5, borderRadius: 3, marginTop: 7 },
  factText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 18, fontWeight: '600' },

  // Lesson player
  dotRow: { flexDirection: 'row', gap: 6, justifyContent: 'center', marginBottom: 16 },
  // borderDark, not trackBg: trackBg is tuned to sit INSIDE an XPBar track on a
  // card; directly on the page field it left the un-visited dots at ~1.03:1
  // (measured), so "3 of 6" read as "3 dots". borderDark is the firm read.
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.borderDark },
  dotActive: { width: 24, borderRadius: 4 },
  infoCard: { borderRadius: 20, padding: 20 },
  infoTitle: { fontFamily: fonts.display, fontSize: 20, fontWeight: '900', color: colors.text, lineHeight: 26 },
  pointRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  pointDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  pointText: { flex: 1, fontSize: 14.5, color: colors.text, lineHeight: 21, fontWeight: '500' },
  sayItBox: {
    marginTop: 16, padding: 12, borderRadius: 12,
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.primary + '33',
  },
  sayItLabel: { fontFamily: fonts.mono, fontSize: 9, fontWeight: '700', color: colors.primary, letterSpacing: 1.5 },
  sayItText: { fontSize: 13.5, color: colors.text, fontStyle: 'italic', lineHeight: 19, marginTop: 5 },
  quizKicker: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.primary, letterSpacing: 1.5, marginBottom: 8 },
  explainBox: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start',
    marginTop: 14, padding: 12, borderRadius: 12, borderWidth: 1,
    backgroundColor: colors.surfaceAlt,
  },
  explainText: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 19 },

  // Lesson complete
  doneWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  doneTitle: { fontFamily: fonts.displayBlack, fontSize: 26, color: colors.text, marginTop: 20, textAlign: 'center', letterSpacing: -0.6 },
  doneScore: { fontFamily: fonts.mono, fontSize: 14, color: colors.textSecondary, marginTop: 8, textAlign: 'center' },
  doneBtn: { marginTop: 22, alignSelf: 'stretch', borderRadius: 14 },
  doneBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // Exam
  qNum: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 1.2, marginTop: 16 },
  qText: { fontFamily: fonts.display, fontSize: 17, fontWeight: '800', color: colors.text, lineHeight: 24, marginTop: 6 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.background },
  radioOuter: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.borderDark, alignItems: 'center', justifyContent: 'center' },
  choiceText: { flex: 1, fontSize: 14, color: colors.text, fontWeight: '600', lineHeight: 19 },
  examNav: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  navBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  navBtnText: { fontSize: 13, fontWeight: '700', color: colors.text },
  navGlowBtn: { flex: 1, borderRadius: 12, paddingVertical: 12 },
  navBtnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '800' },

  // Result
  scoreCard: { padding: 20, borderRadius: 18, alignItems: 'center', gap: 6 },
  scoreTitle: { fontFamily: fonts.displayBlack, color: '#fff', fontSize: 40, letterSpacing: -1 },
  scoreSub: { color: '#fff', fontSize: 14, fontWeight: '700' },
  scoreNote: { color: 'rgba(255,255,255,0.95)', fontSize: 12, fontWeight: '600', textAlign: 'center', marginTop: 4, lineHeight: 18 },

  answerCard: { borderRadius: 14, borderWidth: 1, padding: 12, marginBottom: 8, gap: 6 },
  answerHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  answerBadge: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  answerNum: { fontSize: 11, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.5 },
  answerQ: { fontSize: 13, color: colors.text, fontWeight: '700', lineHeight: 19 },
  answerLine: { fontSize: 12, color: colors.text, lineHeight: 18 },
  answerKey: { color: colors.textMuted, fontWeight: '700' },
  answerExp: { fontSize: 11, color: colors.textMuted, fontStyle: 'italic', marginTop: 4, lineHeight: 16 },
});
