/**
 * Leadership Hub — Impacts view.
 *
 * Renders structured "impact" cards extracted from the Impact Booklet
 * and Leadership Toolkit. Stage-grouped, expandable, with role-based
 * visibility (handled by backend). Admins get edit/delete + Add Impact.
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { showAlert } from '../utils/showAlert';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Modal, KeyboardAvoidingView, Platform, RefreshControl,  } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { apiService } from '../api/client';
import { useColors } from '../theme/ThemeContext';
import { toast } from '../utils/toast';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import { sortCodStages } from '../components/cod/stageOrder';

export type Impact = {
  id: string;
  title: string;
  summary: string;
  body: string;
  key_takeaways: string[];
  stage: number;
  category: string;
  source: string;
  order?: number;
};

type Props = {
  isAdmin: boolean;
};

// COD 2026 stage names — impacts are the live coaching sessions that bring
// each COD stage to life; they stay browsable here as the library.
const STAGE_META: Record<number, { label: string; color: string }> = {
  1: { label: 'Stage 1 · Foundation', color: '#10b981' },
  2: { label: 'Stage 2 · Self Management', color: '#8caf38' },
  3: { label: 'Stage 3 · Leader', color: '#e0607e' },
  4: { label: 'Stage 4 · Team Builder', color: '#f59e0b' },
  5: { label: 'Stage SL · Sector/Site Leader', color: '#ef4444' },
};

const CATEGORY_LABEL: Record<string, string> = {
  mindset: 'Mindset',
  skill: 'Skill',
  communication: 'Communication',
  objection_handling: 'Objections',
  leadership: 'Leadership',
  coaching_others: 'Coaching',
  self_development: 'Self Dev',
  product: 'Campaign',
  strategy: 'Strategy',
  team_development: 'Team Dev',
  general: 'General',
};

export default function ImpactsView({ isAdmin }: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const kbInset = useKeyboardInset();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [impacts, setImpacts] = useState<Impact[]>([]);
  const [stages, setStages] = useState<number[]>([1, 2]);
  const [selectedStage, setSelectedStage] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Impact | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await apiService.coachingImpacts();
      setImpacts(data?.impacts || []);
      // COD display order — Stage SL (stored as 5) sits between Stage 3 and
      // Stage 4, and this list drives both the filter chips and the section
      // order below. See stageOrder.ts.
      setStages(sortCodStages(data?.stages || [1, 2]));
    } catch (e: any) {
      showAlert('Failed to load', e?.response?.data?.detail || e?.message || 'Try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(); };

  // Filter
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return impacts.filter((it) => {
      if (selectedStage !== 'all' && it.stage !== selectedStage) return false;
      if (!q) return true;
      const hay = `${it.title} ${it.summary} ${it.category} ${it.body} ${(it.key_takeaways || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [impacts, selectedStage, search]);

  // Group by stage
  const grouped = useMemo(() => {
    const out: Record<number, Impact[]> = {};
    for (const it of filtered) {
      if (!out[it.stage]) out[it.stage] = [];
      out[it.stage].push(it);
    }
    return out;
  }, [filtered]);

  const toggleExpand = (id: string) => {
    setExpandedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const confirmDelete = (impact: Impact) => {
    showAlert(
      'Delete impact?',
      `"${impact.title}"`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          try { await apiService.coachingDeleteImpact(impact.id); toast.success('Deleted'); load(); }
          catch (e: any) { showAlert('Delete failed', e?.response?.data?.detail || e?.message || ''); }
        }},
      ],
    );
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Filters */}
      <View style={styles.filterBar}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search impacts…"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            returnKeyType="search"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stageRow}>
          <TouchableOpacity
            style={[styles.stageChip, selectedStage === 'all' && { backgroundColor: colors.primary, borderColor: colors.primary }]}
            onPress={() => setSelectedStage('all')}
          >
            <Text style={[styles.stageChipText, selectedStage === 'all' && { color: colors.onPrimary }]}>All</Text>
          </TouchableOpacity>
          {stages.map((s) => {
            const meta = STAGE_META[s];
            const active = selectedStage === s;
            return (
              <TouchableOpacity
                key={s}
                style={[styles.stageChip, active && { backgroundColor: meta.color, borderColor: meta.color }]}
                onPress={() => setSelectedStage(s)}
              >
                <View style={[styles.stageDot, { backgroundColor: active ? '#fff' : meta.color }]} />
                <Text style={[styles.stageChipText, active && { color: '#fff' }]}>{meta.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 140 + kbInset }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        keyboardShouldPersistTaps="handled"
      >
        {filtered.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="bulb-outline" size={40} color={colors.textMuted} />
            <Text style={styles.emptyText}>
              {search ? 'No impacts match your search.' : 'No impacts available yet.'}
            </Text>
          </View>
        ) : (
          stages
            .filter((s) => (selectedStage === 'all' || selectedStage === s) && (grouped[s] || []).length > 0)
            .map((s) => {
              const meta = STAGE_META[s];
              const list = grouped[s] || [];
              return (
                <View key={s} style={styles.stageSection}>
                  <View style={styles.stageHeader}>
                    <View style={[styles.stageDot, { backgroundColor: meta.color }]} />
                    <Text style={styles.stageHeaderText}>{meta.label}</Text>
                    <Text style={styles.stageCount}>{list.length}</Text>
                  </View>
                  {list.map((it) => {
                    const expanded = expandedIds.has(it.id);
                    return (
                      <View key={it.id} style={styles.card}>
                        <TouchableOpacity
                          style={styles.cardHeader}
                          activeOpacity={0.7}
                          onPress={() => toggleExpand(it.id)}
                        >
                          <View style={[styles.iconBox, { backgroundColor: `${meta.color}22` }]}>
                            <Ionicons name="bulb" size={18} color={meta.color} />
                          </View>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.cardTitle} numberOfLines={expanded ? undefined : 2}>{it.title}</Text>
                            {!expanded && it.summary ? (
                              <Text style={styles.cardSummary} numberOfLines={2}>{it.summary}</Text>
                            ) : null}
                            <View style={styles.metaRow}>
                              <View style={[styles.tag, { backgroundColor: `${meta.color}1a`, borderColor: `${meta.color}55` }]}>
                                <Text style={[styles.tagText, { color: meta.color }]}>{CATEGORY_LABEL[it.category] || it.category}</Text>
                              </View>
                              {it.source ? (
                                <Text style={styles.sourceText} numberOfLines={1}>{it.source}</Text>
                              ) : null}
                            </View>
                          </View>
                          <Ionicons
                            name={expanded ? 'chevron-up' : 'chevron-down'}
                            size={18}
                            color={colors.textMuted}
                          />
                        </TouchableOpacity>

                        {expanded && (
                          <View style={styles.cardBody}>
                            {it.summary ? (
                              <Text style={styles.bodySummary}>{it.summary}</Text>
                            ) : null}

                            {(it.key_takeaways || []).length > 0 && (
                              <View style={styles.takeawaysWrap}>
                                <Text style={styles.takeawaysLabel}>KEY TAKEAWAYS</Text>
                                {it.key_takeaways.map((kt, i) => (
                                  <View key={i} style={styles.takeawayRow}>
                                    <View style={[styles.bullet, { backgroundColor: meta.color }]} />
                                    <Text style={styles.takeawayText}>{kt}</Text>
                                  </View>
                                ))}
                              </View>
                            )}

                            {it.body ? (
                              <View style={styles.bodyWrap}>
                                <Text style={styles.bodyLabel}>FULL CONTENT</Text>
                                <Text style={styles.bodyText}>{it.body}</Text>
                              </View>
                            ) : null}

                            {isAdmin && (
                              <View style={styles.adminRow}>
                                <TouchableOpacity style={styles.adminBtn} onPress={() => setEditing(it)}>
                                  <Ionicons name="pencil" size={14} color={colors.primary} />
                                  <Text style={[styles.adminBtnText, { color: colors.primary }]}>Edit</Text>
                                </TouchableOpacity>
                                <TouchableOpacity style={[styles.adminBtn, { borderColor: '#fecaca' }]} onPress={() => confirmDelete(it)}>
                                  <Ionicons name="trash" size={14} color="#dc2626" />
                                  <Text style={[styles.adminBtnText, { color: '#dc2626' }]}>Delete</Text>
                                </TouchableOpacity>
                              </View>
                            )}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              );
            })
        )}
      </ScrollView>

      {isAdmin && (
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: colors.primary }]}
          onPress={() => setCreating(true)}
        >
          <Ionicons name="add" size={22} color={colors.onPrimary} />
          <Text style={styles.fabText}>Add Impact</Text>
        </TouchableOpacity>
      )}

      <ImpactEditor
        visible={creating || !!editing}
        existing={editing}
        defaultStage={selectedStage === 'all' ? (stages[0] || 1) : (selectedStage as number)}
        availableStages={[1, 2, 3, 4]}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSaved={() => { setCreating(false); setEditing(null); load(); }}
      />
    </View>
  );
}


// ──────────────────────── Editor modal ────────────────────────
function ImpactEditor({ visible, existing, defaultStage, availableStages, onClose, onSaved }: {
  visible: boolean;
  existing: Impact | null;
  defaultStage: number;
  availableStages: number[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [takeawaysText, setTakeawaysText] = useState('');
  const [stage, setStage] = useState<number>(defaultStage);
  const [category, setCategory] = useState('general');
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      if (existing) {
        setTitle(existing.title);
        setSummary(existing.summary || '');
        setBody(existing.body || '');
        setTakeawaysText((existing.key_takeaways || []).join('\n'));
        setStage(existing.stage);
        setCategory(existing.category || 'general');
        setSource(existing.source || '');
      } else {
        setTitle(''); setSummary(''); setBody(''); setTakeawaysText('');
        setStage(defaultStage); setCategory('general'); setSource('');
      }
    }
  }, [visible, existing, defaultStage]);

  const save = async () => {
    const t = title.trim();
    if (!t) { showAlert('Title required'); return; }
    const takeaways = takeawaysText.split('\n').map((s) => s.trim()).filter(Boolean);
    const payload = {
      title: t,
      summary: summary.trim(),
      body: body.trim(),
      key_takeaways: takeaways,
      stage,
      category: (category || 'general').trim().toLowerCase() || 'general',
      source: source.trim(),
    };
    try {
      setSaving(true);
      if (existing) await apiService.coachingUpdateImpact(existing.id, payload);
      else await apiService.coachingCreateImpact(payload);
      toast.success(existing ? 'Saved' : 'Added');
      onSaved();
    } catch (e: any) {
      showAlert('Save failed', e?.response?.data?.detail || e?.message || '');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <TouchableOpacity activeOpacity={1} onPress={onClose} style={styles.overlay}>
          <TouchableOpacity activeOpacity={1} style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.modalTitle}>{existing ? 'Edit Impact' : 'Add Impact'}</Text>
            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 500 }}>
              <Text style={styles.fieldLabel}>STAGE</Text>
              <View style={styles.stageRow}>
                {availableStages.map((s) => {
                  const meta = STAGE_META[s];
                  const active = stage === s;
                  return (
                    <TouchableOpacity
                      key={s}
                      style={[styles.stageChip, active && { backgroundColor: meta.color, borderColor: meta.color }]}
                      onPress={() => setStage(s)}
                    >
                      <Text style={[styles.stageChipText, active && { color: '#fff' }]}>{`Stage ${s}`}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.fieldLabel}>TITLE</Text>
              <TextInput value={title} onChangeText={setTitle} placeholder="e.g. Objection Cycle" placeholderTextColor={colors.textMuted} style={styles.input} />

              <Text style={styles.fieldLabel}>CATEGORY (e.g. skill, mindset, leadership)</Text>
              <TextInput value={category} onChangeText={setCategory} placeholder="general" placeholderTextColor={colors.textMuted} style={styles.input} autoCapitalize="none" />

              <Text style={styles.fieldLabel}>SOURCE</Text>
              <TextInput value={source} onChangeText={setSource} placeholder="Impact Booklet" placeholderTextColor={colors.textMuted} style={styles.input} />

              <Text style={styles.fieldLabel}>SUMMARY (1-2 sentences)</Text>
              <TextInput value={summary} onChangeText={setSummary} multiline style={[styles.input, { minHeight: 60 }]} placeholderTextColor={colors.textMuted} placeholder="Quick description shown on the card." />

              <Text style={styles.fieldLabel}>KEY TAKEAWAYS (one per line)</Text>
              <TextInput value={takeawaysText} onChangeText={setTakeawaysText} multiline style={[styles.input, { minHeight: 80 }]} placeholderTextColor={colors.textMuted} placeholder="• …\n• …" />

              <Text style={styles.fieldLabel}>BODY (full content)</Text>
              <TextInput value={body} onChangeText={setBody} multiline style={[styles.input, { minHeight: 160 }]} placeholderTextColor={colors.textMuted} />
            </ScrollView>
            <TouchableOpacity style={[styles.primaryBtn, saving && { opacity: 0.5 }]} onPress={save} disabled={saving}>
              {saving ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryBtnText}>{existing ? 'Save changes' : 'Add impact'}</Text>}
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}


const createStyles = (colors: any) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  filterBar: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, backgroundColor: colors.background, gap: 8 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  searchInput: { flex: 1, fontSize: 14, color: colors.text, paddingVertical: 0 },
  stageRow: { paddingVertical: 4, gap: 6, flexDirection: 'row' },
  stageChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, marginRight: 6 },
  stageChipText: { fontSize: 12, fontWeight: '700', color: colors.text },
  stageDot: { width: 8, height: 8, borderRadius: 4 },

  stageSection: { paddingHorizontal: 12, marginTop: 12 },
  stageHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  stageHeaderText: { flex: 1, fontSize: 13, fontWeight: '900', color: colors.text, letterSpacing: 0.4, textTransform: 'uppercase' },
  stageCount: { fontSize: 11, fontWeight: '800', color: colors.textMuted, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },

  card: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 8 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  iconBox: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  cardSummary: { fontSize: 12, color: colors.textSecondary, marginTop: 4, lineHeight: 17 },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  tag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  tagText: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  sourceText: { fontSize: 10, color: colors.textMuted, fontWeight: '600', flex: 1 },

  cardBody: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 12, paddingTop: 12, gap: 14 },
  bodySummary: { fontSize: 13, color: colors.text, fontWeight: '600', lineHeight: 19 },

  takeawaysWrap: { backgroundColor: colors.background, borderRadius: 8, padding: 10, gap: 6 },
  takeawaysLabel: { fontSize: 10, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.5, marginBottom: 2 },
  takeawayRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  bullet: { width: 5, height: 5, borderRadius: 3, marginTop: 7 },
  takeawayText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 18, fontWeight: '600' },

  bodyWrap: { gap: 4 },
  bodyLabel: { fontSize: 10, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.5 },
  bodyText: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },

  adminRow: { flexDirection: 'row', gap: 6, paddingTop: 4 },
  adminBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: `${colors.primary}55`, backgroundColor: `${colors.primary}10` },
  adminBtnText: { fontSize: 12, fontWeight: '800' },

  empty: { alignItems: 'center', padding: 50, gap: 10 },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: 'center', maxWidth: 280 },

  fab: { position: 'absolute', right: 16, bottom: 90, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 24, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  fabText: { color: colors.onPrimary, fontSize: 13, fontWeight: '800' },

  // Modal
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, maxHeight: '92%' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 },
  modalTitle: { fontSize: 17, fontWeight: '900', color: colors.text, marginBottom: 12 },
  fieldLabel: { fontSize: 11, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.5, marginTop: 8, marginBottom: 4, textTransform: 'uppercase' },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: colors.surface, marginBottom: 4, textAlignVertical: 'top' },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, marginTop: 8 },
  primaryBtnText: { color: colors.onPrimary, fontSize: 14, fontWeight: '800' },
});
