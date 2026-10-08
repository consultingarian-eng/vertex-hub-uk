/**
 * DayGuideSheet + DayTopicsList — "what good looks like" for the 8-day flow.
 *
 * DayTopicsList renders a day's checklist/manual items grouped by category:
 *   • mode="leader"  → the coaching crib sheet: WHAT TO TEACH
 *     (`what_good_looks_like`) + the outcome to check for.
 *   • mode="trainee" → what the new hire sees: the topic + `expected_outcome`
 *     phrased as "what good looks like", a confidence-expected badge, and
 *     (after grading) their grade chip.
 *
 * DayGuideSheet wraps the leader list in a bottom sheet (same Modal pattern
 * as ChoiceSheet) so a leader can review the whole day's teaching guide from
 * the grader — before, during, or at the end of the day.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '../../theme/ThemeContext';
import { fonts } from '../../theme/brand';
import { displayGrade } from '../../manual/utils';

export type GuideItem = {
  id?: string;
  topic: string;
  category?: string;
  what_good_looks_like?: string;
  expected_outcome?: string;
  confidence_expected?: string;
  grade?: string | null;
};

const CONFIDENCE_TONES: Record<string, string> = {
  understand: '#4353ff',
  assisted: '#f59e0b',
  independent: '#10b981',
};

export function groupByCategory(items: GuideItem[]): Array<{ category: string; items: GuideItem[] }> {
  const map = new Map<string, GuideItem[]>();
  for (const it of items) {
    const cat = it.category || 'General';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(it);
  }
  return Array.from(map.entries()).map(([category, list]) => ({ category, items: list }));
}

export function DayTopicsList({ items, mode }: { items: GuideItem[]; mode: 'leader' | 'trainee' }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const groups = useMemo(() => groupByCategory(items), [items]);

  return (
    <View style={{ gap: 14 }}>
      {groups.map((g) => (
        <View key={g.category}>
          <Text style={styles.category}>{g.category.toUpperCase()}</Text>
          <View style={{ gap: 8 }}>
            {g.items.map((it, i) => {
              const conf = (it.confidence_expected || '').toLowerCase();
              const confTone = CONFIDENCE_TONES[conf] || colors.textMuted;
              return (
                <View key={it.id || `${g.category}-${i}`} style={styles.item}>
                  <View style={styles.itemHead}>
                    <Text style={styles.topic}>{it.topic}</Text>
                    {it.confidence_expected ? (
                      <View style={[styles.confChip, { backgroundColor: confTone + '1a' }]}>
                        <Text style={[styles.confText, { color: confTone }]}>{it.confidence_expected}</Text>
                      </View>
                    ) : null}
                  </View>
                  {mode === 'leader' && it.what_good_looks_like ? (
                    <View style={styles.block}>
                      <Text style={styles.blockLabel}>WHAT TO TEACH</Text>
                      <Text style={styles.blockText}>{it.what_good_looks_like}</Text>
                    </View>
                  ) : null}
                  {it.expected_outcome ? (
                    <View style={styles.block}>
                      <Text style={[styles.blockLabel, { color: '#10b981' }]}>
                        {mode === 'leader' ? 'OUTCOME TO CHECK' : 'WHAT GOOD LOOKS LIKE'}
                      </Text>
                      <Text style={styles.blockText}>{it.expected_outcome}</Text>
                    </View>
                  ) : null}
                  {mode === 'trainee' && it.grade ? (
                    <View style={styles.gradeRow}>
                      <Ionicons name="checkmark-circle" size={14} color={colors.primary} />
                      <Text style={styles.gradeText}>Graded: {displayGrade(it.grade)}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

export function DayGuideSheet({
  visible, onClose, dayLabel, objective, items,
}: {
  visible: boolean;
  onClose: () => void;
  dayLabel: string;
  objective?: string;
  items: GuideItem[];
}) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.grabber} />
        <View style={styles.sheetHead}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sheetTitle}>Day guide · {dayLabel}</Text>
            {objective ? <Text style={styles.sheetSub}>{objective}</Text> : null}
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={22} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}>
          <DayTopicsList items={items} mode="leader" />
        </ScrollView>
      </View>
    </Modal>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  category: {
    fontFamily: fonts.mono, fontSize: 10, fontWeight: '700', color: colors.primary,
    letterSpacing: 1.2, marginBottom: 7,
  },
  item: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    padding: 12, gap: 8,
  },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  topic: { flex: 1, fontFamily: fonts.display, fontSize: 14, fontWeight: '800', color: colors.text },
  confChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  confText: { fontSize: 10, fontWeight: '700' },
  block: { gap: 3 },
  blockLabel: { fontFamily: fonts.mono, fontSize: 9, fontWeight: '700', color: colors.primary, letterSpacing: 1 },
  blockText: { fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
  gradeRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  gradeText: { fontSize: 12, fontWeight: '700', color: colors.primary },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    backgroundColor: colors.background, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    maxHeight: '82%', paddingTop: 8,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 8 },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 16, paddingBottom: 12 },
  sheetTitle: { fontFamily: fonts.display, fontSize: 17, fontWeight: '900', color: colors.text },
  sheetSub: { fontSize: 12.5, color: colors.textSecondary, marginTop: 3, lineHeight: 18 },
});

export default DayGuideSheet;
