/**
 * Learning days — a lifetime COUNT of days with any learning activity
 * (one lesson, quiz answer, or exam submit marks the day).
 *
 * Deliberately NOT a streak: missing a day costs nothing, the count never
 * resets, and nothing nags about consecutive days (owner call, 2026-07-12 —
 * rewarding unbroken daily activity pressures people to never take a day
 * off). Badges for hitting counts are awarded server-side.
 *
 * Account-bound: state lives on the user's account (GET/POST /me/streak —
 * legacy endpoint name kept). AsyncStorage is only a local cache:
 *   • instant render + offline fallback when the API is unreachable
 *   • self-heal: if the cache is ahead of the server (activity logged
 *     offline), it's merged up via /me/streak/sync — never lowers.
 *
 * Day boundaries are the DEVICE's local calendar day.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiService } from '../api/client';
import { queryClient } from '../api/queryClient';

const CACHE_KEY = 'cg1.learningdays.v1';

type Stored = { total: number; lastDate: string | null };

export type StreakInfo = Stored & {
  /** Already logged learning today — chip renders lit. */
  activeToday: boolean;
};

const localDateStr = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const today = () => localDateStr(new Date());

async function readCache(): Promise<Stored> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { total: Number(p.total) || 0, lastDate: p.lastDate || null };
    }
    // One-time migration from the old streak cache: best-ever run is a
    // lower bound on total learning days.
    const legacy = await AsyncStorage.getItem('cg1.streak.v1');
    if (legacy) {
      const p = JSON.parse(legacy);
      return { total: Math.max(Number(p.best) || 0, Number(p.count) || 0), lastDate: p.lastDate || null };
    }
  } catch { /* corrupt cache → fresh */ }
  return { total: 0, lastDate: null };
}

async function writeCache(s: Stored): Promise<void> {
  try { await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(s)); } catch { /* non-fatal */ }
}

const fromServer = (d: { total?: number; count?: number; best?: number; last_date: string | null }): Stored => ({
  // Pre-pivot backends only send count/best — take the max as the total.
  total: Math.max(Number(d.total) || 0, Number(d.count) || 0, Number(d.best) || 0),
  lastDate: d.last_date || null,
});

/** Cache strictly ahead of the server ⇒ offline activity to merge up. */
const cacheIsAhead = (cache: Stored, server: Stored) =>
  cache.total > server.total ||
  (!!cache.lastDate && (!server.lastDate || cache.lastDate > server.lastDate));

function toInfo(s: Stored): StreakInfo {
  return { ...s, activeToday: s.lastDate === today() };
}

export async function getStreak(): Promise<StreakInfo> {
  const cache = await readCache();
  try {
    let server = fromServer((await apiService.getStreak()).data);
    if (cacheIsAhead(cache, server)) {
      server = fromServer((await apiService.streakSync({
        total: cache.total, count: cache.total, best: cache.total, last_date: cache.lastDate,
      })).data);
    }
    await writeCache(server);
    return toInfo(server);
  } catch {
    // Offline or backend not redeployed yet — the cache carries the count.
    return toInfo(cache);
  }
}

/** Offline mirror of the server's activity rule: one increment per day. */
function applyLocal(s: Stored): { state: Stored; extended: boolean } {
  if (s.lastDate === today()) return { state: s, extended: false };
  return { state: { total: s.total + 1, lastDate: today() }, extended: true };
}

export async function recordLearningActivity(): Promise<{ total: number; extended: boolean }> {
  let result: { state: Stored; extended: boolean };
  try {
    const r = (await apiService.streakActivity(today())).data;
    result = { state: fromServer(r), extended: !!r.extended };
  } catch {
    result = applyLocal(await readCache());
  }
  await writeCache(result.state);
  queryClient.invalidateQueries({ queryKey: ['streak'] });
  return { total: result.state.total, extended: result.extended };
}
