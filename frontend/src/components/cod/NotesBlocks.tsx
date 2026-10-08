/**
 * NotesBlocks — typesets parsed NoteBlocks (see parseNotes.ts) into a
 * comfortable reading column: real headings, styled bullet / numbered
 * lists, body paragraphs at ~1.55 line-height. Used by both reader modes
 * (full Notes view, and each Learn card's content).
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '../../theme/ThemeContext';
import { fonts } from '../../theme/brand';
import type { NoteBlock } from './parseNotes';

type Props = {
  blocks: NoteBlock[];
  /** Stage color — heading bars, bullet dots, list numbers. */
  accent?: string;
};

export function NotesBlocks({ blocks, accent }: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const a = accent || colors.primary;

  return (
    <View>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          return (
            <View key={i} style={[styles.headingRow, i === 0 && { marginTop: 2 }]}>
              <View style={[styles.headingBar, { backgroundColor: a }]} />
              <Text style={styles.headingText}>{b.text}</Text>
            </View>
          );
        }
        if (b.kind === 'bullets') {
          return (
            <View key={i} style={styles.listWrap}>
              {b.items.map((item, j) => (
                <View key={j} style={styles.listRow}>
                  <View style={[styles.dot, { backgroundColor: a }]} />
                  <Text style={styles.listText}>{item}</Text>
                </View>
              ))}
            </View>
          );
        }
        if (b.kind === 'numbered') {
          return (
            <View key={i} style={styles.listWrap}>
              {b.items.map((item, j) => (
                <View key={j} style={styles.listRow}>
                  <Text style={[styles.num, { color: a }]}>{j + 1}</Text>
                  <Text style={styles.listText}>{item}</Text>
                </View>
              ))}
            </View>
          );
        }
        return (
          <Text key={i} style={styles.para}>{b.text}</Text>
        );
      })}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 18, marginBottom: 10 },
  headingBar: { width: 3.5, alignSelf: 'stretch', borderRadius: 2 },
  headingText: {
    flex: 1,
    fontFamily: fonts.display,
    fontSize: 15,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    lineHeight: 20,
  },
  para: {
    fontFamily: fonts.body,
    fontSize: 15.5,
    lineHeight: 24, // ~1.55
    color: colors.text,
    marginBottom: 12,
  },
  listWrap: { gap: 8, marginBottom: 12, marginTop: 2 },
  listRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 8.5 },
  num: {
    fontFamily: fonts.monoSemibold,
    fontSize: 13,
    fontWeight: '700',
    width: 18,
    textAlign: 'right',
    marginTop: 2.5,
  },
  listText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 22.5,
    color: colors.text,
  },
});

export default NotesBlocks;
