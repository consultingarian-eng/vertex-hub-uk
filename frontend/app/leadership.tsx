/**
 * Leadership Hub — Stage 3 (and later, Stage 4) module browser.
 *
 * Visible to users with role in {leader, admin}. Renders Stage 3 modules
 * grouped by category (Personal Development, Recruiting, Week One Coaching,
 * Working with Stage 2, Running Sectors, Emotional Intelligence).
 *
 * Tapping a module navigates to the shared `/module/[id]` detail screen,
 * which already supports Stage 2/3/4 content + 4-dimension scoring.
 *
 * Look (Oct 2026, the Owner's ask: clean and sleek, not showy): the stages are
 * a row of compact pills; the stage header is one quiet panel with a small
 * tracked kicker, the title, the stage's words, its three shortcuts as slim
 * tiles, and the progress beside it (one figure, a thin bar, done / to go).
 * The rows under it are slim bordered rows, two to a line where there is room.
 * No ribbons, coins, glows or gradients. Copy, queries, handlers and
 * navigation are unchanged.
 */
import React, { useMemo, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { useColors, fonts } from '../src/theme/ThemeContext';
import { apiService } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import { CodTopicList } from '../src/components/cod/CodTopicList';
import { SalesPathPanel } from '../src/components/salespath/SalesPathPanel';
import { TwoLadders, salesNextFrom, salesStepsFrom, LadderStep } from '../src/components/salespath/TwoLadders';
import { StageVideo, useCodVideos } from '../src/components/cod/StageVideo';
import { COD_STAGE_ORDER, codStageIsBefore } from '../src/components/cod/stageOrder';
import { usePullToRefresh } from '../src/components/ui/PullRefresh';
import { useParallaxScroll } from '../src/components/ui/Parallax';
import { DepthCard } from '../src/components/ui/DepthCard';
import { Keycap } from '../src/components/ui/Keycap';

// Per-stage hub copy — COD 2026 names: Stage 4 "Team Builder", Stage SL
// "Sector/Site Leader" (stored as stage 5; unlocked for every leader).
// `icon` and `iconBg` are legacy and no longer read (the stage header carries
// no icon). Left in place so the per-stage data block still matches the other
// stage tables in the app.
// LOOKUP ONLY — never iterate this Record to build a rail: JS walks
// integer-like keys in ascending numeric order, which puts SL last. The
// display sequence lives in stageOrder.ts (COD_STAGE_ORDER).
const STAGE_META: Record<number, { toggle: string; sub: string; title: string; icon: any; iconBg?: string; body: string }> = {
  1: {
    toggle: 'Stage 1', sub: 'STAGE 1 · FOUNDATION', title: 'Build Your Core Competencies', icon: 'flag', iconBg: '#0ea5e9',
    body: 'Foundation — the core competencies every BA runs on: the 5-step sign-up, SEE, impulses, reliability, Field IQ and quality. Each capability climbs Know → Do → Deliver on the proof ladder. As a coach you sign new starters off on this stage (COD 1), so know it cold.',
  },
  2: {
    toggle: 'Stage 2', sub: 'STAGE 2 · INDEPENDENCE', title: 'Independence Modules', icon: 'school', iconBg: '#10b981',
    body: 'Self Management — operate like a professional. Every capability climbs the proof ladder: Know → Do → Deliver → Teach → Systemize. Deliver is the standard; your coach signs the proof.',
  },
  3: {
    toggle: 'Stage 3', sub: 'STAGE 3 · BEING A LEADER', title: 'Leadership Development', icon: 'trophy',
    body: 'Creating success in others — teaching, protecting quality, performance conversations, building independence. Pass a module\'s questions to tick Know, then tap Ready for check — your coach signs the rest.',
  },
  4: {
    toggle: 'Stage 4', sub: 'STAGE 4 · TEAM BUILDER', title: 'Embedding Systems & Independence', icon: 'construct', iconBg: '#f59e0b',
    body: 'Stop being the producer of results — build the people who produce results. The 4 Pillars at Team Builder level: your team runs to the standard when you are not in the room, and every standard has a metric and a consequence.',
  },
  5: {
    toggle: 'SL', sub: 'STAGE SL · SECTOR/SITE LEADER', title: 'Performance Management', icon: 'map', iconBg: '#ef4444',
    body: 'Running sectors and sites: territory, targets, quality, and belief — owned end to end.',
  },
};

// ── Stage header ─────────────────────────────────────────────────────────────
// One quiet panel: kicker, title, the stage's words and its shortcuts on the
// left; progress on the right (underneath on a phone).
type StageLink = { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void };

function StageHero({ stage, links, completed, total, pct, wide }: {
  stage: 1 | 2 | 3 | 4 | 5;
  links: StageLink[];
  completed: number;
  total: number;
  pct: number;
  wide: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const meta = STAGE_META[stage];
  return (
    <View style={[styles.hero, wide && { flexDirection: 'row', gap: 24 }]}>
      <View style={{ flex: 1.7, minWidth: 0 }}>
        <Text style={styles.heroKicker}>{meta.sub}</Text>
        <Text style={styles.heroTitle}>{meta.title}</Text>
        <Text style={styles.heroBody}>{meta.body}</Text>
        <View style={styles.heroLinks}>
          {links.map((l) => {
            // "Title — what it is": the title leads, the rest sits under it.
            const [head, ...rest] = l.label.split(' — ');
            return (
              <TouchableOpacity key={l.label} onPress={l.onPress} activeOpacity={0.75} style={styles.heroLink} accessibilityRole="button" accessibilityLabel={l.label}>
                <Ionicons name={l.icon} size={16} color={colors.primary} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.heroLinkTitle} numberOfLines={1}>{head}</Text>
                  {rest.length ? <Text style={styles.heroLinkSub} numberOfLines={1}>{rest.join(' — ')}</Text> : null}
                </View>
                <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
      <View style={[styles.heroProgress, wide ? { flex: 1, maxWidth: 340 } : { marginTop: 16 }]}
        accessibilityLabel={`${pct}% overall. ${completed} completed, ${total - completed} remaining`}>
        <Text style={styles.heroProgressLabel}>Overall</Text>
        <Text style={styles.heroPct}>{pct}<Text style={styles.heroPctSign}>%</Text></Text>
        <View style={styles.heroTrack}>
          <View style={[styles.heroFill, { width: `${Math.min(100, Math.max(0, pct))}%` as any }]} />
        </View>
        <View style={styles.heroStats}>
          <View style={styles.heroStat}>
            <Text style={styles.heroStatNum}>{completed}</Text>
            <Text style={styles.heroStatLabel}>Completed</Text>
          </View>
          <View style={styles.heroStatRule} />
          <View style={styles.heroStat}>
            <Text style={styles.heroStatNum}>{total - completed}</Text>
            <Text style={styles.heroStatLabel}>Remaining</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ── Row card ─────────────────────────────────────────────────────────────────
// The hub's tappable rows (manual pointer, CONTINUE, sign-offs, impacts, the
// sales ladder toggle): a DepthCard face with a keycap icon well, the same
// strings and the same handler as before.
//
// Every row well is SATURATED (gradient, or green for the sign-off queue).
// A single pale-lilac well in a column of gradient ones read as an unfinished
// row rather than a quieter one — pale keycaps stay where they are a system
// (the K·D·D·T·S grid, the locked banners), not in this column.
//
// `count` is the row's ACTIONABLE number (today: the sign-off queue). The
// title used to carry it inline — "Sign-offs waiting (28)" — which made the
// one thing an admin is meant to go and do the quietest number on a screen of
// 40 px glowing stats (review R2). It now rides a brand-gradient pill with
// Home's red urgency glow, the same treatment as Home's "N waiting" chip, so
// the number reads before the sentence does. The rendered characters are
// unchanged: the phrase, a space (the row gap), then "(", the count, ")" —
// the brackets simply sit inside the pill at half strength.
function RowCard({ onPress, icon, kicker, title, count, sub, chevron = 'chevron-forward', accent, titleLines }: {
  onPress: () => void;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  kicker?: string;
  title: string;
  count?: number;
  sub?: string;
  chevron?: React.ComponentProps<typeof Ionicons>['name'];
  /** The one row to do next: a brand edge and a filled icon well. */
  accent?: boolean;
  titleLines?: number;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <TouchableOpacity style={[styles.rowCard, accent && styles.rowCardAccent]} activeOpacity={0.8} onPress={onPress}>
      <View style={[styles.rowIcon, accent && { backgroundColor: colors.primary }]}>
        <Ionicons name={icon} size={17} color={accent ? colors.onPrimary : colors.primary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {kicker ? <Text style={styles.rowKicker}>{kicker}</Text> : null}
        {count === undefined ? (
          <Text style={styles.rowTitle} numberOfLines={titleLines}>{title}</Text>
        ) : (
          <View style={styles.rowTitleLine}>
            <Text style={[styles.rowTitle, styles.rowTitleShrink]} numberOfLines={titleLines}>{title}</Text>
            <View style={styles.countPill}>
              <Text style={styles.countBracket}>(</Text>
              <Text style={styles.countNum}>{count}</Text>
              <Text style={styles.countBracket}>)</Text>
            </View>
          </View>
        )}
        {sub ? <Text style={styles.rowSub} numberOfLines={2}>{sub}</Text> : null}
      </View>
      <Ionicons name={chevron} size={16} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

export default function LeadershipScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const tabBarClearance = useTabBarClearance();
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [shellW, setShellW] = useState(0);
  const wide = shellW >= 820;

  // Leaders/admins can flip between their own Stage 2 (independence work
  // they completed before being promoted) and Stage 3 (leadership
  // development). Both stages render with the exact same module-row UI
  // below — only the data source + hero copy change.
  const [stage, setStage] = useState<1 | 2 | 3 | 4 | 5>(3);

  const role = (user?.role || '').toLowerCase();
  const isAuthorized = role === 'leader' || role === 'admin';

  const stageStatusQ = useQuery({
    queryKey: ['stage-status'],
    queryFn: () => apiService.getStageStatus().then(r => r.data),
    enabled: isAuthorized,
  });
  const codVideosQ = useCodVideos();
  const checksQ = useQuery({
    queryKey: ['cod-checks'],
    queryFn: () => apiService.getPendingChecks().then((r) => r.data.checks),
    enabled: isAuthorized,
    staleTime: 60 * 1000,
  });

  // Every stage — Stage 1 included — is COD capability modules now. Stage 1
  // derives from the Foundation sheet's 4-Pillar capabilities, NOT the Day
  // 1-8 assessments (those keep their own grading flow in the manual/tabs).
  const modulesQ = useQuery({
    queryKey: ['modules', stage],
    queryFn: () => apiService.listModules(stage).then(r => r.data),
    enabled: isAuthorized,
  });

  const progressQ = useQuery({
    queryKey: ['module-progress', stage],
    queryFn: () => apiService.getMyModuleProgress(stage).then(r => r.data.progress),
    enabled: isAuthorized,
  });

  // Sales Development Path — the second ladder, beside the stage content.
  // Both queries no-op while the office is dark (flag on stage-status).
  const salesPathOn = !!stageStatusQ.data?.sales_path_enabled;
  const [salesOpen, setSalesOpen] = useState(false);
  const salesMeQ = useQuery({
    queryKey: ['sales-path-me'],
    queryFn: () => apiService.getMySalesPath().then(r => r.data),
    enabled: isAuthorized && salesPathOn,
  });
  const salesTeamQ = useQuery({
    queryKey: ['sales-path-team'],
    queryFn: () => apiService.getSalesPathTeam().then(r => r.data),
    enabled: isAuthorized && salesPathOn && salesOpen,
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      stageStatusQ.refetch(), modulesQ.refetch(), progressQ.refetch(),
      ...(salesPathOn ? [salesMeQ.refetch(), ...(salesOpen ? [salesTeamQ.refetch()] : [])] : []),
    ]);
    setRefreshing(false);
  }, [stageStatusQ, modulesQ, progressQ, salesPathOn, salesOpen, salesMeQ, salesTeamQ]);

  const { pullIndicator } = usePullToRefresh(onRefresh);

  // Feeds the app-wide pageScrollY (masthead condense, XP charge, hero parallax).
  const { scrollY, onScroll } = useParallaxScroll();

  // Auth gate — non-leaders see a friendly explanation, not a 404.
  if (!isAuthorized) {
    return (
      <View style={styles.gate}>
        <DepthCard style={styles.gateCard}>
          <Keycap size={62} radius={20}>
            <Ionicons name="lock-closed" size={28} color={colors.textMuted} />
          </Keycap>
          <Text style={styles.gateTitle}>Leadership Resources</Text>
          <Text style={styles.gateBody}>
            Stage 3 development modules are available once you advance to coach.
          </Text>
        </DepthCard>
      </View>
    );
  }

  const modules = (modulesQ.data?.modules || []) as any[];
  const progressById: Record<string, any> = {};
  (progressQ.data || []).forEach((p: any) => { progressById[p.module_id] = p; });

  // Stage-level stats — completed / total across the whole stage. (The
  // per-category grouping that used to live here had no reader left once
  // CodTopicList took over the list: it groups by pillar itself.)
  const totalCompleted = modules.filter((m) => progressById[m.id]?.completed).length;
  const totalModules = modules.length;
  const overallPct = totalModules > 0 ? Math.round((totalCompleted / totalModules) * 100) : 0;

  // The Two Ladders ink block is the screen's ink block when it renders; the
  // stage hero takes the ink role when it does not (one ink block per screen).
  const laddersShown = !!(salesPathOn && salesMeQ.data?.enabled && salesMeQ.data?.path && salesMeQ.data?.meta);

  // Stage rail items — the same visible stages + the same 🔒 label as before,
  // laid out in COD display order (1, 2, 3, SL, 4 — see stageOrder.ts). The
  // stored stage numbers are untouched; only the rail's sequence comes from
  // COD_STAGE_ORDER.
  const stageVisible = (s: number) =>
    s === 4 ? !!stageStatusQ.data?.stage_4_visible
      : s === 5 ? !!stageStatusQ.data?.stage_5_visible
        : true;
  const visibleStages = COD_STAGE_ORDER.filter(stageVisible) as Array<1 | 2 | 3 | 4 | 5>;
  const stageItems = visibleStages.map((s) => {
    const locked = s === 5 && !stageStatusQ.data?.stage_5_unlocked;
    return { key: String(s), label: STAGE_META[s].toggle, locked };
  });

  const heroLinks: StageLink[] = [
    { icon: 'information-circle-outline', label: 'How the COD works — proof ladder & the 4 Pillars', onPress: () => router.push('/cod-intro') },
    { icon: 'grid-outline', label: 'Sheet view — the K·D·D·T·S grid, like the paper COD', onPress: () => router.push(`/cod-sheet?stage=${stage}`) },
    ...(role === 'admin'
      ? [{ icon: 'shield-checkmark-outline' as const, label: 'Vet the COD — review & edit every module (syncs every office)', onPress: () => router.push('/cod-vetting') }]
      : []),
  ];

  return (
    <View style={{ flex: 1 }}>
      {pullIndicator}
      <Stack.Screen options={{ headerLeft: () => null, headerBackVisible: false }} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 + tabBarClearance, paddingHorizontal: 4 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <View style={styles.shell} onLayout={(e) => setShellW(e.nativeEvent.layout.width)}>
        {/* ── Two ladders, side by side — always a next thing on each.
            Development column mirrors the ACTIVE toggle stage; sales column
            comes from the leader's own path. ── */}
        {salesPathOn && salesMeQ.data?.enabled && salesMeQ.data?.path && salesMeQ.data?.meta && (() => {
          const nextMod = modules.find((m) => !progressById[m.id]?.completed);
          // Same visible stages as the rail, in COD display order. `done` vs
          // `upcoming` compares POSITION in that order, not the stored number
          // — 3 → SL → 4 is no longer numerically ascending, so `n < stage`
          // would call Team Builder done while you are still on SL.
          const devSteps: LadderStep[] = (visibleStages as number[])
            .map((n) => ({
              key: `d${n}`,
              label: n === 1 ? 'Foundation' : n === 2 ? 'Self Management' : n === 3 ? 'Leader' : n === 4 ? 'Team Builder' : 'Sector Leader',
              state: n === stage ? 'current'
                : (n === 3 && !stageStatusQ.data?.stage_3_unlocked) || (n === 5 && !stageStatusQ.data?.stage_5_unlocked)
                  ? 'locked'
                  : codStageIsBefore(n, stage) ? 'done' : 'upcoming',
            }));
          return (
            <View style={styles.ladders}>
              <TwoLadders
                devSteps={devSteps}
                salesSteps={salesStepsFrom(salesMeQ.data.path, salesMeQ.data.meta)}
                devNext={nextMod
                  ? { title: nextMod.topic, sub: `${STAGE_META[stage].toggle} · your next capability`, onPress: () => router.push(`/module/${nextMod.id}`) }
                  : modules.length > 0
                    ? { title: `${STAGE_META[stage].toggle} complete 🎉`, sub: 'Pick your next stage on the toggle below.' }
                    : undefined}
                salesNext={salesNextFrom(salesMeQ.data.path, salesMeQ.data.meta,
                  () => router.push('/sales-path-intro'))}
                scrollY={scrollY}
              />
            </View>
          );
        })()}

        {/* Stage toggle: a row of compact pills, in COD order. It scrolls
            sideways on a narrow phone, so every label stays whole. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.stageRail} contentContainerStyle={styles.stagePills} testID="leadership-stage-tabs">
          {stageItems.map((it) => {
            const on = it.key === String(stage);
            return (
              <TouchableOpacity
                key={it.key}
                onPress={() => setStage(Number(it.key) as 1 | 2 | 3 | 4 | 5)}
                style={[styles.stagePill, on && styles.stagePillOn]}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${it.label}${it.locked ? ', locked' : ''}`}
              >
                {it.locked ? <Ionicons name="lock-closed" size={11} color={on ? colors.onPrimary : colors.textMuted} /> : null}
                <Text style={[styles.stagePillText, on && styles.stagePillTextOn]}>{it.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <StageHero
          stage={stage}
          links={heroLinks}
          completed={totalCompleted}
          total={totalModules}
          pct={overallPct}
          wide={wide}
        />

        {/* Stage briefing video — the recorded intro/expectations for this
            stage (Cloudinary). SL has none by design. */}
        <StageVideo
          url={(codVideosQ.data as any)?.[`stage${stage}`]}
          title={`${STAGE_META[stage].toggle} — Stage Briefing`}
        />

        <View style={styles.rowGrid}>
        {/* ── Stage 1 pointer: the Day 1-8 manual keeps its own home. The COD
            list below is the Foundation sheet's capabilities — deliberately
            NOT a mirror of the daily assessments. ── */}
        {stage === 1 && (
          <RowCard
            onPress={() => router.push('/(tabs)/manual')}
            icon="book"
            title="Day 1–8 Training Manual"
            sub="The daily playbook & assessments live in the Manual tab — this sheet tracks the capabilities behind them"
          />
        )}

        {/* One next step: jump straight to the first unfinished module at
            this stage — the author decides the order, not the learner. */}
        {(() => {
          const next = modules.find((m) => !progressById[m.id]?.completed);
          if (!next) return null;
          return (
            <RowCard
              onPress={() => router.push(`/module/${next.id}`)}
              icon="play"
              kicker="CONTINUE"
              title={next.topic}
              titleLines={1}
              accent
            />
          );
        })()}

        {/* The coach's queue — sign-offs waiting, one tap away. */}
        {(checksQ.data?.length || 0) > 0 && (
          <RowCard
            onPress={() => router.push('/cod-checks')}
            icon="checkmark-done"
            title="Sign-offs waiting"
            count={checksQ.data!.length}
            sub={'Your people tapped "Ready for check" — confirm or send back'}
          />
        )}

        {/* COD ↔ library tie: every stage links to its impact sessions in the
            Coaching hub — same stage numbering, one source of truth. */}
        <RowCard
          onPress={() => router.push('/coaching')}
          icon="flash"
          title={`${STAGE_META[stage].toggle} Impacts`}
          sub="The live coaching sessions for this stage — in the Coaching hub library"
        />
        </View>

        {/* ── The second ladder — Sales Proficiency ("two ladders, one
            person"). Collapsed card: your level at a glance; expanded: your
            full panel + the team's levels, each tapping into the person's
            Sales Path tab. Hidden entirely while the office is dark. ── */}
        {salesPathOn && salesMeQ.data?.enabled && salesMeQ.data?.path && (
          <>
            <View style={styles.rowGrid}>
            <RowCard
              onPress={() => setSalesOpen((v) => !v)}
              icon="trending-up"
              title={`Sales Proficiency — ${salesMeQ.data.path.level_name}`}
              sub="Your second ladder — leadership moves fast, sales mastery compounds"
              chevron={salesOpen ? 'chevron-up' : 'chevron-down'}
            />
            </View>
            {salesOpen && (
              <View>
                {salesMeQ.data.meta && (
                  <SalesPathPanel
                    path={salesMeQ.data.path}
                    meta={salesMeQ.data.meta}
                    content={salesMeQ.data.content}
                    canEdit={!!salesMeQ.data.can_edit}
                    onChanged={() => salesMeQ.refetch()}
                  />
                )}
                {(salesTeamQ.data?.team || []).filter((t) => t.user_id !== user?.id).map((t, i) => (
                  <TouchableOpacity
                    key={t.user_id}
                    style={{ marginTop: 8 }}
                    activeOpacity={0.85}
                    onPress={() => router.push(`/leader/trainee/${t.user_id}?tab=sales`)}
                  >
                    <DepthCard style={styles.teamCard} index={i}>
                      <View style={styles.teamInner}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.teamName}>{t.name || 'Unknown'}</Text>
                          <Text style={styles.teamSub}>
                            L{t.level} {t.level_name}
                            {t.ramp_status && t.ramp_status !== 'complete' ? ` · ramp: ${t.ramp_status.replace('_', ' ')}` : ''}
                            {t.expert_data_eligible && t.level === 4 ? ' · Expert data ✓' : ''}
                          </Text>
                        </View>
                        {t.ramp_status === 'behind' && (
                          <Ionicons name="alert-circle" size={18} color="#eab308" />
                        )}
                        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                      </View>
                    </DepthCard>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        )}

        {/* My Trainees CTA removed — leaders/admins access trainees + sub-leaders
            from the My Team tab (tree view). The all-stages drill-in screen is
            wired into every tree-row tap. */}

        {/* Stage 3 soft-locked banner — leaders without a junior leader see a
            teaser explaining what unlocks Stage 3 fully. They CAN still
            self-rate Knowledge & Skill on each module while locked. Only
            shown when viewing Stage 3 (Stage 2 has no equivalent lock). */}
        {stage === 3 && stageStatusQ.data && !stageStatusQ.data.stage_3_unlocked && (
          <DepthCard style={styles.lockedBanner}>
            <View style={styles.lockedInner}>
              <Keycap size={40} radius={13}>
                <Ionicons name="lock-closed" size={20} color={colors.textMuted} />
              </Keycap>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.lockedTitle}>Stage 3 — preview mode</Text>
                <Text style={styles.lockedBody}>
                  You can rate yourself on <Text style={styles.lockedStrong}>Knowledge</Text> and <Text style={styles.lockedStrong}>Skill</Text> on every module. Consistency, Independence and pass-off come from your direct coach or admin once you've got a coach on your team.
                </Text>
              </View>
            </View>
          </DepthCard>
        )}

        {/* Stage SL locked banner — shown only if the server reports SL locked. */}
        {stage === 5 && stageStatusQ.data && !stageStatusQ.data.stage_5_unlocked && (
          <DepthCard style={styles.lockedBanner}>
            <View style={styles.lockedInner}>
              <Keycap size={40} radius={13}>
                <Ionicons name="map" size={20} color={colors.textMuted} />
              </Keycap>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.lockedTitle}>Stage SL — for coaches running sectors</Text>
                <Text style={styles.lockedBody}>
                  The Sector/Site Leader stage opens for coaches. Talk to the Owner about stepping up. You can preview the modules meanwhile.
                </Text>
              </View>
            </View>
          </DepthCard>
        )}

        {modulesQ.isLoading ? (
          <View style={{ padding: 32, alignItems: 'center' }}><BrandLoader size={52} /></View>
        ) : modules.length === 0 ? (
          // Empty state, dressed like the two locked banners above it: a
          // dashed DepthCard with a keycap well, so the screen has no bare
          // text left on the page field. Same string, same (absent) handler.
          <DepthCard style={styles.lockedBanner}>
            <View style={styles.lockedInner}>
              <Keycap size={40} radius={13}>
                <Ionicons name="file-tray-outline" size={20} color={colors.textMuted} />
              </Keycap>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.emptyBody}>
                  No {STAGE_META[stage].toggle} modules available for your office yet.
                </Text>
              </View>
            </View>
          </DepthCard>
        ) : (
          // The PDF's list, live: pillar headers + unnumbered capability rows
          // with the K·D·D·T·S boxes. No path, no numbering — within a stage
          // nothing has to be learned "before" anything else.
          <CodTopicList
            modules={modules}
            progressById={progressById}
            onPress={(m: any) => router.push(`/module/${m.id}`)}
          />
        )}
        </View>
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  // Screen roots stay transparent — the mount-once PageField paints the page.
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  gateCard: { borderRadius: 22, padding: 28, alignItems: 'center', alignSelf: 'stretch' },
  // Unbounded-Black: never add fontWeight (web faux-bold). Matches the
  // assessments gate exactly — the two gates in this package are one system.
  gateTitle: { fontFamily: fonts.displayBlack, fontSize: 20, letterSpacing: -0.5, color: colors.text, marginTop: 14 },
  gateBody: { fontFamily: fonts.body, fontSize: 14, color: colors.textSecondary, marginTop: 6, textAlign: 'center', lineHeight: 20 },

  shell: { width: '100%', maxWidth: 1180, alignSelf: 'center' },
  ladders: { marginHorizontal: 12, marginTop: 12 },
  stageRail: { marginHorizontal: 12, marginTop: 14, flexGrow: 0 },
  stagePills: { flexDirection: 'row', gap: 4, padding: 3, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  stagePill: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34, paddingHorizontal: 16, borderRadius: 9 },
  stagePillOn: { backgroundColor: colors.primary },
  stagePillText: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.textSecondary },
  stagePillTextOn: { color: colors.onPrimary },

  // ── Stage header: one quiet panel ──
  hero: { marginHorizontal: 12, marginTop: 12, padding: 20, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  heroKicker: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.6, color: colors.primary },
  heroTitle: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30, letterSpacing: -0.4, color: colors.text, marginTop: 6 },
  heroBody: { fontFamily: fonts.body, fontSize: 13.5, lineHeight: 20, color: colors.textSecondary, marginTop: 8, maxWidth: 680 },
  heroLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  heroLink: { flexGrow: 1, flexBasis: 210, minWidth: 190, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  heroLinkTitle: { fontFamily: fonts.bodySemibold, fontSize: 13, color: colors.text },
  heroLinkSub: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  heroProgress: { padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignSelf: 'stretch', justifyContent: 'center' },
  heroProgressLabel: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase', color: colors.textMuted },
  heroPct: { fontFamily: fonts.display, fontSize: 44, lineHeight: 50, letterSpacing: -1.5, color: colors.text, marginTop: 2, fontVariant: ['tabular-nums'] as any },
  heroPctSign: { fontSize: 22, color: colors.textMuted, letterSpacing: 0 },
  heroTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceAlt, overflow: 'hidden', marginTop: 10 },
  heroFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  heroStats: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  heroStat: { flex: 1 },
  heroStatRule: { width: 1, alignSelf: 'stretch', backgroundColor: colors.border, marginHorizontal: 14 },
  heroStatNum: { fontFamily: fonts.display, fontSize: 20, color: colors.text, fontVariant: ['tabular-nums'] as any },
  heroStatLabel: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 1 },

  // ── Rows: slim, bordered, two to a line where there is room ──
  rowGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginHorizontal: 12, marginTop: 10 },
  rowCard: { flexGrow: 1, flexBasis: 320, minWidth: 260, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 58, paddingHorizontal: 12, paddingVertical: 9,
    borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  rowCardAccent: { borderColor: colors.primary },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt },
  rowKicker: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1.4, color: colors.primary, marginBottom: 1 },
  rowTitle: { fontFamily: fonts.bodySemibold, fontSize: 13.5, color: colors.text },
  // Title + count pill on one line; the phrase shrinks first so the number
  // never wraps away from it.
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitleShrink: { flexShrink: 1 },
  countPill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 20, borderRadius: 10, backgroundColor: colors.red },
  countNum: { fontFamily: fonts.bodyBold, fontSize: 12, color: '#fff', fontVariant: ['tabular-nums'] as any },
  countBracket: { fontFamily: fonts.mono, fontSize: 11, color: 'rgba(255,255,255,0.55)', marginHorizontal: 1 },
  rowSub: { fontFamily: fonts.body, fontSize: 11.5, lineHeight: 15, color: colors.textMuted, marginTop: 1 },

  // Team rows under the open sales ladder (list rows: no sheen)
  teamCard: { borderRadius: 16 },
  teamInner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  teamName: { fontFamily: fonts.display, fontSize: 13.5, color: colors.text },
  teamSub: { fontFamily: fonts.body, fontSize: 11.5, lineHeight: 15, color: colors.textMuted, marginTop: 1 },

  // ── Locked banners (dashed DepthCards) ──
  lockedBanner: {
    marginHorizontal: 12, marginTop: 12, borderRadius: 18,
    borderStyle: 'dashed' as any, borderColor: colors.borderDark,
  },
  lockedInner: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  lockedTitle: { fontFamily: fonts.display, fontSize: 14, color: colors.text },
  // Empty stage list — the same dashed banner, one muted line of body copy.
  emptyBody: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17, color: colors.textMuted },
  lockedBody: { fontFamily: fonts.body, fontSize: 12, color: colors.textSecondary, marginTop: 4, lineHeight: 17 },
  lockedStrong: { fontFamily: fonts.bodyBold },
});
