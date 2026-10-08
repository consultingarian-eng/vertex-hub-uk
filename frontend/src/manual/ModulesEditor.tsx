/**
 * Stage 2/3/4 module editor — admin-only inline editor used from the
 * Profile → Manual screen. Lets admins/sub-office admins edit:
 *   • topic + category
 *   • trainee_content (single string)
 *   • what_good_looks_like (string list)
 *   • leader_coaching_notes (string list)
 *   • how_measured (string list)
 *   • assessment_prompts (4-key dict for knowledge / skill / consistency / independence)
 *
 * Backend: PATCH /api/manual-editor/module/{id} (auth via the user's normal
 * admin Bearer/cookie session — fallback to MANUAL_EDITOR_PASSWORD).
 */
import React, { useMemo, useState } from 'react';
import { showAlert } from '../utils/showAlert';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, TextInput, RefreshControl,  } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '../api/client';
import { sortCodStages, codStageLabel } from '../components/cod/stageOrder';

type Stage = 2 | 3 | 4 | 5;

const STAGE_LABEL: Record<Stage, string> = {
  2: 'Stage 2 · Independence',
  3: 'Stage 3 · Leadership',
  4: 'Stage 4 · Team Builder',
  5: 'Stage SL · Sector/Site Leader',
};

type ModuleRow = {
  id: string;
  stage: number;
  category: string;
  topic: string;
  trainee_content?: string;
  what_good_looks_like?: string[];
  how_measured?: string[];
  leader_coaching_notes?: string[];
  assessment_prompts?: Record<string, string>;
  sequence?: number;
};

export default function ModulesEditor({
  officeId,
  isSuperAdmin,
  colors,
}: {
  officeId?: string | null;
  isSuperAdmin: boolean;
  colors: any;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<Stage>(2);
  const [scope, setScope] = useState<'office' | 'global'>('office');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<ModuleRow>>({});

  const effectiveOffice = scope === 'global' ? null : (officeId || null);
  const modulesQ = useQuery({
    queryKey: ['admin-modules', stage, effectiveOffice],
    queryFn: () => apiService.adminListModules(stage, effectiveOffice).then(r => r.data),
  });
  const items: ModuleRow[] = modulesQ.data?.items || [];

  const patchMut = useMutation({
    mutationFn: (vars: { id: string; patch: any }) =>
      apiService.adminPatchModule(vars.id, vars.patch).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-modules'] });
      // Also refresh the trainee/leader-facing module lists so edits show up live
      queryClient.invalidateQueries({ queryKey: ['stage-modules'] });
      setEditingId(null);
    },
    onError: (e: any) => showAlert('Save failed', e?.response?.data?.detail || e?.message || 'Try again'),
  });
  const createMut = useMutation({
    mutationFn: () => apiService.adminCreateModule({
      stage,
      office_id: effectiveOffice,
      category: 'New Category',
      topic: 'New module',
    }).then(r => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-modules'] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.adminDeleteModule(id).then(r => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-modules'] }),
  });

  const groupedByCategory = useMemo(() => {
    const map: Record<string, ModuleRow[]> = {};
    items.forEach((m) => {
      const cat = m.category || 'General';
      (map[cat] = map[cat] || []).push(m);
    });
    return map;
  }, [items]);

  const startEdit = (m: ModuleRow) => {
    setEditingId(m.id);
    setExpandedId(m.id);
    setDraft({
      topic: m.topic || '',
      category: m.category || '',
      trainee_content: m.trainee_content || '',
      what_good_looks_like: [...(m.what_good_looks_like || [])],
      how_measured: [...(m.how_measured || [])],
      leader_coaching_notes: [...(m.leader_coaching_notes || [])],
      assessment_prompts: { ...(m.assessment_prompts || {}) },
    });
  };
  const cancelEdit = () => { setEditingId(null); setDraft({}); };
  const saveEdit = () => {
    if (!editingId) return;
    patchMut.mutate({ id: editingId, patch: draft });
  };

  const renderListEditor = (label: string, key: keyof ModuleRow & ('what_good_looks_like'|'how_measured'|'leader_coaching_notes')) => {
    const list = (draft[key] as string[]) || [];
    return (
      <View style={styles.listGroup}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {list.map((line, idx) => (
          <View key={idx} style={styles.listLineRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={line}
              onChangeText={(t) => {
                const next = [...list]; next[idx] = t;
                setDraft({ ...draft, [key]: next });
              }}
              multiline
              placeholder="Bullet text…"
              placeholderTextColor={colors.textMuted}
            />
            <TouchableOpacity
              onPress={() => {
                const next = list.filter((_, i) => i !== idx);
                setDraft({ ...draft, [key]: next });
              }}
              style={styles.iconBtn}
            >
              <Ionicons name="trash-outline" size={16} color={colors.red || '#ef4444'} />
            </TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity
          style={styles.addBulletBtn}
          onPress={() => setDraft({ ...draft, [key]: [...list, ''] })}
        >
          <Ionicons name="add-circle-outline" size={14} color={colors.primary} />
          <Text style={[styles.addBulletText, { color: colors.primary }]}>Add bullet</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderPromptsEditor = () => {
    const prompts = (draft.assessment_prompts || {}) as Record<string, string>;
    const dims: Array<keyof typeof prompts> = ['knowledge', 'skill', 'consistency', 'independence'];
    return (
      <View style={styles.listGroup}>
        <Text style={styles.fieldLabel}>Assessment prompts (scoring rubric)</Text>
        {dims.map((d) => (
          <View key={d} style={{ marginBottom: 6 }}>
            <Text style={styles.subFieldLabel}>{String(d).charAt(0).toUpperCase() + String(d).slice(1)}</Text>
            <TextInput
              style={styles.input}
              value={prompts[d] || ''}
              onChangeText={(t) => setDraft({ ...draft, assessment_prompts: { ...prompts, [d]: t } })}
              multiline
              placeholder={`What does great look like for ${d}?`}
              placeholderTextColor={colors.textMuted}
            />
          </View>
        ))}
      </View>
    );
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={styles.scroll}
      refreshControl={<RefreshControl refreshing={modulesQ.isFetching} onRefresh={() => modulesQ.refetch()} />}
    >
      {/* Stage tabs */}
      <View style={styles.tabsRow}>
        {/* COD display order (stageOrder.ts) — no SL tab here today, but the
            rail follows the same sequence as every other stage rail. */}
        {(sortCodStages([2, 3, 4]) as Stage[]).map((s) => (
          <TouchableOpacity
            key={s}
            style={[styles.tab, stage === s && styles.tabActive]}
            onPress={() => setStage(s)}
          >
            <Text style={[styles.tabText, stage === s && styles.tabTextActive]}>
              Stage {codStageLabel(s)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Global Template toggle (super-admin only). Picking the office at the
          top of the screen implicitly scopes edits to "This Office" — this
          tiny ghost button is just an escape hatch for editing the global
          template that NEW offices clone from. */}
      {isSuperAdmin && (
        <View style={styles.scopeRow}>
          <TouchableOpacity
            style={[styles.globalToggle, scope === 'global' && styles.globalToggleActive]}
            onPress={() => setScope(scope === 'global' ? 'office' : 'global')}
          >
            <Ionicons
              name="globe-outline"
              size={13}
              color={scope === 'global' ? '#fff' : colors.textSecondary}
            />
            <Text style={[styles.globalToggleText, scope === 'global' && styles.globalToggleTextActive]}>
              {scope === 'global' ? 'Editing global template — tap to return' : 'Edit global template'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={styles.pageTitle}>{STAGE_LABEL[stage]}</Text>
      <Text style={styles.subTitle}>
        {scope === 'global'
          ? 'Editing the global template — applies to every new office that adopts it.'
          : 'Editing this office\'s curriculum only.'}
      </Text>

      {modulesQ.isLoading && <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />}

      {!modulesQ.isLoading && Object.entries(groupedByCategory).map(([cat, mods]) => (
        <View key={cat} style={{ marginTop: 14 }}>
          <Text style={styles.catHeader}>{cat}</Text>
          {mods.map((m) => {
            const expanded = expandedId === m.id;
            const editing = editingId === m.id;
            return (
              <View key={m.id} style={styles.card}>
                {/* Title row — tap to expand */}
                <TouchableOpacity
                  style={styles.cardHeader}
                  onPress={() => { setExpandedId(expanded ? null : m.id); if (!expanded && editing) cancelEdit(); }}
                  activeOpacity={0.6}
                >
                  <Text style={styles.cardTitle} numberOfLines={editing ? 0 : 2}>
                    {editing ? (draft.topic ?? m.topic) : m.topic}
                  </Text>
                  <Ionicons
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={colors.textMuted}
                  />
                </TouchableOpacity>

                {expanded && !editing && (
                  <View style={styles.cardBody}>
                    {!!m.trainee_content && (
                      <View style={styles.viewBlock}>
                        <Text style={styles.viewLabel}>BA content</Text>
                        <Text style={styles.viewText}>{m.trainee_content}</Text>
                      </View>
                    )}
                    {(m.what_good_looks_like || []).length > 0 && (
                      <View style={styles.viewBlock}>
                        <Text style={styles.viewLabel}>What good looks like</Text>
                        {(m.what_good_looks_like || []).map((b, i) => (
                          <Text key={i} style={styles.bullet}>• {b}</Text>
                        ))}
                      </View>
                    )}
                    {(m.leader_coaching_notes || []).length > 0 && (
                      <View style={styles.viewBlock}>
                        <Text style={styles.viewLabel}>Coaching notes (for coaches)</Text>
                        {(m.leader_coaching_notes || []).map((b, i) => (
                          <Text key={i} style={styles.bullet}>• {b}</Text>
                        ))}
                      </View>
                    )}
                    {(m.how_measured || []).length > 0 && (
                      <View style={styles.viewBlock}>
                        <Text style={styles.viewLabel}>How measured</Text>
                        {(m.how_measured || []).map((b, i) => (
                          <Text key={i} style={styles.bullet}>• {b}</Text>
                        ))}
                      </View>
                    )}

                    <View style={styles.actionRow}>
                      <TouchableOpacity style={styles.editBtn} onPress={() => startEdit(m)}>
                        <Ionicons name="create-outline" size={14} color={colors.onPrimary} />
                        <Text style={styles.editBtnText}>Edit</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.deleteBtn}
                        onPress={() => showAlert('Delete module', `Delete "${m.topic}"? BA/coach progress on this module will also be cleared.`, [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Delete', style: 'destructive', onPress: () => deleteMut.mutate(m.id) },
                        ])}
                      >
                        <Ionicons name="trash-outline" size={14} color={colors.red || '#ef4444'} />
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {expanded && editing && (
                  <View style={styles.cardBody}>
                    <Text style={styles.fieldLabel}>Topic</Text>
                    <TextInput
                      style={styles.input}
                      value={draft.topic || ''}
                      onChangeText={(t) => setDraft({ ...draft, topic: t })}
                      placeholder="Topic title…"
                      placeholderTextColor={colors.textMuted}
                    />
                    <Text style={styles.fieldLabel}>Category</Text>
                    <TextInput
                      style={styles.input}
                      value={draft.category || ''}
                      onChangeText={(t) => setDraft({ ...draft, category: t })}
                      placeholder="Category…"
                      placeholderTextColor={colors.textMuted}
                    />
                    <Text style={styles.fieldLabel}>BA content</Text>
                    <TextInput
                      style={[styles.input, { minHeight: 90 }]}
                      value={draft.trainee_content || ''}
                      onChangeText={(t) => setDraft({ ...draft, trainee_content: t })}
                      multiline
                      placeholder="What the BA/coach reads when learning this topic…"
                      placeholderTextColor={colors.textMuted}
                    />
                    {renderListEditor('What good looks like', 'what_good_looks_like')}
                    {renderListEditor('Coaching notes (for coaches)', 'leader_coaching_notes')}
                    {renderListEditor('How measured', 'how_measured')}
                    {renderPromptsEditor()}

                    <View style={styles.actionRow}>
                      <TouchableOpacity style={styles.cancelBtn} onPress={cancelEdit}>
                        <Text style={styles.cancelBtnText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.saveBtn, patchMut.isPending && { opacity: 0.5 }]}
                        onPress={saveEdit}
                        disabled={patchMut.isPending}
                      >
                        {patchMut.isPending ? (
                          <ActivityIndicator size="small" color={colors.onPrimary} />
                        ) : (
                          <>
                            <Ionicons name="checkmark" size={14} color={colors.onPrimary} />
                            <Text style={styles.saveBtnText}>Save</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      ))}

      {!modulesQ.isLoading && (
        <TouchableOpacity
          style={styles.addModuleBtn}
          onPress={() => createMut.mutate()}
          disabled={createMut.isPending}
        >
          {createMut.isPending ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <>
              <Ionicons name="add-circle" size={20} color={colors.primary} />
              <Text style={styles.addModuleText}>Add new module to {STAGE_LABEL[stage]}</Text>
            </>
          )}
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  scroll: { padding: 14, paddingBottom: 80 },
  tabsRow: {
    flexDirection: 'row', gap: 6,
    backgroundColor: colors.surface, padding: 4, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 7, alignItems: 'center' },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: '800', color: colors.textSecondary },
  tabTextActive: { color: colors.onPrimary },
  scopeRow: {
    flexDirection: 'row', gap: 6, marginTop: 10,
  },
  scopeBtn: {
    flex: 1, paddingVertical: 8, borderRadius: 7,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  scopeBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  scopeBtnText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  scopeBtnTextActive: { color: colors.onPrimary },
  globalToggle: {
    alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border, backgroundColor: 'transparent',
  },
  globalToggleActive: { backgroundColor: '#D97706', borderColor: '#D97706' },
  globalToggleText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.2 },
  globalToggleTextActive: { color: '#fff' },
  pageTitle: { fontSize: 18, fontWeight: '900', color: colors.text, marginTop: 14 },
  subTitle: { fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 16 },
  catHeader: {
    fontSize: 11, fontWeight: '900', color: colors.primary,
    letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8, paddingHorizontal: 4,
  },
  card: {
    backgroundColor: colors.surface, borderRadius: 10, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12,
  },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text },
  cardBody: { padding: 12, paddingTop: 0, borderTopWidth: 1, borderTopColor: colors.border },
  viewBlock: { marginTop: 10 },
  viewLabel: {
    fontSize: 10, fontWeight: '900', color: colors.textSecondary,
    letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4,
  },
  viewText: { fontSize: 13, color: colors.text, lineHeight: 18 },
  bullet: { fontSize: 13, color: colors.text, lineHeight: 19, marginBottom: 2 },

  fieldLabel: {
    fontSize: 11, fontWeight: '900', color: colors.textSecondary,
    letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 12, marginBottom: 6,
  },
  subFieldLabel: { fontSize: 11, fontWeight: '700', color: colors.text, marginBottom: 4 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 8,
    padding: 10, color: colors.text, fontSize: 13,
    backgroundColor: colors.background,
    textAlignVertical: 'top',
  },
  listGroup: { marginTop: 6 },
  listLineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 6 },
  iconBtn: { padding: 8 },
  addBulletBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, paddingVertical: 6 },
  addBulletText: { fontSize: 12, fontWeight: '700' },

  actionRow: { flexDirection: 'row', gap: 8, marginTop: 14, alignItems: 'center' },
  editBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.primary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 7,
  },
  editBtnText: { color: colors.onPrimary, fontSize: 12, fontWeight: '800' },
  deleteBtn: {
    backgroundColor: (colors.red || '#ef4444') + '14', padding: 8, borderRadius: 7,
    borderWidth: 1, borderColor: (colors.red || '#ef4444') + '33',
  },
  cancelBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 7, borderWidth: 1, borderColor: colors.border },
  cancelBtnText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  saveBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, paddingVertical: 9, borderRadius: 7,
  },
  saveBtnText: { color: colors.onPrimary, fontSize: 13, fontWeight: '800' },

  addModuleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 14, marginTop: 18, borderRadius: 10,
    backgroundColor: (colors.primary || '#244C3B') + '12',
    borderWidth: 1, borderColor: (colors.primary || '#244C3B') + '33', borderStyle: 'dashed',
  },
  addModuleText: { color: colors.primary, fontSize: 13, fontWeight: '800' },
});
