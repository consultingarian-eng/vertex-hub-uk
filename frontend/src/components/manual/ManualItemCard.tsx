/**
 * ManualItemCard — one readable topic card in the Training Manual.
 *
 * Anatomy: sequence chip + topic headline (display font) + a confidence
 * "ladder" chip (Understand → Assisted → Independent, each with its own
 * tint and rising rungs). Trainees read outcome-first ("You'll be able
 * to"); coaches (leaders/admins) also get the teaching script parsed into
 * headings/lists/paragraphs via the shared cod/parseNotes parser —
 * collapsed to a 3-line preview with Read more so the day stays scannable.
 *
 * Read-only by design: the admin pencil/drag/add flows live in the screen's
 * edit mode, which renders its own editor UI instead of this card.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../theme/ThemeContext';
import { fonts } from '../../theme/brand';
import { parseNotes } from '../cod/parseNotes';
import { NotesBlocks } from '../cod/NotesBlocks';
import type { TrainingManualItem } from '../../api/client';

const LADDER = ['understand', 'assisted', 'independent'];

export type ManualItemCardProps = {
  item: TrainingManualItem;
  /** 1-based display number within the day. */
  index: number;
  /** trainee = outcome-first; coach = teach script + outcome. */
  role: 'trainee' | 'coach';
};

export function ManualItemCard({ item, index, role }: ManualItemCardProps) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [expanded, setExpanded] = useState(false);

  const conf = (item.confidence_expected || '').trim();
  const rung = LADDER.indexOf(conf.toLowerCase());
  const confTone = rung === 0 ? colors.info : rung === 1 ? colors.yellow : rung === 2 ? colors.green : colors.textMuted;

  const teach = role === 'coach' ? (item.what_good_looks_like || '').trim() : '';
  const teachBlocks = useMemo(() => (teach ? parseNotes(teach) : []), [teach]);
  const teachPreview = useMemo(() => teach.replace(/\s+/g, ' ').trim(), [teach]);
  const collapsible = teach.length > 180 || teach.includes('\n');

  const outcome = (item.expected_outcome || '').trim();

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.seqChip}><Text style={styles.seqText}>{index}</Text></View>
        <Text style={styles.topic}>{item.topic}</Text>
        {conf ? (
          <View style={[styles.confChip, { backgroundColor: confTone + '1A', borderColor: confTone + '33' }]}>
            <View style={styles.rungRow}>
              {LADDER.map((_, i) => (
                <View
                  key={i}
                  style={[styles.rung, { height: 5 + i * 2, backgroundColor: i <= rung ? confTone : confTone + '2E' }]}
                />
              ))}
            </View>
            <Text style={[styles.confText, { color: confTone }]}>{conf}</Text>
          </View>
        ) : null}
      </View>

      {role === 'coach' && teach ? (
        <View style={styles.teachWrap}>
          <Text style={styles.teachLabel}>HOW TO TEACH IT</Text>
          {!collapsible ? (
            <NotesBlocks blocks={teachBlocks} accent={colors.primary} />
          ) : expanded ? (
            <>
              <NotesBlocks blocks={teachBlocks} accent={colors.primary} />
              <TouchableOpacity style={styles.moreRow} onPress={() => setExpanded(false)} activeOpacity={0.7}>
                <Text style={styles.moreText}>Show less</Text>
                <Ionicons name="chevron-up" size={13} color={colors.primary} />
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity onPress={() => setExpanded(true)} activeOpacity={0.7}>
              <Text style={styles.preview} numberOfLines={3}>{teachPreview}</Text>
              <View style={styles.moreRow}>
                <Text style={styles.moreText}>Read more</Text>
                <Ionicons name="chevron-down" size={13} color={colors.primary} />
              </View>
            </TouchableOpacity>
          )}
        </View>
      ) : null}

      {outcome ? (
        <View style={styles.outcome}>
          <View style={styles.outcomeHead}>
            <Ionicons name="checkmark-circle" size={13} color={colors.green} />
            <Text style={styles.outcomeLabel}>{role === 'trainee' ? "YOU'LL BE ABLE TO" : "THEY'LL BE ABLE TO"}</Text>
          </View>
          <Text style={styles.outcomeText}>{outcome}</Text>
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  card: {
    backgroundColor: colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: colors.border, padding: 14, gap: 10,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  seqChip: {
    minWidth: 22, height: 22, borderRadius: 7, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary + '16', borderWidth: 1, borderColor: colors.primary + '2E',
  },
  seqText: { fontFamily: fonts.monoSemibold, fontSize: 11, fontWeight: '700', color: colors.primary },
  topic: { flex: 1, fontFamily: fonts.display, fontSize: 15, fontWeight: '800', color: colors.text, lineHeight: 20 },
  confChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1,
  },
  rungRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 1.5 },
  rung: { width: 3, borderRadius: 1 },
  confText: { fontSize: 10, fontWeight: '700' },
  teachWrap: { gap: 2 },
  teachLabel: { fontFamily: fonts.mono, fontSize: 9, fontWeight: '700', color: colors.primary, letterSpacing: 1.1, marginBottom: 4 },
  preview: { fontFamily: fonts.body, fontSize: 13.5, color: colors.textSecondary, lineHeight: 19.5 },
  moreRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 6, alignSelf: 'flex-start' },
  moreText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  outcome: {
    backgroundColor: colors.green + '12', borderWidth: 1, borderColor: colors.green + '30',
    borderRadius: 12, padding: 11, gap: 4,
  },
  outcomeHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  outcomeLabel: { fontFamily: fonts.mono, fontSize: 9, fontWeight: '700', color: colors.green, letterSpacing: 1.1 },
  outcomeText: { fontFamily: fonts.body, fontSize: 13.5, color: colors.text, lineHeight: 20 },
});

export default ManualItemCard;
