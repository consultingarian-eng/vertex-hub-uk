/**
 * SalesPathPanel — the Sales Development Path rendered anywhere it's needed:
 * the trainee's own COD tab, the leadership hub, and the per-person drill-in.
 *
 * Two ladders, one person: this runs BESIDE the COD stages. Six levels
 * (Beginner → Mastery), earned from bells data. The server
 * (core/sales_path.py) is the single oracle; this component only renders
 * what it returns and never computes a level client-side.
 *
 * Written in plain sales-floor English (owner rule, 2026-09-12): numbers
 * read the way a coach says them — "8 out of your last 10 days", "sales a
 * day" — never percentages-of-windows or words like "trajectory".
 *
 * Visual system ("Ink & Cube", spec §4 COD): the level hero is an ink
 * DepthCard with a 64px animated HexCoin (the ONE animated coin of the
 * panel), the level name as a folded RankRibbon and the six levels as static
 * 28px coins on a lit GRADIENT_XP rail; the form numbers are glowing
 * StatBlocks; ramp weeks carry XP bars (tip only on the live week); the
 * office Top 5 is a fanned CardStack with a gold/steel/bronze podium.
 *
 * Coach affordances (visible only with `viewerIsCoach` + a target):
 *   • ramp check-in notes on behind weeks (the 30-day coaching obligation)
 *   • raising + signing Expert/Mastery claims (Mastery signs admin-only —
 *     the server enforces both; buttons just mirror the rule).
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';
import { useColors, fonts } from '../../theme/ThemeContext';
import { GRADIENT, GRADIENT_XP, GRADIENT_GOLD, GRADIENT_STEEL, GRADIENT_BRONZE } from '../../theme/brand';
import { ShineSweep } from '../ui/ShineSweep';
import { Reveal } from '../ui/Reveal';
import { DepthCard, CardStack } from '../ui/DepthCard';
import { HexCoin } from '../ui/HexCoin';
import { RankRibbon, type RankRibbonTint } from '../ui/RankRibbon';
import { StatBlock } from '../ui/StatBlock';
import { XPBar } from '../ui/XPBar';
import { GlowButton } from '../ui/GlowButton';
import { haptics } from '../../utils/haptics';
import { useAuth } from '../../auth/AuthContext';
import { apiService, SalesPathContent, SalesPathDoc, SalesPathMeta, SalesPathRampWeek } from '../../api/client';
import { SalesPathEditor } from './SalesPathEditor';
import { NextUpChecklist } from './NextUpChecklist';
import { LEVEL_TINT } from './TwoLadders';
import { GREEN_WEEK_MIN } from '../../utils/weekBands';

const LEVEL_ORDER = [1, 2, 3, 4, 5, 6];
const LEVEL_EMOJI: Record<number, string> = { 1: '🌱', 2: '🥉', 3: '🥈', 4: '🥇', 5: '🏅', 6: '🐐' };
const RANK_MEDALS = ['🥇', '🥈', '🥉'];

/** Ribbon tint per level (the ribbon has no silver/bronze — amber/cyan stand in). */
const LEVEL_RIBBON: Record<number, RankRibbonTint> = {
  1: 'green', 2: 'amber', 3: 'cyan', 4: 'gold', 5: 'purple', 6: 'purple',
};
/** Podium stand metals for ranks 1–3. */
const PODIUM_METAL: Record<number, readonly string[]> = { 1: GRADIENT_GOLD, 2: GRADIENT_STEEL, 3: GRADIENT_BRONZE };

// Fallbacks when server content is missing — same plain-English lines as
// the backend defaults.
const LEVEL_ARC: Record<number, string> = {
  1: "Everyone starts here. You're learning the role — what you earn this week says nothing about what you'll earn next month.",
  2: `Your first Green Week — ${GREEN_WEEK_MIN}+ sign-ups in one week. Real money starts here, and most people get here quickly.`,
  3: `15 sign-ups a week is your normal now — well past the ${GREEN_WEEK_MIN}-a-week Green Week. Steady, strong money.`,
  4: "2+ sign-ups on 8 out of 10 days at a 15-a-week pace. You're one of the top earners now.",
  5: '2+ sign-ups on 9 out of 10 days, month after month. The biggest earnings in the field.',
  6: 'The best of the best — the people everyone else learns from, and paid like it.',
};

const RAMP_STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  not_started: { label: 'Not started yet', color: '#64748b', bg: '#64748b1a' },
  on_track: { label: 'On track 💪', color: '#22c55e', bg: '#22c55e1a' },
  behind: { label: 'Behind — extra coaching time', color: '#eab308', bg: '#eab3081a' },
  overdue: { label: 'Past 30 days — keep going', color: '#f97316', bg: '#f973161a' },
  complete: { label: 'Ramp done 🎉', color: '#22c55e', bg: '#22c55e1a' },
};

type Props = {
  path: SalesPathDoc;
  meta: SalesPathMeta;
  /** Coach viewing someone else — enables check-ins and claim/sign actions. */
  viewerIsCoach?: boolean;
  viewerIsAdmin?: boolean;
  targetUserId?: string;
  /** Admin-editable copy (server-merged). Falls back to built-in lines. */
  content?: SalesPathContent;
  /** Shows the pencil → in-app editor (admins; server enforces too). */
  canEdit?: boolean;
  onChanged?: () => void;
};

// ── Form stat tile ───────────────────────────────────────────────────────────
// A glowing StatBlock numeral with its plain-English hint; "—" while the
// window is too thin to say anything honest.
function FormStat({ label, value, decimals = 0, suffix = '', hint }: {
  label: string; value: number | null; decimals?: number; suffix?: string; hint: string;
}) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.formChip}>
      {value == null ? (
        // No gradient accent bar here: under a thick dash it read as a bar
        // chart with a censored value rather than "nothing to say yet".
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.formDash}>—</Text>
          <Text style={styles.formDashLabel} numberOfLines={1}>{label}</Text>
        </View>
      ) : (
        <StatBlock value={value} decimals={decimals} suffix={suffix} label={label} size={26} />
      )}
      <Text style={styles.formHint}>{hint}</Text>
    </View>
  );
}

export function SalesPathPanel({ path, meta, viewerIsCoach, viewerIsAdmin, targetUserId, content, canEdit, onChanged }: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const { user } = useAuth();
  const [checkinWeek, setCheckinWeek] = useState<string | null>(null);
  const [checkinNote, setCheckinNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Tap any level on the track to see what it takes — defaults to the next
  // level up (owner ask: every rank explorable, not just the next one).
  const [selectedLevel, setSelectedLevel] = useState<number | null>(null);
  const arcFor = (n: number) => content?.level_arc?.[String(n)] || LEVEL_ARC[n];

  const level = path.level || 1;
  const nextLevel = level < 6 ? level + 1 : null;
  const form = path.form || ({} as SalesPathDoc['form']);
  const formThin = (form.days_in_window ?? 0) < 20;
  const minDay = meta.min_scored_day_sales ?? 2;
  // "16 out of your last 20 days" beats "80% of your 20-day window".
  const nOf = (pct?: number, window?: number) =>
    Math.round(((pct ?? 0) / 100) * (window ?? 20));
  const scoredDays = form.scoring_pct_20d != null ? nOf(form.scoring_pct_20d, 20) : null;

  // The office Top 10 — everyone sees it; that's what makes it work.
  const boardQ = useQuery({
    queryKey: ['sales-path-leaderboard'],
    queryFn: () => apiService.getSalesPathLeaderboard().then((r) => r.data),
    staleTime: 60 * 1000,
  });

  const criteriaFor = (n: number): string | null => {
    const t = meta.thresholds?.[n];
    const w = t?.window ?? (n === 5 ? 30 : 20);
    const days = nOf(t?.scoring_pct, w);
    switch (n) {
      case 1: return 'Everyone starts here — finish your 8 training days and get selling.';
      case 2: return `Get your first Green Week — ${meta.green_week_sales ?? GREEN_WEEK_MIN}+ sign-ups in one week (after training) — and have your coach sign off your Stage 1 sales skills.`;
      case 3: return `3 Green Weeks, a 15-a-week pace (${t?.piece_avg ?? 3.0} sign-ups a day), ${minDay}+ sign-ups on ${days} of your last ${w} days out, and your Stage 2 sales skills signed off.`;
      case 4: return `${minDay}+ sign-ups on ${days} of your last ${w} days out — that's 8 in every 10 — at the 15-a-week pace (${t?.piece_avg ?? 3.0} sign-ups a day).`;
      case 5: return `${minDay}+ sign-ups on ${days} of ${w} days at the 15-a-week pace — then do it again for the next ${w}. Two months of proof, then your coach signs it.`;
      case 6: return `Hold Expert level for ${Math.round((meta.mastery_hold_days || 84) / 7)}+ weeks and help someone else get their first Green Week. Signed off by an admin.`;
      default: return null;
    }
  };
  const shownLevel = selectedLevel ?? nextLevel;
  const shownCriteria = shownLevel ? criteriaFor(shownLevel) : null;
  // The live scoreboard only exists for the level you're actually chasing —
  // the server builds it from the gate it just ran. Any OTHER level the rep
  // taps on the track keeps the one-line rule; there are no numbers to show
  // against a level two rungs up, and inventing some would be a lie.
  const nextUp = path.next_up || null;
  const showChecklist = !!nextUp && shownLevel === nextUp.level;

  const act = async (fn: () => Promise<any>, doneMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (doneMsg) Alert.alert(doneMsg);
      onChanged?.();
    } catch (e: any) {
      Alert.alert('Not possible', e?.response?.data?.detail || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const submitCheckin = (week: SalesPathRampWeek) => {
    if (!targetUserId || !checkinNote.trim()) return;
    act(async () => {
      await apiService.salesPathRampCheckin(targetUserId, week.week_ending, checkinNote.trim());
      setCheckinWeek(null);
      setCheckinNote('');
    }, 'Note saved');
  };

  const ramp = path.ramp;
  const rampMeta = ramp?.status ? RAMP_STATUS_META[ramp.status] : null;
  const board = boardQ.data;
  const myId = String(user?.id || '');
  // Lit rail: from the first coin's centre to the current level's centre
  // (coin centres sit at (n − ½)/6 of the track width).
  const litWidthPct = ((level - 1) / LEVEL_ORDER.length) * 100;

  return (
    <>
    <DepthCard style={styles.card}>
      {/* ── Level hero — the game-y bit: ink block, live coin, folded ribbon, lit rail ── */}
      <DepthCard variant="ink" style={styles.hero}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={[styles.kicker, { flex: 1 }]}>SALES PATH</Text>
          {canEdit && (
            <TouchableOpacity onPress={() => setEditorOpen(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} testID="sales-path-edit">
              <Ionicons name="pencil" size={16} color={colors.inkMuted} />
            </TouchableOpacity>
          )}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 8 }}>
          <HexCoin size={64} tint={LEVEL_TINT[level] || 'purple'} animate glow>
            <Text style={styles.heroEmoji}>{LEVEL_EMOJI[level]}</Text>
          </HexCoin>
          <View style={{ flex: 1, minWidth: 0 }}>
            {path.level_name ? (
              <RankRibbon tint={LEVEL_RIBBON[level] || 'purple'}>{String(path.level_name)}</RankRibbon>
            ) : null}
            <Text style={styles.principle}>
              Your level comes from what you do — not how long you've been here or what your title is.
            </Text>
          </View>
        </View>
        <View style={styles.track}>
          {/* Rail behind the coins + the lit segment up to the current level */}
          <View pointerEvents="none" style={styles.trackRail} />
          {litWidthPct > 0 && (
            <LinearGradient
              pointerEvents="none"
              colors={GRADIENT_XP}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={[styles.trackLit, { width: `${litWidthPct}%`, boxShadow: '0 0 8px ' + colors.glow }]}
            />
          )}
          {LEVEL_ORDER.map((n) => {
            const reached = n <= level;
            const selected = shownLevel === n;
            return (
              <TouchableOpacity
                key={n}
                style={styles.trackStep}
                onPress={() => { haptics.light?.(); setSelectedLevel(n); }}
                testID={`level-step-${n}`}
                activeOpacity={0.75}
              >
                <View style={[styles.trackCoin, selected && styles.trackCoinSelected, !reached && styles.trackCoinUpcoming]}>
                  <HexCoin size={28} tint={LEVEL_TINT[n]} animate={false}>
                    <Text style={[styles.trackStepEmoji, !reached && styles.trackStepDot]}>{reached ? LEVEL_EMOJI[n] : '·'}</Text>
                  </HexCoin>
                </View>
                <Text
                  style={[styles.trackStepText, reached && styles.trackStepTextDone, selected && styles.trackStepTextSelected]}
                  numberOfLines={1}
                >
                  {meta.level_names?.[n] || n}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={styles.trackHint}>Tap any level to see what it takes</Text>
      </DepthCard>

      {/* The long game, in one line — plus what your level means. */}
      <Text style={styles.arcLine}>
        {content?.arc_line || 'Getting good takes a few weeks. Getting great takes months — and pays a lot more.'}
      </Text>
      <Text style={styles.arcLevel}>{arcFor(level)}</Text>
      <TouchableOpacity
        onPress={() => router.push('/sales-path-intro' as never)}
        style={styles.introLink}
        hitSlop={{ top: 6, bottom: 6 }}
      >
        <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.introLinkWell}>
          <Ionicons name="information-circle-outline" size={13} color="#fff" />
        </LinearGradient>
        <Text style={styles.introLinkText}>How the Sales Path works</Text>
      </TouchableOpacity>

      {/* Current form — plain numbers, no analytics-speak. */}
      <View style={styles.formGrid}>
        <FormStat
          label={`${minDay}+ SIGN-UP DAYS`}
          value={formThin || scoredDays == null ? null : scoredDays}
          suffix="/20"
          hint={formThin ? `${form.days_in_window ?? 0}/20 days so far` : 'of your last 20'}
        />
        <FormStat
          label="PER DAY"
          value={formThin || form.piece_avg_20d == null ? null : (form.piece_avg_20d ?? 0)}
          decimals={1}
          hint={formThin ? 'early days yet' : 'sign-ups a day'}
        />
        <FormStat
          label="WEEKLY"
          value={form.avg_sales_4w == null ? null : (form.avg_sales_4w ?? 0)}
          decimals={1}
          hint="last 4 weeks"
        />
        <FormStat
          label="GREEN WEEKS"
          value={path.green_weeks ?? 0}
          hint={`${GREEN_WEEK_MIN}+ sign-up weeks`}
        />
      </View>

      {/* Level detail — any tapped level's requirements, money story and
          honest timeline; defaults to the next level up. Never a limit. */}
      {shownLevel != null && shownCriteria && (
        <View style={styles.nextBox}>
          <LinearGradient pointerEvents="none" colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.nextAccent} />
          <Text style={styles.nextTitle}>
            {shownLevel <= level
              ? `${meta.level_names?.[shownLevel] || shownLevel} ${LEVEL_EMOJI[shownLevel]} — you've got this one ✓`
              : shownLevel === nextLevel
                ? `Next up: ${meta.level_names?.[shownLevel] || shownLevel} ${LEVEL_EMOJI[shownLevel]}`
                : `${meta.level_names?.[shownLevel] || shownLevel} ${LEVEL_EMOJI[shownLevel]} — further up the ladder`}
          </Text>
          {showChecklist && nextUp ? (
            // A scoreboard, not a wall: every requirement with the rep's own
            // number against the target, ticked as it lands. The old sentence
            // is still there, folded away under "the full rule".
            <NextUpChecklist nextUp={nextUp} fullRule={shownCriteria} />
          ) : (
            <Text style={styles.nextBody}>{shownCriteria}</Text>
          )}
          {shownLevel > level && meta.typical_weeks?.[shownLevel] && (
            <Text style={styles.nextTiming}>
              Most people get here between weeks {meta.typical_weeks[shownLevel]} — and plenty get there faster. It's not a race, and it's not a limit.
            </Text>
          )}
          <Text style={styles.nextArc}>{arcFor(shownLevel)}</Text>
        </View>
      )}

      {/* Expert / Mastery claim + sign-off (server re-checks everything) */}
      {level === 4 && path.expert_data_eligible && !path.expert_ready_for_check && (
        <GlowButton
          style={styles.claimBtn} disabled={busy}
          onPress={() => act(() => apiService.setSalesPathReady(5, true, targetUserId), 'Expert sign-off requested')}
        >
          <Ionicons name="ribbon-outline" size={16} color="#fff" />
          <Text style={styles.claimBtnText}>Your numbers qualify — ask for the Expert sign-off</Text>
        </GlowButton>
      )}
      {level === 5 && path.mastery_data_eligible && !path.mastery_ready_for_check && (
        <GlowButton
          style={styles.claimBtn} disabled={busy}
          onPress={() => act(() => apiService.setSalesPathReady(6, true, targetUserId), 'Mastery sign-off requested')}
        >
          <Ionicons name="ribbon-outline" size={16} color="#fff" />
          <Text style={styles.claimBtnText}>Ask for the Mastery sign-off (admin)</Text>
        </GlowButton>
      )}
      {viewerIsCoach && targetUserId && path.expert_ready_for_check && (
        <GlowButton
          tone="green" style={styles.claimBtn} disabled={busy}
          onPress={() => act(() => apiService.signOffSalesPath(targetUserId, 5), 'Expert signed')}
        >
          <Ionicons name="shield-checkmark-outline" size={16} color="#fff" />
          <Text style={styles.claimBtnText}>Sign off Expert — check their weeks first</Text>
        </GlowButton>
      )}
      {viewerIsCoach && viewerIsAdmin && targetUserId && path.mastery_ready_for_check && (
        <GlowButton
          tone="green" style={styles.claimBtn} disabled={busy}
          onPress={() => act(() => apiService.signOffSalesPath(targetUserId, 6), 'Mastery signed')}
        >
          <Ionicons name="shield-checkmark-outline" size={16} color="#fff" />
          <Text style={styles.claimBtnText}>Sign off Mastery (admin)</Text>
        </GlowButton>
      )}

      {/* 30-day ramp */}
      {ramp && (
        <View style={styles.rampBox}>
          <View style={styles.rampHeader}>
            <Text style={styles.rampTitle}>First 30 days</Text>
            {rampMeta && (
              <View style={[styles.rampStatus, { backgroundColor: rampMeta.bg }]}>
                <Text style={[styles.rampStatusText, { color: rampMeta.color }]}>{rampMeta.label}</Text>
              </View>
            )}
          </View>
          {ramp.status === 'not_started' ? (
            <Text style={styles.rampHint}>
              Your ramp starts the week you do — sign-ups count from day one. Build to {(ramp.targets || [7, 10, 12, 15]).join(', then ')}.
              A Green Week ({GREEN_WEEK_MIN}+) is the minimum, not the goal — plenty of people run ahead of this.
            </Text>
          ) : (
            (ramp.weekly || []).map((w) => {
              // The live week keeps the lit sweep + glow halo; the pulsing tip
              // is off on every week — these are list rows, and the screen's
              // loop budget (spec §5, ≤6) is spent on the block nebula, the
              // ladder halo, the stage cube and the level coin.
              const live = !w.paused && !w.completed;
              const fill = w.target ? Math.min(1, (w.sales || 0) / w.target) : 0;
              return (
              <View key={w.week_ending} style={styles.weekRow}>
                <View style={[styles.weekDot,
                  w.met && { backgroundColor: '#22c55e', boxShadow: '0 0 8px rgba(34,197,94,0.6)' },
                  w.paused && { backgroundColor: colors.border },
                  w.completed && !w.met && !w.paused && { backgroundColor: '#eab308' }]}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.weekTitle}>
                    {w.paused || w.week == null
                      ? "Week off — doesn't count against you"
                      : `Week ${w.week} · build to ${w.target}`}
                  </Text>
                  <Text style={styles.weekSub}>
                    {w.sales} sign-up{w.sales === 1 ? '' : 's'}{w.completed ? '' : ' so far'} · w/e {w.week_ending}
                  </Text>
                  {!w.paused && (
                    <XPBar
                      value={fill}
                      height={8}
                      ticks={false}
                      tip={false}
                      // glow gates XPBar's looping ShineSweep — sheen never
                      // runs on a list row (spec §5). The live week is marked
                      // with a STATIC halo on the bar instead.
                      glow={false}
                      style={[styles.weekBar, live && { boxShadow: '0 0 10px ' + colors.glow }]}
                    />
                  )}
                  {w.checkin && (
                    <Text style={styles.checkinText}>
                      ✓ Coaching note{w.checkin.by_name ? ` — ${w.checkin.by_name}` : ''}: {w.checkin.note}
                    </Text>
                  )}
                  {viewerIsCoach && targetUserId && w.completed && !w.met && !w.paused && !w.checkin && (
                    checkinWeek === w.week_ending ? (
                      <View style={styles.checkinForm}>
                        <TextInput
                          style={styles.checkinInput}
                          placeholder="What did you coach, and what's the plan?"
                          placeholderTextColor={colors.textMuted}
                          value={checkinNote}
                          onChangeText={setCheckinNote}
                          multiline
                        />
                        <TouchableOpacity style={styles.checkinSave} disabled={busy || !checkinNote.trim()} onPress={() => submitCheckin(w)}>
                          <Text style={styles.checkinSaveText}>Save</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <TouchableOpacity onPress={() => { setCheckinWeek(w.week_ending); setCheckinNote(''); }}>
                        <Text style={styles.checkinLink}>+ Add a coaching note</Text>
                      </TouchableOpacity>
                    )
                  )}
                </View>
                {w.met && <Ionicons name="checkmark-circle" size={18} color="#22c55e" />}
              </View>
              );
            })
          )}
          {ramp.status === 'complete' && ramp.completed_at && (
            <Text style={styles.rampHint}>Green Week hit — week ending {ramp.completed_at}. 🟢</Text>
          )}
          <Text style={styles.rampTls}>
            After your ramp, the Traffic Light System takes over — green, amber and red weeks with real perks and real consequences. Tap "How the Sales Path works" for the full picture.
          </Text>
        </View>
      )}

      {canEdit && (
        <SalesPathEditor
          visible={editorOpen}
          onClose={() => setEditorOpen(false)}
          content={content}
          onSaved={() => onChanged?.()}
        />
      )}
    </DepthCard>

    {/* ── Office Top 10 — the leaderboard, a fanned deck with a metal podium ── */}
    {!!board?.top?.length && (
      <CardStack style={styles.boardStack}>
        <DepthCard style={styles.boardBox}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <Ionicons name="podium" size={16} color={colors.primary} />
            <Text style={styles.boardTitle}>Office Top 5</Text>
            <Text style={styles.boardSub}>· ranked by level, then Green Weeks</Text>
          </View>
          {/* The podium — 2nd | 1st | 3rd on stepped stands, champion under
              a gold shine. Ranks 4–5 stay as list rows below. */}
          {(() => {
            const podium = board.top.filter((r) => r.rank <= 3);
            const rest = board.top.filter((r) => r.rank > 3);
            const order = [2, 1, 3].map((rk) => podium.find((r) => r.rank === rk)).filter(Boolean) as typeof podium;
            return (
              <>
                {podium.length >= 2 && (
                  <View style={styles.podiumRow}>
                    {order.map((r, i) => {
                      const isMe = r.user_id === myId;
                      // Stepped stands, not slabs: tall enough to rank the
                      // three, short enough that the 26px medal FILLS its
                      // stand instead of floating in a sheet of metal.
                      const h = r.rank === 1 ? 56 : r.rank === 2 ? 44 : 36;
                      return (
                        <Reveal key={r.user_id} index={r.rank === 1 ? 2 : i} distance={22}>
                          <TouchableOpacity
                            style={styles.podiumCol}
                            activeOpacity={0.75}
                            onPress={() => setSelectedLevel(r.level)}
                          >
                            <HexCoin size={r.rank === 1 ? 40 : 34} tint={LEVEL_TINT[r.level] || 'purple'} animate={false} style={{ marginBottom: 4 }}>
                              <Text style={styles.podiumEmoji}>{LEVEL_EMOJI[r.level]}</Text>
                            </HexCoin>
                            <Text style={[styles.podiumName, isMe && { color: colors.primary }]} numberOfLines={1}>
                              {(r.name || '').split(' ')[0]}{isMe ? ' (you)' : ''}
                            </Text>
                            <Text style={styles.podiumLevel} numberOfLines={1}>{r.level_name}</Text>
                            <View style={[styles.podiumStand, { height: h }]}>
                              <LinearGradient
                                pointerEvents="none"
                                colors={(PODIUM_METAL[r.rank] || GRADIENT_BRONZE) as readonly [string, string, ...string[]]}
                                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                                style={StyleSheet.absoluteFill}
                              />
                              <View pointerEvents="none" style={styles.podiumBevel} />
                              {r.rank === 1 && <ShineSweep tint="#fff7d1" />}
                              <Text style={styles.podiumRank}>{RANK_MEDALS[r.rank - 1]}</Text>
                            </View>
                          </TouchableOpacity>
                        </Reveal>
                      );
                    })}
                  </View>
                )}
                {(podium.length < 2 ? board.top : rest).map((r, i) => {
                  const isMe = r.user_id === myId;
                  return (
                    <Reveal key={r.user_id} index={i + 3}>
                      {/* Ranks 4–10 are tiles, not bare text, so the list
                          finishes the podium instead of trailing off. No
                          sheen — these are list rows. */}
                      <TouchableOpacity
                        style={styles.boardRowTouch}
                        activeOpacity={0.7}
                        onPress={() => setSelectedLevel(r.level)}
                      >
                        <DepthCard
                          style={[styles.boardRow, isMe && styles.boardRowMe]}
                          fill={isMe ? (colors.primary || '#244C3B') + '1F' : colors.surfaceAlt}
                        >
                          <Text style={styles.boardRank}>{RANK_MEDALS[r.rank - 1] || `#${r.rank}`}</Text>
                          <Text style={[styles.boardName, isMe && { color: colors.primary }]} numberOfLines={1}>
                            {r.name}{isMe ? ' (you)' : ''}
                          </Text>
                          <Text style={styles.boardLevel}>{LEVEL_EMOJI[r.level]} {r.level_name}</Text>
                        </DepthCard>
                      </TouchableOpacity>
                    </Reveal>
                  );
                })}
              </>
            );
          })()}
          {board.my_rank != null && board.my_rank > 5 && (
            <Text style={styles.boardMe}>
              You're #{board.my_rank} of {board.total} — every Green Week moves you up. 📈
            </Text>
          )}
        </DepthCard>
      </CardStack>
    )}
    </>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  card: { borderRadius: 20, padding: 14, marginTop: 12 },

  // Ink level hero
  hero: { borderRadius: 16, padding: 14, marginBottom: 12 },
  kicker: {
    fontFamily: fonts.displayWide, fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase',
    color: colors.inkMuted,
  },
  heroEmoji: { fontSize: 28 },
  principle: { fontFamily: fonts.body, fontSize: 11.5, color: colors.inkMuted, marginTop: 6, lineHeight: 16 },

  // Level track — six coins on a lit rail
  track: { flexDirection: 'row', marginTop: 14, position: 'relative' },
  trackRail: {
    position: 'absolute', left: '8.33%', right: '8.33%', top: 17, height: 2, borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  trackLit: { position: 'absolute', left: '8.33%', top: 16.5, height: 3, borderRadius: 1.5 },
  trackStep: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  trackCoin: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  trackCoinSelected: {
    backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1.5, borderColor: colors.inkText,
  },
  trackCoinUpcoming: { opacity: 0.45 },
  trackStepEmoji: { fontSize: 13 },
  trackStepDot: { fontSize: 14, color: colors.inkText, fontFamily: fonts.bodyBold },
  // 7.5px keeps the longest level name ("Competency", bold when selected)
  // inside its sixth of the track instead of ellipsising.
  trackStepText: {
    fontFamily: fonts.bodySemibold, fontSize: 7.5, letterSpacing: -0.1,
    color: colors.inkMuted, marginTop: 4, opacity: 0.8,
  },
  trackStepTextDone: { color: colors.inkText, opacity: 1 },
  trackStepTextSelected: { color: colors.inkText, fontFamily: fonts.bodyBold, opacity: 1 },
  trackHint: { fontFamily: fonts.body, fontSize: 9.5, color: colors.inkMuted, textAlign: 'center', marginTop: 8 },

  arcLine: { fontFamily: fonts.bodySemibold, fontSize: 11.5, color: colors.textSecondary, lineHeight: 16, marginBottom: 4 },
  arcLevel: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, lineHeight: 16, marginBottom: 8 },
  introLink: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 12 },
  introLinkWell: {
    width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 4px 10px -3px rgba(58,122,86,0.55)',
  },
  introLinkText: { fontFamily: fonts.bodyBold, fontSize: 12.5, color: colors.primary },

  // Form — 2×2 glowing stat tiles
  formGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // surfaceAlt (the tile/chip token), never `surface`: in dark, surface
  // (#0C241D) is DARKER than the card hosting it (#102D25) and the tiles sank
  // into wells — the exact pattern §2.3 exists to kill. surfaceAlt raises in
  // dark and reads as a lavender tile on the white card in light.
  formChip: {
    flexBasis: '48%', flexGrow: 1, backgroundColor: colors.surfaceAlt, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 8,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center',
  },
  // "—" placeholder: Space Grotesk, not Unbounded Black — Black's em dash at
  // 26px is a stubby slab that reads as a redaction bar. Height matches the
  // StatBlock numeral+accent stack it stands in for.
  formDash: { fontFamily: fonts.display, fontSize: 22, lineHeight: 34, color: colors.textMuted },
  formDashLabel: { marginTop: 8, fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.6, textTransform: 'uppercase', color: colors.textMuted },
  formHint: { fontFamily: fonts.body, fontSize: 9.5, color: colors.textMuted, marginTop: 4, textAlign: 'center' },

  nextBox: {
    marginTop: 12, padding: 12, paddingLeft: 15, borderRadius: 14, overflow: 'hidden',
    backgroundColor: (colors.primary || '#244C3B') + '12',
    borderWidth: 1, borderColor: (colors.primary || '#244C3B') + '30',
  },
  nextAccent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  nextTitle: { fontFamily: fonts.display, fontSize: 13.5, color: colors.primary, letterSpacing: -0.1 },
  nextBody: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textSecondary, marginTop: 3, lineHeight: 16 },
  nextTiming: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 6, lineHeight: 15, fontStyle: 'italic' },
  nextArc: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.textSecondary, marginTop: 5, lineHeight: 15 },

  claimBtn: { marginTop: 12, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, minHeight: 46 },
  claimBtnText: { fontFamily: fonts.bodyBold, color: '#fff', fontSize: 12.5, flexShrink: 1, textAlign: 'center' },

  rampBox: { marginTop: 14, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 },
  rampHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  rampTitle: { fontFamily: fonts.display, fontSize: 14, color: colors.text, letterSpacing: -0.2 },
  rampStatus: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  rampStatusText: { fontFamily: fonts.bodyBold, fontSize: 10 },
  rampHint: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textSecondary, lineHeight: 16, marginTop: 2 },
  rampTls: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, lineHeight: 15.5, marginTop: 8, fontStyle: 'italic' },

  weekRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8 },
  weekDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.border, marginTop: 4 },
  weekTitle: { fontFamily: fonts.bodyBold, fontSize: 12.5, color: colors.text },
  weekSub: { fontFamily: fonts.body, fontSize: 11, color: colors.textSecondary, marginTop: 1 },
  weekBar: { marginTop: 7, marginRight: 4 },
  checkinText: { fontFamily: fonts.body, fontSize: 11, color: colors.textSecondary, marginTop: 5, fontStyle: 'italic' },
  checkinLink: { fontFamily: fonts.bodyBold, fontSize: 11.5, color: colors.primary, marginTop: 6 },
  checkinForm: { marginTop: 8, gap: 6 },
  checkinInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 10,
    fontFamily: fonts.body, fontSize: 12, color: colors.text, backgroundColor: colors.surface, minHeight: 52,
  },
  checkinSave: {
    alignSelf: 'flex-start', backgroundColor: colors.primary, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  checkinSaveText: { fontFamily: fonts.bodyBold, color: colors.onPrimary, fontSize: 12 },

  // Leaderboard deck
  boardStack: { marginTop: 22, marginBottom: 6 },
  boardBox: { borderRadius: 20, padding: 14 },
  boardTitle: { fontFamily: fonts.display, fontSize: 14.5, color: colors.text, letterSpacing: -0.2 },
  boardSub: { fontFamily: fonts.bodySemibold, fontSize: 10.5, color: colors.textMuted, flexShrink: 1 },
  boardRowTouch: { marginTop: 6 },
  boardRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9,
    paddingHorizontal: 10, borderRadius: 12,
  },
  // `fill` carries the face colour (DepthCard strips backgroundColor), so the
  // "you" row only has to say so on the rim.
  boardRowMe: { borderColor: (colors.primary || '#244C3B') + '66' },
  podiumRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 10, marginBottom: 12, marginTop: 6 },
  podiumCol: { alignItems: 'center', width: 92 },
  podiumEmoji: { fontSize: 16 },
  podiumName: { fontFamily: fonts.bodyBold, fontSize: 12, color: colors.text, maxWidth: 90 },
  podiumLevel: { fontFamily: fonts.bodySemibold, fontSize: 9.5, color: colors.textMuted, marginBottom: 6 },
  podiumStand: {
    width: 86, borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  podiumBevel: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.6)' },
  // Fills the stand — the metal gradient and this medal together carry the
  // rank, so the level-tinted coins above can't be misread as rank colours.
  podiumRank: { fontSize: 26 },
  boardRank: { fontFamily: fonts.bodyBold, width: 30, fontSize: 13, color: colors.text, textAlign: 'center' },
  boardName: { flex: 1, fontFamily: fonts.bodyBold, fontSize: 13, color: colors.text },
  boardLevel: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.textSecondary },
  boardMe: { fontFamily: fonts.bodyBold, fontSize: 11.5, color: colors.primary, marginTop: 8, textAlign: 'center' },
});
