/**
 * NextUpChecklist — the live scoreboard for the level you're chasing.
 *
 * Replaces the old one-sentence wall ("What it takes: 3 Green Weeks, a
 * 15-a-week pace, 2+ sales on 14 of your last 20 days out, and your Stage 2
 * sales skills signed off") with one row per requirement, the rep's OWN
 * number against the target, and a tick on every line that's done.
 *
 * Every number here comes straight off `path.next_up` — the server block the
 * level gate itself builds (core/sales_path.py `_next_up`). Nothing is
 * re-derived on the client, so a counter can never disagree with the award.
 *
 * Reading the payload:
 *   • `current` is the GATE's number, and it is null whenever nothing is
 *     graded yet — a stretch of days out too short to score
 *     (`window_ready: false`), or a requirement this rep is waived from. In
 *     that case `so_far` still carries their real live number, and the row
 *     counts `days_out` of `of_days` as the thing filling up. So "is this
 *     graded yet" is `current != null`.
 *   • `target` is the BAR, not a measurement — known before anyone works a
 *     day, so it stays set on a row that is still filling up. It is null only
 *     where no target exists at all: a signature, or a waived skills row.
 *   • `kind: 'signature'` is a person, not a number: it shows a status line,
 *     never a faked 0-of-1.
 *   • `met` is always the gate's own verdict — this file never decides it,
 *     and never prints a number that contradicts it (see `nextUpFormat.ts`).
 *
 * Tone (owner rule, confidence-first): no red, no "behind", no "you're
 * missing one". A rep with nothing ticked sees a start line; an unfinished
 * row reads "1 to go".
 *
 * Visual system ("Ink & Cube"): the SectionHead rule with the live score as
 * its heading, a segmented strip reading the whole card at a glance, Keycap
 * tick badges down the left rail, pips for the small counts (the owner's
 * ●●○ / ✓✓○○) and XPBars for everything longer. Motion: the bars are list
 * rows — `tip={false} glow={false}` — so the block registers ZERO loops.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors, fonts, GRADIENT, GRADIENT_XP } from '../../theme/ThemeContext';
import { Keycap } from '../ui/Keycap';
import { XPBar } from '../ui/XPBar';
import { fmt, fmtScore } from './nextUpFormat';
import type { SalesPathNextUp, SalesPathRequirement } from '../../api/client';

/** Above this many steps a row draws a bar instead of dots (14 pips is a rash). */
const MAX_PIPS = 6;

type Props = {
  nextUp: SalesPathNextUp;
  /** The old one-line "what it takes" sentence — kept behind a tap. */
  fullRule?: string | null;
  style?: StyleProp<ViewStyle>;
};

/**
 * "1 to go" — the only way a gap is ever worded (owner rule: never "you are
 * missing one").
 *
 * Whole things only. A pace row is deliberately left to its bar: the server
 * rounds an average's gap UP to a tenth so an unfinished row can never print
 * "0.0 to go", which means 2.87 → "2.9 of 3.0 · 0.2 to go" would show a rep
 * arithmetic that doesn't add up. Counts and day tallies are exact, so they
 * keep the nudge.
 */
function toGo(r: SalesPathRequirement): string | null {
  if (r.met || r.kind === 'average' || r.remaining == null || r.remaining <= 0) return null;
  return `${fmt(r.remaining)} to go`;
}

/** ●●○ — the owner's pips, for targets small enough to count at a glance. */
function Pips({ done, total, met }: { done: number; total: number; met: boolean }) {
  const colors = useColors();
  // Same green as the score on the row above — `sgreenInk`, the type-safe
  // stop (see ThemeContext); two greens on one row read as two states.
  const on = met ? colors.sgreenInk : colors.primary;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={{
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: i < done ? on : 'transparent',
            borderWidth: i < done ? 0 : 1.5,
            borderColor: colors.borderDark,
          }}
        />
      ))}
    </View>
  );
}

type RowModel = {
  r: SalesPathRequirement;
  /** "8 of 14", "10", "2.3" — or null when there is nothing honest to print. */
  value: string | null;
  /** The small line under the value: "3 needed", "a day so far". */
  valueSub: string | null;
  /** 0–1 for the bars. Their number over the gate's, or days out over days needed. */
  frac: number;
  /** How many dots to draw (0 = draw a bar instead). */
  pips: number;
  /** The line under the label. */
  sub: string;
  gap: string | null;
  isSig: boolean;
  /** Nothing is graded yet: waived, or a stretch of days out still filling. */
  ungraded: boolean;
};

/**
 * "days" under the score, for a count whose label and detail talk in weeks.
 *
 * Mastery's hold is 84 DAYS, so the row printed a bare "100" under the words
 * "12 weeks at Expert" — which reads as 100 weeks, nearly two years of a wait
 * that is under four months. Everything else on the card counts the thing its
 * own label names, so only the day counts need saying out loud.
 */
function unitWord(r: SalesPathRequirement): string | null {
  return r.kind === 'count' && r.unit === 'days' ? 'days' : null;
}

/** Everything a row needs to draw itself, derived once from the gate's block. */
function toModel(r: SalesPathRequirement): RowModel {
  const dec = r.decimals ?? 0;
  // Graded = the gate has a number for this rep on this row today. `target`
  // is the bar and is set even before grading starts, so `current` is the
  // signal.
  const graded = r.current != null && r.target != null;
  // Filling up = a trailing stretch too short to score yet. Nothing is ever
  // graded on a smaller denominator, so there IS no gate number — what is
  // growing is days out, so that's what the bar counts.
  const filling = !graded && r.window_ready === false;
  const unit = unitWord(r);

  let value: string | null = null;
  let valueSub: string | null = null;
  if (graded) {
    const cur = r.current as number;
    const tgt = r.target as number;
    // fmtScore, never toFixed: a rep on 2.96 a day is NOT at the 3.0 bar, and
    // "3.0 of 3.0" beside an empty tick box is the one thing this card may
    // never print. It prints "2.96 of 3.0" instead.
    const curText = fmtScore(cur, dec, tgt, r.met);
    const tgtText = fmt(tgt, dec);
    // Past the bar, "10 of 3" reads like a typo — and capping it at "3 of 3"
    // would hide a rep's ten Green Weeks. Their real number leads, with the
    // bar it cleared underneath it. Only when the two actually print
    // differently, or "100 / 100 needed" appears on a row sitting on 100.4.
    if (r.met && curText !== tgtText) {
      value = unit ? `${curText} ${unit}` : curText;
      valueSub = `${tgtText}${unit ? ` ${unit}` : ''} needed`;
    } else {
      value = `${curText} of ${tgtText}`;
      // A row may name what its number stands for — the sales total says
      // "3 a day" — otherwise the unit word, otherwise nothing.
      valueSub = r.value_sub ?? unit;
    }
  } else if (filling && r.so_far != null) {
    // Same rule off the gate's number: a live average of 2.97 must not read
    // as the 3.0 it is still short of, tick box empty.
    value = fmtScore(r.so_far, dec, r.target, r.met);
    valueSub = r.unit === 'sales_per_day' ? 'a day so far' : 'so far';
  }

  let frac = r.met ? 1 : 0;
  if (graded && (r.target as number) > 0) {
    frac = Math.min(1, (r.current as number) / (r.target as number));
  } else if (filling && r.of_days) {
    frac = Math.min(1, (r.days_out ?? 0) / r.of_days);
  }

  // One lone dot beside a tick box says nothing the tick box doesn't, so pips
  // start at two steps.
  const tgt = r.target as number;
  const pips = graded && r.kind === 'count' && tgt >= 2 && tgt <= MAX_PIPS ? tgt : 0;

  return {
    r, value, valueSub, frac, pips,
    // The server's note when it has one (a waiver, or a stretch still
    // filling); otherwise the plain detail.
    sub: r.kind === 'signature' ? r.detail : (r.note || r.detail),
    gap: toGo(r),
    isSig: r.kind === 'signature',
    ungraded: !graded && !filling,
  };
}

/**
 * The card at a glance: one segment per requirement, each as full as its own
 * row, green once it's ticked.
 *
 * Deliberately NOT a single bar of met/total. An Advanced rep sitting on
 * 22-of-27, 24-of-27 and three paces within a tenth would have watched a
 * completely empty bar under "0 of 6 ticked" — true, and a flat contradiction
 * of the five nearly-full bars right below it.
 */
function ProgressStrip({ models }: { models: RowModel[] }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: 3, marginTop: 8, marginBottom: 4 }}>
      {models.map((m) => (
        <View
          key={m.r.key}
          style={{
            flex: 1, height: 8, borderRadius: 4, overflow: 'hidden',
            backgroundColor: colors.trackBg, borderWidth: 1, borderColor: colors.border,
          }}
        >
          <LinearGradient
            colors={m.r.met ? (['#34d399', '#059669'] as const) : (GRADIENT_XP as unknown as readonly [string, string])}
            start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
            style={{ width: `${Math.round(m.frac * 100)}%`, height: '100%' }}
          />
        </View>
      ))}
    </View>
  );
}

export function NextUpChecklist({ nextUp, fullRule, style }: Props) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [ruleOpen, setRuleOpen] = useState(false);

  const rows = nextUp.requirements || [];
  const models = useMemo(() => rows.map(toModel), [rows]);
  const total = nextUp.total || rows.length;
  const done = nextUp.met_count || 0;
  const left = Math.max(0, total - done);

  // Always the owner's shape — "2 of 3 — one to go", never "you're missing
  // one". Nothing ticked reads as a start line, not a deficit.
  const headline = done >= total && total > 0
    ? `All ${total} ticked ✓`
    : `${done} of ${total} ticked`;
  const headHint = done < total
    ? `${left} to go`
    : nextUp.needs_signature && !nextUp.requested ? 'Just the sign-off to go' : null;

  return (
    <View style={[styles.wrap, style]}>
      {/* SectionHead treatment, made live: the 22×3 brand rule, then the
          score itself as the heading — the card already says which level. */}
      <View style={styles.sumRow}>
        <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.headRule} />
        <Text style={styles.sumText} numberOfLines={1}>{headline}</Text>
        {headHint ? <Text style={styles.sumHint}>{headHint}</Text> : null}
      </View>
      <ProgressStrip models={models} />

      {models.map((m) => {
        const r = m.r;
        const { value, valueSub, frac, pips, sub, gap, isSig } = m;
        // A signature isn't a number — say where it stands in words.
        const who = r.signed_off_by === 'admin' ? 'an admin' : 'your coach';
        const sigStatus = r.met ? 'Signed ✓'
          : r.requested ? `Asked for — ${who} signs it next`
            : r.can_request ? 'Your numbers are in — ask for it'
              : 'The last step, once the numbers are in';

        return (
          <View key={r.key} style={styles.row}>
            <View style={styles.rowTop}>
              <Keycap
                size={22} radius={7} tone={r.met ? 'green' : 'paper'}
                style={[styles.tick, !r.met && styles.tickTodo]}
                accessibilityLabel={r.met ? 'Done' : 'Still to do'}
              >
                {r.met ? <Ionicons name="checkmark" size={13} color="#fff" /> : null}
              </Keycap>
              <Text style={styles.rowLabel} numberOfLines={2}>{r.label}</Text>
              {value ? (
                <View style={styles.valueCol}>
                  <Text style={[styles.value, r.met && styles.valueMet]} numberOfLines={1}>{value}</Text>
                  {valueSub ? <Text style={styles.valueSub} numberOfLines={1}>{valueSub}</Text> : null}
                </View>
              ) : null}
            </View>

            <View style={styles.rowBody}>
              {/* What to DO comes first and in the reading colour. Everything
                  else on the row is a scoreboard, and a scoreboard alone left
                  a rep knowing the gap but not the move (owner, 2026-09-16). */}
              {r.action ? <Text style={styles.rowAction}>{r.action}</Text> : null}
              <View style={styles.subRow}>
                <Text style={styles.rowSub}>
                  {sub}
                  {gap ? <Text style={styles.rowGap}>{`  ·  ${gap}`}</Text> : null}
                </Text>
                {pips > 0 ? <Pips done={Math.min(pips, Math.round(r.current as number))} total={pips} met={r.met} /> : null}
              </View>

              {isSig ? (
                <View style={[styles.sigChip, r.met && styles.sigChipMet]}>
                  <Ionicons
                    name={r.met ? 'shield-checkmark' : 'ribbon-outline'}
                    size={12}
                    color={r.met ? colors.sgreenInk : colors.primary}
                  />
                  <Text style={[styles.sigText, r.met && { color: colors.sgreenInk }]}>{sigStatus}</Text>
                </View>
              ) : pips > 0 || m.ungraded ? null : (
                <XPBar
                  value={frac}
                  height={6}
                  ticks={false}
                  tip={false}
                  glow={false}
                  gradient={r.met ? (['#34d399', '#059669'] as const) : undefined}
                  style={styles.rowBar}
                />
              )}
            </View>
          </View>
        );
      })}

      {/* The old sentence still says it in one breath — kept, but folded away:
          the numbers above are the point now. */}
      {fullRule ? (
        <>
          <TouchableOpacity
            style={styles.ruleToggle}
            onPress={() => setRuleOpen((v) => !v)}
            hitSlop={{ top: 8, bottom: 8 }}
            testID="next-up-full-rule"
          >
            <Ionicons name={ruleOpen ? 'chevron-up' : 'chevron-down'} size={13} color={colors.primary} />
            <Text style={styles.ruleToggleText}>{ruleOpen ? 'Hide the full rule' : 'The full rule, in one line'}</Text>
          </TouchableOpacity>
          {ruleOpen ? <Text style={styles.ruleText}>{fullRule}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  wrap: { marginTop: 8 },

  headRule: { width: 22, height: 3, borderRadius: 2, alignSelf: 'center' },

  sumRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  sumText: { flex: 1, fontFamily: fonts.display, fontSize: 14, color: colors.text, letterSpacing: -0.2 },
  sumHint: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.textMuted },

  row: { marginTop: 11 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tick: { borderRadius: 7 },
  // An unticked Keycap is a blank tile: on the card's own tint it needs a rim
  // to read as an empty box waiting to be ticked rather than a gap — in dark
  // especially, where paper tone and the tinted card are nearly the same value.
  tickTodo: { borderWidth: 1, borderColor: colors.borderDark },
  rowLabel: { flex: 1, fontFamily: fonts.bodyBold, fontSize: 12.5, color: colors.text, lineHeight: 16 },
  // Fixed column so every number on the card lines up down the right edge.
  valueCol: { minWidth: 62, alignItems: 'flex-end' },
  // Space Grotesk, not the mono face: "0 of 1" in JetBrains Mono set the word
  // "of" as wide as the numerals and the score read as three separate things.
  value: { fontFamily: fonts.display, fontSize: 13, color: colors.text, letterSpacing: -0.2 },
  // sgreenInk, not sgreen: #059669 at 13px measures 3.8:1 on this card in
  // light — under the 4.5:1 this project holds type to, and this is the one
  // number on the row a rep is meant to read. Dark keeps the bright green.
  valueMet: { color: colors.sgreenInk },
  valueSub: { fontFamily: fonts.body, fontSize: 9, color: colors.textMuted, marginTop: 1 },

  // Everything under the label hangs off the tick column (22 + 8 gap).
  rowBody: { paddingLeft: 30, marginTop: 3 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowAction: { fontFamily: fonts.bodyBold, fontSize: 11.5, color: colors.text, lineHeight: 15, marginBottom: 2 },
  rowSub: { flex: 1, fontFamily: fonts.body, fontSize: 10.5, color: colors.textMuted, lineHeight: 14 },
  rowGap: { fontFamily: fonts.bodyBold, color: colors.primary },
  rowBar: { marginTop: 6, marginRight: 2 },

  sigChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
    marginTop: 6, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999,
    backgroundColor: (colors.primary || '#244C3B') + '1A',
    borderWidth: 1, borderColor: (colors.primary || '#244C3B') + '33',
  },
  sigChipMet: { backgroundColor: colors.greenBg, borderColor: colors.sgreen + '44' },
  sigText: { fontFamily: fonts.bodyBold, fontSize: 10.5, color: colors.primary },

  // Hairline + breathing room: without it the toggle sat flush against the
  // italic timing line below the card and read as already expanded.
  ruleToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 14, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  ruleToggleText: { fontFamily: fonts.bodySemibold, fontSize: 11, color: colors.primary },
  ruleText: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, lineHeight: 15.5, marginTop: 5 },
});

export default NextUpChecklist;
