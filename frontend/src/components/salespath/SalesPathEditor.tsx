/**
 * SalesPathEditor — the admin's in-app editor for the Sales Development
 * Path's framing copy + ramp pacing, following the onboarding editor
 * pattern (bottom-sheet modal, re-seeded from live content on open, partial
 * PUT). What's editable: the three ramp weekly targets, the arc line, the
 * six per-level money-story lines, the My Progress long-game card, and the
 * Start Here ramp phase body.
 *
 * Deliberately NOT editable: level thresholds, typical-week bands, the
 * Green Week constant — company-wide policy lives in code so an "Advanced"
 * badge certifies the same thing in every office.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GREEN_WEEK_MIN } from '../../utils/weekBands';
import { useColors } from '../../theme/ThemeContext';
import { apiService, SalesPathContent } from '../../api/client';
import { showAlert } from '../../utils/showAlert';

const LEVEL_LABELS: Record<string, string> = {
  '1': 'Beginner', '2': 'Competency', '3': 'Proficiency',
  '4': 'Advanced', '5': 'Expert', '6': 'Mastery',
};

export function SalesPathEditor({
  visible, onClose, content, onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  content?: SalesPathContent;
  onSaved: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const [targets, setTargets] = useState<string[]>(['7', '10', '12', '15']);
  const [arcLine, setArcLine] = useState('');
  const [levelArc, setLevelArc] = useState<Record<string, string>>({});
  const [longGameTitle, setLongGameTitle] = useState('');
  const [longGameBody, setLongGameBody] = useState('');
  const [journeyRampBody, setJourneyRampBody] = useState('');

  // Re-seed the form each time the editor opens with the latest content.
  useEffect(() => {
    if (!visible) return;
    setTargets((content?.ramp_targets || [7, 10, 12, 15]).map(String));
    setArcLine(content?.arc_line || '');
    setLevelArc({ ...(content?.level_arc || {}) });
    setLongGameTitle(content?.long_game_title || '');
    setLongGameBody(content?.long_game_body || '');
    setJourneyRampBody(content?.journey_ramp_body || '');
  }, [visible, content]);

  const parsedTargets = targets.map((t) => parseInt(t, 10));
  const targetsValid = parsedTargets.every((t) => Number.isInteger(t) && t >= 1 && t <= 50);

  const saveMut = useMutation({
    mutationFn: () =>
      apiService.updateSalesPathSettings({
        ramp_targets: parsedTargets,
        arc_line: arcLine,
        level_arc: levelArc,
        long_game_title: longGameTitle,
        long_game_body: longGameBody,
        journey_ramp_body: journeyRampBody,
      }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e: any) => showAlert('Save failed', e?.response?.data?.detail || 'Please try again.'),
  });

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.header}>
            <Text style={styles.title}>Edit Sales Path</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
            <Text style={styles.fieldLabel}>Ramp weekly targets (week 1 = their start week)</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {targets.map((t, i) => (
                <TextInput
                  key={i}
                  style={[styles.input, { flex: 1, textAlign: 'center' }, !targetsValid && { borderColor: colors.red }]}
                  value={t}
                  onChangeText={(v) => setTargets((prev) => prev.map((x, idx) => (idx === i ? v.replace(/[^0-9]/g, '') : x)))}
                  keyboardType="number-pad"
                  maxLength={2}
                />
              ))}
            </View>
            <Text style={styles.hint}>
              Week 1 counts from their first day (BA Academy + first field days). The Green Week badge always keys on {GREEN_WEEK_MIN}+ sign-ups, wherever it lands on the runway.
            </Text>

            <Text style={styles.fieldLabel}>The arc line (shown under the level track)</Text>
            <TextInput style={[styles.input, styles.inputMulti]} value={arcLine} onChangeText={setArcLine} multiline
              placeholder="Decent comes in weeks — great is built over months…" placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>Per-level money story</Text>
            {Object.keys(LEVEL_LABELS).map((n) => (
              <View key={n}>
                <Text style={styles.levelLabel}>{n} · {LEVEL_LABELS[n]}</Text>
                <TextInput
                  style={[styles.input, styles.inputMulti, { minHeight: 60 }]}
                  value={levelArc[n] || ''}
                  onChangeText={(v) => setLevelArc((prev) => ({ ...prev, [n]: v }))}
                  multiline
                  placeholderTextColor={colors.textMuted}
                />
              </View>
            ))}

            <Text style={styles.fieldLabel}>"The long game" card — title (My Progress)</Text>
            <TextInput style={styles.input} value={longGameTitle} onChangeText={setLongGameTitle}
              placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>"The long game" card — body</Text>
            <TextInput style={[styles.input, styles.inputMulti, { minHeight: 110 }]} value={longGameBody}
              onChangeText={setLongGameBody} multiline placeholderTextColor={colors.textMuted} />

            <Text style={styles.fieldLabel}>Start Here — ramp phase description</Text>
            <TextInput style={[styles.input, styles.inputMulti, { minHeight: 110 }]} value={journeyRampBody}
              onChangeText={setJourneyRampBody} multiline placeholderTextColor={colors.textMuted} />
          </ScrollView>
          <TouchableOpacity
            style={[styles.saveBtn, (saveMut.isPending || !targetsValid) && { opacity: 0.7 }]}
            onPress={() => saveMut.mutate()}
            disabled={saveMut.isPending || !targetsValid}
            testID="sales-path-save"
          >
            {saveMut.isPending
              ? <ActivityIndicator size="small" color={colors.onPrimary} />
              : <Text style={styles.saveBtnText}>Save</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingHorizontal: 16, paddingTop: 14, maxHeight: '88%',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { fontSize: 16, fontWeight: '900', color: colors.text },
  fieldLabel: {
    fontSize: 11, fontWeight: '900', letterSpacing: 0.5, textTransform: 'uppercase',
    color: colors.textMuted, marginTop: 14, marginBottom: 6,
  },
  levelLabel: { fontSize: 11.5, fontWeight: '800', color: colors.primary, marginTop: 8, marginBottom: 4 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12,
    paddingVertical: 10, fontSize: 13.5, color: colors.text, backgroundColor: colors.background,
  },
  inputMulti: { minHeight: 84, textAlignVertical: 'top' },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 6, lineHeight: 15 },
  saveBtn: {
    backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 13,
    alignItems: 'center', marginTop: 8,
  },
  saveBtnText: { color: colors.onPrimary, fontSize: 14.5, fontWeight: '800' },
});
