import React, { useState, useCallback, useRef, useMemo } from 'react';
import { showAlert } from '../../src/utils/showAlert';
import { promptText } from '../../src/utils/promptText';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, TextInput, KeyboardAvoidingView, Platform,  } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsLandscape } from '../../src/hooks/useIsLandscape';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  NestableScrollContainer,
  NestableDraggableFlatList,
  ScaleDecorator,
} from 'react-native-draggable-flatlist';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '../../src/theme/ThemeContext';
import { fonts, GRADIENT } from '../../src/theme/brand';
import { apiService, DayTarget, TrainingManualItem, GradePreset } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
// Refactored helpers extracted from this file (see /src/manual/*)
import { ALL_DAYS } from '../../src/manual/constants';
import { getPresetLabel, getPresetColor, getDayLabel } from '../../src/manual/utils';
import { SectionedDaySelector } from '../../src/manual/SectionedDaySelector';
import { GradePickerModal } from '../../src/manual/GradePickerModal';
import { SummaryBoxes, type AudienceRole } from '../../src/manual/SummaryBox';
import ModulesEditor from '../../src/manual/ModulesEditor';
import { BrandLoader } from '../../src/components/ui/BrandLoader';
// Reading experience (see /src/components/manual/*)
import { DayStrip } from '../../src/components/manual/DayStrip';
import { DayMissionCard } from '../../src/components/manual/DayMissionCard';
import { ManualItemCard } from '../../src/components/manual/ManualItemCard';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { Skeleton } from '../../src/components/ui/Skeleton';
import { Reveal } from '../../src/components/ui/Reveal';
// ── "Ink & Cube" visual system (spec §3) ────────────────────────────────────
import { DepthCard } from '../../src/components/ui/DepthCard';
import { SectionHead } from '../../src/components/ui/SectionHead';
import { SlidingSegments } from '../../src/components/ui/SlidingSegments';
import { StatBlock } from '../../src/components/ui/StatBlock';
import { XPBar } from '../../src/components/ui/XPBar';
import { GlowButton } from '../../src/components/ui/GlowButton';

// ── Admin section tabs ──
const SECTION_TABS = ['manual', 'assessments', 'modules', 'kpis'] as const;
type SectionKey = (typeof SECTION_TABS)[number];
const SECTION_LABELS: Record<SectionKey, string> = {
  manual: 'Manual', assessments: 'Assessments', modules: 'Modules', kpis: 'KPIs',
};

// ==================== MAIN COMPONENT ====================

export default function ManualScreen() {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const isLandscape = useIsLandscape();
  // Theme-aware styling — the whole screen (reading + admin editors) reacts
  // to light/dark live instead of the old static light-only sheet.
  const colors = useColors();
  const isDarkTheme = String(colors.background).toLowerCase() !== '#ffffff';
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [selectedDay, setSelectedDay] = useState(1);
  const [editMode, setEditMode] = useState(false);
  const [editingItem, setEditingItem] = useState<{ day: number; seq: number } | null>(null);
  const [editFields, setEditFields] = useState({ topic: '', what_good_looks_like: '', expected_outcome: '', category: '', confidence_expected: '' });
  const CONFIDENCE_LEVELS = ['Understand', 'Assisted', 'Independent'];
  const [showAddForm, setShowAddForm] = useState(false);
  const [newItem, setNewItem] = useState({ category: '', topic: '', what_good_looks_like: '', expected_outcome: '' });
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const isSuperAdmin = user?.is_super_admin;
  const isTrainee = user?.role === 'trainee';
  const queryClient = useQueryClient();

  // Office picker for super admin
  const [selectedOffice, setSelectedOffice] = useState<string | undefined>(user?.office_id || undefined);
  const [applyAll, setApplyAll] = useState(false);
  const { data: offices } = useQuery({
    queryKey: ['offices'],
    queryFn: () => apiService.getOffices().then(r => r.data),
    enabled: !!isSuperAdmin,
  });
  // Set default office once loaded
  React.useEffect(() => {
    if (isSuperAdmin && offices && offices.length > 0 && !selectedOffice) {
      setSelectedOffice(offices[0].id);
    }
  }, [offices, isSuperAdmin]);

  // Pass office to all content queries
  const officeParam = isSuperAdmin ? selectedOffice : undefined;

  // Scroll ref for scrolling to top on day change
  const manualScrollRef = useRef<ScrollView>(null);

  // Admin section toggle
  const [activeSection, setActiveSection] = useState<'manual' | 'assessments' | 'modules' | 'kpis'>('manual');

  const { data: targets, isLoading: tL } = useQuery({
    queryKey: ['targets', officeParam],
    queryFn: () => apiService.getTargets(officeParam).then(r => r.data),
  });
  const { data: manual, isLoading: mL } = useQuery({
    queryKey: ['training-manual', officeParam],
    queryFn: () => apiService.getTrainingManual(officeParam).then(r => r.data),
  });
  const { data: presets } = useQuery({
    queryKey: ['grade-presets'],
    queryFn: () => apiService.getGradePresets().then(r => r.data),
    enabled: isAdmin,
  });

  // ==================== MANUAL MUTATIONS ====================

  const updateMut = useMutation({
    mutationFn: ({ day, seq, data }: { day: number; seq: number; data: Partial<TrainingManualItem> }) =>
      apiService.updateManualItem(day, seq, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-manual'] });
      setEditingItem(null);
      showAlert('Saved', 'Manual item updated');
    },
    onError: () => showAlert('Error', 'Failed to update'),
  });

  const addMut = useMutation({
    mutationFn: (data: { day_number: number; category: string; topic: string; what_good_looks_like: string; expected_outcome: string; grade_options: string[] }) =>
      apiService.addManualItem(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-manual'] });
      setShowAddForm(false);
      setNewItem({ category: '', topic: '', what_good_looks_like: '', expected_outcome: '' });
      setAssessAddToCat(null);
      showAlert('Added', 'New item added');
    },
    onError: () => showAlert('Error', 'Failed to add'),
  });

  const deleteMut = useMutation({
    mutationFn: ({ day, seq }: { day: number; seq: number }) =>
      apiService.deleteManualItem(day, seq),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-manual'] });
      showAlert('Deleted', 'Item removed');
    },
  });

  const reorderMut = useMutation({
    mutationFn: ({ day, ordered }: { day: number; ordered: number[] }) =>
      apiService.reorderManualItems(day, ordered),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-manual'] });
    },
  });

  const bulkGradeMut = useMutation({
    mutationFn: (items: { day_number: number; sequence: number; grade_options: string[] }[]) =>
      apiService.bulkUpdateGradeOptions(items),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-manual'] });
      showAlert('Saved', 'Grade type updated');
    },
    onError: () => showAlert('Error', 'Failed to update grade type'),
  });

  const targetMut = useMutation({
    mutationFn: ({ day, data }: { day: number; data: Partial<DayTarget> }) =>
      apiService.updateDayTarget(day, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      showAlert('Saved', 'Targets updated');
    },
    onError: () => showAlert('Error', 'Failed to update targets'),
  });

  // ==================== MANUAL HELPERS ====================

  const moveItem = (dayItems: TrainingManualItem[], index: number, direction: 'up' | 'down', day: number) => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= dayItems.length) return;
    const reordered = [...dayItems];
    [reordered[index], reordered[newIndex]] = [reordered[newIndex], reordered[index]];
    const orderedSeqs = reordered.map(i => i.sequence);
    reorderMut.mutate({ day, ordered: orderedSeqs });
  };

  const isLoading = tL || mL;
  const dayTarget = targets?.find(t => t.day_number === selectedDay);
  const dayManual = manual?.filter(m => m.day_number === selectedDay) || [];
  // Topic count per day — feeds the day-strip cards.
  const dayCounts = useMemo(() => {
    const acc: Record<number, number> = {};
    for (const m of manual || []) acc[m.day_number] = (acc[m.day_number] || 0) + 1;
    return acc;
  }, [manual]);
  const categoryOrder = dayManual.reduce((acc, item) => {
    if (!acc.includes(item.category)) acc.push(item.category);
    return acc;
  }, [] as string[]);
  const groupedManual = dayManual.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, TrainingManualItem[]>);

  const moveCategory = (catIndex: number, direction: 'up' | 'down', allItems: TrainingManualItem[], catOrderArr: string[], grouped: Record<string, TrainingManualItem[]>, day: number) => {
    const newIndex = direction === 'up' ? catIndex - 1 : catIndex + 1;
    if (newIndex < 0 || newIndex >= catOrderArr.length) return;
    const newCatOrder = [...catOrderArr];
    [newCatOrder[catIndex], newCatOrder[newIndex]] = [newCatOrder[newIndex], newCatOrder[catIndex]];
    const reordered: number[] = [];
    for (const cat of newCatOrder) {
      for (const item of grouped[cat]) {
        reordered.push(item.sequence);
      }
    }
    reorderMut.mutate({ day, ordered: reordered });
  };

  const [addToCategory, setAddToCategory] = useState<string | null>(null);
  const [addSubItem, setAddSubItem] = useState({ topic: '', what_good_looks_like: '', expected_outcome: '' });

  // WGLL edit state
  const [editingBox, setEditingBox] = useState<string | null>(null);
  const [editBullets, setEditBullets] = useState<string[]>([]);
  const [editNewBullet, setEditNewBullet] = useState('');
  // Collapse state for leader/trainee
  const [collapsedBoxes, setCollapsedBoxes] = useState<Record<string, boolean>>({});
  const toggleCollapse = (key: string) => setCollapsedBoxes(p => ({ ...p, [key]: !p[key] }));

  const getWeightText = () => {
    if (selectedDay === 1) return 'Behaviours: 100%';
    if (selectedDay === 2) return 'Behaviours: 50% | Skills: 50%';
    return 'Behaviours: 33% | Skills: 33% | KPIs: 33%';
  };

  const startEdit = (item: TrainingManualItem) => {
    setEditingItem({ day: item.day_number, seq: item.sequence });
    setEditFields({
      topic: item.topic, what_good_looks_like: item.what_good_looks_like,
      expected_outcome: item.expected_outcome, category: item.category,
      confidence_expected: item.confidence_expected || '',
    });
  };

  const saveEdit = () => {
    if (!editingItem) return;
    updateMut.mutate({ day: editingItem.day, seq: editingItem.seq, data: editFields });
  };

  const handleAdd = () => {
    if (!newItem.category.trim() || !newItem.topic.trim()) {
      showAlert('Error', 'Category and Topic are required'); return;
    }
    addMut.mutate({
      day_number: selectedDay, category: newItem.category.trim(),
      topic: newItem.topic.trim(), what_good_looks_like: newItem.what_good_looks_like.trim(),
      expected_outcome: newItem.expected_outcome.trim(),
      grade_options: selectedDay <= 2 ? ['Learnt', 'Not Learnt'] : ['Excellent', 'Average', 'Below Average'],
    });
  };

  const handleDelete = (item: TrainingManualItem) => {
    showAlert('Delete', `Remove "${item.topic}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMut.mutate({ day: item.day_number, seq: item.sequence }) },
    ]);
  };

  // ==================== ASSESSMENTS SECTION STATE ====================

  const [gradePickerVisible, setGradePickerVisible] = useState(false);
  const [gradePickerItem, setGradePickerItem] = useState<TrainingManualItem | null>(null);
  const [expandedDays, setExpandedDays] = useState<Record<number, boolean>>({ 1: true, 2: false, 3: false, 4: false, 5: false, 6: false, 7: false, 8: false });
  const toggleDay = (day: number) => setExpandedDays(prev => ({ ...prev, [day]: !prev[day] }));
  const [assessAddToCat, setAssessAddToCat] = useState<{ day: number; category: string } | null>(null);
  const [assessNewItem, setAssessNewItem] = useState({ topic: '', what_good_looks_like: '', expected_outcome: '' });

  const openGradePicker = useCallback((item: TrainingManualItem) => {
    setGradePickerItem(item);
    setGradePickerVisible(true);
  }, []);

  const selectPreset = useCallback((preset: GradePreset) => {
    if (!gradePickerItem) return;
    setGradePickerVisible(false);
    bulkGradeMut.mutate([{
      day_number: gradePickerItem.day_number,
      sequence: gradePickerItem.sequence,
      grade_options: preset.options,
    }]);
    setGradePickerItem(null);
  }, [gradePickerItem, bulkGradeMut]);

  // ==================== KPI SECTION STATE ====================

  const [kpiSelectedDay, setKpiSelectedDay] = useState(1);
  const [kpiEditing, setKpiEditing] = useState(false);
  const [kpiFields, setKpiFields] = useState<Record<string, string>>({});

  const kpiTarget = targets?.find(t => t.day_number === kpiSelectedDay);

  const startKpiEdit = () => {
    if (!kpiTarget) return;
    setKpiFields({
      day_objective: kpiTarget.day_objective || '',
      target_intro: String(kpiTarget.target_intro || 0),
      target_presentation: String(kpiTarget.target_presentation || 0),
      target_short_story: String(kpiTarget.target_short_story || 0),
      target_close: String(kpiTarget.target_close || 0),
      target_signup: String(kpiTarget.target_signup || 0),
      target_rehash: String(kpiTarget.target_rehash || 0),
      target_introductions: String(kpiTarget.target_introductions || 0),
      target_presentations: String(kpiTarget.target_presentations || 0),
      target_short_stories: String(kpiTarget.target_short_stories || 0),
      target_closes: String(kpiTarget.target_closes || 0),
      target_sales: String(kpiTarget.target_sales || 0),
      leader_assisted_sales_target: String(kpiTarget.leader_assisted_sales_target || 0),
    });
    setKpiEditing(true);
  };

  const saveKpiEdit = () => {
    const data: Record<string, any> = {};
    if (kpiFields.day_objective !== undefined) data.day_objective = kpiFields.day_objective;
    const numFields = ['target_intro', 'target_presentation', 'target_short_story', 'target_close', 'target_signup', 'target_rehash', 'target_introductions', 'target_presentations', 'target_short_stories', 'target_closes', 'target_sales', 'leader_assisted_sales_target'];
    for (const f of numFields) {
      const v = parseInt(kpiFields[f] || '0', 10);
      if (!isNaN(v)) data[f] = v;
    }
    targetMut.mutate({ day: kpiSelectedDay, data });
    setKpiEditing(false);
  };

  // ==================== SUMMARY BOX RENDERER ====================
  // Pure rendering moved to /src/manual/SummaryBox.tsx — this screen now
  // just decides the role and forwards state into the <SummaryBoxes /> tree.

  const summaryRole: AudienceRole = isAdmin ? 'admin' : isTrainee ? 'trainee' : 'leader';
  const renderSummaryBoxes = () => (
    <SummaryBoxes
      role={summaryRole}
      dayTarget={dayTarget}
      selectedDay={selectedDay}
      styles={styles}
      editingBox={editingBox}
      setEditingBox={setEditingBox}
      editBullets={editBullets}
      setEditBullets={setEditBullets}
      editNewBullet={editNewBullet}
      setEditNewBullet={setEditNewBullet}
      collapsedBoxes={collapsedBoxes}
      toggleCollapse={toggleCollapse}
      onSave={(day, patch) => targetMut.mutate({ day, data: patch as any })}
    />
  );

  // ==================== RENDER: ASSESSMENTS ====================

  const renderAssessmentsSection = () => {
    if (!manual) return null;

    return (
      <ScrollView style={styles.scrollView} contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 20 }]} keyboardShouldPersistTaps="handled">
        <DepthCard edge="gradient" style={styles.assessIntro}>
          <Ionicons name="clipboard" size={20} color={colors.primary} />
          <Text style={styles.assessIntroText}>
            Tap a grade type to change it. Use arrows to reorder. Tap + to add items.
          </Text>
        </DepthCard>

        {ALL_DAYS.map(day => {
          const dayItems = (manual || []).filter(m => m.day_number === day);
          const isExpanded = expandedDays[day];
          const dayCatOrder = dayItems.reduce((acc, item) => {
            if (!acc.includes(item.category)) acc.push(item.category);
            return acc;
          }, [] as string[]);
          const dayGrouped = dayItems.reduce((acc, item) => {
            if (!acc[item.category]) acc[item.category] = [];
            acc[item.category].push(item);
            return acc;
          }, {} as Record<string, TrainingManualItem[]>);

          return (
            <React.Fragment key={day}>
              {day === 1 && (
                <View style={styles.assessSectionHeader}>
                  <Ionicons name="home-outline" size={14} color={colors.textSecondary} />
                  <Text style={styles.assessSectionHeaderText}>BA ACADEMY</Text>
                </View>
              )}
              {day === 3 && (
                <View style={styles.assessSectionHeader}>
                  <Ionicons name="walk-outline" size={14} color={colors.textSecondary} />
                  <Text style={styles.assessSectionHeaderText}>FIELD</Text>
                </View>
              )}
              <DepthCard sheen={false} style={styles.assessDayCard}>
              <TouchableOpacity style={styles.assessDayHeader} onPress={() => toggleDay(day)} activeOpacity={0.7}>
                <View style={styles.assessDayBadge}>
                  <Text style={styles.assessDayBadgeText}>{getDayLabel(day)}</Text>
                </View>
                <Text style={styles.assessDayCount}>{dayItems.length} items</Text>
                <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textSecondary} style={{ marginLeft: 'auto' }} />
              </TouchableOpacity>

              {isExpanded && (
                <View style={styles.assessDayContent}>
                  {dayCatOrder.map((category, catIdx) => (
                    <View key={category} style={styles.assessCatGroup}>
                      <View style={styles.assessCatHeader}>
                        {/* Category reorder controls */}
                        <View style={styles.assessCatReorder}>
                          <TouchableOpacity
                            onPress={() => moveCategory(catIdx, 'up', dayItems, dayCatOrder, dayGrouped, day)}
                            disabled={catIdx === 0}
                            style={{ opacity: catIdx === 0 ? 0.25 : 1 }}
                          >
                            <Ionicons name="chevron-up" size={14} color={colors.textSecondary} />
                          </TouchableOpacity>
                          <Ionicons name="reorder-three" size={14} color={colors.textMuted} />
                          <TouchableOpacity
                            onPress={() => moveCategory(catIdx, 'down', dayItems, dayCatOrder, dayGrouped, day)}
                            disabled={catIdx === dayCatOrder.length - 1}
                            style={{ opacity: catIdx === dayCatOrder.length - 1 ? 0.25 : 1 }}
                          >
                            <Ionicons name="chevron-down" size={14} color={colors.textSecondary} />
                          </TouchableOpacity>
                        </View>
                        <Ionicons name="folder-open" size={14} color={colors.primary} />
                        <Text style={styles.assessCatTitle}>{category}</Text>
                        <TouchableOpacity
                          style={{ marginLeft: 'auto' }}
                          onPress={() => {
                            const match = assessAddToCat?.day === day && assessAddToCat?.category === category;
                            setAssessAddToCat(match ? null : { day, category });
                            setAssessNewItem({ topic: '', what_good_looks_like: '', expected_outcome: '' });
                          }}
                        >
                          <Ionicons name="add-circle" size={22} color={colors.primary} />
                        </TouchableOpacity>
                      </View>

                      {/* Inline add form */}
                      {assessAddToCat?.day === day && assessAddToCat?.category === category && (
                        <View style={styles.assessAddForm}>
                          <TextInput style={styles.editInput} value={assessNewItem.topic} onChangeText={t => setAssessNewItem({ ...assessNewItem, topic: t })} placeholder="Topic name" placeholderTextColor={colors.textMuted} />
                          <TextInput style={[styles.editInput, styles.editMulti]} value={assessNewItem.what_good_looks_like} onChangeText={t => setAssessNewItem({ ...assessNewItem, what_good_looks_like: t })} placeholder="What to teach" placeholderTextColor={colors.textMuted} multiline />
                          <TextInput style={[styles.editInput, styles.editMulti]} value={assessNewItem.expected_outcome} onChangeText={t => setAssessNewItem({ ...assessNewItem, expected_outcome: t })} placeholder="Expected outcome" placeholderTextColor={colors.textMuted} multiline />
                          <View style={styles.editActions}>
                            <TouchableOpacity style={styles.editCancel} onPress={() => setAssessAddToCat(null)}>
                              <Text style={styles.editCancelText}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.editSave} onPress={() => {
                              if (!assessNewItem.topic.trim()) { showAlert('Error', 'Topic is required'); return; }
                              addMut.mutate({
                                day_number: day, category,
                                topic: assessNewItem.topic.trim(),
                                what_good_looks_like: assessNewItem.what_good_looks_like.trim(),
                                expected_outcome: assessNewItem.expected_outcome.trim(),
                                grade_options: day <= 2 ? ['Learnt', 'Not Learnt'] : ['Excellent', 'Average', 'Below Average'],
                              });
                            }}>
                              <Text style={[styles.editSaveText, { color: colors.onPrimary }]}>Add</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      )}

                      {dayGrouped[category].map((item, idx) => {
                        const label = getPresetLabel(item.grade_options);
                        const labelColor = getPresetColor(label);
                        const itemIdx = dayItems.indexOf(item);
                        return (
                          <View key={`${item.day_number}-${item.sequence}`} style={styles.assessItem}>
                            {/* Reorder controls */}
                            <View style={styles.assessItemReorder}>
                              <TouchableOpacity
                                onPress={() => moveItem(dayItems, itemIdx, 'up', day)}
                                disabled={itemIdx === 0}
                                style={{ opacity: itemIdx === 0 ? 0.25 : 1 }}
                              >
                                <Ionicons name="chevron-up" size={14} color={colors.textSecondary} />
                              </TouchableOpacity>
                              <Ionicons name="reorder-three" size={12} color={colors.textMuted} />
                              <TouchableOpacity
                                onPress={() => moveItem(dayItems, itemIdx, 'down', day)}
                                disabled={itemIdx === dayItems.length - 1}
                                style={{ opacity: itemIdx === dayItems.length - 1 ? 0.25 : 1 }}
                              >
                                <Ionicons name="chevron-down" size={14} color={colors.textSecondary} />
                              </TouchableOpacity>
                            </View>

                            <View style={styles.assessItemMiddle}>
                              <Text style={styles.assessItemTopic} numberOfLines={2}>{item.topic}</Text>
                              <TouchableOpacity
                                style={[styles.assessGradeBadge, { backgroundColor: labelColor + '18' }]}
                                onPress={() => openGradePicker(item)}
                                activeOpacity={0.6}
                              >
                                <Text style={[styles.assessGradeText, { color: labelColor }]}>{label}</Text>
                                <Ionicons name="chevron-forward" size={12} color={labelColor} />
                              </TouchableOpacity>
                            </View>

                            {/* Delete button */}
                            <TouchableOpacity onPress={() => handleDelete(item)} style={styles.assessDeleteBtn}>
                              <Ionicons name="trash-outline" size={16} color={colors.red} />
                            </TouchableOpacity>
                          </View>
                        );
                      })}
                    </View>
                  ))}

                  {/* Add new category */}
                  <TouchableOpacity
                    style={styles.assessAddCatBtn}
                    activeOpacity={0.7}
                    onPress={async () => {
                      const category = await promptText('New Category', 'Enter category name:');
                      if (category) {
                        setAssessAddToCat({ day, category });
                        setAssessNewItem({ topic: '', what_good_looks_like: '', expected_outcome: '' });
                      }
                    }}
                  >
                    <Ionicons name="add" size={16} color={colors.primary} />
                    <Text style={styles.assessAddCatText}>Add Topic to {getDayLabel(day)}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </DepthCard>
            </React.Fragment>
          );
        })}
      </ScrollView>
    );
  };

  // ==================== RENDER: Modules (Stage 2/3/4) ====================

  const renderModulesSection = () => (
    <ModulesEditor
      officeId={selectedOffice}
      isSuperAdmin={!!user?.is_super_admin}
      colors={colors}
    />
  );

  // ==================== RENDER: KPIs ====================

  const renderKpiSection = () => {
    if (!targets) return null;

    const SKILL_FIELDS = [
      { key: 'target_intro', label: 'Intro' },
      { key: 'target_presentation', label: 'Presentation' },
      { key: 'target_short_story', label: 'Short Story' },
      { key: 'target_close', label: 'Close' },
      { key: 'target_signup', label: 'Signup' },
      { key: 'target_rehash', label: 'Rehash' },
    ];
    // The owner's Field IQ names. Short Stories has no Field IQ equivalent —
    // it only shows while its target is above 0 (so a leftover target can
    // still be cleared); the field itself stays in the data.
    const KPI_FIELDS = [
      { key: 'target_introductions', label: 'Spoken' },
      { key: 'target_presentations', label: 'Presented' },
      { key: 'target_short_stories', label: 'Short Stories' },
      { key: 'target_closes', label: 'Closed' },
      { key: 'target_sales', label: 'Sign-ups' },
    ].filter((f) => f.key !== 'target_short_stories' || Number((kpiTarget as any)?.target_short_stories) > 0);

    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {/* Day selector - two-bubble layout */}
        <SectionedDaySelector
          selected={kpiSelectedDay}
          onSelect={(d) => { setKpiSelectedDay(d); setKpiEditing(false); }}
          styles={styles}
          trailingRight={
            <TouchableOpacity style={styles.editToggle} onPress={() => kpiEditing ? saveKpiEdit() : startKpiEdit()}>
              <Ionicons name={kpiEditing ? 'checkmark' : 'create-outline'} size={20} color={kpiEditing ? colors.green : colors.primary} />
            </TouchableOpacity>
          }
        />

        <ScrollView style={styles.scrollView} contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 20 }]} keyboardShouldPersistTaps="handled">
          {/* Day Objective */}
          <Reveal key={`kpi-obj-${kpiSelectedDay}`}>
          <DepthCard edge="gradient" style={styles.overviewCard}>
            <View style={styles.overviewHeader}>
              <Ionicons name="flag" size={20} color={colors.primary} />
              <Text style={styles.overviewTitle}>{getDayLabel(kpiSelectedDay)} Objective</Text>
            </View>
            {kpiEditing ? (
              <TextInput
                style={[styles.editInput, styles.editMulti]}
                value={kpiFields.day_objective}
                onChangeText={t => setKpiFields(f => ({ ...f, day_objective: t }))}
                multiline
                placeholder="Day objective..."
                placeholderTextColor={colors.textMuted}
              />
            ) : (
              <Text style={styles.objectiveText}>{kpiTarget?.day_objective || 'No objective set'}</Text>
            )}
          </DepthCard>
          </Reveal>

          {/* Skill Targets (Day 2+) */}
          {kpiSelectedDay >= 2 && (
            <Reveal key={`kpi-skill-${kpiSelectedDay}`} index={1}>
            <DepthCard sheen={false} style={styles.kpiCard}>
              <View style={styles.kpiCardHeader}>
                <Ionicons name="star" size={18} color="#D97706" />
                <Text style={styles.kpiCardTitle}>Skill Targets (out of 10)</Text>
              </View>
              <View style={styles.kpiGrid}>
                {SKILL_FIELDS.map(f => (
                  <View key={f.key} style={styles.kpiFieldRow}>
                    <Text style={styles.kpiFieldLabel}>{f.label}</Text>
                    {kpiEditing ? (
                      <TextInput
                        style={styles.kpiInput}
                        value={kpiFields[f.key] || '0'}
                        onChangeText={t => setKpiFields(prev => ({ ...prev, [f.key]: t }))}
                        keyboardType="number-pad"
                        selectTextOnFocus
                      />
                    ) : (
                      <Text style={styles.kpiFieldValue}>{(kpiTarget as any)?.[f.key] ?? 0}/10</Text>
                    )}
                  </View>
                ))}
              </View>
            </DepthCard>
            </Reveal>
          )}

          {/* KPI Targets (Day 3+) */}
          {kpiSelectedDay >= 3 && (
            <Reveal key={`kpi-kpis-${kpiSelectedDay}`} index={2}>
            <DepthCard sheen={false} style={styles.kpiCard}>
              <View style={styles.kpiCardHeader}>
                <Ionicons name="bar-chart" size={18} color={colors.primary} />
                <Text style={styles.kpiCardTitle}>KPI Targets</Text>
              </View>
              <View style={styles.kpiGrid}>
                {KPI_FIELDS.map(f => (
                  <View key={f.key} style={styles.kpiFieldRow}>
                    <Text style={styles.kpiFieldLabel}>{f.label}</Text>
                    {kpiEditing ? (
                      <TextInput
                        style={styles.kpiInput}
                        value={kpiFields[f.key] || '0'}
                        onChangeText={t => setKpiFields(prev => ({ ...prev, [f.key]: t }))}
                        keyboardType="number-pad"
                        selectTextOnFocus
                      />
                    ) : (
                      <Text style={styles.kpiFieldValue}>{(kpiTarget as any)?.[f.key] ?? 0}</Text>
                    )}
                  </View>
                ))}
              </View>
            </DepthCard>
            </Reveal>
          )}

          {/* Coach Assisted Sign-ups */}
          {kpiSelectedDay >= 3 && (
            <Reveal key={`kpi-las-${kpiSelectedDay}`} index={3}>
            <DepthCard sheen={false} style={styles.kpiCard}>
              <View style={styles.kpiCardHeader}>
                <Ionicons name="shield-checkmark" size={18} color="#2F6A4B" />
                <Text style={styles.kpiCardTitle}>Coach Assisted Sign-ups</Text>
              </View>
              <View style={styles.kpiFieldRow}>
                <Text style={styles.kpiFieldLabel}>Target</Text>
                {kpiEditing ? (
                  <TextInput
                    style={styles.kpiInput}
                    value={kpiFields.leader_assisted_sales_target || '0'}
                    onChangeText={t => setKpiFields(prev => ({ ...prev, leader_assisted_sales_target: t }))}
                    keyboardType="number-pad"
                    selectTextOnFocus
                  />
                ) : (
                  <Text style={styles.kpiFieldValue}>{kpiTarget?.leader_assisted_sales_target ?? 0}</Text>
                )}
              </View>
            </DepthCard>
            </Reveal>
          )}

          {kpiSelectedDay === 1 && !kpiEditing && (
            <DepthCard sheen={false} style={styles.kpiEmptyCard}>
              <Ionicons name="information-circle" size={24} color={colors.textMuted} />
              <Text style={styles.kpiEmptyText}>Day 1 is behaviour-only. Skill and KPI targets begin from Day 2.</Text>
            </DepthCard>
          )}

          {kpiEditing && (
            <View style={styles.kpiSaveRow}>
              <TouchableOpacity style={styles.editCancel} onPress={() => setKpiEditing(false)}>
                <Text style={styles.editCancelText}>Cancel</Text>
              </TouchableOpacity>
              <GlowButton style={styles.saveGlowBtn} sheen={false} onPress={saveKpiEdit}>
                <Text style={styles.editSaveText}>Save Changes</Text>
              </GlowButton>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  };

  // ==================== RENDER: GRADE PICKER MODAL ====================
  // Stateless modal extracted to /src/manual/GradePickerModal.tsx — this
  // component just wires its props to the parent's state.
  const renderGradePickerModal = () => (
    <GradePickerModal
      visible={gradePickerVisible}
      presets={presets}
      item={gradePickerItem}
      styles={styles}
      onSelect={selectPreset}
      onClose={() => setGradePickerVisible(false)}
    />
  );

  // ==================== MAIN RENDER ====================

  return (
    <KeyboardAvoidingView
      style={[
        styles.container,
        isLandscape && { paddingLeft: insets.left, paddingRight: insets.right, paddingTop: insets.top },
      ]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Super Admin Office Picker — ink rail with one sliding tile (spec §3.13) */}
      {isSuperAdmin && offices && offices.length > 0 && (
        <View style={styles.officePicker}>
          <SlidingSegments
            style={styles.officeSegments}
            items={offices.map((o: any) => ({ key: o.id, label: o.name }))}
            value={selectedOffice ?? ''}
            onChange={(key) => { setSelectedOffice(key); setApplyAll(false); }}
          />
          {editMode && (
            <TouchableOpacity
              style={[styles.applyAllBtn, applyAll && styles.applyAllBtnActive]}
              onPress={() => setApplyAll(!applyAll)}
            >
              <Ionicons name={applyAll ? 'checkmark-circle' : 'ellipse-outline'} size={16} color={applyAll ? '#fff' : colors.textSecondary} />
              <Text style={[styles.applyAllText, applyAll && styles.applyAllTextActive]}>Apply to All</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {/* Admin: Manual | Assessments | Modules | KPIs */}
      {isAdmin && (
        <SlidingSegments
          style={styles.sectionPills}
          items={SECTION_TABS.map((k) => ({ key: k, label: SECTION_LABELS[k] }))}
          value={activeSection as SectionKey}
          onChange={(key) => { setActiveSection(key as typeof activeSection); setEditMode(false); }}
        />
      )}

      {/* Content based on active section */}
      {isAdmin && activeSection === 'assessments' ? (
        isLoading ? (
          <BrandLoader size={56} />
        ) : (
          <>
            {renderAssessmentsSection()}
            {renderGradePickerModal()}
          </>
        )
      ) : isAdmin && activeSection === 'modules' ? (
        renderModulesSection()
      ) : isAdmin && activeSection === 'kpis' ? (
        isLoading ? (
          <BrandLoader size={56} />
        ) : (
          renderKpiSection()
        )
      ) : (
        <>
          {/* Day Selector — day-card strip (Orientation 1-2 / Field 1-6) */}
          <DayStrip
            selected={selectedDay}
            onSelect={(d) => {
              setSelectedDay(d);
              setEditingItem(null);
              setShowAddForm(false);
              manualScrollRef.current?.scrollTo({ y: 0, animated: true });
            }}
            counts={dayCounts}
            trailingRight={isAdmin && activeSection === 'manual' ? (
              <TouchableOpacity testID="edit-manual-btn" style={styles.editToggle} onPress={() => { setEditMode(!editMode); setEditingItem(null); setShowAddForm(false); }}>
                <Ionicons name={editMode ? 'checkmark' : 'create-outline'} size={20} color={editMode ? colors.green : colors.primary} />
              </TouchableOpacity>
            ) : undefined}
          />

          {isLoading ? (
            <View style={styles.readSkeleton}>
              <Skeleton height={128} borderRadius={20} />
              <Skeleton width={150} height={12} borderRadius={6} style={{ marginTop: 6 }} />
              <Skeleton height={96} borderRadius={16} />
              <Skeleton height={96} borderRadius={16} />
              <Skeleton height={96} borderRadius={16} />
            </View>
          ) : (
            <NestableScrollContainer ref={manualScrollRef as any} style={[styles.scrollView, Platform.OS === 'web' ? { overflow: 'auto' as any } : {}]} contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 20 }]} keyboardShouldPersistTaps="handled">
              {/* Day mission — objective from targets, hidden silently when unset */}
              <Reveal key={`mission-${selectedDay}`}>
                <DayMissionCard
                  day={selectedDay}
                  objective={dayTarget?.day_objective}
                  itemCount={dayManual.length}
                  weightText={getWeightText()}
                  isTrainee={!!isTrainee}
                />
              </Reveal>

              {/* What Good/Great Looks Like Boxes */}
              {renderSummaryBoxes()}

              {/* Targets */}
              {selectedDay >= 2 && dayTarget && (
                <View style={styles.section}>
                  <SectionHead style={styles.sectionHead}>Skill Targets</SectionHead>
                  <View style={styles.targetsGrid}>
                    {[{ l: 'Intro', v: dayTarget.target_intro }, { l: 'Presentation', v: dayTarget.target_presentation }, { l: 'Short Story', v: dayTarget.target_short_story }, { l: 'Close', v: dayTarget.target_close }, { l: 'Signup', v: dayTarget.target_signup }, { l: 'Rehash', v: dayTarget.target_rehash }].filter(t => t.v > 0).map((t, ti) => (
                      <DepthCard key={t.l} sheen={false} index={ti} style={styles.targetItem}>
                        <StatBlock value={t.v} suffix="/10" label={t.l} size={26} align="left" />
                        <XPBar value={t.v / 10} height={6} ticks={false} tip={false} glow={false} style={styles.targetBar} />
                      </DepthCard>
                    ))}
                  </View>
                </View>
              )}
              {selectedDay >= 3 && dayTarget && (
                <View style={styles.section}>
                  <SectionHead style={styles.sectionHead}>KPI Targets</SectionHead>
                  <View style={styles.targetsGrid}>
                    {[{ l: 'Spoken', v: dayTarget.target_introductions }, { l: 'Presented', v: dayTarget.target_presentations }, { l: 'Short Stories', v: dayTarget.target_short_stories }, { l: 'Closed', v: dayTarget.target_closes }, { l: 'Sign-ups', v: dayTarget.target_sales }].filter(t => t.v > 0).map((t, ti) => (
                      <DepthCard key={t.l} sheen={false} index={ti} style={styles.targetItem}>
                        <StatBlock value={t.v} label={t.l} size={26} align="left" />
                      </DepthCard>
                    ))}
                  </View>
                </View>
              )}
              {!isTrainee && dayTarget && dayTarget.leader_assisted_sales_target > 0 && (
                <DepthCard sheen={false} style={styles.leaderTargetCard}>
                  <Ionicons name="shield-checkmark" size={18} color={colors.primary} />
                  <Text style={styles.leaderTargetText}>Coach Assisted Sign-ups Target: {dayTarget.leader_assisted_sales_target}</Text>
                </DepthCard>
              )}

              {/* Manual Items */}
              {(dayManual.length > 0 || editMode) && (
                <SectionHead style={styles.sectionHead}>{isTrainee ? 'What You Should Know' : 'What to Teach'}</SectionHead>
              )}
              {!editMode && dayManual.length === 0 && (
                <EmptyState
                  icon="book-outline"
                  title="This day is being prepared"
                  subtitle={`Topics for ${getDayLabel(selectedDay)} will appear here as soon as they're ready.`}
                />
              )}
              {categoryOrder.map((category, catIdx) => {
                const items = groupedManual[category] || [];
                // ── Reading experience — grouped cards with uppercase kickers ──
                if (!editMode) {
                  return (
                    <Reveal key={`read-${selectedDay}-${category}`} index={Math.min(catIdx + 1, 6)}>
                      <View style={styles.readCatSection}>
                        <View style={styles.readCatHead}>
                          <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.readCatTick} />
                          <Text style={styles.readCatKicker}>{category.toUpperCase()}</Text>
                          <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.readCatRule} />
                          <View style={styles.readCatCountChip}><Text style={styles.readCatCount}>{items.length}</Text></View>
                        </View>
                        <View style={styles.readCatItems}>
                          {items.map((item) => {
                            const isEditing = editingItem?.day === item.day_number && editingItem?.seq === item.sequence;
                            const displayNum = dayManual.indexOf(item) + 1;
                            if (isEditing) {
                              return (
                                <DepthCard key={item.sequence} style={styles.readEditWrap}>
                                  <View style={styles.editForm}>
                                    <Text style={styles.editLabel}>Category</Text>
                                    <TextInput style={styles.editInput} value={editFields.category} onChangeText={t => setEditFields({ ...editFields, category: t })} />
                                    <Text style={styles.editLabel}>Topic</Text>
                                    <TextInput style={styles.editInput} value={editFields.topic} onChangeText={t => setEditFields({ ...editFields, topic: t })} />
                                    <Text style={styles.editLabel}>What to Teach</Text>
                                    <TextInput style={[styles.editInput, styles.editMulti]} value={editFields.what_good_looks_like} onChangeText={t => setEditFields({ ...editFields, what_good_looks_like: t })} multiline />
                                    <Text style={styles.editLabel}>Expected Outcome</Text>
                                    <TextInput style={[styles.editInput, styles.editMulti]} value={editFields.expected_outcome} onChangeText={t => setEditFields({ ...editFields, expected_outcome: t })} multiline />
                                    <Text style={styles.editLabel}>Confidence Expected</Text>
                                    <View style={styles.confRow}>
                                      {CONFIDENCE_LEVELS.map(level => (
                                        <TouchableOpacity key={level} style={[styles.confChip, editFields.confidence_expected === level && styles.confChipActive]} onPress={() => setEditFields({ ...editFields, confidence_expected: level })}>
                                          <Text style={[styles.confChipText, editFields.confidence_expected === level && styles.confChipTextActive]}>{level}</Text>
                                        </TouchableOpacity>
                                      ))}
                                    </View>
                                    <View style={styles.editActions}>
                                      <TouchableOpacity style={styles.editCancel} onPress={() => setEditingItem(null)}><Text style={styles.editCancelText}>Cancel</Text></TouchableOpacity>
                                      <TouchableOpacity style={styles.editSave} onPress={saveEdit}><Text style={[styles.editSaveText, { color: colors.onPrimary }]}>Save</Text></TouchableOpacity>
                                    </View>
                                  </View>
                                </DepthCard>
                              );
                            }
                            return (
                              <ManualItemCard
                                key={item.sequence}
                                item={item}
                                index={displayNum}
                                role={isTrainee ? 'trainee' : 'coach'}
                              />
                            );
                          })}
                        </View>
                      </View>
                    </Reveal>
                  );
                }
                // ── Edit mode — unchanged admin editor (drag, add, pencil, delete) ──
                return (
                <DepthCard key={category} sheen={false} style={styles.categorySection}>
                  <View style={styles.categoryHeader}>
                    {editMode && (
                      <View style={styles.catReorderControls}>
                        <TouchableOpacity
                          style={[styles.reorderBtn, catIdx === 0 && styles.reorderBtnDisabled]}
                          onPress={() => moveCategory(catIdx, 'up', dayManual, categoryOrder, groupedManual, selectedDay)}
                          disabled={catIdx === 0}
                        >
                          <Ionicons name="chevron-up" size={14} color={catIdx === 0 ? colors.border : colors.textLight} />
                        </TouchableOpacity>
                        <Ionicons name="reorder-three" size={16} color={colors.textLight} style={{ opacity: 0.6 }} />
                        <TouchableOpacity
                          style={[styles.reorderBtn, catIdx === categoryOrder.length - 1 && styles.reorderBtnDisabled]}
                          onPress={() => moveCategory(catIdx, 'down', dayManual, categoryOrder, groupedManual, selectedDay)}
                          disabled={catIdx === categoryOrder.length - 1}
                        >
                          <Ionicons name="chevron-down" size={14} color={catIdx === categoryOrder.length - 1 ? colors.border : colors.textLight} />
                        </TouchableOpacity>
                      </View>
                    )}
                    <Ionicons name="book" size={18} color={colors.primary} />
                    <Text style={styles.categoryTitle}>{category}</Text>
                    {editMode && (
                      <TouchableOpacity
                        style={styles.addSubBtn}
                        onPress={() => { setAddToCategory(addToCategory === category ? null : category); setAddSubItem({ topic: '', what_good_looks_like: '', expected_outcome: '' }); }}
                      >
                        <Ionicons name="add-circle" size={22} color={colors.primary} />
                      </TouchableOpacity>
                    )}
                  </View>
                  {editMode && addToCategory === category && (
                    <View style={styles.addSubForm}>
                      <TextInput style={styles.editInput} value={addSubItem.topic} onChangeText={t => setAddSubItem({ ...addSubItem, topic: t })} placeholder="Topic name" placeholderTextColor={colors.textMuted} />
                      <TextInput style={[styles.editInput, styles.editMulti]} value={addSubItem.what_good_looks_like} onChangeText={t => setAddSubItem({ ...addSubItem, what_good_looks_like: t })} placeholder="What to teach" placeholderTextColor={colors.textMuted} multiline />
                      <TextInput style={[styles.editInput, styles.editMulti]} value={addSubItem.expected_outcome} onChangeText={t => setAddSubItem({ ...addSubItem, expected_outcome: t })} placeholder="Expected outcome" placeholderTextColor={colors.textMuted} multiline />
                      <View style={styles.editActions}>
                        <TouchableOpacity style={styles.editCancel} onPress={() => setAddToCategory(null)}><Text style={styles.editCancelText}>Cancel</Text></TouchableOpacity>
                        <TouchableOpacity style={styles.editSave} onPress={() => {
                          if (!addSubItem.topic.trim()) { showAlert('Error', 'Topic is required'); return; }
                          addMut.mutate({
                            day_number: selectedDay, category: category,
                            topic: addSubItem.topic.trim(), what_good_looks_like: addSubItem.what_good_looks_like.trim(),
                            expected_outcome: addSubItem.expected_outcome.trim(),
                            grade_options: selectedDay <= 2 ? ['Learnt', 'Not Learnt'] : ['Excellent', 'Average', 'Below Average'],
                          });
                          setAddToCategory(null);
                        }}><Text style={styles.editSaveText}>Add</Text></TouchableOpacity>
                      </View>
                    </View>
                  )}
                  {editMode ? (
                    <NestableDraggableFlatList
                      data={items}
                      keyExtractor={(item) => `${item.day_number}-${item.sequence}`}
                      onDragEnd={({ data: newOrder }) => {
                        // Reconstruct full day order: keep other categories in place, update this category
                        const otherItems = dayManual.filter(m => m.category !== category);
                        const fullOrder = [...otherItems, ...newOrder];
                        // Sort by original category order
                        const orderedSeqs = dayManual.map(orig => {
                          const updated = fullOrder.find(u => u.sequence === orig.sequence);
                          return updated ? updated.sequence : orig.sequence;
                        });
                        // Build correct order: categories in current order, items in new order within this category
                        const finalOrder: number[] = [];
                        categoryOrder.forEach(cat => {
                          if (cat === category) {
                            newOrder.forEach(item => finalOrder.push(item.sequence));
                          } else {
                            (groupedManual[cat] || []).forEach(item => finalOrder.push(item.sequence));
                          }
                        });
                        reorderMut.mutate({ day: selectedDay, ordered: finalOrder });
                      }}
                      renderItem={({ item, drag, isActive }) => {
                        const isEditingThis = editingItem?.day === item.day_number && editingItem?.seq === item.sequence;
                        const displayNum = dayManual.indexOf(item) + 1;
                        return (
                          <ScaleDecorator>
                            <View style={[styles.manualItem, isActive && { backgroundColor: colors.surfaceAlt, elevation: 3 }]}>
                              {isEditingThis ? (
                                <View style={styles.editForm}>
                                  <Text style={styles.editLabel}>Category</Text>
                                  <TextInput style={styles.editInput} value={editFields.category} onChangeText={t => setEditFields({ ...editFields, category: t })} />
                                  <Text style={styles.editLabel}>Topic</Text>
                                  <TextInput style={styles.editInput} value={editFields.topic} onChangeText={t => setEditFields({ ...editFields, topic: t })} />
                                  <Text style={styles.editLabel}>What to Teach</Text>
                                  <TextInput style={[styles.editInput, styles.editMulti]} value={editFields.what_good_looks_like} onChangeText={t => setEditFields({ ...editFields, what_good_looks_like: t })} multiline />
                                  <Text style={styles.editLabel}>Expected Outcome</Text>
                                  <TextInput style={[styles.editInput, styles.editMulti]} value={editFields.expected_outcome} onChangeText={t => setEditFields({ ...editFields, expected_outcome: t })} multiline />
                                  <Text style={styles.editLabel}>Confidence Expected</Text>
                                  <View style={styles.confRow}>
                                    {CONFIDENCE_LEVELS.map(level => (
                                      <TouchableOpacity key={level} style={[styles.confChip, editFields.confidence_expected === level && styles.confChipActive]} onPress={() => setEditFields({ ...editFields, confidence_expected: level })}>
                                        <Text style={[styles.confChipText, editFields.confidence_expected === level && styles.confChipTextActive]}>{level}</Text>
                                      </TouchableOpacity>
                                    ))}
                                  </View>
                                  <View style={styles.editActions}>
                                    <TouchableOpacity style={styles.editCancel} onPress={() => setEditingItem(null)}><Text style={styles.editCancelText}>Cancel</Text></TouchableOpacity>
                                    <TouchableOpacity style={styles.editSave} onPress={saveEdit}><Text style={[styles.editSaveText, { color: colors.onPrimary }]}>Save</Text></TouchableOpacity>
                                  </View>
                                </View>
                              ) : (
                                <>
                                  <View style={styles.manualItemHeader}>
                                    <TouchableOpacity onLongPress={drag} delayLongPress={150} style={styles.dragGrip}>
                                      <Ionicons name="reorder-three" size={22} color={colors.textMuted} />
                                    </TouchableOpacity>
                                    <View style={styles.sequenceBadge}><Text style={styles.sequenceText}>{displayNum}</Text></View>
                                    <Text style={styles.manualTopic}>{item.topic}</Text>
                                    <View style={styles.itemActions}>
                                      <TouchableOpacity onPress={() => startEdit(item)}><Ionicons name="pencil" size={18} color={colors.primary} /></TouchableOpacity>
                                      <TouchableOpacity onPress={() => handleDelete(item)}><Ionicons name="trash-outline" size={18} color={colors.red} /></TouchableOpacity>
                                    </View>
                                  </View>
                                  <View style={styles.manualDetails}>
                                    {!isTrainee && (
                                      <><View style={styles.detailRow}><Ionicons name="eye-outline" size={15} color={colors.textSecondary} /><Text style={styles.detailLabel}>What to Teach:</Text></View>
                                      <Text style={styles.detailText}>{item.what_good_looks_like}</Text></>
                                    )}
                                    <View style={styles.detailRow}><Ionicons name="checkmark-circle-outline" size={15} color={colors.green} /><Text style={styles.detailLabel}>Expected Outcome:</Text></View>
                                    <Text style={styles.detailText}>{item.expected_outcome}</Text>
                                  </View>
                                </>
                              )}
                            </View>
                          </ScaleDecorator>
                        );
                      }}
                    />
                  ) : (
                  items.map((item) => {
                    const isEditing = editingItem?.day === item.day_number && editingItem?.seq === item.sequence;
                    const displayNum = dayManual.indexOf(item) + 1;
                    return (
                      <View key={item.sequence} style={styles.manualItem}>
                        {isEditing ? (
                          <View style={styles.editForm}>
                            <Text style={styles.editLabel}>Category</Text>
                            <TextInput style={styles.editInput} value={editFields.category} onChangeText={t => setEditFields({ ...editFields, category: t })} />
                            <Text style={styles.editLabel}>Topic</Text>
                            <TextInput style={styles.editInput} value={editFields.topic} onChangeText={t => setEditFields({ ...editFields, topic: t })} />
                            <Text style={styles.editLabel}>What to Teach</Text>
                            <TextInput style={[styles.editInput, styles.editMulti]} value={editFields.what_good_looks_like} onChangeText={t => setEditFields({ ...editFields, what_good_looks_like: t })} multiline />
                            <Text style={styles.editLabel}>Expected Outcome</Text>
                            <TextInput style={[styles.editInput, styles.editMulti]} value={editFields.expected_outcome} onChangeText={t => setEditFields({ ...editFields, expected_outcome: t })} multiline />
                            <Text style={styles.editLabel}>Confidence Expected</Text>
                            <View style={styles.confRow}>
                              {CONFIDENCE_LEVELS.map(level => (
                                <TouchableOpacity key={level} style={[styles.confChip, editFields.confidence_expected === level && styles.confChipActive]} onPress={() => setEditFields({ ...editFields, confidence_expected: level })}>
                                  <Text style={[styles.confChipText, editFields.confidence_expected === level && styles.confChipTextActive]}>{level}</Text>
                                </TouchableOpacity>
                              ))}
                            </View>
                            <View style={styles.editActions}>
                              <TouchableOpacity style={styles.editCancel} onPress={() => setEditingItem(null)}><Text style={styles.editCancelText}>Cancel</Text></TouchableOpacity>
                              <TouchableOpacity style={styles.editSave} onPress={saveEdit}><Text style={[styles.editSaveText, { color: colors.onPrimary }]}>Save</Text></TouchableOpacity>
                            </View>
                          </View>
                        ) : (
                          <>
                            <View style={styles.manualItemHeader}>
                              <View style={styles.sequenceBadge}><Text style={styles.sequenceText}>{displayNum}</Text></View>
                              <Text style={styles.manualTopic}>{item.topic}</Text>
                            </View>
                            <View style={styles.manualDetails}>
                              {!isTrainee && (
                                <><View style={styles.detailRow}><Ionicons name="eye-outline" size={15} color={colors.textSecondary} /><Text style={styles.detailLabel}>What to Teach:</Text></View>
                                <Text style={styles.detailText}>{item.what_good_looks_like}</Text></>
                              )}
                              <View style={styles.detailRow}><Ionicons name="checkmark-circle-outline" size={15} color={colors.green} /><Text style={styles.detailLabel}>Expected Outcome:</Text></View>
                              <Text style={styles.detailText}>{item.expected_outcome}</Text>
                            </View>
                          </>
                        )}
                      </View>
                    );
                  })
                  )}
                </DepthCard>
              )})}

              {editMode && !showAddForm && (
                <GlowButton style={styles.addItemBtn} onPress={() => setShowAddForm(true)}>
                  <Ionicons name="add-circle" size={22} color="#fff" />
                  <Text style={styles.addItemText}>Add Topic to {getDayLabel(selectedDay)}</Text>
                </GlowButton>
              )}
              {editMode && showAddForm && (
                <DepthCard edge="gradient" style={styles.addForm}>
                  <Text style={styles.addFormTitle}>Add New Topic</Text>
                  <Text style={styles.editLabel}>Category</Text>
                  <TextInput style={styles.editInput} value={newItem.category} onChangeText={t => setNewItem({ ...newItem, category: t })} placeholder="e.g. 5 Steps, Behaviour, Signup" placeholderTextColor={colors.textMuted} />
                  <Text style={styles.editLabel}>Topic</Text>
                  <TextInput style={styles.editInput} value={newItem.topic} onChangeText={t => setNewItem({ ...newItem, topic: t })} placeholder="Topic name" placeholderTextColor={colors.textMuted} />
                  <Text style={styles.editLabel}>What to Teach</Text>
                  <TextInput style={[styles.editInput, styles.editMulti]} value={newItem.what_good_looks_like} onChangeText={t => setNewItem({ ...newItem, what_good_looks_like: t })} placeholder="Teaching guidance" placeholderTextColor={colors.textMuted} multiline />
                  <Text style={styles.editLabel}>Expected Outcome</Text>
                  <TextInput style={[styles.editInput, styles.editMulti]} value={newItem.expected_outcome} onChangeText={t => setNewItem({ ...newItem, expected_outcome: t })} placeholder="What the new BA should achieve" placeholderTextColor={colors.textMuted} multiline />
                  <View style={styles.editActions}>
                    <TouchableOpacity style={styles.editCancel} onPress={() => setShowAddForm(false)}><Text style={styles.editCancelText}>Cancel</Text></TouchableOpacity>
                    <TouchableOpacity style={styles.editSave} onPress={handleAdd}><Text style={styles.editSaveText}>Add</Text></TouchableOpacity>
                  </View>
                </DepthCard>
              )}
            </NestableScrollContainer>
          )}
        </>
      )}
    </KeyboardAvoidingView>
  );
}

// ==================== STYLES ====================

const createStyles = (colors: any) => {
  const isDark = String(colors.background).toLowerCase() !== '#ffffff';
  // Tinted card backgrounds — light pastels in light mode, translucent in dark
  const blueBg    = isDark ? 'rgba(140, 175, 56, 0.12)' : '#F7FAF1';
  const blueBdr   = isDark ? 'rgba(140, 175, 56, 0.30)' : '#E2EFC4';
  const blueText  = isDark ? '#D5E9A6' : '#2F6A4B';
  const blueChip  = isDark ? 'rgba(140, 175, 56, 0.20)' : '#EAF2DA';
  const blueChipText = isDark ? '#E2EFC4' : '#56731B';
  const purpleBg    = isDark ? 'rgba(58, 122, 86, 0.18)' : '#EAF2DA';
  const purpleBdr   = isDark ? 'rgba(140, 175, 56, 0.40)' : '#AEC879';
  const purpleText  = isDark ? '#AEC879' : '#2F6A4B';
  const purpleDeepText = isDark ? '#D2E1B5' : '#244C3B';
  const purpleInputBg = isDark ? 'rgba(58, 122, 86, 0.10)' : '#E7EFD7';
  const purpleDot    = isDark ? '#8CAF38' : '#2F6A4B';
  // Spec 2.1: the new rgba tokens are never concatenated. This is the literal
  // glow lift shadow (same 0.45 / 0.65 alpha the glow token carries per theme).
  const glowLift = isDark ? '0 6px 14px -6px rgba(140, 175, 56, 0.65)' : '0 6px 14px -6px rgba(140, 175, 56, 0.45)';
  return StyleSheet.create({
  container: { flex: 1 },
  // Top chrome rides the page field (no white band) — the ink rails carry it.
  officePicker: { paddingTop: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionPills: { marginHorizontal: 12, marginTop: 10, marginBottom: 2 },
  officeSegments: { flex: 1 },
  applyAllBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.surfaceAlt, marginLeft: 8 },
  applyAllBtnActive: { backgroundColor: '#D97706' },
  applyAllText: { fontSize: 11, fontWeight: '600', color: colors.textSecondary },
  applyAllTextActive: { color: '#fff' },
  // ── Sectioned day selector (Orientation / Field bubbles) ──
  daySectionWrap: { flexDirection: 'row', alignItems: 'stretch', paddingVertical: 10, paddingHorizontal: 12, gap: 8 },
  daySectionContent: { flex: 1, gap: 8 },
  daySectionTrailing: { justifyContent: 'center', alignItems: 'center' },
  sectionBubble: { backgroundColor: colors.background, borderRadius: 16, paddingVertical: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.border, boxShadow: colors.depthShadow },
  sectionBubbleHeader: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4, paddingHorizontal: 2 },
  sectionBubbleLabel: { fontFamily: fonts.displayWide, fontSize: 9.5, color: colors.textMuted, letterSpacing: 1.2, textTransform: 'uppercase' },
  sectionBubbleRow: { flexDirection: 'row', gap: 6, paddingRight: 4 },
  bubbleDayBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 14, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  bubbleDayBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary, boxShadow: glowLift },
  bubbleDayText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  bubbleDayTextActive: { color: colors.onPrimary },
  // ── Assessments section headers (Orientation / Field) ──
  assessSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, marginBottom: 8, paddingHorizontal: 4 },
  assessSectionHeaderText: { fontFamily: fonts.displayWide, fontSize: 10.5, color: colors.textSecondary, letterSpacing: 1.4, textTransform: 'uppercase' },
  editToggle: { paddingHorizontal: 14, paddingVertical: 8 },
  scrollView: { flex: 1 },
  content: { padding: 16 },
  overviewCard: { borderRadius: 18, padding: 18, marginBottom: 16 },
  overviewHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  overviewTitle: { fontFamily: fonts.display, fontSize: 17, fontWeight: '700', color: colors.primary, flex: 1 },
  objectiveText: { fontSize: 14.5, color: colors.text, marginBottom: 4, lineHeight: 22, fontWeight: '500' },
  weightText: { fontSize: 13, color: blueChipText, fontWeight: '600', backgroundColor: blueChip, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  section: { marginBottom: 20 },
  sectionHead: { marginBottom: 14, marginTop: 4 },
  // ── Reading experience (non-edit manual view) ──
  readSkeleton: { padding: 16, gap: 12 },
  readCatSection: { marginBottom: 18 },
  readCatHead: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 12, marginTop: 2, paddingHorizontal: 2 },
  readCatTick: { width: 16, height: 3, borderRadius: 1.5 },
  // Category kicker colour is split per theme because no single brand token
  // clears 4.5:1 on BOTH page fields (measured on the rendered glyph):
  //   dark  page #061410: primary #7fa032 = 6.32:1, primaryDark #2f6a4b = 3.12:1
  //   light page #F0F4E9: primaryDark #244c3b = 7.27:1 (4.35:1 at the darkest
  //                       PageField blob), primary #2f6a4b = 5.30:1 (3.17:1 there)
  // so each theme takes the token that is the stronger of the two on its own field.
  readCatKicker: { fontFamily: fonts.displayWide, fontSize: 10.5, color: isDark ? colors.primary : colors.primaryDark, letterSpacing: 1.3 },
  readCatRule: { flex: 1, height: 2, borderRadius: 1, opacity: 0.35 },
  readCatCountChip: { minWidth: 22, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  readCatCount: { fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.textSecondary },
  readCatItems: { gap: 10 },
  readEditWrap: { borderRadius: 18, padding: 14 },
  targetsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  targetItem: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 16, minWidth: 150, flexGrow: 1, flexBasis: '45%' },
  targetBar: { marginTop: 10 },
  leaderTargetCard: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, padding: 14, marginBottom: 20 },
  leaderTargetText: { flex: 1, fontSize: 14, fontWeight: '600', color: purpleText },
  categorySection: { borderRadius: 18, marginBottom: 16 },
  categoryHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14, backgroundColor: colors.surfaceAlt, borderTopLeftRadius: 17, borderTopRightRadius: 17 },
  catReorderControls: { alignItems: 'center', marginRight: 2 },
  addSubBtn: { marginLeft: 'auto' },
  addSubForm: { padding: 14, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  categoryTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  manualItem: { padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  manualItemHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  reorderControls: { alignItems: 'center', marginRight: 4 },
  reorderBtn: { padding: 2 },
  reorderBtnDisabled: { opacity: 0.3 },
  dragGrip: { paddingVertical: 8, paddingHorizontal: 4, marginRight: 4 },
  wgllDragHandle: { paddingVertical: 4, paddingHorizontal: 2, marginRight: 4 },
  sequenceBadge: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  sequenceText: { fontSize: 12, fontWeight: '600', color: colors.onPrimary },
  manualTopic: { fontSize: 15, fontWeight: '600', color: colors.text, flex: 1 },
  itemActions: { flexDirection: 'row', gap: 12 },
  manualDetails: { marginLeft: 34 },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  detailLabel: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  detailText: { fontSize: 13, color: colors.text, marginLeft: 21, marginTop: 2, lineHeight: 18 },
  editForm: { gap: 8 },
  editLabel: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  editInput: { backgroundColor: colors.surfaceAlt, borderRadius: 8, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  editMulti: { minHeight: 60, textAlignVertical: 'top' },
  editActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  confRow: { flexDirection: 'row', gap: 8 },
  confChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  confChipActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  confChipText: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },
  confChipTextActive: { color: colors.onPrimary },
  editCancel: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  editCancelText: { color: colors.textSecondary, fontWeight: '600' },
  editSave: { flex: 2, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center' },
  saveGlowBtn: { flex: 2, borderRadius: 12, paddingVertical: 10 },
  editSaveText: { color: colors.textLight, fontWeight: '600' },
  addItemBtn: { borderRadius: 16, paddingVertical: 15 },
  addItemText: { fontFamily: fonts.bodyBold, fontSize: 15, color: '#ffffff' },
  addForm: { borderRadius: 18, padding: 16, gap: 8 },
  addFormTitle: { fontFamily: fonts.display, fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 },
  loader: { flex: 1, justifyContent: 'center' },
  // ==================== WGLL STYLES ====================
  // NOTE: SummaryBox.tsx:116 applies GOOD_STYLE/GREAT_STYLE.bg INLINE over this
  // style, so in dark the fill is a hard-coded pastel and purpleBg never wins
  // (cross-file - flagged for SummaryBox's owner). Until that is fixed, dark
  // drops the depth shadow so the card is not ALSO raised off the abyss.
  wgllCard: { backgroundColor: purpleBg, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: purpleText, borderWidth: 1, borderColor: purpleBdr },
  wgllHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  wgllTitle: { fontFamily: fonts.display, fontSize: 15.5, fontWeight: '700', color: purpleText, flex: 1 },
  wgllEditBtn: { padding: 4 },
  wgllBulletList: { gap: 8 },
  wgllBulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  wgllDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: purpleDot, marginTop: 6 },
  wgllBulletText: { flex: 1, fontSize: 14, color: purpleDeepText, lineHeight: 20 },
  wgllEditList: { gap: 8 },
  wgllEditRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  wgllEditInput: { flex: 1, backgroundColor: purpleInputBg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: purpleDeepText, borderWidth: 1, borderColor: purpleBdr },
  wgllRemoveBtn: { padding: 4 },
  wgllAddRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  wgllAddInput: { flex: 1, backgroundColor: purpleInputBg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: purpleDeepText, borderWidth: 1, borderColor: purpleBdr, borderStyle: 'dashed' },
  wgllAddBtn: { padding: 2 },
  wgllEmptyCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: purpleBg, borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 2, borderColor: purpleBdr, borderStyle: 'dashed' },
  wgllEmptyText: { fontSize: 14, fontWeight: '600', color: purpleText },
  // ==================== ASSESSMENTS STYLES ====================
  assessIntro: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, padding: 14, marginBottom: 16 },
  assessIntroText: { flex: 1, fontSize: 13, color: colors.primary, lineHeight: 18 },
  assessDayCard: { borderRadius: 18, marginBottom: 12 },
  assessDayHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  assessDayBadge: { backgroundColor: colors.primary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, boxShadow: glowLift },
  assessDayBadgeText: { fontFamily: fonts.displayWide, fontSize: 11, color: colors.onPrimary, letterSpacing: 0.6, textTransform: 'uppercase' },
  assessDayCount: { fontSize: 13, color: colors.textSecondary },
  assessDayContent: { borderTopWidth: 1, borderTopColor: colors.border },
  assessCatGroup: { borderBottomWidth: 1, borderBottomColor: colors.border },
  assessCatHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.surfaceAlt },
  assessCatReorder: { alignItems: 'center', marginRight: 4 },
  assessCatTitle: { fontSize: 13, fontWeight: '600', color: colors.text, flex: 1 },
  assessAddForm: { padding: 14, gap: 8, backgroundColor: colors.surface },
  assessItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  assessItemReorder: { alignItems: 'center', marginRight: 6, width: 22 },
  assessItemMiddle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  assessItemTopic: { flex: 1, fontSize: 13, color: colors.text },
  assessGradeBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6 },
  assessGradeText: { fontSize: 11, fontWeight: '600' },
  assessDeleteBtn: { padding: 6, marginLeft: 4 },
  assessAddCatBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, backgroundColor: colors.surfaceAlt, borderBottomLeftRadius: 17, borderBottomRightRadius: 17 },
  assessAddCatText: { fontSize: 13, fontWeight: '600', color: colors.primary },
  // ==================== KPI STYLES ====================
  kpiCard: { borderRadius: 18, padding: 16, marginBottom: 12 },
  kpiCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  kpiCardTitle: { fontFamily: fonts.display, fontSize: 15, fontWeight: '700', color: colors.text },
  kpiGrid: { gap: 8 },
  kpiFieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, paddingHorizontal: 4 },
  kpiFieldLabel: { fontSize: 14, color: colors.textSecondary, flex: 1 },
  kpiFieldValue: { fontFamily: fonts.mono, fontSize: 16, fontWeight: '700', color: colors.primary, minWidth: 50, textAlign: 'right' },
  kpiInput: { backgroundColor: colors.surfaceAlt, borderRadius: 8, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16, fontWeight: '600', color: colors.primary, minWidth: 70, textAlign: 'center' },
  kpiSaveRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  kpiEmptyCard: { borderRadius: 18, padding: 24, alignItems: 'center', gap: 8 },
  kpiEmptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  // ==================== MODAL STYLES ====================
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 40 },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 4 },
  modalSubtitle: { fontSize: 13, color: colors.textSecondary, marginBottom: 20 },
  presetList: { gap: 12 },
  presetOption: { backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.border },
  presetHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  presetDot: { width: 10, height: 10, borderRadius: 5 },
  presetLabel: { fontSize: 15, fontWeight: '600' },
  presetOptionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  presetChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  presetChipText: { fontSize: 12, fontWeight: '500' },
  modalCancel: { marginTop: 16, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  modalCancelText: { fontSize: 15, fontWeight: '600', color: colors.textSecondary },
});
};
