import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { getScheduleRemindersEnabled } from './notificationPrefs';
import { getNativeNotifications } from '../notifications/nativeNotifications';
import { APP_LOCALE, APP_TZ } from './appTime';

// Local-notification scheduler for the recurring weekly schedule.
//
// Approach: every time the schedule list is fetched (and on app launch via the
// schedule screen mounting), we cancel all previously-scheduled "schedule"
// notifications and re-create local notifications for every relevant block in
// the next ~14 days. We keep the IDs we created in AsyncStorage so we know
// what to cancel next time without affecting other notifications.
//
// Reminder offset: 5 minutes before block start.

export type ScheduleBlock = {
  id: string;
  office_id: string;
  day_of_week: number;       // 0=Mon..6=Sun
  start_time: string;        // 'HH:MM'
  end_time: string;
  title: string;
  audience: 'all' | 'leaders' | 'trainees' | 'core_leaders' | 'personal';
  core_leader_ids?: string[];
  owner_id?: string | null;  // set only for 'personal' blocks — the sole owner
  color: string;
  presenter?: string | null;
  topic?: string | null;
  details?: string | null;
  groups?: string[];              // timetable lanes: 's4' | 'ld' | 's2' | 's1'
  date?: string | null;           // 'YYYY-MM-DD' one-off; null repeats weekly
  kind?: 'event' | 'task';
  reminder_minutes?: number | null;
  done_dates?: string[];          // tasks: dates ticked off
};

const STORAGE_KEY = 'schedule_notif_ids_v1';
// 7-day lookahead keeps us comfortably under iOS's 64-pending-notification
// quota even with ~7 blocks/day. The schedule screen reschedules whenever
// it mounts, so users always have a fresh week of reminders.
const LOOKAHEAD_DAYS = 7;
const REMINDER_MINUTES = 5;

/** Returns true if the block should fire for the given user. */
export function isAudienceMatch(audience: string, role: string | undefined, userId?: string, coreLeaderIds?: string[], ownerId?: string | null): boolean {
  // Personal blocks belong to exactly one owner (no role needed).
  if (audience === 'personal') return !!userId && !!ownerId && userId === ownerId;
  if (!role) return false;
  if (audience === 'all') return true;
  if (audience === 'leaders') return role === 'leader' || role === 'admin';
  if (audience === 'trainees') return role === 'trainee';
  if (audience === 'core_leaders') {
    if (role === 'admin') return true;
    if (!userId) return false;
    return Array.isArray(coreLeaderIds) && coreLeaderIds.includes(userId);
  }
  return false;
}

/**
 * Returns true if the block should be visible at all (i.e. not entirely
 * hidden) for the given user.
 *  - admins see everything
 *  - trainees see 'all' + 'trainees' only (leaders/core_leaders blocks are hidden)
 *  - leaders see 'all' + 'leaders' + 'trainees' (so they can coach), plus
 *    core_leaders blocks they're explicitly part of
 *  - 'core_leaders' is always private to the listed user IDs
 */
export function isBlockVisible(audience: string, role: string | undefined, userId?: string, coreLeaderIds?: string[], ownerId?: string | null): boolean {
  // Personal blocks are private to their owner — hidden from everyone else,
  // including admins (checked before the admin catch-all below on purpose).
  if (audience === 'personal') return !!userId && !!ownerId && userId === ownerId;
  if (!role) return false;
  if (role === 'admin') return true;
  if (audience === 'core_leaders') {
    if (!userId) return false;
    return Array.isArray(coreLeaderIds) && coreLeaderIds.includes(userId);
  }
  // Trainees only see 'all' and 'trainees' blocks — leader content is hidden.
  if (role === 'trainee') return audience === 'all' || audience === 'trainees';
  // Leaders see 'all' + 'leaders' + 'trainees' (coaching visibility).
  if (role === 'leader') return audience === 'all' || audience === 'leaders' || audience === 'trainees';
  return true;
}

// All schedule times are app time (UK time) regardless of the device's locale.

/** Parse a UTC timestamp into its wall-clock parts in app time. */
function appPartsOf(d: Date): { year: number; month: number; day: number; dow: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat(APP_LOCALE, {
    timeZone: APP_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  const dowMap: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    year: parseInt(p.year),
    month: parseInt(p.month) - 1,  // 0-indexed
    day: parseInt(p.day),
    dow: dowMap[p.weekday] ?? 0,   // 0=Mon..6=Sun
    hour: parseInt(p.hour) % 24,  // some engines report midnight as 24
    minute: parseInt(p.minute),
  };
}

/**
 * Convert an app-time wall-clock date+time to a UTC timestamp.
 * Starts from "wall time as if it were UTC" and iterates on the full
 * wall-clock difference (days included), so it lands on the right instant
 * for any zone and across DST changes (GMT = UTC+0, BST = UTC+1).
 */
function appWallToUtcMs(year: number, month: number, day: number, hh: number, mm: number): number {
  const target = Date.UTC(year, month, day, hh, mm, 0);
  let utcMs = target;
  for (let i = 0; i < 3; i++) {
    const probe = appPartsOf(new Date(utcMs));
    const diff = target - Date.UTC(probe.year, probe.month, probe.day, probe.hour, probe.minute, 0);
    if (diff === 0) break;
    utcMs += diff;
  }
  return utcMs;
}

/**
 * Returns the next occurrence of (day_of_week, HH:MM) in app time as a UTC Date.
 * day_of_week: 0=Mon..6=Sun matching the schedule model.
 * hhmm: '09:00' stored as app-time wall time.
 */
function nextOccurrence(day_of_week: number, hhmm: string, fromDate = new Date()): Date {
  const [hh, mm] = hhmm.split(':').map((s) => parseInt(s, 10) || 0);
  const now = appPartsOf(fromDate);

  let daysDiff = (day_of_week - now.dow + 7) % 7;
  // If same app-time day, check whether the block time has already passed
  if (daysDiff === 0 && hh * 60 + mm <= now.hour * 60 + now.minute) {
    daysDiff = 7;
  }

  // Build the target date (plain date arithmetic — add whole days to midnight)
  const midnightUtc = Date.UTC(now.year, now.month, now.day);
  const targetUtcDate = new Date(midnightUtc + daysDiff * 86_400_000);

  return new Date(appWallToUtcMs(
    targetUtcDate.getUTCFullYear(),
    targetUtcDate.getUTCMonth(),
    targetUtcDate.getUTCDate(),
    hh, mm,
  ));
}

/** App-time calendar date of an instant as 'YYYY-MM-DD'. */
function appDateOf(d: Date): string {
  const p = appPartsOf(d);
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// `absentDates` — app-time dates this user is marked absent (`ab`) on the bells
// (GET /schedule → absent_dates). No reminder is scheduled on those days.
export async function rescheduleAllForUser(blocks: ScheduleBlock[], role: string | undefined, userId?: string, absentDates: string[] = []) {
  // Web has no scheduled-local-notifications. Clear any legacy ids without
  // evaluating the native notification module during static rendering.
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return { scheduled: 0, reason: 'web-unsupported' };
  }

  const Notifications = getNativeNotifications();
  if (!Notifications) return { scheduled: 0, reason: 'native-module-unavailable' };

  // 1) cancel previously-scheduled IDs we owned
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const ids: string[] = JSON.parse(raw);
      await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => {})));
    }
  } catch {}

  // 1b) honor the per-user opt-out — if disabled, leave everything cleared.
  const enabled = await getScheduleRemindersEnabled();
  if (!enabled) {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return { scheduled: 0, reason: 'user-disabled' };
  }

  // 2) verify permissions are granted (don't request here — the AuthContext flow does that)
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== 'granted') {
      await AsyncStorage.removeItem(STORAGE_KEY);
      return { scheduled: 0, reason: 'permission-denied' };
    }
  } catch {
    return { scheduled: 0, reason: 'permission-error' };
  }

  // 3) schedule fresh ones
  const myBlocks = blocks.filter((b) => isAudienceMatch(b.audience, role, userId, b.core_leader_ids, b.owner_id));
  const now = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const newIds: string[] = [];

  for (const b of myBlocks) {
    // Per-block reminder (older blocks: 5 min); null = no reminder.
    const minutes = b.reminder_minutes === undefined ? REMINDER_MINUTES : b.reminder_minutes;
    if (minutes === null || minutes < 0) continue;
    let occurrence = nextOccurrence(b.day_of_week, b.start_time, now);
    while (occurrence <= horizon) {
      const fireAt = new Date(occurrence.getTime() - minutes * 60 * 1000);
      const day = appDateOf(occurrence);
      const onThisDate = !b.date || b.date === day;
      const done = b.kind === 'task' && (b.done_dates || []).includes(day);
      if (onThisDate && !done && fireAt > now && !absentDates.includes(day)) {
        try {
          const id = await Notifications.scheduleNotificationAsync({
            content: {
              title: minutes === 0 ? `Starting now: ${b.title}` : `Starting in ${minutes} min: ${b.title}`,
              body: [b.presenter ? `with ${b.presenter}` : null, b.topic].filter(Boolean).join(' · ') || 'Tap to view details',
              data: { kind: 'schedule', blockId: b.id },
              sound: 'default',
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: fireAt.getTime(),
              channelId: Platform.OS === 'android' ? 'default' : undefined,
            },
          });
          newIds.push(id);
        } catch (e: any) {
          if (__DEV__) console.log('[schedule-notif] schedule error', e?.message || e);
        }
      }
      // Advance by exactly 7 days in UTC — safe across DST boundaries
      occurrence = new Date(occurrence.getTime() + 7 * 86_400_000);
    }
  }

  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newIds));
  return { scheduled: newIds.length, reason: 'ok' };
}

export async function clearAllScheduledForUser() {
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
