import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { lightColors } from '../../theme/ThemeContext';
import { useColors, useTheme, fonts } from '../../theme/ThemeContext';
import { apiService } from '../../api/client';
import { formatMoney } from '../../utils/appTime';
import { teamColor, type TeamTint, type TeamScheme } from '../../utils/teamColors';
// "Ink & Cube" primitives (spec §3, §4 P1 bells) — visual pass only: same
// handlers, data and navigation as before.
import { DepthCard } from '../ui/DepthCard';
import { StatBlock } from '../ui/StatBlock';
import { XPBar } from '../ui/XPBar';

export type BellsTeam = {
  leader_id: string;
  leader_name: string;
  team_name: string;
  team_weekly_goal?: number | null;
  member_count: number;
  total_sales: number;
  total_memberships: number;
  days_worked: number;
  earnings: number;
  piece_average: number;
  scoring_pct: number;
  weekly_average: number;
  working_today: number;
  members_with_entries: number;
  last_week_total_sales: number | null;
  sales_delta: number;
  sales_delta_pct: number | null;
};

// Crew goal met — the bar and its caption go green in both themes
// (light 5.5:1 on the white card, dark 9.3:1 on the plum card).
const GOAL_HIT_GRADIENT = ['#059669', '#34D399'] as const;
const GOAL_HIT_TEXT = { light: '#047857', dark: '#34D399' } as const;
// vs-last-week chip type, on the translucent status backgrounds (≥4.8:1).
const DELTA_TEXT = {
  light: { up: '#047857', down: '#B91C1C' },
  dark: { up: '#6EE7B7', down: '#FCA5A5' },
} as const;

export default function TeamView({ weekEnding, office }: { weekEnding: string; office?: string }) {
  const colors = useColors();
  const { effective } = useTheme();
  const scheme: TeamScheme = effective === 'dark' ? 'dark' : 'light';
  const styles = useMemo(() => createStyles(colors), [colors]);

  const q = useQuery({
    queryKey: ['bells-teams', weekEnding, office],
    queryFn: () => apiService.listBellsTeams(weekEnding, office).then((r) => r.data),
    staleTime: 1000 * 15,
  });

  if (q.isLoading) {
    return <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />;
  }

  const teams: BellsTeam[] = q.data?.teams || [];
  // Canonical office totals (unique entries, not summed teams). Falls back
  // to sum of teams in case the backend doesn't return office_totals yet.
  const officeTotals: { sales?: number; working_today?: number } = q.data?.office_totals || {};
  const officeTotal: number = (typeof officeTotals.sales === 'number' && officeTotals.sales > 0)
    ? officeTotals.sales
    : teams.reduce((s, t) => s + (t.total_sales || 0), 0);
  const officeWorkingNow: number = (typeof officeTotals.working_today === 'number')
    ? officeTotals.working_today
    : teams.reduce((s, t) => s + (t.working_today || 0), 0);

  if (!teams.length) {
    return (
      <DepthCard style={styles.emptyCard}>
        <View style={styles.empty}>
          <Ionicons name="people-circle-outline" size={44} color={colors.textMuted} />
          <Text style={styles.emptyText}>
            No teams yet. Coaches can set a team name from the Profile screen to start grouping members here.
          </Text>
        </View>
      </DepthCard>
    );
  }

  return (
    <View style={{ marginTop: 10 }}>
      {/* Summary strip — the same three figures as a row of house stat tiles
          (count-up numerals, mono kickers), so it reads like the office board
          above instead of three flat pills. */}
      <DepthCard style={styles.summaryCard}>
        <View style={styles.summaryRow}>
          <StatBlock size={26} value={teams.length} label="Teams" style={styles.summaryCell} />
          <View style={styles.summaryDivider} />
          <StatBlock size={26} value={officeTotal} label="Total Sign-ups" gradient style={styles.summaryCell} />
          <View style={styles.summaryDivider} />
          <StatBlock size={26} value={officeWorkingNow} label="Working Now" style={styles.summaryCell} />
        </View>
      </DepthCard>

      {teams.map((t, i) => {
        const tint: TeamTint = teamColor(t.leader_id, scheme);
        const sharePct = officeTotal > 0 ? Math.round((t.total_sales / officeTotal) * 100) : 0;
        const deltaPositive = t.sales_delta >= 0;
        const deltaColor = DELTA_TEXT[scheme][deltaPositive ? 'up' : 'down'];
        const deltaBg = deltaPositive ? colors.sgreenBg : colors.redBg;
        return (
          // Paper DepthCard with the team's hue as a lit left rail — the tint
          // is identity, not the card fill, so the card floats on the field in
          // light and RAISES off the abyss in dark (spec §2.5). No sheen on
          // list rows.
          <DepthCard
            key={t.leader_id}
            index={i}
            sheen={false}
            style={[styles.teamCard, { borderLeftColor: tint.border }]}
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              // Wrap the team card body in a horizontal ScrollView so the
              // KPI strip can overflow on narrow screens without being clipped.
              contentContainerStyle={{ flexGrow: 1 }}
            >
              <View style={{ flex: 1, width: '100%' }}>
                {/* Header */}
                <View style={styles.teamHeader}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={styles.teamNameRow}>
                      <View style={[styles.teamDot, { backgroundColor: tint.border }]} />
                      <Text style={[styles.teamName, { color: tint.text }]} numberOfLines={1}>
                        {t.team_name}
                      </Text>
                    </View>
                    <Text style={styles.teamLead} numberOfLines={1}>
                      Led by {t.leader_name} · {t.member_count} member{t.member_count === 1 ? '' : 's'}
                      {t.working_today > 0 ? ` · ${t.working_today} working today` : ''}
                    </Text>
                  </View>
                  <View style={[styles.sharePill, { backgroundColor: tint.pill, borderColor: tint.border + '66' }]}>
                    <Text style={[styles.sharePillValue, { color: tint.text }]}>{sharePct}%</Text>
                    <Text style={[styles.sharePillLabel, { color: tint.text }]}>of office</Text>
                  </View>
                </View>

                {/* Crew goal — progress toward the team's weekly target
                    (team_weekly_goal on the leader's row, same field the
                    Weekly Planner and table-view header editor write) */}
                {t.team_weekly_goal != null && t.team_weekly_goal > 0 && (() => {
                  const pct = Math.min(100, Math.round((t.total_sales / t.team_weekly_goal!) * 100));
                  const hit = pct >= 100;
                  return (
                    <View style={styles.goalRow}>
                      {/* XP bar in the team's hue — charges as the card scrolls
                          in; tip/glow off so a list of crews costs zero loops. */}
                      <XPBar
                        value={pct / 100}
                        height={10}
                        tip={false}
                        glow={false}
                        gradient={hit
                          ? GOAL_HIT_GRADIENT
                          : (scheme === 'dark' ? [tint.border, tint.text] : [tint.text, tint.border])}
                      />
                      <Text style={[styles.goalText, hit && { color: GOAL_HIT_TEXT[scheme] }]}>
                        {t.total_sales} / {t.team_weekly_goal} goal · {pct}%{hit ? ' 🔔' : ''}
                      </Text>
                    </View>
                  );
                })()}

                {/* Primary metrics row */}
                <View style={styles.metricsRow}>
                  <Metric label="Sign-ups" value={`${t.total_sales}`} strong />
                  <Metric label="Goal" value={t.team_weekly_goal != null ? `${t.team_weekly_goal}` : '—'} />
                  <Metric label="Days" value={`${t.days_worked}`} />
                  <Metric label="P/A" value={t.piece_average.toFixed(1)} />
                  <Metric label="BA fees" value={formatMoney(t.earnings || 0)} money />
                </View>

                {/* Secondary metrics row */}
                <View style={styles.secondaryRow}>
                  <View style={styles.secondaryChip}>
                    <Text style={styles.secondaryLabel}>Weekly Avg / Rep</Text>
                    <Text style={styles.secondaryValue}>{t.weekly_average.toFixed(1)}</Text>
                  </View>
                  <View style={styles.secondaryChip}>
                    <Text style={styles.secondaryLabel}>Scoring %</Text>
                    <Text style={styles.secondaryValue}>{t.scoring_pct}%</Text>
                  </View>
                  <View style={[styles.secondaryChip, { backgroundColor: deltaBg, borderColor: deltaColor + '40' }]}>
                    <Text style={[styles.secondaryLabel, { color: deltaColor }]}>vs Last Wk</Text>
                    <Text style={[styles.secondaryValue, { color: deltaColor }]}>
                      {deltaPositive ? '+' : ''}
                      {t.sales_delta}
                      {t.sales_delta_pct !== null ? ` (${t.sales_delta_pct > 0 ? '+' : ''}${t.sales_delta_pct}%)` : ''}
                    </Text>
                  </View>
                </View>
              </View>
            </ScrollView>
          </DepthCard>
        );
      })}
    </View>
  );
}

function Metric({ label, value, strong, money }: { label: string; value: string; strong?: boolean; money?: boolean }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.metricCell}>
      <Text style={styles.metricLabel}>{label}</Text>
      {/* Weight comes from the real Space Grotesk cut, never faux-bold. */}
      <Text style={[styles.metricValue, strong && styles.metricValueStrong, money && { color: colors.primary }]}>
        {value}
      </Text>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  // Empty state — a paper card so it sits in the same system as the crews.
  emptyCard: { marginTop: 10, borderRadius: 18 },
  empty: { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 24, gap: 10 },
  emptyText: { color: colors.textMuted, fontSize: 13, fontFamily: fonts.body, textAlign: 'center', lineHeight: 18 },

  summaryCard: { marginBottom: 4, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 6 },
  summaryRow: { flexDirection: 'row', alignItems: 'center' },
  summaryCell: { flex: 1 },
  summaryDivider: { width: 1, alignSelf: 'stretch', marginVertical: 4, backgroundColor: colors.border },

  // The card face (fill, hairline, depth shadow) comes from DepthCard; only
  // placement, radius and the tinted rail live here.
  teamCard: {
    borderLeftWidth: 4,
    borderRadius: 18,
    padding: 12,
    marginTop: 10,
  },
  teamHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  teamNameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  teamDot: { width: 8, height: 8, borderRadius: 4 },
  teamName: { flexShrink: 1, fontSize: 16, fontFamily: fonts.display, letterSpacing: -0.2 },
  teamLead: { fontSize: 11, fontFamily: fonts.bodyMedium, color: colors.textMuted, marginTop: 3, lineHeight: 15 },
  sharePill: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, alignItems: 'center', minWidth: 66, borderWidth: 1 },
  // Unbounded-Black numeral — never stack fontWeight on a display face.
  sharePillValue: { fontSize: 20, fontFamily: fonts.displayBlack, letterSpacing: -0.8, fontVariant: ['tabular-nums'] as any },
  // Full-strength tint type (no opacity): the amber tint measures 4.51:1 on
  // its own pill, so fading it would drop the kicker under 4.5.
  sharePillLabel: { fontSize: 8.5, fontFamily: fonts.mono, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 1 },

  goalRow: { marginBottom: 10 },
  goalText: { fontSize: 10, fontFamily: fonts.monoSemibold, color: colors.textMuted, letterSpacing: 0.3, marginTop: 5, textAlign: 'right', fontVariant: ['tabular-nums'] as any },

  metricsRow: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  // Inset grooves on the card face (the same `surface` + hairline the rest of
  // the bells rows use), so numbers stay readable in BOTH themes.
  metricCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 2,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  metricLabel: { fontSize: 9, fontFamily: fonts.mono, color: colors.textMuted, letterSpacing: 0.8, textTransform: 'uppercase' },
  metricValue: { fontSize: 15, fontFamily: fonts.displayMedium, color: colors.text, marginTop: 3, fontVariant: ['tabular-nums'] as any },
  metricValueStrong: { fontFamily: fonts.display },
  secondaryRow: { flexDirection: 'row', gap: 6 },
  secondaryChip: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 8,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // 8.5/0.2 keeps the longest kicker ("Weekly Avg / Rep", 16 chars) on ONE
  // line in a third-of-a-card chip, so the three values stay on one baseline.
  secondaryLabel: { fontSize: 8.5, fontFamily: fonts.mono, color: colors.textMuted, letterSpacing: 0.2, textTransform: 'uppercase' },
  secondaryValue: { fontSize: 13, fontFamily: fonts.display, color: colors.text, marginTop: 2, fontVariant: ['tabular-nums'] as any },
});

/* __theme_static_fallback__ */
// Fallback static styles (used if a sub-component didn't pick up the
// useColors hook). Always light-mode — won't react to theme changes.
const styles = createStyles(lightColors);
