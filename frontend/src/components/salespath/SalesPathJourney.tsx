/**
 * SalesPathJourney — the full sales-competency path as a winding map, built
 * on the same Duolingo-style JourneyPath the 8-day plan uses.
 *
 * One picture, whole career: training days → the three ramp weeks → the
 * Green Week trophy → the six proficiency levels, with the viewer's spot
 * pulsing "YOU ARE HERE" and every node tappable (the parent shows the
 * tapped level's what-it-takes card). States come from the server path doc
 * only — nothing is computed here.
 *
 * Nodes render as hexagonal rank coins on a neon trail: runway weeks are
 * purple, the Green Week trophy is green, and each level wears its medal's
 * metal (LEVEL_TINT) so the ladder reads bronze → silver → gold at a glance.
 *
 * One non-visual change rides with that pass: the ramp-target FALLBACK is
 * [7, 10, 12, 15], matching `backend/core/sales_path.py`
 * DEFAULT_RAMP_TARGETS, the live settings doc, and RAMP_SUB below — which
 * has described a 7/10/12/15 runway since b095e6d7 while the fallback still
 * said 6/9/12, so a dark office read "Week 1 — build to 6" over "7 is the
 * floor". See docs/graphic-overhaul/orchestrator-findings.md §15.
 */
import React from 'react';
import { JourneyPath, JourneyNode } from '../journey/JourneyPath';
import type { HexCoinTint } from '../ui/HexCoin';
import { SalesPathDoc, SalesPathMeta } from '../../api/client';
import { GREEN_WEEK_MIN } from '../../utils/weekBands';

export const LEVEL_EMOJI: Record<number, string> = { 1: '🌱', 2: '🥉', 3: '🥈', 4: '🥇', 5: '🏅', 6: '🐐' };

/** Coin metal per level — mirrors the medal emoji (bronze / silver / gold; Beginner green, Mastery purple). */
export const LEVEL_TINT: Record<number, HexCoinTint> = {
  1: 'green', 2: 'bronze', 3: 'silver', 4: 'gold', 5: 'gold', 6: 'purple',
};

// Short node lines — the tap-through card carries the full criteria.
export const LEVEL_SHORT: Record<number, string> = {
  1: 'Finish training and get selling',
  2: 'First Green Week + Stage 1 skills signed off',
  3: '3 Green Weeks · 2+ sign-ups on 14 of your last 20 days',
  4: '2+ sign-ups on 16 of your last 20 days',
  5: '27 of 30 days, twice in a row — coach-signed',
  6: 'Hold Expert 12+ weeks + coach someone to Green',
};

type Props = {
  path: SalesPathDoc;
  meta: SalesPathMeta;
  onSelectLevel?: (n: number) => void;
};

export function SalesPathJourney({ path, meta, onSelectLevel }: Props) {
  const level = path.level || 1;
  const greens = path.green_weeks || 0;
  const ramp = path.ramp;
  const rampActive = !!ramp && ['on_track', 'behind', 'overdue'].includes(ramp.status || '');
  const pastRunway = level >= 2 || greens >= 1 || ramp?.status === 'complete';
  // Mirrors backend DEFAULT_RAMP_TARGETS (see the header note), so the node
  // titles and RAMP_SUB below describe the same runway.
  const targets = ramp?.targets || [7, 10, 12, 15];

  const nodes: JourneyNode[] = [];

  // ── The runway — graded from the START week (sign-ups count from day 1) ──
  // The Green Week trophy belongs at the week whose target FIRST reaches a
  // Green Week, not after the whole runway. (Owner, 2026-09-14.) Green is the
  // owner's "What Good Looks Like" tier — 8+ sign-ups (src/utils/weekBands.ts).
  const GREEN = GREEN_WEEK_MIN;
  const greenAfter = targets.findIndex((t) => t >= GREEN);   // -1 if no week reaches it
  const rampSub = (t: number, i: number): string => {
    if (i === 0) return `Your start week — BA Academy, first field days, first sign-ups. ${t} is the floor.`;
    if (i === greenAfter) return `${t} — that's a Green Week.`;
    if (greenAfter >= 0 && i > greenAfter) return `${t} — the Green Week is behind you now.`;
    return `${t} is the worst case, not the aim.`;
  };

  const pushGreenWeek = () => nodes.push({
    key: 'green-week',
    kind: 'trophy',
    state: pastRunway ? 'done' : 'upcoming',
    title: 'Green Week 🟢',
    subtitle: `${GREEN}+ sign-ups in one week — steady money starts here.`,
    tint: 'green',
  });

  targets.forEach((t, i) => {
    const row = ramp?.weekly?.find((w) => !w.paused && w.week === i + 1);
    const state: JourneyNode['state'] = pastRunway
      ? 'done'
      : row?.met
        ? 'done'
        : rampActive && row && !row.completed
          ? 'today'
          : 'upcoming';
    nodes.push({
      key: `ramp-${i + 1}`,
      kind: 'day',
      state,
      // An elapsed week is WALKED whether or not its target landed: the trail
      // out of it lights, the coin stays unclaimed. (A missed week that greys
      // the whole map is exactly the negative-momentum read the confidence
      // rule forbids for a new hire.)
      travelled: !!row?.completed,
      title: `Week ${i + 1} — build to ${t}`,
      subtitle: rampSub(t, i),
      badge: String(i + 1),
      section: i === 0 ? 'THE RUNWAY' : undefined,
      todayLabel: 'YOU ARE HERE',
      tint: 'purple',
    });
    if (i === greenAfter) pushGreenWeek();
  });

  // No runway week reaches Green (a custom per-office ramp): the trophy still closes
  // the runway, because the ramp completes on the first Green Week whenever it lands.
  if (greenAfter === -1) pushGreenWeek();

  // ── The ladder ─────────────────────────────────────────────────────────
  for (let n = 1; n <= 6; n++) {
    nodes.push({
      key: `level-${n}`,
      kind: 'level',
      // The ladder only claims YOU ARE HERE once the runway is history —
      // otherwise a mid-ramp hire would pulse in two places at once.
      state: n < level ? 'done' : n === level && pastRunway ? 'today' : 'upcoming',
      title: `${meta.level_names?.[n] || `Level ${n}`}`,
      subtitle: LEVEL_SHORT[n],
      meta: meta.typical_weeks?.[n] ? `Most people: weeks ${meta.typical_weeks[n]} — plenty go faster` : undefined,
      badge: LEVEL_EMOJI[n],
      section: n === 1 ? 'THE LADDER' : undefined,
      todayLabel: 'YOU ARE HERE',
      tint: LEVEL_TINT[n],
      onPress: onSelectLevel ? () => onSelectLevel(n) : undefined,
    });
  }

  // Nobody is standing on this map — an admin or leader reading the explainer,
  // or a hire whose ramp has not opened yet. Without an anchor every segment
  // took the unlit branch and the flagship picture rendered with its neon off,
  // so light the runway through to the Green Week trophy: the road the page is
  // describing is drawn, while every coin stays honestly unclaimed.
  if (!nodes.some((n) => n.state !== 'upcoming')) {
    nodes.forEach((n) => {
      if (n.kind === 'day') n.travelled = true;
    });
  }

  return <JourneyPath nodes={nodes} />;
}
