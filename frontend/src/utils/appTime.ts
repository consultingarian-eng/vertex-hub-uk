/**
 * The one timezone the whole app runs on (UK time by default, GMT/BST handled
 * automatically). Every "today", week boundary and office-time label reads the
 * clock in this zone rather than trusting the phone's own setting, so a rep
 * whose phone is set to another zone still sees the same day as the team.
 *
 * Mirrors backend/core/app_time.py (APP_TIMEZONE) — change both together.
 * Override at build time with EXPO_PUBLIC_APP_TIMEZONE.
 */
export const APP_TZ: string = process.env.EXPO_PUBLIC_APP_TIMEZONE || 'Europe/London';

/** Locale for every date, time and number the app formats. */
export const APP_LOCALE = 'en-GB';

/** Currency for every money figure the app formats. */
export const APP_CURRENCY = 'GBP';

/** Format a whole-pound (or pence, with `decimals`) amount as £1,234. */
export function formatMoney(amount: number, decimals = 0): string {
  return new Intl.NumberFormat(APP_LOCALE, {
    style: 'currency',
    currency: APP_CURRENCY,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number.isFinite(amount) ? amount : 0);
}
