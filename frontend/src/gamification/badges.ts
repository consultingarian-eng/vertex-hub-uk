/**
 * Achievement celebrations — badges are frequently earned by an action
 * someone ELSE took (a leader grading the trainee's 8th day, an admin
 * entering bells), so there's no single screen where the award happens for
 * the earning user. Instead: poll GET /me/badges wherever this hook is
 * mounted (Home, on every load/focus), find any `seen: false` rows, fire a
 * RankUp celebration for each in sequence, then mark them seen so they never
 * replay.
 */
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiService } from '../api/client';
import { useRankUpStore } from '../utils/rankUpStore';
import { useAuth } from '../auth/AuthContext';

const CELEBRATION_GAP_MS = 2900; // just past RankUp's own AUTO_DISMISS_MS

export function useBadgeWatcher() {
  const firedRef = useRef(false);
  const { isPreviewing } = useAuth();
  const { data } = useQuery({
    queryKey: ['my-badges'],
    queryFn: () => apiService.getMyBadges().then((res) => res.data),
    staleTime: 60_000,
    // While a super admin is previewing as someone else, don't fetch — the
    // celebration belongs to that person's next real session, and mark-seen
    // would be blocked (read-only) so it would replay every visit anyway.
    enabled: !isPreviewing,
  });

  useEffect(() => {
    if (isPreviewing) return;
    const unseen = (data || []).filter((b) => !b.seen);
    if (unseen.length === 0 || firedRef.current) return;
    firedRef.current = true;

    // Cumulative, variant-aware spacing: a level-up takeover holds the
    // screen ~4.4s, so a flat gap tuned to the 2.6s default would stomp it
    // — and Green Weeks commonly award personal_12 + sales_competency
    // together, making that the common case, not an edge.
    let delay = 0;
    unseen.forEach((badge) => {
      const isLevelUp = (badge as any).key?.startsWith('sales_');
      setTimeout(() => {
        useRankUpStore.getState().fire({
          emoji: badge.emoji,
          title: badge.title,
          subtitle: badge.subtitle,
          variant: isLevelUp ? 'levelup' : 'default',
        });
      }, delay);
      delay += isLevelUp ? 4700 : CELEBRATION_GAP_MS;
    });

    apiService.markBadgesSeen(unseen.map((b) => b.id)).catch(() => {});
  }, [data]);
}
