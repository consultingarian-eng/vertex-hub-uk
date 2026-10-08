import AsyncStorage from '@react-native-async-storage/async-storage';

// ──────────────────────────────────────────────────────────────────────────
// Per-user / per-device notification preferences.
//
// AsyncStorage holds the device-local half: it gates the *local*
// notifications scheduled on-device. But PWA users get their schedule
// reminders from the SERVER (core/schedule_reminders.py web push), so the
// toggle must ALSO be persisted via PUT /me/schedule-reminders — the Profile
// toggle handler does that. Defaulting to "on" keeps new users opted-in by
// default (we already prompt for OS permission at login); flipping it off
// cancels all currently-scheduled local reminders the next time the app
// reschedules.
// ──────────────────────────────────────────────────────────────────────────

const KEY_SCHEDULE_REMINDERS = 'pref_schedule_reminders_v1';

/** Returns whether schedule reminders are enabled. Defaults to `true` on first run. */
export async function getScheduleRemindersEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(KEY_SCHEDULE_REMINDERS);
    if (raw === null) return true;
    return raw === '1';
  } catch {
    return true;
  }
}

export async function setScheduleRemindersEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_SCHEDULE_REMINDERS, enabled ? '1' : '0');
  } catch {}
}
