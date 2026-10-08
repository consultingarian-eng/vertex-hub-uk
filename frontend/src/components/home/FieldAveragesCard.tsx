/**
 * FieldAveragesCard — reusable OwnerIQ "Law of Averages" (LOA) card.
 *
 * Embedded on the Home tab and in the team Weekly Planner. Adapts by role:
 *   • admin  → their office's average / rep / day ("Yesterday's LOA"),
 *              expandable to a per-BA table with long-press hide-from-average.
 *   • leader → their OWN average / rep / day, with the team average alongside.
 * Both get a Today / Yesterday mini switcher. 0-data BAs are always excluded
 * from the average automatically (server-side).
 *
 * Visual ("Ink & Cube", spec §4 Home 8): paper DepthCard; the five averages
 * are glowing Unbounded-Black count-up numerals with gradient accent bars (see
 * AvgStat for why they run 22px rather than StatBlock's 26); the
 * Today / Yest. switch is a paper-tone SlidingSegments on its own row (the
 * old pill row squeezed the title into three lines). Same handlers, queries
 * and copy — the switch keeps its `setDay` signature.
 *
 * Data: GET /api/owneriq/summary (office/team) and /averages (leader own+team).
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { officeFromPin, useOwnerIqCompanies } from '../../utils/liveOps';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { api } from '../../api/client';
import { useColors, fonts, brand, GRADIENT } from '../../theme/ThemeContext';
import { useAuth } from '../../auth/AuthContext';
import { toast } from '../../utils/toast';
import { haptics } from '../../utils/haptics';
import { MOTION } from '../../theme/motion';
import { DepthCard } from '../ui/DepthCard';
import { AnimatedNumber, formatAnimatedNumber } from '../ui/AnimatedNumber';
import { SlidingSegments } from '../ui/SlidingSegments';
import { APP_LOCALE } from '../../utils/appTime';

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoToday = () => ymd(new Date());
const isoYesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); };

// The owner's Field IQ names. `th` is the per-rep table header, where a
// column is ~45px wide — "Presented" shortens to "Pres." there only.
const AVG_METRICS = [
  { key: 'doors_knocked', h: 'Doors', th: 'Doors' },
  { key: 'spoken_to', h: 'Spoken', th: 'Spoken' },
  { key: 'pitches_commenced', h: 'Presented', th: 'Pres.' },
  { key: 'pitches_closed', h: 'Closed', th: 'Closed' },
  { key: 'sales', h: 'Sign-ups', th: 'Sign-ups' },
];
// The Today / Yesterday switch (labels unchanged from the old pill row).
const DAY_ITEMS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yest.' },
];
const fmt = (n: any) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(APP_LOCALE));
const fmt1 = (n: any) => (n === null || n === undefined ? '—' : Number(n).toFixed(n >= 100 ? 0 : 1));

/** Numeral size for the five-across funnel — see AvgStat. */
const AVG_NUM_SIZE = 22;
/** Glow ghost fade, matching StatBlock's landing choreography. */
const GHOST_MS = 240;
const GHOST_OPACITY = 0.35;

/**
 * AvgStat — one funnel numeral, in StatBlock's language one step down the scale.
 *
 * StatBlock's `size` scale starts at 26 and five 26px Unbounded-Black numerals
 * cannot fit this card: the row gives each column ~65px while "32.5" measures
 * 71px at 26px, so the numerals ran into the divider rules and "116" + "32.5"
 * read as one number. At 22px the widest realistic value ("99.9") measures
 * ~59px, which leaves a real gutter on every column. Everything else is
 * StatBlock's recipe: a UI-thread count-up in Unbounded-Black (never a
 * fontWeight on it), a purple ghost behind the glyphs that lights up to 0.35
 * when the count lands, the 24×2 brand accent bar, the mono uppercase label.
 * Swap back to <StatBlock size={22} accent> if the primitive's scale gains 22.
 */
function AvgStat({ value, decimals, label, styles, glow }: {
  value: number;
  decimals: number;
  label: string;
  styles: ReturnType<typeof createStyles>;
  glow: string;
}) {
  const ghost = useSharedValue(0);
  useEffect(() => {
    ghost.value = 0;
    ghost.value = withDelay(MOTION.dur.count, withTiming(GHOST_OPACITY, { duration: GHOST_MS }));
  }, [ghost, value, decimals]);
  const ghostStyle = useAnimatedStyle(() => ({ opacity: ghost.value }));

  return (
    <View style={styles.avgStat}>
      <View>
        <Animated.Text
          numberOfLines={1}
          aria-hidden
          style={[styles.avgNum, StyleSheet.absoluteFill, styles.avgGhost, { textShadowColor: glow }, ghostStyle]}
        >
          {formatAnimatedNumber(value, '', '', decimals)}
        </Animated.Text>
        <AnimatedNumber
          value={value}
          decimals={decimals}
          duration={MOTION.dur.count}
          style={styles.avgNum}
        />
      </View>
      <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.avgAccent} />
      <Text numberOfLines={1} style={styles.avgLbl}>{label}</Text>
    </View>
  );
}

type Props = {
  /** Force a variant; defaults to the caller's role. Planner passes 'leader'. */
  variant?: 'admin' | 'leader';
  /** Lock to a single day (planner uses the planner's context); hides switcher. */
  day?: 'today' | 'yesterday';
  /** Card starts expanded (planner embeds it open). */
  defaultExpanded?: boolean;
};

// Collapse state persists across Home re-mounts within the session.
let homeCollapsed = false;

export default function FieldAveragesCard({ variant, day: fixedDay, defaultExpanded }: Props) {
  const companies = useOwnerIqCompanies();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useAuth();
  // A Coach+ reads the office's averages, like an Admin.
  const role = variant || ((user?.role === 'leader' && user?.coach_plus ? 'admin' : user?.role) as 'admin' | 'leader' | undefined);
  const isAdmin = role === 'admin';
  const isLeader = role === 'leader';

  const [day, setDay] = useState<'today' | 'yesterday'>(fixedDay || (isAdmin ? 'yesterday' : 'today'));
  const [expanded, setExpanded] = useState(!!defaultExpanded);
  const [collapsed, setCollapsed] = useState(homeCollapsed);
  const toggleCollapsed = () => setCollapsed((v) => { homeCollapsed = !v; return !v; });
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const iso = (fixedDay || day) === 'today' ? isoToday() : isoYesterday();
  const excludeParam = useMemo(() => Array.from(excluded).join(','), [excluded]);

  const officeQ = useQuery({
    enabled: isAdmin,
    queryKey: ['home-loa-office', iso, excludeParam],
    queryFn: async () =>
      (await api.get('/owneriq/summary', { params: { from_date: iso, to_date: iso, own_office: true, exclude: excludeParam || undefined } })).data,
  });
  const leaderQ = useQuery({
    enabled: isLeader,
    queryKey: ['home-loa-leader', iso],
    queryFn: async () => (await api.get('/owneriq/averages', { params: { from_date: iso, to_date: iso } })).data,
  });

  const toggleExclude = useCallback((key: string) => {
    haptics.medium?.();
    setExcluded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }, []);

  // Auto-sync from OwnerIQ only runs hourly — this button forces a live pull now
  // (POST /owneriq/sync), then refreshes the card.
  const [syncing, setSyncing] = useState(false);
  const doRefresh = useCallback(async () => {
    if (syncing) return;
    haptics.medium?.();
    setSyncing(true);
    // Only admins may pull from OwnerIQ (the server refuses anyone else);
    // everyone else just refetches what the scheduled sync stored.
    if (isAdmin) { try { await api.post('/owneriq/sync'); } catch { /* best-effort */ } }
    try { await Promise.all([officeQ.refetch(), leaderQ.refetch()]); } catch { /* ignore */ }
    setSyncing(false);
  }, [syncing, isAdmin, officeQ, leaderQ]);

  if (!isAdmin && !isLeader) return null;

  const loading = isAdmin ? officeQ.isLoading : leaderQ.isLoading;
  const office = officeQ.data;
  const reps: any[] = office?.reps || [];
  const officeName = officeFromPin(reps[0]?.mc_pin, companies);
  const avg = isAdmin ? (office?.avg_per_rep_day || {}) : (leaderQ.data?.own_avg_per_day || {});
  const teamAvg = leaderQ.data?.team_avg_per_day || {};

  const title = isAdmin
    ? `${(fixedDay || day) === 'today' ? 'Today' : 'Yesterday'}’s LOA${officeName ? ` · ${officeName}` : ''}`
    : 'My averages';
  const subtitle = isAdmin
    ? `Office average / rep / day · ${office?.included_count ?? 0} active`
    : `Your average / rep / day${leaderQ.data?.team_included_count ? ` · team of ${leaderQ.data.team_included_count}` : ''}`;

  return (
    <DepthCard style={styles.card} sheen>
      <View style={styles.head}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={0.7} onPress={toggleCollapsed}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>{title}</Text>
            <Ionicons name={collapsed ? 'chevron-down' : 'chevron-up'} size={16} color={colors.textMuted} />
          </View>
          <Text style={styles.sub}>{subtitle}</Text>
        </TouchableOpacity>
      </View>
      {!collapsed && !fixedDay && (
        <View style={styles.controls}>
          <SlidingSegments
            tone="paper"
            items={DAY_ITEMS}
            value={day}
            onChange={(k) => setDay(k as 'today' | 'yesterday')}
            style={styles.switch}
          />
          <TouchableOpacity onPress={() => router.push('/field-kpis')} style={styles.seeAllBtn}>
            <Text style={styles.seeAllTxt}>See all</Text>
            <Ionicons name="chevron-forward" size={12} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={doRefresh}
            disabled={syncing}
            style={styles.refreshBtn}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel="Refresh KPIs from Field IQ"
          >
            {syncing
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Ionicons name="refresh" size={15} color={colors.primary} />}
          </TouchableOpacity>
        </View>
      )}

      {collapsed ? null : loading ? (
        <ActivityIndicator style={{ marginVertical: 16 }} color={colors.primary} />
      ) : (
        <>
          {/* average / rep / day funnel — glowing numerals with gradient accents */}
          <View style={styles.avgRow}>
            {AVG_METRICS.map((m) => {
              const raw = avg[m.key];
              const has = raw !== null && raw !== undefined;
              const n = has ? Number(raw) : 0;
              return (
                <View key={m.key} style={styles.avgItem}>
                  {has ? (
                    <AvgStat value={n} decimals={n >= 100 ? 0 : 1} label={m.h} styles={styles} glow={colors.glow} />
                  ) : (
                    <View style={styles.avgStat}>
                      <Text style={styles.avgNum}>{fmt1(raw)}</Text>
                      <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.avgAccent} />
                      <Text style={styles.avgLbl}>{m.h}</Text>
                    </View>
                  )}
                </View>
              );
            })}
          </View>

          {/* leader: team comparison line */}
          {isLeader && leaderQ.data?.team_included_count ? (
            <View style={styles.teamRow}>
              <Text style={styles.teamTag}>Team</Text>
              {AVG_METRICS.map((m) => (
                <Text key={m.key} style={styles.teamNum}>{fmt1(teamAvg[m.key])}</Text>
              ))}
            </View>
          ) : null}

          {/* admin: expand to per-BA rows with hide-from-average */}
          {isAdmin && reps.length > 0 && (
            <>
              <TouchableOpacity style={styles.expandBtn} onPress={() => setExpanded((v) => !v)}>
                <Text style={styles.expandTxt}>{expanded ? 'Hide' : 'Show'} everyone ({reps.length})</Text>
                <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.primary} />
              </TouchableOpacity>
              {expanded && (
                <>
                  <Text style={styles.hint}>Tap the eye to hide/show a rep in the average.</Text>
                  <View style={styles.thead}>
                    <Text style={styles.thRep}>Rep</Text>
                    {AVG_METRICS.map((m) => <Text key={m.key} style={styles.thCell}>{m.th}</Text>)}
                  </View>
                  {reps.map((rep) => {
                    const off = rep.excluded;
                    return (
                      <View
                        key={rep.key}
                        style={[styles.trow, off && styles.rowOff]}
                      >
                        <View style={styles.trRep}>
                          <TouchableOpacity
                            onPress={rep.zero ? undefined : () => toggleExclude(rep.key)}
                            disabled={rep.zero}
                            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                            style={{ marginRight: 5, padding: 2 }}
                            accessibilityRole="button"
                            accessibilityLabel={`${off ? 'Show' : 'Hide'} ${rep.rep_name || 'rep'} in the average`}
                          >
                            <Ionicons name={off ? 'eye-off-outline' : 'eye-outline'} size={17}
                              color={off ? colors.textMuted : colors.primary} />
                          </TouchableOpacity>
                          <Text style={[styles.repName, off && styles.dim]} numberOfLines={1}>
                            {rep.rep_name || rep.badge_number || 'Unknown'}{rep.zero ? ' · off' : ''}
                          </Text>
                        </View>
                        {AVG_METRICS.map((m) => (
                          <Text key={m.key} style={[styles.td, m.key === 'sales' && styles.tdSales, off && styles.dim]}>
                            {fmt(rep.totals?.[m.key])}
                          </Text>
                        ))}
                      </View>
                    );
                  })}
                </>
              )}
            </>
          )}
        </>
      )}
    </DepthCard>
  );
}

const createStyles = (c: any) => StyleSheet.create({
  card: { borderRadius: 16, padding: 14, marginBottom: 12 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontFamily: fonts.displayWide, fontSize: 12.5, letterSpacing: 0.9, textTransform: 'uppercase', color: c.text },
  sub: { fontFamily: fonts.body, fontSize: 11, color: c.textMuted, marginTop: 2 },
  // Controls row: liquid Today/Yest. segments + See all + refresh
  controls: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  switch: { flex: 1, maxWidth: 200 },
  seeAllBtn: { flexDirection: 'row', alignItems: 'center', gap: 1, paddingHorizontal: 8, paddingVertical: 5, marginLeft: 'auto' },
  seeAllTxt: { fontFamily: fonts.bodySemibold, fontSize: 11, color: c.primary },
  refreshBtn: { width: 26, alignItems: 'center', justifyContent: 'center', paddingVertical: 5 },

  // The funnel well: a near-white inset panel with a hairline on the white face
  avgRow: { flexDirection: 'row', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 14, paddingVertical: 12, marginTop: 14 },
  // Five numerals across ~324px = 65px a column. The gradient accent bar + mono
  // label group each column, so there are no rules between them: at 22px a rule
  // would sit 2px off the widest glyph ("32.5" renders ~61px) and read as a line
  // struck through the number, which is exactly what it did at 26px. No
  // overflow:hidden either — the glow ghost bleeds ~14px past its glyphs.
  avgItem: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  avgStat: { alignItems: 'center' },
  // Unbounded-Black numeral (never a fontWeight on it) — also the '—' fallback
  avgNum: { fontFamily: fonts.displayBlack, fontSize: AVG_NUM_SIZE, letterSpacing: -1, color: c.primary, textAlign: 'center' },
  avgGhost: { color: brand.limeDark, textShadowRadius: 14, textShadowOffset: { width: 0, height: 0 } },
  avgAccent: { width: 24, height: 2, borderRadius: 1, marginTop: 8 },
  // 10 px / 0.4 tracking so "PRESENTED" (9 mono glyphs ≈ 58px) fits a 61px column.
  avgLbl: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: c.textMuted, marginTop: 6 },

  teamRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, paddingHorizontal: 4 },
  teamTag: { fontFamily: fonts.bodyBold, fontSize: 9.5, letterSpacing: 0.4, textTransform: 'uppercase', color: c.textMuted, width: 44 },
  teamNum: { flex: 1, fontFamily: fonts.mono, fontSize: 12, color: c.textSecondary, textAlign: 'center' },

  expandBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 6 },
  expandTxt: { fontFamily: fonts.bodySemibold, fontSize: 12.5, color: c.primary },

  hint: { fontFamily: fonts.body, fontSize: 10.5, color: c.textMuted, marginBottom: 8, textAlign: 'center' },
  thead: { flexDirection: 'row', alignItems: 'flex-end', paddingBottom: 5, borderBottomWidth: 1, borderBottomColor: c.border, marginBottom: 2 },
  thRep: { flex: 2.2, fontFamily: fonts.bodyBold, fontSize: 9, letterSpacing: 0.3, textTransform: 'uppercase', color: c.textMuted },
  thCell: { flex: 1, fontFamily: fonts.bodyBold, fontSize: 9, letterSpacing: 0.3, textTransform: 'uppercase', color: c.textMuted, textAlign: 'center' },
  trow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border },
  rowOff: { opacity: 0.5 },
  trRep: { flex: 2.2, flexDirection: 'row', alignItems: 'center', paddingRight: 4 },
  repName: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 12, color: c.text },
  td: { flex: 1, fontFamily: fonts.mono, fontSize: 12, color: c.text, textAlign: 'center' },
  tdSales: { fontFamily: fonts.bodyBold, color: c.primary },
  dim: { color: c.textMuted },
});
