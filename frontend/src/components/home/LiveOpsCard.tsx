/**
 * LiveOpsCard — Home entry tile for the Live Operations feature.
 *
 * Live Operations is its own hub (/live-ops): admins open it from Home to manage
 * all their teams out in the field for the day, compiled together, and drill in
 * team → BA → door-by-door log. This tile is just the opener: a live headline
 * (teams out · sales today · BAs in field) that taps through to the hub.
 * Role-scoped server-side; self-hides when no teams are out.
 *
 * Visual ("Ink & Cube", spec §4 Home 7): the one INK block among Home's white
 * cards — an ink DepthCard with three 34px GRADIENT StatBlock numerals and
 * "Manage teams" in inkText. Before any team is out the numerals are dropped
 * entirely (three 34px zeros read as white doughnuts, not as data) and the
 * block carries its empty-state well alone. Every string, handler and query
 * is unchanged.
 *
 * Data: GET /owneriq/live (proxied live from OwnerIQ — not stored).
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useColors, fonts } from '../../theme/ThemeContext';
import { useAuth } from '../../auth/AuthContext';
import { DepthCard } from '../ui/DepthCard';
import { StatBlock } from '../ui/StatBlock';

export default function LiveOpsCard() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useAuth();
  const role = (user?.role || '').toLowerCase();

  const q = useQuery({
    queryKey: ['live-ops-home'],
    // own_office=1 → a super-admin's Home tile shows only their own office
    // (e.g. office A); the hub is where they switch offices / see them all.
    queryFn: async () => (await api.get('/owneriq/live', { params: { own_office: 1 } })).data,
    refetchInterval: 90_000, // it's live — refresh while Home is open
    staleTime: 60_000,
  });

  const sectors: any[] = q.data?.sectors || [];
  const summary = q.data?.summary || {};
  const empty = !q.isLoading && sectors.length === 0;

  // For managers the tile stays put as a stable opener even before any team is
  // out (it shows an empty state instead of vanishing). Trainees — who only
  // watch their own team — don't need an empty card cluttering Home.
  if (empty && role === 'trainee') return null;

  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.wrap} onPress={() => router.push('/live-ops' as any)}>
      <DepthCard variant="ink" style={styles.card} sheen>
        <View style={styles.head}>
          <View style={styles.titleRow}>
            <View style={styles.liveDot} />
            <Text style={styles.title}>Sectors</Text>
          </View>
          <View style={styles.openRow}>
            <Text style={styles.openTxt}>View sectors</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.inkText} />
          </View>
        </View>

        {q.isLoading ? (
          <ActivityIndicator style={{ marginVertical: 14 }} color={colors.inkMuted} />
        ) : (
          <>
            {/* Spec §4 Home 7 — "three 34px GRADIENT numerals". `gradient` was
                missing, so tone="ink" fell through to a solid inkText numeral
                and the block's headline figures rendered flat white (round-2
                review, 3 reviewers).

                Empty day → no numerals at all. Three zeroed Unbounded-Black
                34px glyphs are three fat white rings, and on a leader whose
                teams are not out yet they were the largest, brightest object
                on the whole screen — announcing nothing, directly above a well
                that already says so in words. The block keeps its ink face,
                its live dot and "View sectors", so it still reads as the one
                lit block on Home rather than as something switched off. */}
            {empty ? null : (
              <View style={styles.statRow}>
                <StatBlock
                  value={Number(summary.live_teams ?? sectors.length)}
                  label="Sectors out"
                  tone="ink"
                  size={34}
                  gradient
                  style={styles.stat}
                />
                <View style={styles.statDivider} />
                <StatBlock
                  value={Number(summary.sales ?? 0)}
                  label="Sign-ups today"
                  tone="ink"
                  size={34}
                  gradient
                  style={styles.stat}
                />
                <View style={styles.statDivider} />
                <StatBlock
                  value={Number(summary.bas_in_field ?? 0)}
                  label="BAs in field"
                  tone="ink"
                  size={34}
                  gradient
                  style={styles.stat}
                />
              </View>
            )}
            {empty ? (
              <View style={styles.emptyBox}>
                <Ionicons name="cellular-outline" size={20} color={colors.inkMuted} />
                <Text style={styles.emptyTxt}>No teams in the field yet today. Tap to open.</Text>
              </View>
            ) : null}
          </>
        )}
      </DepthCard>
    </TouchableOpacity>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  wrap: { marginBottom: 14 },
  card: { borderRadius: 16, padding: 14 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Live indicator — a lit green dot (glow via boxShadow string; rnw → CSS).
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e', boxShadow: '0 0 8px rgba(34,197,94,0.85)' },
  title: { fontFamily: fonts.displayWide, fontSize: 12.5, letterSpacing: 0.9, textTransform: 'uppercase', color: c.inkText },
  openRow: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  openTxt: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: c.inkText },

  // Inset well ON the ink block (a translucent white wash, not the page glass
  // token — it must read the same in both themes on the dark gradient).
  emptyBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12,
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14, paddingVertical: 14, paddingHorizontal: 14,
  },
  emptyTxt: { fontFamily: fonts.body, fontSize: 12.5, color: c.inkMuted, flex: 1 },

  statRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, paddingVertical: 2 },
  stat: { flex: 1 },
  statDivider: { width: 1, height: 44, backgroundColor: 'rgba(255,255,255,0.12)' },
});
