/**
 * One place that knows every screen a sales goal shows up on.
 *
 * Personal and crew goals are already a single source of truth server-side —
 * both live on the leader's own bells row (`weekly_goal` / `team_weekly_goal`),
 * and every entry point writes that same row: the Bells "My Week" bars, the
 * Bells table's crew-goal pencil, the Weekly Planner's goal boxes, and the
 * planner's per-crew-member goals.
 *
 * What was NOT shared was the refresh. Each writer invalidated only the query
 * behind the screen it lived on, so setting a crew goal in the planner left
 * the Bells team cards, the Home crew pulse and the Monday Review showing the
 * old number until they happened to refetch. Every goal writer calls this
 * instead, so one edit updates every surface.
 *
 * React Query matches prefixes, so `['bells']` covers `['bells', week, office]`.
 * Add a key here when a new screen starts displaying a goal.
 */
import type { QueryClient } from '@tanstack/react-query';

const GOAL_DEPENDENT_KEYS: readonly (readonly unknown[])[] = [
  ['bells'],                        // Bells sheet — cards, table, entry rows
  ['bells-teams'],                  // Bells Team cards (crew goal per team)
  ['weekly-planner'],               // planner doc
  ['weekly-planner-stats'],         // planner goal boxes + crew list
  ['weekly-planner-pulse'],         // Home — crew pulse
  ['weekly-planner-home'],          // Home — my week card
  ['leader-today'],                 // Home — Team pulse crew goal
  ['office-weekly-review'],         // Monday Review scoreboard
  ['daily-breakdown'],              // "goal remaining" copy
  // The backend now mirrors an admin's crew goal into the Weekly Plan's
  // Sales Goal (core/goal_sync.py) — refresh the plan editor + Snapshot so
  // an open editor reseeds its draft instead of autosaving the stale goal
  // back over the fresh edit.
  ['agenda'],                       // Schedule → Weekly Plan editor
  ['snapshot-agenda'],              // Weekly Snapshot goal headline
];

/** Refresh every surface that displays a personal or crew sales goal. */
export function invalidateGoalQueries(queryClient: QueryClient): void {
  for (const queryKey of GOAL_DEPENDENT_KEYS) {
    queryClient.invalidateQueries({ queryKey: queryKey as unknown[] });
  }
}
