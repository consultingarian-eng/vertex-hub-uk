/**
 * COD Vetting — admin walkthrough of the entire COD 2026 curriculum.
 *
 * The leadership team steps through every module (stages 1 → SL), approves
 * it as-is or edits the wording, targets (How It's Measured), WGLL bullets
 * and coaching notes. Every save writes to BOTH cities plus the global
 * template — the curriculum stays identical everywhere, which is what makes
 * it scalable. Vetted state (who/when) shows so the team can split the work.
 */
import React, { useMemo, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { apiService } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { toast } from '../src/utils/toast';
import { COD_STAGE_ORDER, sortByCodStage } from '../src/components/cod/stageOrder';

const STAGE_LABEL: Record<number, string> = {
  1: 'Stage 1 · Foundation',
  2: 'Stage 2 · Self Management',
  3: 'Stage 3 · Leader',
  4: 'Stage 4 · Team Builder',
  5: 'Stage SL · Sector/Site Leader',
};

type VetModule = {
  stage: number; category: string; topic: string; sequence: number;
  trainee_content: string; what_good_looks_like: string[];
  how_measured: string[]; leader_coaching_notes: string[];
  vetted_by?: string | null; vetted_at?: string | null;
};

export default function CodVettingScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tabBarClearance = useTabBarClearance();
  const { user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  const listQ = useQuery({
    queryKey: ['cod-vetting'],
    queryFn: () => apiService.codVettingList().then((r) => r.data.modules as VetModule[]),
    enabled: isAdmin,
  });

  const [idx, setIdx] = useState(0);
  const [stageFilter, setStageFilter] = useState<number | null>(null);
  // Draft fields for the module currently on screen
  const [draft, setDraft] = useState<{ topic: string; content: string; wgll: string; measured: string; coach: string } | null>(null);

  const all = listQ.data || [];
  // The stepper walks the whole curriculum in COD display order — stage 1,
  // 2, 3, SL (stored as 5), then 4. The backend already sorts this way; the
  // client sort keeps the walk right whatever order the rows arrive in.
  const ordered = sortByCodStage(all, (m) => m.stage);
  const mods = stageFilter ? ordered.filter((m) => m.stage === stageFilter) : ordered;
  const m = mods[Math.min(idx, Math.max(0, mods.length - 1))];
  const vettedCount = all.filter((x) => x.vetted_at).length;

  useEffect(() => {
    if (m) {
      setDraft({
        topic: m.topic,
        content: m.trainee_content,
        wgll: m.what_good_looks_like.join('\n'),
        measured: m.how_measured.join('\n'),
        coach: m.leader_coaching_notes.join('\n'),
      });
    }
  }, [m?.stage, m?.topic]);

  const save = useMutation({
    mutationFn: () => {
      const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
      const updates: any = {};
      if (draft) {
        if (draft.topic.trim() && draft.topic.trim() !== m.topic) updates.topic = draft.topic.trim();
        if (draft.content.trim() !== m.trainee_content) updates.trainee_content = draft.content.trim();
        if (draft.wgll !== m.what_good_looks_like.join('\n')) updates.what_good_looks_like = lines(draft.wgll);
        if (draft.measured !== m.how_measured.join('\n')) updates.how_measured = lines(draft.measured);
        if (draft.coach !== m.leader_coaching_notes.join('\n')) updates.leader_coaching_notes = lines(draft.coach);
      }
      return apiService.codVetModule({ stage: m.stage, topic: m.topic, updates, vetted: true }).then((r) => r.data);
    },
    onSuccess: (d: any) => {
      toast.success?.(`Approved — synced to ${d.matched} copies (every office + template)`);
      qc.invalidateQueries({ queryKey: ['cod-vetting'] });
      qc.invalidateQueries({ queryKey: ['modules'] });
      if (idx < mods.length - 1) setIdx(idx + 1);
    },
    onError: (e: any) => toast.error?.('Save failed', e?.response?.data?.detail || 'Try again'),
  });

  if (!isAdmin) {
    return (
      <View style={styles.gate}>
        <Ionicons name="lock-closed" size={40} color={colors.textMuted} />
        <Text style={styles.gateText}>COD vetting is for office admins.</Text>
      </View>
    );
  }
  if (listQ.isLoading || !m || !draft) {
    return <View style={styles.gate}><BrandLoader size={56} /></View>;
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'COD Vetting' }} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40 + tabBarClearance }}>
        {/* Progress */}
        <View style={styles.progressCard}>
          <Text style={styles.progressTitle}>{vettedCount}/{all.length} modules vetted</Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${all.length ? Math.round((vettedCount / all.length) * 100) : 0}%` }]} />
          </View>
          <Text style={styles.progressSub}>
            Approvals and edits apply to every office and the template — one curriculum, everywhere.
          </Text>
        </View>

        {/* Stage filter */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 10 }}>
          {[null, ...COD_STAGE_ORDER].map((sv) => (
            <TouchableOpacity
              key={String(sv)}
              onPress={() => { setStageFilter(sv as any); setIdx(0); }}
              style={[styles.chip, stageFilter === sv && styles.chipActive]}
            >
              <Text style={[styles.chipText, stageFilter === sv && styles.chipTextActive]}>
                {sv === null ? 'All stages' : STAGE_LABEL[sv]}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Stepper */}
        <View style={styles.stepRow}>
          <TouchableOpacity onPress={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0} hitSlop={10}>
            <Ionicons name="chevron-back-circle" size={30} color={idx === 0 ? colors.border : colors.primary} />
          </TouchableOpacity>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={styles.stepLabel}>{idx + 1} of {mods.length}</Text>
            <Text style={styles.stepStage}>{STAGE_LABEL[m.stage]} · {m.category}</Text>
          </View>
          <TouchableOpacity onPress={() => setIdx(Math.min(mods.length - 1, idx + 1))} disabled={idx >= mods.length - 1} hitSlop={10}>
            <Ionicons name="chevron-forward-circle" size={30} color={idx >= mods.length - 1 ? colors.border : colors.primary} />
          </TouchableOpacity>
        </View>

        {/* Vetted badge */}
        {m.vetted_at ? (
          <View style={styles.vettedBadge}>
            <Ionicons name="checkmark-circle" size={14} color="#16a34a" />
            <Text style={styles.vettedText}>Vetted by {m.vetted_by} · {String(m.vetted_at).slice(0, 10)}</Text>
          </View>
        ) : (
          <View style={[styles.vettedBadge, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
            <Ionicons name="ellipse-outline" size={14} color={colors.textMuted} />
            <Text style={[styles.vettedText, { color: colors.textMuted }]}>Not vetted yet</Text>
          </View>
        )}

        {/* Editable fields */}
        <Text style={styles.fieldLabel}>Topic</Text>
        <TextInput style={styles.input} value={draft.topic} onChangeText={(v) => setDraft({ ...draft, topic: v })} />

        <Text style={styles.fieldLabel}>What to learn (BA content)</Text>
        <TextInput style={[styles.input, styles.multi, { minHeight: 120 }]} multiline value={draft.content}
          onChangeText={(v) => setDraft({ ...draft, content: v })} />

        <Text style={styles.fieldLabel}>What Good Looks Like — one per line (these get tick boxes)</Text>
        <TextInput style={[styles.input, styles.multi]} multiline value={draft.wgll}
          onChangeText={(v) => setDraft({ ...draft, wgll: v })} />

        <Text style={styles.fieldLabel}>How It's Measured / targets — one per line</Text>
        <TextInput style={[styles.input, styles.multi]} multiline value={draft.measured}
          onChangeText={(v) => setDraft({ ...draft, measured: v })} />

        <Text style={styles.fieldLabel}>Coaching notes (for coaches) — one per line</Text>
        <TextInput style={[styles.input, styles.multi]} multiline value={draft.coach}
          onChangeText={(v) => setDraft({ ...draft, coach: v })} />

        {/* Actions */}
        <TouchableOpacity style={[styles.approveBtn, save.isPending && { opacity: 0.6 }]} disabled={save.isPending}
          onPress={() => save.mutate()}>
          {save.isPending ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Ionicons name="checkmark" size={18} color={colors.onPrimary} />}
          <Text style={styles.approveText}>Approve{draft && (draft.content !== m.trainee_content || draft.topic !== m.topic || draft.wgll !== m.what_good_looks_like.join('\n') || draft.measured !== m.how_measured.join('\n') || draft.coach !== m.leader_coaching_notes.join('\n')) ? ' with edits' : ''} → next</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipBtn} onPress={() => setIdx(Math.min(mods.length - 1, idx + 1))}>
          <Text style={styles.skipText}>Skip for now</Text>
        </TouchableOpacity>
      </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: colors.background },
  gateText: { fontFamily: fonts.body, fontSize: 14, color: colors.textSecondary },
  progressCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 14 },
  progressTitle: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.text },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceAlt, marginTop: 8, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: colors.primary },
  progressSub: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginTop: 8, lineHeight: 17 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontFamily: fonts.bodyBold, fontSize: 12, color: colors.textSecondary },
  chipTextActive: { color: colors.onPrimary },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 8 },
  stepLabel: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.text },
  stepStage: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  vettedBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: '#16a34a14', borderWidth: 1, borderColor: '#16a34a44', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 8 },
  vettedText: { fontFamily: fonts.bodyBold, fontSize: 11, color: '#16a34a' },
  fieldLabel: { fontFamily: fonts.bodyBold, fontSize: 12, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 14, marginBottom: 5 },
  input: { fontFamily: fonts.body, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  multi: { minHeight: 90, textAlignVertical: 'top', lineHeight: 20 },
  approveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, marginTop: 20 },
  approveText: { fontFamily: fonts.bodyBold, fontSize: 15, color: colors.onPrimary },
  skipBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  skipText: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted },
});
