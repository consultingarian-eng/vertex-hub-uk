/**
 * The owner's "What Good Looks Like" weekly tiers — sign-ups in one week.
 *
 *   Super Green  10+
 *   Green        8–9
 *   Amber        6–7
 *   Red          5 and under
 *
 * "A Green Week" means Green or better (8+). Every screen that colour-codes
 * or counts a week by its sign-ups reads these, so the bands live in one
 * place.
 *
 * NOTE: the backend computes its own copies (Bells `green_pct`, the Green
 * Week badge, the Sales Path's GREEN_WEEK_SALES) — keep them in step.
 */
export const SUPER_GREEN_WEEK_MIN = 10;
export const GREEN_WEEK_MIN = 8;
export const AMBER_WEEK_MIN = 6;
/** Red is this many sign-ups or fewer. */
export const RED_WEEK_MAX = AMBER_WEEK_MIN - 1;

export type WeekBand = 'super_green' | 'green' | 'amber' | 'red';

/** Which tier a week's sign-up count falls in. */
export function weekBand(signUps: number): WeekBand {
  if (signUps >= SUPER_GREEN_WEEK_MIN) return 'super_green';
  if (signUps >= GREEN_WEEK_MIN) return 'green';
  if (signUps >= AMBER_WEEK_MIN) return 'amber';
  return 'red';
}

/** Green or better — the week counts as a Green Week. */
export function isGreenWeek(signUps: number): boolean {
  return signUps >= GREEN_WEEK_MIN;
}

/** On-screen names and ranges, top tier first. */
export const WEEK_BAND_LABELS: Record<WeekBand, { name: string; range: string }> = {
  super_green: { name: 'Super Green', range: `${SUPER_GREEN_WEEK_MIN}+` },
  green: { name: 'Green', range: `${GREEN_WEEK_MIN}–${SUPER_GREEN_WEEK_MIN - 1}` },
  amber: { name: 'Amber', range: `${AMBER_WEEK_MIN}–${GREEN_WEEK_MIN - 1}` },
  red: { name: 'Red', range: `${RED_WEEK_MAX} and under` },
};
