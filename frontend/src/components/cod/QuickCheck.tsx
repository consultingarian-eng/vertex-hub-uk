/**
 * QuickCheck — the final Learn-mode card: 3 multiple-choice questions
 * generated from the impact's own text (contract mirrors the module
 * quizzes in routes/modules.py). Grading is server-side; pass = 2 of 3.
 * On pass: confetti + onPassed() so the hub tick lights up.
 *
 * The quiz itself is prefetched by the reader (404 → the reader renders a
 * completion card instead and this component never mounts), so a broken or
 * absent quiz backend can never take the reader down.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { apiService } from '../../api/client';
import { useColors } from '../../theme/ThemeContext';
import { fonts, GRADIENT, brand } from '../../theme/brand';
import { haptics } from '../../utils/haptics';
import { toast } from '../../utils/toast';
import { ConfettiCelebration, ConfettiCelebrationHandle } from '../ui/ConfettiCelebration';
import type { ImpactQuiz, ImpactQuizResult } from './types';

type Props = {
  impactId: string;
  quiz: ImpactQuiz;
  accent: string;
  onPassed: () => void;
  onDone: () => void;
  onReadNotes: () => void;
};

export function QuickCheck({ impactId, quiz, accent, onPassed, onDone, onReadNotes }: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImpactQuizResult | null>(null);
  const confettiRef = useRef<ConfettiCelebrationHandle>(null);

  useEffect(() => {
    if (result?.passed) {
      confettiRef.current?.fire();
      haptics.success();
    }
  }, [result?.passed]);

  const allAnswered = quiz.questions.every((q) => answers[q.id] !== undefined);

  const choose = (qid: string, idx: number) => {
    if (result) return; // locked after grading
    haptics.light();
    setAnswers((cur) => ({ ...cur, [qid]: idx }));
  };

  const submit = async () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    try {
      const { data } = await apiService.coachingImpactQuizSubmit(impactId, {
        quiz_id: quiz.quiz_id,
        answers,
      });
      setResult(data);
      if (data?.passed) onPassed();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || e?.message || 'Could not grade — try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const retry = () => {
    haptics.light();
    setAnswers({});
    setResult(null);
  };

  const rowFor = (qid: string) => result?.results?.find((r) => r.id === qid);

  return (
    <View style={styles.card}>
      <ConfettiCelebration ref={confettiRef} />
      <Text style={[styles.kicker, { color: accent }]}>QUICK CHECK</Text>
      <Text style={styles.title}>Prove you own it</Text>
      <Text style={styles.sub}>Three questions from this note — get 2 of 3 to pass it off.</Text>

      {quiz.questions.map((q, qi) => {
        const graded = rowFor(q.id);
        return (
          <View key={q.id} style={styles.qBlock}>
            <Text style={styles.qNum}>QUESTION {qi + 1} / {quiz.questions.length}</Text>
            <Text style={styles.qText}>{q.question}</Text>
            <View style={{ gap: 8, marginTop: 10 }}>
              {q.choices.map((choice, ci) => {
                const picked = answers[q.id] === ci;
                const isCorrect = graded ? graded.correct === ci : false;
                const isWrongPick = graded ? picked && !graded.ok && !isCorrect : false;
                return (
                  <TouchableOpacity
                    key={ci}
                    onPress={() => choose(q.id, ci)}
                    disabled={!!result}
                    activeOpacity={0.75}
                    style={[
                      styles.choice,
                      picked && !result && { borderColor: accent, backgroundColor: `${accent}12` },
                      graded && isCorrect && { borderColor: colors.green, backgroundColor: colors.greenBg },
                      isWrongPick && { borderColor: colors.red, backgroundColor: colors.redBg },
                    ]}
                  >
                    <View
                      style={[
                        styles.radio,
                        picked && !result && { borderColor: accent, backgroundColor: accent },
                        graded && isCorrect && { borderColor: colors.green, backgroundColor: colors.green },
                        isWrongPick && { borderColor: colors.red, backgroundColor: colors.red },
                      ]}
                    >
                      {picked && !result && <Ionicons name="checkmark" size={12} color={colors.textLight} />}
                      {graded && isCorrect && <Ionicons name="checkmark" size={12} color={colors.textLight} />}
                      {isWrongPick && <Ionicons name="close" size={12} color={colors.textLight} />}
                    </View>
                    <Text style={styles.choiceText}>{choice}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        );
      })}

      {!result ? (
        <TouchableOpacity
          onPress={submit}
          disabled={!allAnswered || submitting}
          activeOpacity={0.85}
          style={{ marginTop: 20, opacity: allAnswered && !submitting ? 1 : 0.45 }}
        >
          <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.submitBtn}>
            {submitting ? (
              <ActivityIndicator color={colors.textLight} size="small" />
            ) : (
              <>
                <Text style={styles.submitText}>Check my answers</Text>
                <Ionicons name="checkmark-circle" size={18} color={colors.textLight} />
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>
      ) : (
        <View style={{ marginTop: 20, gap: 12 }}>
          <View style={[styles.resultBanner, { backgroundColor: result.passed ? colors.green : colors.yellow }]}>
            <Ionicons name={result.passed ? 'trophy' : 'refresh-circle'} size={26} color={brand.paper} />
            <View style={{ flex: 1 }}>
              <Text style={styles.resultTitle}>
                {result.passed ? 'Passed' : 'Not yet'} — {result.score}/{result.total}
              </Text>
              <Text style={styles.resultSub}>
                {result.passed
                  ? 'This one’s in your locker. It shows on your hub now.'
                  : 'Need 2 of 3. The green rows are the answers — run it back.'}
              </Text>
            </View>
          </View>
          {result.passed ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={styles.ghostBtn} onPress={onReadNotes} activeOpacity={0.8}>
                <Ionicons name="document-text-outline" size={16} color={colors.text} />
                <Text style={styles.ghostBtnText}>Read the notes</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onDone} activeOpacity={0.85} style={{ flex: 1 }}>
                <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.submitBtn}>
                  <Text style={styles.submitText}>Done</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={styles.ghostBtn} onPress={onReadNotes} activeOpacity={0.8}>
                <Ionicons name="document-text-outline" size={16} color={colors.text} />
                <Text style={styles.ghostBtnText}>Review notes</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={retry} activeOpacity={0.85} style={{ flex: 1 }}>
                <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.submitBtn}>
                  <Text style={styles.submitText}>Try again</Text>
                  <Ionicons name="refresh" size={16} color={colors.textLight} />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    overflow: 'hidden',
  },
  kicker: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  title: { fontFamily: fonts.display, fontSize: 20, fontWeight: '900', color: colors.text, marginTop: 6 },
  sub: { fontFamily: fonts.body, fontSize: 13, color: colors.textSecondary, marginTop: 4, lineHeight: 19 },
  qBlock: { marginTop: 18 },
  qNum: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.8 },
  qText: { fontFamily: fonts.bodySemibold, fontSize: 15, fontWeight: '700', color: colors.text, lineHeight: 21, marginTop: 5 },
  choice: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    paddingVertical: 12, paddingHorizontal: 13,
    borderRadius: 12, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.background,
  },
  radio: {
    width: 21, height: 21, borderRadius: 11, borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  choiceText: { flex: 1, fontFamily: fonts.body, fontSize: 13.5, color: colors.text, fontWeight: '600', lineHeight: 19 },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    paddingVertical: 14, borderRadius: 12,
  },
  submitText: { fontFamily: fonts.bodyBold, color: colors.textLight, fontSize: 14.5, fontWeight: '800' },
  resultBanner: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14 },
  resultTitle: { fontFamily: fonts.display, fontSize: 16, fontWeight: '900', color: brand.paper },
  resultSub: { fontFamily: fonts.body, fontSize: 12, color: brand.paper, opacity: 0.92, marginTop: 2, lineHeight: 17 },
  ghostBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 13, paddingHorizontal: 14, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background,
  },
  ghostBtnText: { fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '700', color: colors.text },
});

export default QuickCheck;
