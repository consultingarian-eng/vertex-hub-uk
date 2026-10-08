/**
 * Skill Grading — one day's delivery checklist, graded topic by topic.
 *
 * Visual system ("Ink & Cube", spec §4 P1): the summary is a white DepthCard
 * with oversized Unbounded numerals on gradient accent bars and an XP bar for
 * the graded share; each category is a DepthCard headed by an ink band.
 * Loops: one XP-bar tip. Everything else is static.
 */
import React, { useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../../src/theme/colors';
import { lightColors } from '../../src/theme/ThemeContext';
import { useColors, useTheme, fonts, GRADIENT } from '../../src/theme/ThemeContext';
import { apiService, DeliveryChecklist } from '../../src/api/client';
import { BrandLoader } from '../../src/components/ui/BrandLoader';
import { useTabBarClearance } from '../../src/customization/CustomTabBar';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { XPBar } from '../../src/components/ui/XPBar';

const GRADES = ['Excellent', 'Average', 'Below Average'] as const;
const gradeColor = (g: string | null) => {
  if (g === 'Excellent') return { bg: '#DCFCE7', text: '#16A34A', icon: 'star' as const };
  if (g === 'Average') return { bg: '#FEF9C3', text: '#CA8A04', icon: 'remove-circle' as const };
  if (g === 'Below Average') return { bg: '#FEE2E2', text: '#DC2626', icon: 'arrow-down-circle' as const };
  return { bg: colors.surfaceAlt, text: colors.textMuted, icon: 'ellipse-outline' as const };
};

/**
 * Avg-Grade numeral tones. The raw status tokens fail on the white DepthCard
 * (#10B981 ~2.2:1, #D97706 ~3.4:1 — both under even the 3:1 large-text floor)
 * and the numeral is 26px Unbounded-Black, so light gets the darker twins
 * (5.5-6.5:1 on white) while dark keeps the bright stops (7-8:1 on #102D25).
 * Same pattern as day/[id].tsx's SCORE_TONES.
 */
const GRADE_TONES = {
  light: { good: '#047857', mid: '#B45309', bad: '#B91C1C' },
  dark: { good: '#10b981', mid: '#f59e0b', bad: '#ef4444' },
} as const;

const confColor = (c: string) => {
  if (c === 'Independent') return { bg: '#DCFCE7', text: '#16A34A' };
  if (c === 'Assisted') return { bg: '#FEF9C3', text: '#CA8A04' };
  return { bg: '#EAF2DA', text: '#56731B' };
};

export default function ChecklistScreen() {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const styles = useMemo(() => createStyles(colors), [colors]);
  const gradeTones = isDark ? GRADE_TONES.dark : GRADE_TONES.light;

  const { id } = useLocalSearchParams<{ id: string }>();
  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();

  const { data: items, isLoading } = useQuery({
    queryKey: ['checklist', id],
    queryFn: () => apiService.getChecklist(id!).then(r => r.data),
    enabled: !!id,
  });

  const updateMutation = useMutation({
    mutationFn: ({ itemId, data }: { itemId: string; data: Partial<DeliveryChecklist> }) =>
      apiService.updateChecklistItem(itemId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['checklist', id] });
      queryClient.invalidateQueries({ queryKey: ['assessments'] });
      queryClient.invalidateQueries({ queryKey: ['assessment'] });
    },
  });

  const handleGrade = (itemId: string, grade: string) => {
    updateMutation.mutate({ itemId, data: { grade, taught: true, outcome_achieved: grade !== 'Below Average' } });
  };

  const handleToggleTaught = (itemId: string, current: boolean) => {
    updateMutation.mutate({ itemId, data: { taught: !current } });
  };

  // Group by category
  const grouped = (items || []).reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, DeliveryChecklist[]>);

  const totalItems = items?.length || 0;
  const gradedItems = items?.filter(i => i.grade).length || 0;
  const taughtItems = items?.filter(i => i.taught).length || 0;
  const avgGrade = items && items.length > 0
    ? items.reduce((sum, i) => {
        if (i.grade === 'Excellent') return sum + 10;
        if (i.grade === 'Average') return sum + 7;
        if (i.grade === 'Below Average') return sum + 4;
        return sum;
      }, 0) / (gradedItems || 1)
    : 0;

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <BrandLoader size={56} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 20 }]}
      >
        {/* Summary Card */}
        <DepthCard style={styles.summaryCard} sheen>
          <View style={styles.summaryRow}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{taughtItems}/{totalItems}</Text>
              <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.summaryAccent} />
              <Text style={styles.summaryLabel}>Taught</Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{gradedItems}/{totalItems}</Text>
              <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.summaryAccent} />
              <Text style={styles.summaryLabel}>Graded</Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={[styles.summaryValue, {
                color: avgGrade >= 9 ? gradeTones.good : avgGrade >= 7 ? gradeTones.mid : avgGrade > 0 ? gradeTones.bad : colors.textMuted
              }]}>
                {gradedItems > 0 ? avgGrade.toFixed(1) : '-'}
              </Text>
              <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.summaryAccent} />
              <Text style={styles.summaryLabel}>Avg Grade</Text>
            </View>
          </View>
          <XPBar value={totalItems ? gradedItems / totalItems : 0} height={12} style={styles.summaryBar} />
        </DepthCard>

        {/* Checklist Items */}
        {Object.entries(grouped).map(([category, catItems]) => (
          <DepthCard key={category} style={styles.categorySection}>
            <View style={[styles.categoryHeader, { backgroundColor: isDark ? colors.surfaceAlt : colors.ink }]}>
              <Ionicons name="book" size={18} color={colors.primaryLight} />
              <Text style={styles.categoryTitle}>{category}</Text>
              <Text style={styles.categoryCount}>
                {catItems.filter(i => i.grade).length}/{catItems.length}
              </Text>
              <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.categoryRule} />
            </View>

            {catItems.map(item => {
              const cc = confColor(item.confidence_expected);
              return (
                <View key={item.id} style={styles.checklistItem}>
                  <View style={styles.itemHeader}>
                    <TouchableOpacity
                      testID={`taught-toggle-${item.id}`}
                      style={[styles.taughtToggle, item.taught && styles.taughtToggleActive]}
                      onPress={() => handleToggleTaught(item.id, item.taught)}
                    >
                      <Ionicons
                        name={item.taught ? 'checkmark-circle' : 'ellipse-outline'}
                        size={22}
                        color={item.taught ? colors.green : colors.textMuted}
                      />
                    </TouchableOpacity>
                    <View style={styles.itemInfo}>
                      <Text style={styles.itemTopic}>{item.topic}</Text>
                      <View style={[styles.confBadge, { backgroundColor: cc.bg }]}>
                        <Text style={[styles.confText, { color: cc.text }]}>
                          Expected: {item.confidence_expected}
                        </Text>
                      </View>
                    </View>
                  </View>

                  {/* Grade Selector */}
                  <View style={styles.gradeRow}>
                    {GRADES.map(grade => {
                      const isSelected = item.grade === grade;
                      const gc2 = gradeColor(grade);
                      return (
                        <TouchableOpacity
                          key={grade}
                          testID={`grade-${item.id}-${grade.toLowerCase().replace(' ', '-')}`}
                          style={[
                            styles.gradeButton,
                            isSelected && { backgroundColor: gc2.bg, borderColor: gc2.text, borderWidth: 1.5 }
                          ]}
                          onPress={() => handleGrade(item.id, grade)}
                        >
                          <Ionicons name={gc2.icon} size={16} color={isSelected ? gc2.text : colors.textMuted} />
                          <Text style={[
                            styles.gradeButtonText,
                            isSelected && { color: gc2.text, fontFamily: fonts.bodyBold }
                          ]}>
                            {grade}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </DepthCard>
        ))}
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  scrollView: { flex: 1 },
  content: { padding: 16 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  summaryCard: { borderRadius: 22, padding: 18, marginBottom: 20 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 16 },
  summaryItem: { alignItems: 'center' },
  // Unbounded-Black numerals — never stack fontWeight on displayBlack.
  summaryValue: { fontFamily: fonts.displayBlack, fontSize: 26, letterSpacing: -1, color: colors.primary },
  summaryAccent: { width: 24, height: 2, borderRadius: 1, marginTop: 6 },
  summaryLabel: {
    fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.6,
    textTransform: 'uppercase', color: colors.textMuted, marginTop: 6,
  },
  summaryBar: { marginTop: 2 },
  categorySection: { borderRadius: 20, marginBottom: 16, overflow: 'hidden' },
  // The printed section tab. Fill is set per theme at the call site: `ink`
  // (#0e271f) is within a hair of the dark card face (#102D25), so in dark the
  // band read as no band at all — dark uses `surfaceAlt` (#18392E) instead.
  // Children stay inkText/inkMuted, which read on either fill.
  categoryHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14,
  },
  categoryRule: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2 },
  categoryTitle: { fontFamily: fonts.display, fontSize: 15, color: colors.inkText, flex: 1 },
  categoryCount: { fontFamily: fonts.mono, fontSize: 12, color: colors.inkMuted, letterSpacing: 0.6 },
  checklistItem: { padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  itemHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  taughtToggle: { paddingTop: 2 },
  taughtToggleActive: {},
  itemInfo: { flex: 1 },
  itemTopic: { fontFamily: fonts.display, fontSize: 15, color: colors.text, marginBottom: 4 },
  confBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: 'flex-start' },
  confText: { fontFamily: fonts.bodySemibold, fontSize: 11 },
  gradeRow: { flexDirection: 'row', gap: 8, marginLeft: 32 },
  gradeButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  gradeButtonText: { fontFamily: fonts.bodyMedium, fontSize: 11, color: colors.textMuted },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
