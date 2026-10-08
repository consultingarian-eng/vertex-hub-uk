/**
 * StreakFlame — the learning-days chip (Home header + PK hub).
 * (File keeps its historical name; the streak concept is gone.)
 *
 * Shows a lifetime COUNT of learning days — lit amber when today already
 * counts, muted otherwise. No pulsing, no "keep it alive" nagging, no
 * consecutive-day pressure: missing a day costs nothing.
 *
 * Tapping routes to /product-knowledge — the fastest way to make today
 * count is a 2-minute lesson.
 *
 * Surface-aware (spec §2.2: chips sitting ON ink use glass/glassBorder). The
 * UNLIT chip used to paint `colors.surfaceAlt` wherever it stood, so the same
 * element read oppositely between themes on the Home hero's ink block — a
 * bright lilac sticker on near-black in light (11.5:1 against the block), a
 * #18392E panel at 1.49:1 in dark — and disagreed with the glass bell chip
 * 60px above it. Inside an EditorialHero ink/pop block it is glass now (like
 * XPBar's tone='auto', it reads `useHeroSurface()`, so no call site changes).
 * On light glass the house rule is `text`/`textSecondary`, never inkText: a
 * 0.78-white chip over ink composites to a LIGHT chip. Dark glass is 0.06
 * white, so there the type is inkText/inkMuted. The lit amber branch is
 * unchanged on every surface.
 */
import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useColors, useTheme } from '../../theme/ThemeContext';
import { fonts } from '../../theme/brand';
import { getStreak } from '../../gamification/streak';
import { haptics } from '../../utils/haptics';
import PressableScale from './PressableScale';
import { useHeroSurface } from './EditorialHero';

const LIT = '#f59e0b';

export function StreakFlame({ compact = false }: { compact?: boolean }) {
  const colors = useColors();
  const { effective } = useTheme();
  const isDark = effective === 'dark';
  const surface = useHeroSurface();
  const onInk = surface === 'ink' || surface === 'pop';
  const router = useRouter();
  const { data } = useQuery({ queryKey: ['streak'], queryFn: getStreak, staleTime: 30_000 });

  if (!data) return null;
  const lit = data.activeToday;
  const total = data.total;

  // Unlit palette per surface. On ink/pop the chip is glass; its composited
  // value flips with the theme, so the type does too.
  //
  // DARK glass is only 6 % white, so the chip shows the hero's nebula through
  // it: measured on Home's dark hero the fill runs rgb(63,55,143) →
  // rgb(58,108,86), where inkMuted is 4.45 → 2.76:1 — under AA at the bright
  // end. The 11px label therefore takes inkText there (5.35 → 8.62:1) and the
  // hierarchy is carried by the icon, which is not text.
  const chipBg = onInk ? colors.glass : colors.surfaceAlt;
  const chipBorder = onInk ? colors.glassBorder : colors.border;
  const strongInk = onInk ? (isDark ? colors.inkText : colors.text) : colors.text;
  const quietInk = onInk ? (isDark ? colors.inkText : colors.textSecondary) : colors.textMuted;
  const iconInk = onInk ? (isDark ? colors.inkMuted : colors.textSecondary) : colors.textMuted;

  return (
    <PressableScale
      onPress={() => { haptics.light(); router.push('/product-knowledge'); }}
      style={[
        styles.chip,
        {
          backgroundColor: lit ? LIT + '1A' : chipBg,
          borderColor: lit ? LIT + '66' : chipBorder,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={total > 0 ? `${total} learning days` : 'Start learning'}
    >
      <Ionicons name={lit ? 'book' : 'book-outline'} size={compact ? 14 : 16} color={lit ? LIT : iconInk} />
      {total > 0 ? (
        <Text style={[styles.count, { color: lit ? LIT : strongInk, fontSize: compact ? 12 : 13 }]}>
          {total}
        </Text>
      ) : null}
      {!compact && (
        <Text style={[styles.label, { color: lit ? LIT : quietInk }]} numberOfLines={1}>
          {total > 0 ? (total === 1 ? 'learning day' : 'learning days') : 'start learning'}
        </Text>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1.2,
  },
  count: { fontFamily: fonts.monoSemibold, fontWeight: '800' },
  label: { fontSize: 11, fontWeight: '700' },
});

export default StreakFlame;
