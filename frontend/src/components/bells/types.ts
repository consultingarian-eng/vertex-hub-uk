// Shared types + helpers used across the Bells screen and its sub-components.
// Extracted from the original monolithic bells.tsx.
import { APP_TZ } from '../../utils/appTime';

/**
 * The two sign-up tiers a day row counts. The stored field names are legacy
 * (`over30` / `under30`) and the payload shape is unchanged — only the
 * meaning is:
 *   over30  → £15+ = a Target (£15/month) or Premium (£20/month) gift
 *   under30 → £12  = a Standard (£12/month) gift
 * Every label on the Bells screen reads from here so the wording stays in
 * one place. (`memberships` is still carried on the row but is not used by
 * Vertex and is never shown.)
 */
export const TIER = {
  over30: { short: '£15+', long: '£15+ Target/Premium' },
  under30: { short: '£12', long: '£12 Standard' },
} as const;

/** "sign-up" / "sign-ups" for a count. */
export function signUps(n: number): string {
  return `${n} sign-up${n === 1 ? '' : 's'}`;
}

/** Today's date in app (UK) time as YYYY-MM-DD, optionally shifted by whole days. */
export function appTodayISO(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const iso = `${get('year')}-${get('month')}-${get('day')}`;
  if (!offsetDays) return iso;
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Today's weekday in app (UK) time: 0=Mon … 6=Sun. */
export function appDayIdx(): number {
  return (new Date(appTodayISO() + 'T00:00:00Z').getUTCDay() + 6) % 7;
}

/** The Sunday that ends the current bells week, in app (UK) time. */
export function appWeekEndingISO(): string {
  return appTodayISO(6 - appDayIdx());
}

export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export type Day = {
  over30: number | null;
  under30: number | null;
  memberships: number | null;
  status: string;
};

/** Why an approved absence was granted, and who signed it off. */
export type AbsenceDetail = {
  reason: string;
  decided_at?: string | null;
  decided_by_name?: string;
  requested_by?: string;
  decision_note?: string;
};

export type Entry = {
  id: string | null;
  office_id: string;
  user_id: string | null;
  user_name: string;
  role?: string;
  break_even: number | null;
  weekly_goal: number | null;
  // Crew goal — only meaningful on a section leader's own row; the whole
  // team's weekly target (synced with the Weekly Planner's team-goal box).
  team_weekly_goal?: number | null;
  /**
   * This person's sign-ups plus their whole downline's. Sections on the sheet are
   * exclusive — a member only lands under their NEAREST section-leader
   * ancestor — so a leader whose reports are themselves section leaders sits
   * alone in their section. Their crew goal still covers everyone beneath
   * them, so it's compared against this (matches how the Weekly Planner
   * counts a team total).
   */
  team_subtree_sales?: number | null;
  last_week_total: number | null;
  last_week_total_source?: 'manual' | 'auto' | null;
  prev_prev_week_total?: number | null;
  week_ending: string;
  days: Day[];
  /**
   * Approved-absence context keyed by day index ('0'=Mon … '5'=Sat). An `ab`
   * on the row records only THAT someone was absent; the why and who approved
   * it live on the absence request, and the server folds them in here so the
   * table / public sheet can explain an AB on tap or hover.
   */
  absence_details?: Record<string, AbsenceDetail>;
  total_sales: number;
  total_over30: number;
  total_under30: number;
  total_memberships: number;
  days_worked: number;
  piece_average: number;
  reliability_pct?: number | null;
  scoring_pct?: number | null;
  earnings: number;
  average_earnings_per_day: number;
  daily_totals?: number[];
  /**
   * Estimated BA sign-up fees (the server's maths): fee_standard × £12
   * sign-ups + fee_target × £15+ sign-ups, BEFORE the 3rd direct-debit bonus.
   * Keys are optional so an older cached response (different shape) simply
   * falls back to showing the total.
   */
  earnings_breakdown?: {
    fee_standard?: number;
    fee_target?: number;
    standard_count?: number;
    target_count?: number;
    standard_earnings?: number;
    target_earnings?: number;
    sign_up_fees?: number;
  };
  /** Who they report to, and the stage they hold as OwnerIQ words it ("3", "3+"). */
  coach_name?: string | null;
  stage_label?: string | null;
  /** The office's (MC's) fees for this person's sign-ups. Sent to Admins only. */
  mc_fees?: number;
  primary_team?: { leader_id: string; leader_name: string; team_name: string } | null;
  teams?: Array<{ leader_id: string; leader_name: string; team_name: string }>;
  public_hidden?: boolean;
};

export function emptyDay(): Day {
  return { over30: null, under30: null, memberships: null, status: 'off' };
}

/**
 * Status helpers — only 'in' counts as a working day. 'off', 'rt', 'nc', and
 * legacy 'normal' are all excluded from piece_average / scoring denominators.
 * A day counts toward piece_average / scoring ONLY when it's 'in'. RT / NC / Off are excluded.
 */
export function isInDay(d: Day | null | undefined): boolean {
  return !!d && d.status === 'in';
}

/**
 * A day's working numeric total. Only 'in' days contribute.
 */
export function dayTotal(d: Day | null | undefined): number {
  if (!isInDay(d)) return 0;
  return (d!.over30 || 0) + (d!.under30 || 0);
}

/**
 * Absence requests must carry a reason — the office owner approves or denies
 * off the back of it, so a blank request isn't actionable. Shared by every
 * place an AB can be requested (card row, table cell, day view).
 */
export const MIN_AB_REASON = 3;
