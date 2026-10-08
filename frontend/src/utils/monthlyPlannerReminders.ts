/**
 * Monthly Goal Planner — local push reminders.
 *
 * Schedules notifications at 9:00 AM on each of the LAST 3 days of the
 * current month, telling the user that next month is about to start and
 * to fill their planner out.
 *
 * Behaviour:
 *  • Skipped on web (no native scheduled notifications API).
 *  • Skipped if the user has revoked notification permission OR has
 *    disabled schedule reminders globally (we re-use the same opt-out).
 *  • Auto-cancelled the moment the user creates their next-month planner
 *    — call `rescheduleMonthlyPlannerReminder` after every planner save
 *    to keep this in sync.
 *
 * Stored ids → AsyncStorage key `monthly_planner_reminder_ids:v1`.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getScheduleRemindersEnabled } from './notificationPrefs';
import { getNativeNotifications } from '../notifications/nativeNotifications';
import { APP_LOCALE } from './appTime';

const STORAGE_KEY = 'monthly_planner_reminder_ids:v1';
const FIRE_HOUR = 9;       // 9 AM local
const FIRE_MINUTE = 0;
const REMINDER_DAYS = 3;   // last N days of the month

function thisMonthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function nextMonthKey(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return thisMonthKey(d);
}

/** Cancel anything we previously scheduled. Safe to call repeatedly. */
export async function clearMonthlyPlannerReminders() {
  const Notifications = getNativeNotifications();
  if (Notifications) {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const ids: string[] = JSON.parse(raw);
        await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => {})));
      }
    } catch {
      // Stale notification ids should never prevent clearing local state.
    }
  }
  await AsyncStorage.removeItem(STORAGE_KEY);
}

/**
 * Re-compute the schedule. Called on planner-screen mount and after every save.
 *
 * @param existingMonths  every month the user already has a planner doc for
 *                        (so we can skip if they've already created next month).
 */
export async function rescheduleMonthlyPlannerReminder(existingMonths: string[]) {
  // Always wipe first — easier to reason about than diffing.
  await clearMonthlyPlannerReminders();

  // User opt-out check (we share the existing toggle in Profile)
  const enabled = await getScheduleRemindersEnabled();
  if (!enabled) return { scheduled: 0, reason: 'user-disabled' };

  if (Platform.OS === 'web') return { scheduled: 0, reason: 'web-unsupported' };

  const Notifications = getNativeNotifications();
  if (!Notifications) return { scheduled: 0, reason: 'native-module-unavailable' };

  try {
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== 'granted') return { scheduled: 0, reason: 'permission-denied' };
  } catch {
    return { scheduled: 0, reason: 'permission-error' };
  }

  // If next month's planner already exists, the reminder is moot.
  const nm = nextMonthKey();
  if ((existingMonths || []).includes(nm)) {
    return { scheduled: 0, reason: 'next-month-exists' };
  }

  // Compute the last 3 days of the current month
  const today = new Date();
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const targetDays: number[] = [];
  for (let i = 0; i < REMINDER_DAYS; i++) {
    targetDays.push(lastDay - i);  // [last, last-1, last-2]
  }
  targetDays.reverse(); // schedule earliest first → [last-2, last-1, last]

  const newIds: string[] = [];
  for (const d of targetDays) {
    const fireAt = new Date(today.getFullYear(), today.getMonth(), d, FIRE_HOUR, FIRE_MINUTE, 0, 0);
    if (fireAt.getTime() <= today.getTime()) continue; // already past today

    const daysLeft = lastDay - d + 1; // 3 → 2 → 1 days remaining incl. fire-day
    const body = daysLeft === 1
      ? "Today is the last day of the month — fill your next-month planner now."
      : `Only ${daysLeft} day${daysLeft === 1 ? '' : 's'} left in the month. Take a few minutes to plan ${friendlyMonthName(today, 1)}.`;

    try {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: 'New month about to start',
          body,
          data: { kind: 'monthly-planner', target_month: nm },
          sound: 'default',
        },
        // Use the typed enum + Unix timestamp — the older
        // `{ type: 'date', date: <Date> }` shape silently fails in iOS
        // production (TestFlight / App Store) native builds.
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireAt.getTime(),
          channelId: Platform.OS === 'android' ? 'default' : undefined,
        },
      });
      newIds.push(id);
    } catch (e: any) {
      if (__DEV__) console.log('[mp-reminder] schedule error', e?.message || e);
    }
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newIds));
  return { scheduled: newIds.length, reason: 'ok' };
}

function friendlyMonthName(now: Date, monthOffset: number = 0): string {
  const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  return d.toLocaleString(APP_LOCALE, { month: 'long' });
}
