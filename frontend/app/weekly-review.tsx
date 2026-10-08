/**
 * Monday Review — the 9:00 AM meeting on one page, for a whole office.
 *
 * Runs in the order the meeting runs: close last week (office scoreboard →
 * money leaderboard → positives), then open this one (leader by leader →
 * themes & goals → what still needs chasing).
 *
 * The week you pick is the week being PLANNED. Everything retrospective is
 * the Sunday before it, matching the Weekly Planner's own review-week
 * convention — so on Monday morning the defaults are already right.
 *
 * Admin-only, one office at a time (super admins switch with OfficeToggle).
 * Read-only: nothing on this screen writes.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';

import { useColors, fonts } from '../src/theme/ThemeContext';
import { ScrollReveal } from '../src/components/ui/ScrollFx';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import OfficeToggle from '../src/components/ui/OfficeToggle';
import { useActiveOffice } from '../src/office/ActiveOfficeContext';
import { useAuth } from '../src/auth/AuthContext';
import { apiService, OfficeReviewLeader, OfficeWeeklyReview } from '../src/api/client';
import { APP_LOCALE, formatMoney } from '../src/utils/appTime';

// ── Dates ────────────────────────────────────────────────────────────────
// The week currently being planned (Mon–Sat → this week's Sunday; on Sunday
// itself → next week's). Mirrors the server default exactly.
function planningSunday(): string {
  const d = new Date();
  const offset = (7 - d.getDay()) % 7;
  d.setDate(d.getDate() + (offset === 0 ? 7 : offset));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addWeeksISO(iso: string, n: number): string {
  const [y, m, dd] = iso.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  d.setDate(d.getDate() + n * 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function weekRange(weekEnding?: string | null): string {
  if (!weekEnding) return '—';
  const [y, m, dd] = weekEnding.split('-').map(Number);
  if (!y) return '—';
  const end = new Date(y, m - 1, dd);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  const f = (d: Date) => d.toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' });
  return `${f(start)} – ${f(end)}`;
}

// ── Numbers ──────────────────────────────────────────────────────────────
const money = (n?: number | null) =>
  n == null ? '—' : formatMoney(n);
const num = (n?: number | null) => (n == null ? '—' : String(n));
const pct = (n?: number | null) => (n == null ? '—' : `${n}%`);

export default function WeeklyReviewScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const { officeId, canSwitch } = useActiveOffice();

  const { scrollY, onScroll } = useParallaxScroll();
  const [week, setWeek] = useState<string>(planningSunday());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isAdmin = user?.role === 'admin';

  const q = useQuery({
    queryKey: ['office-weekly-review', week, officeId || 'home'],
    queryFn: () => apiService.officeWeeklyReview(week, officeId).then((r) => r.data),
    enabled: isAdmin,
  });

  const { pullIndicator } = usePullToRefresh(() => q.refetch());

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'Monday Review' }} />
        <Ionicons name="lock-closed-outline" size={32} color={colors.textMuted} />
        <Text style={s.emptyTitle}>Admins only</Text>
        <Text style={s.emptyText}>
          The office review pulls together every coach's plan, so it's limited to office admins.
        </Text>
      </View>
    );
  }

  const d: OfficeWeeklyReview | undefined = q.data;
  const onPlanningWeek = week === planningSunday();
  const allOpen = !!d?.leaders.length && d.leaders.every((l) => open[l.user_id]);
  const toggleAll = () =>
    setOpen(allOpen ? {} : Object.fromEntries((d?.leaders || []).map((l) => [l.user_id, true])));

  return (
    <View style={{ flex: 1 }}>
      {pullIndicator}
      <Stack.Screen options={{ title: 'Monday Review' }} />
      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ padding: 14, paddingBottom: 80 + insets.bottom }}
        refreshControl={
          <RefreshControl refreshing={q.isFetching && !q.isLoading} onRefresh={() => q.refetch()} tintColor={colors.primary} />
        }
      >
        {canSwitch && <OfficeToggle style={{ marginBottom: 12 }} />}

        {/* ── Header: which week we're closing, which we're opening ────── */}
        <View style={s.header}>
          <TouchableOpacity style={s.weekArrow} onPress={() => setWeek((w) => addWeeksISO(w, -1))} testID="weekly-review-prev">
            <Ionicons name="chevron-back" size={18} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity style={{ flex: 1, alignItems: 'center' }} onPress={() => setWeek(planningSunday())} disabled={onPlanningWeek}>
            <Text style={s.headerKicker}>{d?.office.name || 'Office'} · Weekly Review</Text>
            <Text style={s.headerTitle}>Reviewing {weekRange(d?.review_week_ending)}</Text>
            <Text style={s.headerSub}>
              Planning {weekRange(d?.week_ending || week)}
              {onPlanningWeek ? ' · this week' : ' · tap to jump back'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.weekArrow} onPress={() => setWeek((w) => addWeeksISO(w, 1))} testID="weekly-review-next">
            <Ionicons name="chevron-forward" size={18} color={colors.text} />
          </TouchableOpacity>
        </View>

        {q.isLoading ? (
          <View style={s.center}><BrandLoader size={48} /></View>
        ) : q.isError ? (
          <View style={s.center}>
            <Ionicons name="cloud-offline-outline" size={30} color={colors.textMuted} />
            <Text style={s.emptyText}>{(q.error as any)?.response?.data?.detail || 'Could not load the review.'}</Text>
          </View>
        ) : !d ? null : (
          <>
            {/* ── 1 · Last week, as an office ───────────────────────────── */}
            <SectionHead n={1} icon="stats-chart" title="Last week, as an office" colors={colors} s={s} />
            <ScrollReveal scrollY={scrollY}>
            <View style={s.card}>
              {(() => {
                // Headline against the office's own target where one exists;
                // the bottom-up sum of individual goals is shown beneath it so
                // a gap between the two is visible rather than averaged away.
                const t = d.totals;
                const usingTarget = t.target != null;
                const headline = usingTarget ? t.target : t.goal;
                const headlinePct = usingTarget ? t.target_pct : t.goal_pct;
                const gap = t.target != null && t.goal != null ? t.goal - t.target : null;
                return (
                  <>
                    <View style={s.heroRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.heroLabel}>Sign-ups</Text>
                        <Text style={s.heroValue}>
                          {num(t.sales)}
                          {headline != null && <Text style={s.heroGoal}> / {headline}</Text>}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={s.heroLabel}>Money made</Text>
                        <Text style={[s.heroValue, { color: colors.green }]}>{money(t.earnings)}</Text>
                      </View>
                    </View>
                    {headlinePct != null && (
                      <>
                        <View style={s.barTrack}>
                          <View
                            style={[
                              s.barFill,
                              {
                                width: `${Math.min(100, headlinePct)}%`,
                                backgroundColor: headlinePct >= 100 ? colors.green : headlinePct >= 80 ? colors.yellow : colors.red,
                              },
                            ]}
                          />
                        </View>
                        <Text style={s.barCaption}>
                          {headlinePct}% of the {usingTarget ? 'office target' : 'summed crew goals'}
                          {headlinePct >= 100 ? ' — hit 🎉' : ` · ${Math.max(0, (headline || 0) - t.sales)} short`}
                        </Text>
                      </>
                    )}
                    {usingTarget && t.goal != null && (
                      <Text style={s.barSub}>
                        Crew goals add up to {t.goal} ({t.goal_pct}%)
                        {gap === 0
                          ? ' — level with the target'
                          : gap! > 0
                          ? ` — ${gap} above the target`
                          : ` — ${-gap!} short of the target`}
                      </Text>
                    )}
                  </>
                );
              })()}
              <View style={s.tileGrid}>
                <Tile label="Piece avg" value={d.totals.piece_avg == null ? '—' : d.totals.piece_avg.toFixed(2)} s={s} />
                <Tile label="Scoring" value={pct(d.totals.scoring_pct)} s={s} />
                <Tile label="£15+ %" value={pct(d.totals.gold_pct)} s={s} />
                <Tile label="BA days" value={num(d.totals.ba_days)} s={s} />
                <Tile
                  label="Zero weeks"
                  value={`${d.totals.reps_zero}/${d.totals.reps_worked}`}
                  tone={d.totals.reps_zero > 0 ? 'bad' : 'good'}
                  s={s}
                  colors={colors}
                />
              </View>
            </View>
            </ScrollReveal>

            {/* ── 2 · Top 5 highrollers ─────────────────────────────────── */}
            <SectionHead n={2} icon="trophy" title="Top 5 highrollers" sub="By money made last week" colors={colors} s={s} />
            {d.highrollers.length === 0 ? (
              <Empty text="No earnings recorded for that week yet." s={s} colors={colors} />
            ) : (
              <ScrollReveal scrollY={scrollY}>
              <View style={s.card}>
                {d.highrollers.map((h) => {
                  const medal = h.rank === 1 ? '#D4AF37' : h.rank === 2 ? '#A8A9AD' : h.rank === 3 ? '#B87333' : colors.surfaceAlt;
                  return (
                    <View key={h.user_id} style={[s.rollerRow, h.rank === 1 && { backgroundColor: colors.surfaceAlt, borderRadius: 10 }]}>
                      <View style={[s.rankBadge, { backgroundColor: medal }]}>
                        <Text style={[s.rankText, h.rank > 3 && { color: colors.textMuted }]}>{h.rank}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.rollerName}>{h.name}</Text>
                        <Text style={s.rollerMeta}>
                          {h.sales} sign-up{h.sales === 1 ? '' : 's'} · {h.over30} at £15+ · {h.days_worked}d
                          {h.leader_name ? ` · ${h.leader_name}'s crew` : ''}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={s.rollerMoney}>{money(h.earnings)}</Text>
                        <Text style={s.rollerMeta}>{money(h.avg_per_day)}/day</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
              </ScrollReveal>
            )}

            {/* ── 3 · Positives & wins ──────────────────────────────────── */}
            <SectionHead
              n={3}
              icon="sparkles"
              title="Positives & wins"
              sub="Straight from the coaches' plans — what to call out"
              colors={colors}
              s={s}
            />
            {d.wins.length === 0 ? (
              <Empty text="No wins written up yet. Chase the plans below." s={s} colors={colors} />
            ) : (
              <ScrollReveal scrollY={scrollY}>
              <View style={s.card}>
                {d.wins.map((w, i) => (
                  <View key={`${w.user_id}-${i}`} style={s.winRow}>
                    <Ionicons name="checkmark-circle" size={15} color={colors.green} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.winText}>{w.text}</Text>
                      <Text style={s.attrib}>{w.name}</Text>
                    </View>
                  </View>
                ))}
              </View>
              </ScrollReveal>
            )}

            {/* ── 4 · Leader by leader ──────────────────────────────────── */}
            <View style={s.sectionHeadRow}>
              <SectionHead
                n={4}
                icon="people"
                title="Coach by coach"
                sub={`${d.plans_submitted}/${d.plans_total} plans in for this week`}
                colors={colors}
                s={s}
                inline
              />
              {d.leaders.length > 0 && (
                <TouchableOpacity onPress={toggleAll} style={s.expandAll}>
                  <Text style={s.expandAllText}>{allOpen ? 'Collapse all' : 'Expand all'}</Text>
                </TouchableOpacity>
              )}
            </View>
            {d.leaders.length === 0 ? (
              <Empty text="No coaches in this office yet." s={s} colors={colors} />
            ) : (
              d.leaders.map((l) => (
                <LeaderCard
                  key={l.user_id}
                  l={l}
                  expanded={!!open[l.user_id]}
                  onToggle={() => setOpen((o) => ({ ...o, [l.user_id]: !o[l.user_id] }))}
                  onOpenPlan={() => router.push(`/weekly-planner?user_id=${l.user_id}&week=${d.week_ending}`)}
                  colors={colors}
                  s={s}
                />
              ))
            )}

            {/* ── 5 · This week ─────────────────────────────────────────── */}
            <SectionHead n={5} icon="flag" title="This week" sub="Themes, focuses and what we're recruiting" colors={colors} s={s} />
            {d.themes.length > 0 && (
              <View style={s.card}>
                <Text style={s.cardHead}>Themes & concentration</Text>
                {d.themes.map((t) => (
                  <View key={t.user_id} style={s.themeRow}>
                    <Text style={s.themeWho}>{t.name}</Text>
                    {!!t.theme && <Text style={s.themeText}>“{t.theme}”</Text>}
                    {!!t.concentration && <Text style={s.themeSub}>Concentration: {t.concentration}</Text>}
                  </View>
                ))}
              </View>
            )}
            {d.focuses.length > 0 && (
              <View style={s.card}>
                <Text style={s.cardHead}>Focuses for the week</Text>
                {d.focuses.map((f, i) => (
                  <View key={`${f.user_id}-${i}`} style={s.winRow}>
                    <Ionicons name="arrow-forward-circle-outline" size={15} color={colors.primary} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.winText}>{f.text}</Text>
                      <Text style={s.attrib}>{f.name}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
            {d.developing.length > 0 && (
              <View style={s.card}>
                <Text style={s.cardHead}>Who we're developing</Text>
                {d.developing.map((x, i) => (
                  <View key={`${x.user_id}-${i}`} style={s.devRow}>
                    <Text style={s.devWho}>{x.who || '—'}</Text>
                    <Text style={s.devWhat}>{x.what}</Text>
                    <Text style={s.attrib}>by {x.name}</Text>
                  </View>
                ))}
              </View>
            )}
            <ScrollReveal scrollY={scrollY}>
            <View style={s.card}>
              <Text style={s.cardHead}>Recruitment across the office</Text>
              <View style={s.tileGrid}>
                <Tile label="Booked in" value={num(d.recruitment.booked_in)} s={s} />
                <Tile label="Attended" value={num(d.recruitment.attended)} s={s} />
                <Tile label="New starts" value={num(d.recruitment.newstarts)} s={s} />
              </View>
            </View>
            </ScrollReveal>

            {/* ── 6 · Needs chasing ─────────────────────────────────────── */}
            <SectionHead n={6} icon="alert-circle" title="Needs chasing" sub="Before we leave the room" colors={colors} s={s} />
            <View style={s.card}>
              <Text style={s.cardHead}>Plans still outstanding</Text>
              {d.missing_plans.length === 0 ? (
                <Text style={s.allGood}>Every coach has their plan in. 👏</Text>
              ) : (
                d.missing_plans.map((m) => (
                  <TouchableOpacity
                    key={m.user_id}
                    style={s.missingRow}
                    onPress={() => router.push(`/weekly-planner?user_id=${m.user_id}&week=${d.week_ending}`)}
                  >
                    <Ionicons name="time-outline" size={15} color={colors.yellow} />
                    <Text style={s.missingName}>{m.name}</Text>
                    <Text style={s.missingMeta}>
                      {m.steps_done === 0 ? 'Not started' : `${m.steps_done}/${m.steps_total} parts`}
                    </Text>
                    <Ionicons name="chevron-forward" size={15} color={colors.textMuted} />
                  </TouchableOpacity>
                ))
              )}
            </View>
            {d.eight_steps_office.length > 0 && (
              <View style={s.card}>
                <Text style={s.cardHead}>8 Steps — where the coaches rate themselves lowest</Text>
                {d.eight_steps_office.slice(0, 4).map((x) => (
                  <View key={x.step} style={s.stepRow}>
                    <Text style={s.stepName}>{x.step}</Text>
                    <View style={s.stepBarTrack}>
                      <View
                        style={[
                          s.stepBarFill,
                          { width: `${(x.avg / 5) * 100}%`, backgroundColor: x.avg < 3 ? colors.red : x.avg < 4 ? colors.yellow : colors.green },
                        ]}
                      />
                    </View>
                    <Text style={s.stepScore}>{x.avg.toFixed(1)}</Text>
                  </View>
                ))}
                <Text style={s.stepFoot}>Averaged across the coaches who rated themselves this week.</Text>
              </View>
            )}
            {d.learnings.length > 0 && (
              <View style={s.card}>
                <Text style={s.cardHead}>What the coaches learned</Text>
                {d.learnings.map((l, i) => (
                  <View key={`${l.user_id}-${i}`} style={s.winRow}>
                    <Ionicons name="bulb-outline" size={15} color={colors.yellow} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.winText}>{l.text}</Text>
                      <Text style={s.attrib}>{l.name}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────
function SectionHead({
  n, icon, title, sub, colors, s, inline,
}: { n: number; icon: any; title: string; sub?: string; colors: any; s: any; inline?: boolean }) {
  return (
    <View style={[s.sectionHead, inline && { flex: 1, marginBottom: 0 }]}>
      <View style={s.sectionNum}>
        <Text style={s.sectionNumText}>{n}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name={icon} size={14} color={colors.primary} />
          <Text style={s.sectionTitle}>{title}</Text>
        </View>
        {!!sub && <Text style={s.sectionSub}>{sub}</Text>}
      </View>
    </View>
  );
}

function Tile({ label, value, tone, s, colors }: { label: string; value: string; tone?: 'good' | 'bad'; s: any; colors?: any }) {
  return (
    <View style={s.tile}>
      <Text style={s.tileLabel}>{label}</Text>
      <Text style={[s.tileValue, tone === 'bad' && colors && { color: colors.red }, tone === 'good' && colors && { color: colors.green }]}>
        {value}
      </Text>
    </View>
  );
}

function Empty({ text, s, colors }: { text: string; s: any; colors: any }) {
  return (
    <View style={[s.card, { alignItems: 'center', gap: 6, paddingVertical: 20 }]}>
      <Ionicons name="document-text-outline" size={22} color={colors.textMuted} />
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

function KV({ label, value, s }: { label: string; value: string; s: any }) {
  if (!value || !value.trim()) return null;
  return (
    <View style={s.kv}>
      <Text style={s.kvLabel}>{label}</Text>
      <Text style={s.kvValue}>{value}</Text>
    </View>
  );
}

function LeaderCard({
  l, expanded, onToggle, onOpenPlan, colors, s,
}: {
  l: OfficeReviewLeader; expanded: boolean;
  onToggle: () => void; onOpenPlan: () => void; colors: any; s: any;
}) {
  const lw = l.last_week;
  const tm = l.plan.team_management;
  // Grade the crew against the goal the leader COMMITTED to for the reviewed
  // week (their crew goal, same number their own planner review shows); fall
  // back to the summed personal goals only when no crew goal was set.
  const crewGoal = lw.team_goal ?? lw.goal;
  const goalPct = crewGoal ? Math.round((100 * lw.sales) / crewGoal) : null;
  const tone = goalPct == null ? colors.textMuted : goalPct >= 100 ? colors.green : goalPct >= 80 ? colors.yellow : colors.red;

  return (
    <View style={s.leaderCard}>
      <TouchableOpacity style={s.leaderTop} onPress={onToggle} activeOpacity={0.7}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={s.leaderName}>{l.name}</Text>
            <View style={[s.pill, { backgroundColor: l.plan.submitted ? colors.greenBg : l.plan.started ? colors.yellowBg : colors.surfaceAlt }]}>
              <Text style={[s.pillText, { color: l.plan.submitted ? colors.green : l.plan.started ? colors.yellow : colors.textMuted }]}>
                {l.plan.submitted ? 'Plan in' : l.plan.started ? `${l.plan.steps_done}/${l.plan.steps_total}` : 'No plan'}
              </Text>
            </View>
          </View>
          <Text style={s.leaderMeta}>
            {l.crew_size} on crew · {lw.sales} sign-ups
            {crewGoal != null ? ` / ${crewGoal}` : ''} · {money(lw.earnings)}
          </Text>
        </View>
        {goalPct != null && <Text style={[s.leaderPct, { color: tone }]}>{goalPct}%</Text>}
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </TouchableOpacity>

      {expanded && (
        <View style={s.leaderBody}>
          {/* Last week */}
          <Text style={s.blockHead}>Last week</Text>
          <View style={s.tileGrid}>
            <Tile label="Piece avg" value={lw.piece_avg == null ? '—' : lw.piece_avg.toFixed(2)} s={s} />
            <Tile label="Scoring" value={pct(lw.scoring_pct)} s={s} />
            <Tile label="£15+ %" value={pct(lw.gold_pct)} s={s} />
            <Tile label="BA days" value={num(lw.ba_days)} s={s} />
            <Tile label="Zero weeks" value={`${lw.reps_zero}/${lw.reps_worked}`} tone={lw.reps_zero > 0 ? 'bad' : 'good'} s={s} colors={colors} />
            {lw.own && <Tile label="Own sign-ups" value={num(lw.own.sales)} s={s} />}
          </View>
          {lw.top.length > 0 && (
            <Text style={s.topEarners}>
              Top earners: {lw.top.map((t) => `${t.name} ${money(t.earnings)}`).join(' · ')}
            </Text>
          )}

          {/* This week's plan */}
          <Text style={s.blockHead}>This week's plan</Text>
          {!l.plan.started ? (
            <Text style={s.noPlan}>Nothing written yet for this week.</Text>
          ) : (
            <>
              <View style={s.goalRow}>
                <View style={s.goalChip}>
                  <Text style={s.goalChipLabel}>Personal goal</Text>
                  <Text style={s.goalChipValue}>{l.plan.goals.personal ?? '—'}</Text>
                </View>
                <View style={s.goalChip}>
                  <Text style={s.goalChipLabel}>Team goal</Text>
                  <Text style={s.goalChipValue}>{l.plan.goals.team ?? '—'}</Text>
                </View>
              </View>
              <KV label="Theme" value={l.plan.theme} s={s} />
              <KV label="Concentration" value={l.plan.concentration} s={s} />
              {l.plan.focus_next_week.length > 0 && (
                <View style={s.kv}>
                  <Text style={s.kvLabel}>Focuses</Text>
                  {l.plan.focus_next_week.map((f, i) => (
                    <Text key={i} style={s.bullet}>• {f}</Text>
                  ))}
                </View>
              )}
              {l.plan.wins.length > 0 && (
                <View style={s.kv}>
                  <Text style={s.kvLabel}>Wins</Text>
                  {l.plan.wins.map((w, i) => (
                    <Text key={i} style={s.bullet}>• {w}</Text>
                  ))}
                </View>
              )}
              <KV label="Meetings" value={tm.meetings} s={s} />
              <KV label="Team call" value={tm.team_call} s={s} />
              <KV label="1-on-1s" value={tm.one_on_one} s={s} />
              <KV label="Education" value={tm.education} s={s} />
              <KV label="Social" value={tm.social} s={s} />
              {l.plan.developing.length > 0 && (
                <View style={s.kv}>
                  <Text style={s.kvLabel}>Developing</Text>
                  {l.plan.developing.map((x, i) => (
                    <Text key={i} style={s.bullet}>• {x.who}{x.what ? ` — ${x.what}` : ''}</Text>
                  ))}
                </View>
              )}
              {l.plan.eight_steps.lowest.length > 0 && (
                <View style={s.kv}>
                  <Text style={s.kvLabel}>8 Steps — lowest</Text>
                  <Text style={s.bullet}>
                    {l.plan.eight_steps.lowest.map((x) => `${x.step} (${x.score}/5)`).join(' · ')}
                  </Text>
                </View>
              )}
              <KV label="8 Steps focus" value={l.plan.eight_steps.focus} s={s} />
              <KV label="Recruitment focus" value={l.plan.recruitment.focus} s={s} />
              <KV label="Headcount" value={l.plan.headcount} s={s} />
            </>
          )}

          <TouchableOpacity style={s.openPlan} onPress={onOpenPlan}>
            <Text style={s.openPlanText}>Open {l.name.split(' ')[0]}'s full planner</Text>
            <Ionicons name="arrow-forward" size={14} color={colors.primary} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 8 },
  emptyTitle: { fontFamily: fonts.display, fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 6 },
  emptyText: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, textAlign: 'center', lineHeight: 18 },

  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border,
    marginBottom: 16,
  },
  weekArrow: { paddingHorizontal: 14, paddingVertical: 14 },
  headerKicker: {
    fontFamily: fonts.bodySemibold, fontSize: 10, fontWeight: '800', color: colors.primary,
    letterSpacing: 0.7, textTransform: 'uppercase',
  },
  headerTitle: { fontFamily: fonts.display, fontSize: 17, fontWeight: '900', color: colors.text, marginTop: 3 },
  headerSub: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 2 },

  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, marginBottom: 10 },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, marginBottom: 10 },
  sectionNum: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  sectionNumText: { fontFamily: fonts.display, fontSize: 12, fontWeight: '900', color: colors.onPrimary },
  sectionTitle: { fontFamily: fonts.display, fontSize: 15, fontWeight: '900', color: colors.text },
  sectionSub: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 1 },
  expandAll: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.surfaceAlt },
  expandAllText: { fontFamily: fonts.bodySemibold, fontSize: 11, fontWeight: '800', color: colors.primary },

  card: {
    backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border,
    padding: 14, marginBottom: 14,
  },
  cardHead: {
    fontFamily: fonts.bodySemibold, fontSize: 11, fontWeight: '800', color: colors.textMuted,
    letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 10,
  },

  heroRow: { flexDirection: 'row', alignItems: 'flex-end' },
  heroLabel: {
    fontFamily: fonts.bodySemibold, fontSize: 10, fontWeight: '800', color: colors.textMuted,
    letterSpacing: 0.6, textTransform: 'uppercase',
  },
  heroValue: { fontFamily: fonts.display, fontSize: 30, fontWeight: '900', color: colors.text, marginTop: 2 },
  heroGoal: { fontFamily: fonts.display, fontSize: 17, fontWeight: '800', color: colors.textMuted },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceAlt, marginTop: 12, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  barCaption: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 6 },
  barSub: { fontFamily: fonts.body, fontSize: 10.5, color: colors.textMuted, marginTop: 3, opacity: 0.85 },

  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  tile: {
    flexGrow: 1, flexBasis: '30%', backgroundColor: colors.surfaceAlt, borderRadius: 10,
    paddingVertical: 9, paddingHorizontal: 10,
  },
  tileLabel: {
    fontFamily: fonts.bodySemibold, fontSize: 9, fontWeight: '800', color: colors.textMuted,
    letterSpacing: 0.5, textTransform: 'uppercase',
  },
  tileValue: { fontFamily: fonts.mono, fontSize: 15, fontWeight: '800', color: colors.text, marginTop: 3 },

  rollerRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 9, paddingHorizontal: 6 },
  rankBadge: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rankText: { fontFamily: fonts.display, fontSize: 12, fontWeight: '900', color: '#fff' },
  rollerName: { fontFamily: fonts.display, fontSize: 14, fontWeight: '800', color: colors.text },
  rollerMeta: { fontFamily: fonts.body, fontSize: 10.5, color: colors.textMuted, marginTop: 2 },
  rollerMoney: { fontFamily: fonts.monoSemibold, fontSize: 15, fontWeight: '800', color: colors.green },

  winRow: { flexDirection: 'row', gap: 9, paddingVertical: 7 },
  winText: { fontFamily: fonts.body, fontSize: 13, color: colors.text, lineHeight: 18 },
  attrib: { fontFamily: fonts.bodySemibold, fontSize: 10, color: colors.textMuted, marginTop: 2 },

  leaderCard: {
    backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border,
    marginBottom: 10, overflow: 'hidden',
  },
  leaderTop: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13 },
  leaderName: { fontFamily: fonts.display, fontSize: 14.5, fontWeight: '800', color: colors.text },
  leaderMeta: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 3 },
  leaderPct: { fontFamily: fonts.monoSemibold, fontSize: 15, fontWeight: '900' },
  pill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 },
  pillText: { fontFamily: fonts.bodySemibold, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.3 },
  leaderBody: { paddingHorizontal: 13, paddingBottom: 13, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 4 },
  blockHead: {
    fontFamily: fonts.bodySemibold, fontSize: 10, fontWeight: '800', color: colors.primary,
    letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 12,
  },
  topEarners: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 9, lineHeight: 16 },
  noPlan: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginTop: 8, fontStyle: 'italic' },
  goalRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  goalChip: { flex: 1, backgroundColor: colors.surfaceAlt, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 10 },
  goalChipLabel: {
    fontFamily: fonts.bodySemibold, fontSize: 9, fontWeight: '800', color: colors.textMuted,
    letterSpacing: 0.5, textTransform: 'uppercase',
  },
  goalChipValue: { fontFamily: fonts.mono, fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 3 },
  kv: { marginTop: 10 },
  kvLabel: {
    fontFamily: fonts.bodySemibold, fontSize: 9.5, fontWeight: '800', color: colors.textMuted,
    letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 3,
  },
  kvValue: { fontFamily: fonts.body, fontSize: 12.5, color: colors.text, lineHeight: 18 },
  bullet: { fontFamily: fonts.body, fontSize: 12.5, color: colors.text, lineHeight: 19 },
  openPlan: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 14, paddingVertical: 9, borderRadius: 10, backgroundColor: colors.surfaceAlt,
  },
  openPlanText: { fontFamily: fonts.bodySemibold, fontSize: 12, fontWeight: '800', color: colors.primary },

  themeRow: { paddingVertical: 7 },
  themeWho: { fontFamily: fonts.bodySemibold, fontSize: 11, fontWeight: '800', color: colors.textMuted },
  themeText: { fontFamily: fonts.display, fontSize: 14, fontWeight: '800', color: colors.text, marginTop: 2 },
  themeSub: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textSecondary, marginTop: 2 },
  devRow: { paddingVertical: 7 },
  devWho: { fontFamily: fonts.display, fontSize: 13, fontWeight: '800', color: colors.text },
  devWhat: { fontFamily: fonts.body, fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 17 },

  allGood: { fontFamily: fonts.body, fontSize: 12.5, color: colors.green, fontWeight: '700' },
  missingRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9 },
  missingName: { flex: 1, fontFamily: fonts.bodySemibold, fontSize: 13, fontWeight: '700', color: colors.text },
  missingMeta: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted },

  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 6 },
  stepName: { flex: 1, fontFamily: fonts.body, fontSize: 12, color: colors.text },
  stepBarTrack: { width: 70, height: 6, borderRadius: 3, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  stepBarFill: { height: 6, borderRadius: 3 },
  stepScore: { width: 26, textAlign: 'right', fontFamily: fonts.monoSemibold, fontSize: 12, fontWeight: '800', color: colors.text },
  stepFoot: { fontFamily: fonts.body, fontSize: 10.5, color: colors.textMuted, marginTop: 8, lineHeight: 15 },
});
