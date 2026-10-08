/**
 * Goal Planner — KPI menu editor (admin only).
 *
 * Curates the preset KPIs and Rock suggestions that people pick from in the
 * Monthly Goal Planner's guided Goal Builder. Scoped to the admin's office
 * (falls back to the global list until customised) — mirrors the onboarding
 * content editor. Backed by GET/PUT /api/monthly-planners/goal-menu.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../src/theme/ThemeContext';
import { apiService } from '../src/api/client';
import { haptics } from '../src/utils/haptics';
import { toast } from '../src/utils/toast';
import { useTabBarClearance } from '../src/customization/CustomTabBar';

export default function PlannerGoalMenuScreen() {
  const colors = useColors();
  const s = useMemo(() => createS(colors), [colors]);
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();

  const q = useQuery({
    queryKey: ['planner-goal-menu'],
    queryFn: () => apiService.getPlannerGoalMenu().then((r) => r.data),
  });

  const [kpis, setKpis] = useState<string[]>([]);
  const [rocks, setRocks] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setKpis(q.data.kpis || []);
    setRocks(q.data.rock_suggestions || []);
    setDirty(false);
  }, [q.data]);

  const canEdit = !!q.data?.can_edit;

  const saveMut = useMutation({
    mutationFn: () => apiService.updatePlannerGoalMenu({
      kpis: kpis.map((x) => x.trim()).filter(Boolean),
      rock_suggestions: rocks.map((x) => x.trim()).filter(Boolean),
    }).then((r) => r.data),
    onSuccess: (data) => {
      haptics.success();
      setKpis(data.kpis || []);
      setRocks(data.rock_suggestions || []);
      setDirty(false);
      toast.success?.('Saved', 'Goal menu updated');
    },
    onError: (e: any) => toast.error?.('Save failed', e?.response?.data?.detail || 'Try again'),
  });

  const mkList = (list: string[], setList: (v: string[]) => void) => ({
    update: (i: number, v: string) => { setList(list.map((x, idx) => (idx === i ? v : x))); setDirty(true); },
    remove: (i: number) => { haptics.light(); setList(list.filter((_, idx) => idx !== i)); setDirty(true); },
    move: (i: number, dir: -1 | 1) => {
      const j = i + dir;
      if (j < 0 || j >= list.length) return;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      haptics.light(); setList(next); setDirty(true);
    },
    add: () => { setList([...list, '']); setDirty(true); },
  });

  const kpiOps = mkList(kpis, setKpis);
  const rockOps = mkList(rocks, setRocks);

  const renderList = (
    title: string,
    hint: string,
    accent: string,
    list: string[],
    ops: ReturnType<typeof mkList>,
    placeholder: string,
  ) => (
    <View style={s.card}>
      <Text style={[s.cardTitle, { color: accent }]}>{title}</Text>
      <Text style={s.cardHint}>{hint}</Text>
      {list.map((val, i) => (
        <View key={i} style={s.row}>
          <View style={s.reorder}>
            <TouchableOpacity onPress={() => ops.move(i, -1)} disabled={!canEdit || i === 0} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Ionicons name="chevron-up" size={16} color={i === 0 ? colors.border : colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => ops.move(i, 1)} disabled={!canEdit || i === list.length - 1} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Ionicons name="chevron-down" size={16} color={i === list.length - 1 ? colors.border : colors.textMuted} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={[s.input, !canEdit && s.inputDisabled]}
            editable={canEdit}
            value={val}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            onChangeText={(v) => ops.update(i, v)}
          />
          {canEdit && (
            <TouchableOpacity onPress={() => ops.remove(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      ))}
      {canEdit && (
        <TouchableOpacity style={s.addBtn} onPress={ops.add}>
          <Ionicons name="add" size={16} color={colors.primary} />
          <Text style={s.addText}>Add {title.includes('KPI') ? 'KPI' : 'Rock'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Goal Planner — KPI menu', headerShown: true }} />
      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: tabBarClearance + 100 }} keyboardShouldPersistTaps="handled">
        <Text style={s.intro}>
          These are the presets people tap when building their monthly goals. Changes apply to your
          office{q.data?.office_id ? '' : ' (global default)'}.
        </Text>
        {q.isLoading ? (
          <Text style={s.loading}>Loading…</Text>
        ) : (
          <>
            {renderList('KPIs — the numbers', 'Measurables people pick 4–5 of.', colors.primary, kpis, kpiOps, 'KPI name…')}
            {renderList('Rocks — did I / didn\'t I', 'Task suggestions people pick 2–3 of.', colors.green, rocks, rockOps, 'Rock suggestion…')}
          </>
        )}
      </ScrollView>

      {canEdit && (
        <View style={[s.footer, { paddingBottom: tabBarClearance + 10 }]}>
          <TouchableOpacity
            style={[s.saveBtn, (!dirty || saveMut.isPending) && { opacity: 0.5 }]}
            onPress={() => saveMut.mutate()}
            disabled={!dirty || saveMut.isPending}
          >
            <Ionicons name="save-outline" size={16} color={colors.onPrimary} />
            <Text style={s.saveText}>{saveMut.isPending ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</Text>
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const createS = (colors: any) => StyleSheet.create({
  intro: { fontSize: 12.5, color: colors.textSecondary, lineHeight: 18, marginBottom: 14 },
  loading: { color: colors.textMuted, textAlign: 'center', marginTop: 30 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 14, marginBottom: 14 },
  cardTitle: { fontSize: 15, fontWeight: '900' },
  cardHint: { fontSize: 11.5, color: colors.textMuted, marginTop: 2, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  reorder: { alignItems: 'center' },
  input: { flex: 1, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, fontSize: 13, color: colors.text },
  inputDisabled: { color: colors.textMuted },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, marginTop: 4, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border },
  addText: { fontSize: 12.5, fontWeight: '700', color: colors.primary },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14, paddingTop: 10, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 13, borderRadius: 12, backgroundColor: colors.primary },
  saveText: { fontSize: 14, fontWeight: '800', color: colors.onPrimary },
});
