/**
 * PrimetimeCard — Home tile showing the whole office's Primetime plan.
 *
 * Grouped by IMPACT, not by person. A flat per-person list printed both sides
 * of the same arrangement as separate lines — "Ana learning Pitch Practice
 * from Ben" directly above "Ben teaching Pitch Practice to Ana" — which
 * read as duplicates and hid the thing you actually want to see: who is
 * running what, and how many people are in it.
 *
 * The grouped rendering itself lives in components/primetime/ImpactSummary so
 * this tile and the Weekly Planner's day page stay identical.
 *
 * Collapsible, since an admin's office fills this with a lot of blocks.
 *
 * Visual ("Ink & Cube", spec §4 Home 9): a paper DepthCard with a brand
 * gradient rim (`edge="gradient"`) and a gradient icon well — the tile that
 * marks the office's coaching plan. Copy, handlers and data are unchanged.
 *
 * Leaders and admins only. Data: GET /primetime/home (own office only).
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { apiService } from '../../api/client';
import { useColors, fonts, GRADIENT } from '../../theme/ThemeContext';
import { useAuth } from '../../auth/AuthContext';
import { DepthCard } from '../ui/DepthCard';
import ImpactSummary from '../primetime/ImpactSummary';

// Collapse state survives Home re-mounting within a session, the same way
// FieldAveragesCard remembers its own. Not persisted across app restarts —
// the card is worth seeing at least once a day.
let cardCollapsed = false;

// The "no Primetime set" keycap: an amber face (the app's warning hue as a
// FILL) with a near-black glyph — 11.4:1 on the lighter stop, so the alert
// still reads at 15px without putting #D97706 on a pale surface.
const NUDGE_WELL = ['#fbbf24', '#f59e0b'] as const;
const NUDGE_GLYPH = '#3b2400';

export default function PrimetimeCard() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [collapsed, setCollapsed] = useState(cardCollapsed);
  const { user } = useAuth();
  const role = (user?.role || '').toLowerCase();
  const isLeader = role === 'leader' || role === 'admin';

  const q = useQuery({
    queryKey: ['primetime-home'],
    queryFn: () => apiService.primetimeHome().then((r) => r.data),
    enabled: isLeader,
    staleTime: 60_000,
  });

  const d = q.data;

  // Biggest impacts first — that's the one a spare trainee should join.
  const sessions = useMemo(
    () => [...(d?.sessions || [])].sort((a, b) => b.attendees.length - a.attendees.length),
    [d],
  );

  // Anyone whose plan isn't part of a session: learning from a book, watching
  // someone outside the office, a topic with nobody named yet.
  const solo = useMemo(() => {
    const grouped = new Set<string>();
    for (const s of sessions) {
      grouped.add(s.host_user_id);
      for (const a of s.attendees) grouped.add(a.user_id);
    }
    return (d?.plans || []).filter((p) => !grouped.has(p.user_id));
  }, [d, sessions]);

  const unplanned = d?.my_unplanned || [];
  const dayLabel = d ? (d.is_tomorrow ? `${d.day_name} · tomorrow` : `${d.day_name} · today`) : '';

  if (!isLeader) return null;

  const open = () => {
    if (!d) return router.push('/weekly-planner' as any);
    router.push(`/weekly-planner?week=${d.week_ending}&day=${d.day_index}` as any);
  };

  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.wrap} onPress={open}>
      <DepthCard edge="gradient" style={styles.card}>
        <View style={styles.head}>
          <View style={styles.titleRow}>
            <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.iconWell}>
              <Ionicons name="flash" size={14} color="#fff" />
            </LinearGradient>
            <Text style={styles.title}>Primetime</Text>
            {!!dayLabel && <Text style={styles.dayTag}>{dayLabel}</Text>}
          </View>
          <TouchableOpacity
            onPress={() => { cardCollapsed = !collapsed; setCollapsed(!collapsed); }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.collapseBtn}
          >
            <Ionicons name={collapsed ? 'chevron-down' : 'chevron-up'} size={16} color={colors.textMuted} />
          </TouchableOpacity>
          <Ionicons name="chevron-forward" size={16} color={colors.primary} />
        </View>

        {q.isLoading ? (
          <ActivityIndicator style={{ marginVertical: 16 }} color={colors.primary} />
        ) : !d ? (
          <View style={styles.emptyBox}>
            <Ionicons name="flash-outline" size={20} color={colors.textMuted} />
            <Text style={styles.emptyTxt}>Couldn't load the office plan. Tap to open.</Text>
          </View>
        ) : collapsed ? (
          <Text style={styles.collapsedTxt}>
            {sessions.length
              ? `${sessions.length} ${sessions.length === 1 ? 'impact' : 'impacts'} running`
              : 'Nothing planned yet'}
            {solo.length ? ` · ${solo.length} on their own` : ''}
            {unplanned.length ? ` · ${d.my_unplanned_total} unset` : ''}
          </Text>
        ) : (
          <>
            <ImpactSummary sessions={sessions} solo={solo} />

            {sessions.length === 0 && solo.length === 0 && (
              <View style={styles.emptyBox}>
                <Ionicons name="flash-outline" size={20} color={colors.textMuted} />
                <Text style={styles.emptyTxt}>
                  Nothing planned for {d.day_name} yet. Tap to set the office up.
                </Text>
              </View>
            )}

            {unplanned.length > 0 && (
              <View style={styles.nudge}>
                {/* The one element the pass had missed: a flat pale-yellow
                    rectangle with a bare orange dot inside a card that had the
                    full treatment. It is now the same inset well as the
                    empty-state box above it (surface + hairline), and the dot
                    is a raised amber keycap — the warning colour survives as a
                    FILL, which is what finding 6 asks for (amber as text or as
                    a glyph on a lavender surface measures 2.9:1). */}
                <LinearGradient
                  colors={NUDGE_WELL}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.nudgeWell}
                >
                  <Ionicons name="alert" size={15} color={NUDGE_GLYPH} />
                </LinearGradient>
                <Text style={styles.nudgeTxt} numberOfLines={2}>
                  <Text style={styles.nudgeStrong}>
                    {unplanned.slice(0, 3).map((p) => (p.is_self ? 'You' : p.name)).join(', ')}
                    {d.my_unplanned_total > 3 ? ` and ${d.my_unplanned_total - 3} more` : ''}
                  </Text>
                  {' '}
                  {d.my_unplanned_total === 1 && !unplanned[0]?.is_self ? 'has' : 'have'} no Primetime set.
                </Text>
              </View>
            )}
          </>
        )}
      </DepthCard>
    </TouchableOpacity>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  wrap: { marginBottom: 14 },
  card: { borderRadius: 16, padding: 14 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  iconWell: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 10px rgba(58,122,86,0.35)' },
  title: { fontFamily: fonts.displayWide, fontSize: 12.5, letterSpacing: 0.9, textTransform: 'uppercase', color: c.text },
  dayTag: { fontFamily: fonts.mono, fontSize: 10.5, color: c.textMuted, marginLeft: 2 },
  collapseBtn: { padding: 2 },
  collapsedTxt: { fontFamily: fonts.body, fontSize: 12, color: c.textMuted },

  // Inset panels on the white face use the secondary surface + a hairline so
  // they read as wells rather than white-on-white.
  emptyBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 14 },
  emptyTxt: { fontFamily: fonts.body, fontSize: 12.5, color: c.textMuted, flex: 1 },

  nudge: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10,
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    borderRadius: 14, paddingVertical: 11, paddingHorizontal: 12,
  },
  // 26px raised amber keycap — same footprint and radius as the card's own
  // gradient title well, so the two wells read as one family.
  nudgeWell: {
    width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 4px 10px rgba(217,119,6,0.40), inset 0 1px 0 rgba(255,255,255,0.55)',
  },
  nudgeTxt: { fontFamily: fonts.body, fontSize: 12, color: c.text, flex: 1, lineHeight: 17 },
  nudgeStrong: { fontFamily: fonts.bodySemibold, color: c.text },
});
