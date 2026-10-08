/**
 * Office-time day helpers.
 *
 * Everything the office plans around happens in app time (UK time — see
 * ./appTime), but the app runs on whatever timezone the phone is set to. A rep
 * on a phone still set to another zone must see the same "tomorrow" as
 * everyone standing next to them, so these read the clock in app time rather
 * than trusting the device.
 *
 * Mirrors `_planning_day_et` in backend/routes/primetime.py — if the rollover
 * rule changes, it has to change in both places.
 */
import { APP_LOCALE, APP_TZ } from './appTime';

/** The hour (app time) after which the working day is over and we plan tomorrow. */
export const ROLLOVER_HOUR = 18;

/** Today's date in the app's timezone, as {y, m, d, hour}. */
function appParts(): { y: number; m: number; d: number; hour: number } {
  const parts = new Intl.DateTimeFormat(APP_LOCALE, {
    timeZone: APP_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
  // 'hour' with hour12:false can come back as 24 at midnight in some engines.
  const hour = get('hour') % 24;
  return { y: get('year'), m: get('month'), d: get('day'), hour };
}

/**
 * The actual calendar day Primetime is being planned for right now.
 *
 * Before 6pm app time that's today; after it we roll to tomorrow, because the day is
 * done and what matters is what's happening next. Sunday has no Primetime and
 * is skipped in either direction.
 *
 * Returns a date rather than a weekday index on purpose: rolling forward on a
 * Saturday evening lands on Monday, which belongs to the FOLLOWING week, and a
 * bare index would silently point at the wrong week's Monday.
 */
export function planningTarget(): { date: string; weekEnding: string; dayIndex: number } {
  const { y, m, d, hour } = appParts();
  const dt = new Date(y, m - 1, d);
  if (hour >= ROLLOVER_HOUR) dt.setDate(dt.getDate() + 1);
  if (dt.getDay() === 0) dt.setDate(dt.getDate() + 1); // Sunday → Monday

  const iso = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;

  // Mon=0 … Sat=5, and the Sunday that ends this day's week.
  const dayIndex = (dt.getDay() + 6) % 7;
  const sunday = new Date(dt);
  sunday.setDate(sunday.getDate() + ((7 - dt.getDay()) % 7));

  return { date: iso(dt), weekEnding: iso(sunday), dayIndex };
}

/** True once the office has rolled over to planning tomorrow. */
export function isPlanningTomorrow(): boolean {
  return appParts().hour >= ROLLOVER_HOUR;
}
