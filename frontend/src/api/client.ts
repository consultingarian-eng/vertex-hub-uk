import axios from 'axios';

import { Platform } from 'react-native';
import { usePreviewStore } from '../utils/previewStore';
import { publishAuthExpired } from '../auth/authSessionEvents';
import {
  clearAuthTokens,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  usesWebTokenFallback,
} from '../auth/tokenStorage';

// In deployment, frontend and backend share the same domain
// Use relative URL '' so requests go to the same origin
const API_BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';
const USE_WEB_COOKIE_SESSION = Platform.OS === 'web' && !usesWebTokenFallback();

export const api = axios.create({
  baseURL: `${API_BASE_URL}/api`,
  // Browser sessions are carried by HttpOnly cookies in production. This is
  // also required for an explicitly CORS-allowed Expo Web dev origin.
  withCredentials: USE_WEB_COOKIE_SESSION,
  headers: {
    'Content-Type': 'application/json',
    ...(Platform.OS !== 'web' ? { 'X-CG1-Client': 'expo-native' } : {}),
  },
});

// Interceptor to add auth token to every request
api.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // "View As" — attach the previewed user's id so the backend resolves
  // get_current_user() as them (read-only; enforced server-side).
  const previewUser = usePreviewStore.getState().user;
  if (previewUser) {
    config.headers['X-View-As-User-Id'] = previewUser.id;
  }
  return config;
});

// ── Auto-refresh on 401 "Token expired" ────────────────────────────────
// When the 24h access token expires, transparently swap it for a new one
// using the long-lived refresh token and retry the original request. The
// user never sees "Token expired" or gets bounced back to Login as long as
// their refresh token is still valid (7 days).
// Tri-state return: 'ok', definitive credential expiry, or a recoverability
// issue. Network failures preserve the session; missing/malformed native
// refresh credentials cannot recover and are cleared by the interceptor.
type RefreshOutcome =
  | { kind: 'ok'; token?: string }
  | { kind: 'expired' }
  | { kind: 'unavailable'; reason: 'missing' | 'network' | 'invalid-response' };

let refreshPromise: Promise<RefreshOutcome> | null = null;

async function performRefresh(): Promise<RefreshOutcome> {
  try {
    const refreshToken = await getRefreshToken();
    const canUseCookie = USE_WEB_COOKIE_SESSION;
    if (!refreshToken && !canUseCookie) {
      return { kind: 'unavailable', reason: 'missing' };
    }

    const res = await axios.post(
      `${API_BASE_URL}/api/auth/refresh`,
      refreshToken ? { refresh_token: refreshToken } : {},
      {
        headers: {
          'Content-Type': 'application/json',
          ...(Platform.OS !== 'web' ? { 'X-CG1-Client': 'expo-native' } : {}),
        },
        withCredentials: canUseCookie,
      },
    );
    const newToken = res.data?.token;
    if (!newToken) {
      // A same-origin browser can replay with the newly-set access cookie even
      // if a future backend stops returning the bearer token in JSON.
      if (canUseCookie) return { kind: 'ok' };
      return { kind: 'unavailable', reason: 'invalid-response' };
    }

    await setAccessToken(newToken);
    return { kind: 'ok', token: newToken };
  } catch (e: any) {
    // A refresh-token rejection is definitive session expiry. Clear durable
    // credentials first, then notify AuthProvider to clear in-memory identity,
    // preview state, and private query data. Network/5xx failures remain
    // retryable and must not sign the user out.
    const status = e?.response?.status;
    if (status === 401 || status === 403) {
      await clearAuthTokens().catch(() => {});
      publishAuthExpired();
      return { kind: 'expired' };
    }
    return { kind: 'unavailable', reason: 'network' };
  }
}

function attemptRefresh(): Promise<RefreshOutcome> {
  if (!refreshPromise) {
    const activeRefresh = performRefresh();
    refreshPromise = activeRefresh;
    // Keep the settled promise through the current task so a burst of failed
    // requests observes the same exact outcome (including `expired`).
    activeRefresh.finally(() => {
      setTimeout(() => {
        if (refreshPromise === activeRefresh) refreshPromise = null;
      }, 0);
    });
  }
  return refreshPromise;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error?.config;
    const status = error?.response?.status;
    const detail = error?.response?.data?.detail;
    const requestPath = String(original?.url || '').split('?')[0];
    const isRefreshRequest = /\/auth\/refresh$/.test(requestPath);
    const isInteractiveAuth = /\/auth\/(login|register|verify-email|resend-otp|forgot-password|reset-password)$/.test(requestPath);
    const sessionFailureDetails = new Set([
      'not authenticated',
      'token expired',
      'invalid token',
      'invalid token type',
      'user not found',
      'session revoked',
    ]);
    const isSessionAuthFailure = (
      status === 401
      && typeof detail === 'string'
      && sessionFailureDetails.has(detail.trim().toLowerCase())
    );

    // Try every protected 401 once, not only a literal "Token expired"
    // response. On same-origin web the browser removes the 24-hour access
    // cookie at Max-Age, so /auth/me correctly says "Not authenticated" even
    // though the 7-day HttpOnly refresh cookie is still available. Native
    // expired/revoked bearer sessions take the same safe path: a valid refresh
    // recovers them, while a rejected refresh clears the session centrally.
    const shouldAttemptRefresh = (
      isSessionAuthFailure
      && original
      && !original._retry
      && !isRefreshRequest
      && !isInteractiveAuth
    );
    if (shouldAttemptRefresh) {
      original._retry = true;
      const result = await attemptRefresh();
      if (result.kind === 'ok') {
        if (result.token) {
          original.headers = { ...(original.headers || {}), Authorization: `Bearer ${result.token}` };
        }
        return api(original); // replay original request with fresh token
      }
      // 'expired' — refresh token itself is dead. Durable and in-memory auth
      // state were already cleared; let the original 401 reject normally.
      // A network outage must not sign the user out. A native session with no
      // refresh credential, however, cannot recover and must not leave the UI
      // in a zombie-authenticated state.
      if (result.kind === 'unavailable' && result.reason !== 'network') {
        await clearAuthTokens().catch(() => {});
        publishAuthExpired();
      } else if (result.kind === 'unavailable' && result.reason === 'network') {
        // The original response is a 401, but the only reason we could not
        // recover it was a transient refresh/network failure. Mark it so
        // AuthProvider does not mistake that stale 401 for definitive expiry
        // and erase otherwise valid durable credentials.
        error.cg1RefreshRecoverable = true;
      }
    } else if (isSessionAuthFailure && original) {
      // A replay that still returns 401, or a refresh call rejected directly,
      // is definitive. Expected interactive-auth failures never sign out an
      // existing session or publish a global expiry event. Domain/upstream
      // 401s (share codes, manual-editor codes) are deliberately excluded so
      // an integration outage cannot destroy a healthy login.
      if (!isInteractiveAuth) {
        await clearAuthTokens().catch(() => {});
        publishAuthExpired();
      }
    }
    return Promise.reject(error);
  },
);

// Types
export interface NewHire {
  id: string;
  name: string;
  leader: string;
  start_date: string;
  campaign: string;
  phase: string;
  current_day: number;
  current_status: string;
  final_outcome: string | null;
  active: boolean;
  created_at: string;
  trainee_user_id?: string | null;
  office_id?: string | null;
}

export interface NewHireCreate {
  name: string;
  leader: string;
  start_date: string;
  campaign?: string;
  notes?: string;
}

export interface DailyAssessment {
  id: string;
  new_hire_id: string;
  new_hire_name: string;
  day_number: number;
  assessment_date: string | null;
  completed: boolean;
  completed_by: string | null;
  behaviour_punctuality: number | null;
  behaviour_engagement: number | null;
  behaviour_image: number | null;
  behaviour_coachability: number | null;
  behaviour_attitude: number | null;
  behaviour_comfort_zones: number | null;
  behaviour_customer_service: number | null;
  skill_intro: number | null;
  skill_presentation: number | null;
  skill_short_story: number | null;
  skill_close: number | null;
  skill_signup: number | null;
  skill_rehash: number | null;
  kpi_introductions: number | null;
  kpi_presentations: number | null;
  kpi_short_stories: number | null;
  kpi_closes: number | null;
  kpi_sales: number | null;
  leader_assisted_sales: number | null;
  behaviour_score: number | null;
  skill_score: number | null;
  kpi_score: number | null;
  checklist_grade_score: number | null;
  overall_score: number | null;
  status: string;
  coaching_actions: string | null;
  biggest_weakness: string | null;
  focus_tomorrow: string | null;
  leader_notes: string | null;
}

export interface DayTarget {
  day_number: number;
  behaviour_weight: number;
  skill_weight: number;
  kpi_weight: number;
  target_intro: number;
  target_presentation: number;
  target_short_story: number;
  target_close: number;
  target_signup: number;
  target_rehash: number;
  target_introductions: number;
  target_presentations: number;
  target_short_stories: number;
  target_closes: number;
  target_sales: number;
  leader_assisted_sales_target: number;
  day_objective: string;
  what_good_looks_like?: string[];
  what_great_looks_like?: string[];
  hire_what_good_looks_like?: string[];
  hire_what_great_looks_like?: string[];
}

export interface TrainingManualItem {
  id?: string;
  day_number: number;
  sequence: number;
  category: string;
  topic: string;
  what_good_looks_like: string;
  expected_outcome: string;
  confidence_expected: string;
  required: boolean;
  grade_options?: string[];
}

export interface GradePreset {
  label: string;
  options: string[];
}

export interface DeliveryChecklist {
  id: string;
  assessment_id: string;
  manual_item_id: string;
  topic: string;
  category: string;
  confidence_expected: string;
  taught: boolean;
  outcome_achieved: boolean;
  confidence_level: string;
  grade: string | null;
  grade_options: string[];
  notes: string | null;
}

export interface DashboardStats {
  total_active_hires: number;
  status_breakdown: Record<string, number>;
  outcome_breakdown: Record<string, number>;
  average_score_by_day: Record<number, number>;
}

export interface OnboardingContact {
  name: string;
  role: string;
  phone: string;
  email: string;
}

export interface OnboardingContent {
  welcome_title: string;
  welcome_message: string;
  pay_title: string;
  pay_notes: string;
  week_one_note: string;
  contacts: OnboardingContact[];
  updated_at: string | null;
}

// ── Sales Development Path (30-day ramp + proficiency ladder) ────────────
export interface SalesPathRampWeek {
  week_ending: string;
  week: number | null;     // 1–3 (Week A/B/C); null on paused/excused rows
  target: number;
  sales: number;
  completed: boolean;
  paused: boolean;         // excused week — extends the runway, never graded
  met: boolean;
  checkin?: { note: string; by_id: string; by_name?: string; at: string };
}

export interface SalesPathRamp {
  start_date: string;
  targets: number[];             // Week A/B/C targets — shown from day 1
  phase: 'training' | 'weeks' | null;
  week: number | null;
  status: 'not_started' | 'training' | 'on_track' | 'behind' | 'complete' | 'overdue' | null;
  weekly: SalesPathRampWeek[];
  completed_at: string | null;   // the Green Week's week_ending
  pre30_avg_earnings?: number | null;
  post30_avg_earnings?: number | null;
}

export interface SalesPathWindow {
  days: number; from: string; to: string; scoring_pct: number; piece_avg: number;
  /** Day count behind scoring_pct — the gate's own chunk, not a re-derivation. */
  days_scored?: number;
}

/**
 * One line of the "what it takes" scoreboard for the level above (server
 * block `next_up`, built by core/sales_path.py `_next_up`).
 *
 * `current` is the GATE's own number and is null whenever nothing is graded
 * against the target yet — a stretch of days out too short to score
 * (`window_ready: false`) or a requirement this rep is waived from
 * (`waived`). `so_far` still carries their real live number in those cases,
 * and the row counts `days_out` of `of_days` as the thing filling up. So the
 * test for "graded yet" is `current != null`.
 *
 * `target` is the BAR, not a measurement: it is known before anyone works a
 * day, so it stays set while a row is still filling up, and is null only
 * where no target exists at all — a signature, or a waived skills row.
 *
 * `met` is always the gate's verdict, never re-derived on the client — and
 * when it is false with both numbers set, `current < target` is guaranteed
 * by the engine, which is what lets `nextUpFormat.fmtScore` promise that a
 * printed score can never read as the target on an unticked row.
 */
export interface SalesPathRequirement {
  key: string;
  label: string;
  detail: string;
  kind: 'count' | 'ratio' | 'average' | 'signature';
  /** What is being counted. 'days' on a count row is printed under the score. */
  unit: string | null;
  /** Small line under the score, when the row wants to say more than its unit
   *  (the sales total prints "3 a day" there, the pace its own count stands for). */
  value_sub?: string | null;
  /** What to actually DO, in one sentence: the rate and how many days out it
   *  takes. Absent on a met row and on one still filling its stretch. */
  action?: string | null;
  current: number | null;
  target: number | null;
  met: boolean;
  remaining: number | null;
  so_far?: number | null;
  of_days?: number;
  days_out?: number;
  window_ready?: boolean;
  decimals?: number;
  waived?: boolean;
  note?: string;
  signed_off_by?: string;
  requested?: boolean;
  can_request?: boolean;
}

/** Live progress toward the next level. Null at Mastery — there is no next. */
export interface SalesPathNextUp {
  level: number;
  level_name: string;
  requirements: SalesPathRequirement[];
  met_count: number;
  total: number;
  /** The engine's own verdict for this level — the authority the rows describe. */
  ready: boolean;
  needs_signature: boolean;
  signed_off_by: 'coach' | 'admin' | null;
  requested: boolean;
}

export interface SalesPathDoc {
  user_id: string;
  level: number;               // 1–6, high-water
  level_name: string;
  auto_level: number;
  level_dates: Record<string, string>;
  green_weeks: number;
  first_green_week: string | null;
  windows: { w20: SalesPathWindow | null; w30a: SalesPathWindow | null; w30b: SalesPathWindow | null };
  expert_data_eligible: boolean;
  mastery_data_eligible: boolean;
  expert_ready_for_check: boolean;
  mastery_ready_for_check: boolean;
  expert_signed_at: string | null;
  mastery_signed_at: string | null;
  form: {
    scoring_pct_20d: number | null; piece_avg_20d: number | null;
    days_in_window: number; avg_sales_4w: number | null; updated_at: string;
  };
  /** Per-requirement progress toward the NEXT level. Null at Mastery. */
  next_up?: SalesPathNextUp | null;
  ramp: SalesPathRamp | null;
}

export interface SalesPathMeta {
  green_week_sales: number;
  level_names: Record<number, string>;
  thresholds: Record<number, { scoring_pct: number; piece_avg: number; window: number }>;
  /** Typical week ranges per level (slide copy) — expectation-setting only, never gates. */
  typical_weeks: Record<number, string>;
  mastery_hold_days: number;
  /** A field day only scores at this many sales — the industry minimum. */
  min_scored_day_sales?: number;
}

/** Admin-editable framing copy + ramp pacing (office over global over code
 *  defaults — the onboarding-content pattern). Thresholds are NOT here:
 *  they're company-wide policy. */
export interface SalesPathContent {
  ramp_targets: number[];
  arc_line: string;
  level_arc: Record<string, string>;
  long_game_title: string;
  long_game_body: string;
  journey_ramp_body: string;
  updated_at: string | null;
}

export interface SalesPathLeaderboardRow {
  rank: number;
  user_id: string;
  name: string;
  level: number;
  level_name: string;
  green_weeks: number;
  piece_avg: number | null;
  ramp_status: string | null;
}

export interface SalesPathTeamRow {
  user_id: string; name?: string; role?: string;
  level: number; level_name: string;
  form: SalesPathDoc['form'] | null;
  ramp_status: SalesPathRamp['status'];
  ramp_week: number | null;
  expert_data_eligible: boolean;
  green_weeks: number;
}

// ── Office weekly review (the Monday 9:00 meeting page) ──────────────────
// `week_ending` is the week being PLANNED; every retrospective number is for
// `review_week_ending` (the Sunday before it).
export interface OfficeWeeklyRoll {
  sales: number;
  over30: number;
  memberships: number;
  earnings: number;
  ba_days: number;
  piece_avg: number | null;
  scoring_pct: number | null;
  goal: number | null;
  goal_pct: number | null;
  gold_pct: number | null;
  reps_worked: number;
  reps_zero: number;
}

export interface OfficeHighroller {
  rank: number;
  user_id: string;
  name: string;
  role: string;
  leader_name: string;
  earnings: number;
  sales: number;
  over30: number;
  memberships: number;
  days_worked: number;
  piece_avg: number | null;
  avg_per_day: number | null;
  goal: number | null;
}

export interface OfficeReviewLeader {
  user_id: string;
  name: string;
  role: string;
  crew_size: number;
  plan: {
    submitted: boolean;
    started: boolean;
    steps_done: number;
    steps_total: number;
    updated_at?: string | null;
    theme: string;
    concentration: string;
    goals: { personal: number | null; team: number | null };
    next_goals: Record<string, string>;
    wins: string[];
    learnings: string[];
    focus_next_week: string[];
    focus_mid: string;
    focus_long: string;
    team_management: Record<string, string>;
    eight_steps: {
      scores: Record<string, number>;
      focus: string;
      lowest: Array<{ step: string; score: number }>;
    };
    developing: Array<{ id?: string; who: string; what: string }>;
    recruitment: Record<string, string>;
    headcount: string;
    owners_profit: string;
    personal_development: Record<string, string>;
  };
  last_week: OfficeWeeklyRoll & {
    own: {
      sales: number; earnings: number; piece_avg: number | null;
      scoring_pct: number | null; days_worked: number; goal: number | null;
    } | null;
    team_goal: number | null;
    top: Array<{ user_id: string; name: string; earnings: number; sales: number }>;
  };
}

export interface OfficeWeeklyReview {
  week_ending: string;
  review_week_ending: string;
  office: { id: string; name: string };
  // `goal` is the bottom-up sum of individual goals; `target` is the office's
  // own top-down commitment (explicit office target, else the crew goal(s) at
  // the top of the tree). They can legitimately disagree.
  totals: OfficeWeeklyRoll & {
    reps: number;
    target: number | null;
    target_pct: number | null;
    target_source: 'office' | 'crew' | null;
  };
  highrollers: OfficeHighroller[];
  leaders: OfficeReviewLeader[];
  wins: Array<{ user_id: string; name: string; text: string }>;
  learnings: Array<{ user_id: string; name: string; text: string }>;
  focuses: Array<{ user_id: string; name: string; text: string }>;
  developing: Array<{ user_id: string; name: string; who: string; what: string }>;
  themes: Array<{ user_id: string; name: string; theme: string; concentration: string }>;
  eight_steps_office: Array<{ step: string; avg: number; raters: number }>;
  recruitment: { booked_in: number; attended: number; newstarts: number };
  plans_submitted: number;
  plans_total: number;
  missing_plans: Array<{ user_id: string; name: string; steps_done: number; steps_total: number }>;
}

export type PrimetimeMode = 'learning' | 'teaching' | 'watching';

export interface PrimetimeEntry {
  id: string;
  day_index: number;
  day_date: string;
  subject_user_id: string;
  // Snapshotted at write time — this is what lets a departed person's past
  // rows still render with the right name after their account is gone.
  subject_name: string;
  mode: PrimetimeMode;
  topic: string;
  // Rows sharing a session_id are the same session; the teaching row hosts it.
  session_id: string;
  with_ids: string[];
  with_names: string[];
  with_text: string;
  updated_at?: string;
  updated_by_name?: string;
}

export interface PrimetimePerson {
  user_id: string;
  name: string;
  role: string;
  team_name: string;
  leader_id: string;
  leader_name: string;
  // Null while they still work here; otherwise their last day (inclusive).
  left_on: string | null;
  can_edit: boolean;
  in_my_tree: boolean;
  // Day indices they are actually on the plan for — a mid-week leaver is on
  // the grid up to their last day and greyed out after it.
  days_on_grid: number[];
  // Bells attendance for Mon..Sat ('in' | 'off' | 'ab' | 'rt' | 'nc' | 'pc'),
  // blank where nobody has filled the sheet in yet.
  day_statuses: string[];
  // Day indices explicitly marked Absent — these people drop out of the day's
  // Primetime list, since they aren't in to be coached.
  absent_days: number[];
  is_ghost?: boolean;
}

export interface PrimetimeSession {
  session_id: string;
  day_index: number;
  day_date: string;
  topic: string;
  host_user_id: string;
  host_name: string;
  attendees: Array<{ user_id: string; name: string; mode: PrimetimeMode }>;
}

export interface PrimetimeWeek {
  week_ending: string;
  office_id: string;
  days: Array<{ day_index: number; date: string; name: string; short: string }>;
  today_index: number | null;
  people: PrimetimePerson[];
  entries: PrimetimeEntry[];
  sessions: PrimetimeSession[];
  can_edit_any: boolean;
}

export interface PrimetimeHome {
  week_ending: string;
  day_index: number;
  date: string;
  day_name: string;
  is_tomorrow: boolean;
  office_id: string;
  // Who's got what on, for this one day, in this one office. Deliberately no
  // planned/total tally — see the endpoint docstring.
  plans: Array<{
    user_id: string;
    name: string;
    mode: PrimetimeMode;
    topic: string;
    /** Who they're doing it with: real names if they joined a session, else free text. */
    with_label: string;
    /** Shared by everyone in the same impact — blank if they're on their own. */
    session_id: string;
  }>;
  sessions: PrimetimeSession[];
  // Everyone in YOUR tree still with nothing set — the whole team, so nothing
  // hides three levels down. Push notifications are narrower than this and go
  // only to whoever is directly above each person; `is_direct` marks the ones
  // you're personally accountable for, and `is_self` renders as "You".
  my_unplanned: Array<{ user_id: string; name: string; is_self: boolean; is_direct: boolean }>;
  my_unplanned_total: number;
}

// API Functions
export const apiService = {
  // Auth
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (email: string, password: string, name: string, officeId?: string, leaderId?: string | null) =>
    api.post('/auth/register', { email, password, name, office_id: officeId, leader_id: leaderId }),
  verifyEmail: (email: string, code: string) =>
    api.post('/auth/verify-email', { email, code }),
  resendOtp: (email: string) =>
    api.post('/auth/resend-otp', { email }),
  getMe: (token?: string | null) =>
    api.get('/auth/me', token ? { headers: { Authorization: `Bearer ${token}` } } : undefined),
  logout: (token?: string | null) =>
    api.post('/auth/logout', {}, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.put('/auth/change-password', { current_password: currentPassword, new_password: newPassword }),
  savePushToken: (token: string) =>
    api.put('/auth/push-token', { token }),

  // Badge tool
  getBadgeTemplate: () =>
    api.get<{ authorized_by: string; verify_phone: string }>('/badges/template'),
  removeBadgeBackground: (imageBase64: string) =>
    api.post('/badges/remove-background', { image_base64: imageBase64 }, { timeout: 60000 }),
  createBadge: (payload: { full_name: string; badge_number: string; photo_base64: string; user_id?: string | null; expiry_date?: string; photo_zoom?: number; photo_position_y?: number }) =>
    api.post('/badges', payload),
  listBadges: (userId?: string) =>
    api.get('/badges' + (userId ? `?user_id=${encodeURIComponent(userId)}` : '')),
  getBadge: (badgeId: string) =>
    api.get(`/badges/${badgeId}`),
  updateBadge: (badgeId: string, payload: { full_name?: string; badge_number?: string; photo_base64?: string; expiry_date?: string; photo_zoom?: number; photo_position_y?: number }) =>
    api.patch(`/badges/${badgeId}`, payload),
  deleteBadge: (badgeId: string) =>
    api.delete(`/badges/${badgeId}`),

  // Bells — weekly sales tracker
  listBells: (week?: string, office?: string) => {
    const params = new URLSearchParams();
    if (week) params.set('week', week);
    if (office) params.set('office', office);
    const qs = params.toString();
    return api.get('/bells' + (qs ? `?${qs}` : ''));
  },
  upsertBell: (payload: {
    week_ending: string; user_name: string; user_id?: string | null; office_id?: string;
    stage?: number | null; break_even?: number | null; weekly_goal?: number | null;
    last_week_total?: number | null;
    days: Array<{ over30: number | null; under30: number | null; memberships: number | null; status: string }>;
  }) => api.post('/bells', payload),
  deleteBell: (entryId: string) => api.delete(`/bells/${entryId}`),
  setMyWeeklyGoal: (weeklyGoal: number) =>
    api.put<{ week_ending: string; weekly_goal: number | null }>('/bells/my-weekly-goal', { weekly_goal: weeklyGoal }),
  // Crew goal — whole-team weekly target on the section leader's bells row
  // (same field the Weekly Planner's team-goal box edits). Leaders set their
  // own; admins may pass user_id for any leader in their office.
  setTeamWeeklyGoal: (body: { team_weekly_goal: number | null; user_id?: string; week_ending?: string }) =>
    api.put<{ week_ending: string; team_weekly_goal: number | null; user_id: string }>('/bells/team-weekly-goal', body),
  // Mini Vertex (the people not in a named team yet): its goal for a week. Admins.
  setMiniTeamGoal: (body: { goal: number | null; week_ending?: string; office?: string }) =>
    api.put<{ week_ending: string; goal: number | null }>('/bells/mini-team-goal', body),
  clearBellsDay: (weekEnding: string, dayIndex: number) =>
    api.post('/bells/clear-day', { week_ending: weekEnding, day_index: dayIndex }),
  setBellsPublicVisibility: (entryId: string, hidden: boolean) =>
    api.put(`/bells/${entryId}/visibility`, { hidden }),
  listBellsWeeks: (office?: string) =>
    api.get('/bells/weeks' + (office ? `?office=${encodeURIComponent(office)}` : '')),
  listOfficeRoster: (office?: string) =>
    api.get('/bells/roster' + (office ? `?office=${encodeURIComponent(office)}` : '')),
  uploadProfileImage: (image: string) =>
    api.put('/auth/profile-image', { image }),
  removeProfileImage: () =>
    api.delete('/auth/profile-image'),
  updateTeamName: (teamName: string) =>
    api.put('/auth/team-name', { team_name: teamName }),
  adminUpdateUserTeamName: (userId: string, teamName: string) =>
    api.put(`/admin/users/${userId}/team-name`, { team_name: teamName }),
  listBellsTeams: (week?: string, office?: string) => {
    const params = new URLSearchParams();
    if (week) params.set('week', week);
    if (office) params.set('office', office);
    const qs = params.toString();
    return api.get('/bells/teams' + (qs ? `?${qs}` : ''));
  },
  // The caller's own Bells numbers (any role) — this week's £12 / £15+
  // sign-ups + sign-ups per month, and the office's pay knobs. Feeds Pay.
  getMyBellsSummary: (months = 6) => api.get(`/bells/my-summary?months=${months}`),

  // ── Monthly Planner AI Coach ────────────────────────────────────────────
  plannerAiCoach: (data: {
    kind: 'swot' | 'gap';
    role?: string;
    swot_current?: Record<string, string>;
    swot_target?: string[];
    trait?: string;
    score?: number;
    context?: string;
  }) => api.post('/monthly-planners/ai-coach', data),

  // ── Schedule (recurring weekly office schedule) ─────────────────────────
  listSchedule: (office?: string) => {
    const qs = office ? `?office=${encodeURIComponent(office)}` : '';
    return api.get('/schedule' + qs);
  },
  createScheduleBlock: (data: any) => api.post('/schedule', data),
  updateScheduleBlock: (id: string, data: any) => api.put(`/schedule/${id}`, data),
  deleteScheduleBlock: (id: string) => api.delete(`/schedule/${id}`),
  duplicateScheduleBlock: (id: string, days: number[]) =>
    api.post(`/schedule/${id}/duplicate`, { days }),
  setScheduleTaskDone: (id: string, date: string, done: boolean) =>
    api.post(`/schedule/${id}/done`, { date, done }),
  setScheduleDayLabels: (labels: Record<string, string>, office?: string | null) =>
    api.put('/schedule/day-labels', { labels, office_id: office || undefined }),

  // Weekly Agenda
  getAgenda: (week?: string, office?: string) => {
    const params = new URLSearchParams();
    if (week) params.set('week', week);
    if (office) params.set('office', office);
    const qs = params.toString();
    return api.get(`/agenda${qs ? `?${qs}` : ''}`);
  },
  upsertAgenda: (data: { office_id?: string; week_ending: string; status?: 'draft' | 'preview'; themes?: any; stats?: any; rows?: any[] }) =>
    api.post('/agenda', data),

  // Upload a photo of the handwritten weekly planner. Backend runs Gemini
  // Vision and returns a parsed { themes, stats, rows } shape ready for the
  // editor's per-field review modal. NOTE: does NOT save anything.
  scanAgendaImage: (data: { uri: string; name?: string; type?: string }, office?: string) => {
    const form = new FormData();
    // @ts-ignore — RN FormData accepts {uri,name,type}
    form.append('file', { uri: data.uri, name: data.name || 'sheet.jpg', type: data.type || 'image/jpeg' });
    // Office rides as a query param, not a form field — the endpoint is
    // multipart and the row labels the OCR is allowed to match against come
    // from the office being viewed, not the uploader's home office.
    return api.post(`/agenda/scan${office ? `?office=${encodeURIComponent(office)}` : ''}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120_000,
    });
  },
  // No office arg: publish targets an agenda by id, and that document already
  // carries the office it was created for.
  publishAgenda: (id: string, overwrite: boolean = true) =>
    api.post(`/agenda/${id}/publish`, { overwrite }),
  copyAgendaFromLastWeek: (week_ending: string, office?: string) =>
    api.post('/agenda/copy-from-last-week', { week_ending, office_id: office }),
  // Per-office row configuration (order + hidden) for the Weekly Plan grid
  // and PDF export. Order/hidden slugs are lowercase-trimmed row labels.
  getAgendaRowConfig: (office?: string) =>
    api.get(`/agenda/row-config${office ? `?office=${encodeURIComponent(office)}` : ''}`),
  putAgendaRowConfig: (payload: { row_order: string[]; hidden_rows: string[]; office_id?: string }) =>
    api.put('/agenda/row-config', payload),
  // Read-only countrywide bulletin data (admins and leaders can locally export/share).
  getWeeklyBulletin: (week_ending: string) =>
    api.get(`/bulletin/weekly?week_ending=${encodeURIComponent(week_ending)}`),
  getTeamBulletin: (week_ending: string) =>
    api.get(`/bulletin/team-weekly?week_ending=${encodeURIComponent(week_ending)}`),
  // Pulls every schedule_block whose title maps to a Plan row label (exact
  // or alias — see _match_plan_row_from_title on the backend) and drops it
  // into the matching (day, row) cell of the Plan for the given week.
  // Empty cells only unless overwrite=true.
  fillAgendaFromSchedule: (week_ending: string, overwrite: boolean = false, reset: boolean = false, office?: string) =>
    api.post('/agenda/fill-from-schedule', { week_ending, overwrite, reset, office_id: office }),
  // Persists the admin's "scanned label → office block title" choices so
  // future scans pre-pick the same target row. Pass empty string for a
  // raw_label to forget that mapping.
  saveScanMappings: (mappings: Record<string, string>, office?: string) =>
    api.post('/agenda/scan-mappings', { mappings, office_id: office }),
  listScanMappings: (office?: string) =>
    api.get(`/agenda/scan-mappings${office ? `?office=${encodeURIComponent(office)}` : ''}`),
  listScheduleTitles: (office?: string) =>
    api.get(`/agenda/schedule-titles${office ? `?office=${encodeURIComponent(office)}` : ''}`),

  // ── Monthly Goal Planner ──────────────────────────────────────────────
  // Per-user monthly self-assessment + goal/SWOT/budget/GAP planner.
  // Owners can edit their own LATEST month; older months auto-lock.
  // Leaders can READ direct/transitive reports' planners. Admins can
  // READ everyone in their office.
  listMonthlyPlanners: (user_id?: string) =>
    api.get('/monthly-planners', { params: user_id ? { user_id } : undefined }),
  getMonthlyPlanner: (month: string, user_id?: string) =>
    api.get(`/monthly-planners/${month}`, { params: user_id ? { user_id } : undefined }),
  upsertMonthlyPlanner: (month: string, body: any) =>
    api.put(`/monthly-planners/${month}`, body),
  startMonthlyPlanner: (month: string) =>
    api.post(`/monthly-planners/start/${month}`),
  monthlyPlannerTraits: () => api.get('/monthly-planners/traits'),

  // ── Leaders' Weekly Planner ───────────────────────────────────────────
  // Digital version of the printed weekly planner book + the WhatsApp
  // weekly-plan reports. Owner edits; upline may read (same as MGP).
  listWeeklyPlanners: (user_id?: string) =>
    api.get('/weekly-planners', { params: user_id ? { user_id } : undefined }),
  getWeeklyPlanner: (week: string, user_id?: string) =>
    api.get(`/weekly-planners/${week}`, { params: user_id ? { user_id } : undefined }),
  upsertWeeklyPlanner: (week: string, body: any) =>
    api.put(`/weekly-planners/${week}`, body),
  weeklyPlannerStats: (week: string, user_id?: string) =>
    api.get(`/weekly-planners/${week}/stats`, { params: user_id ? { user_id } : undefined }),
  bellsReadout: (week: string, day: number) =>
    api.get(`/weekly-planners/bells-readout/${week}`, { params: { day } }),
  searchWeeklyPlanners: (q: string, user_id?: string) =>
    api.get('/weekly-planners/search', { params: { q, ...(user_id ? { user_id } : {}) } }),
  setCrewMemberPlan: (member_id: string, body: { week_ending: string; weekly_goal?: string | number | null; day_statuses?: string[]; absence_reason?: string }) =>
    api.put(`/weekly-planners/crew/${member_id}`, body),
  // ── Absence requests — leader requests, office admin approves/denies ──
  createAbsenceRequest: (body: { target_user_id: string; week_ending: string; day_indices: number[]; reason?: string }) =>
    api.post('/absence-requests', body),
  listAbsenceRequests: (params?: { status?: string; week?: string; office_id?: string }) =>
    api.get<{ items: any[] }>('/absence-requests', { params }),
  absenceRequestsPendingCount: (officeId?: string) =>
    api.get<{ pending: number }>('/absence-requests/pending-count', {
      params: officeId ? { office_id: officeId } : undefined,
    }),
  decideAbsenceRequest: (id: string, action: 'approve' | 'deny', note?: string) =>
    api.post(`/absence-requests/${id}/decide`, { action, note: note || '' }),
  // Send ONLY the goal that changed — the server patches per field, so
  // omitting one leaves whatever is stored for it alone. Sending both would
  // let a stale input clobber a goal just changed from Bells or by an admin.
  setMyPlannerGoals: (body: { week_ending: string; personal_goal?: string | number | null; team_goal?: string | number | null }) =>
    // `office_goal` comes back only for an OFFICE-LEVEL admin, whose crew goal
    // doubles as the office goal and is mirrored onto the office doc
    // server-side. An admin who runs their own crew inside the office gets
    // null — their crew goal is their team's alone (core/admin_scope.py).
    api.put<{ ok: boolean; week_ending: string; personal_goal: number | null; team_goal: number | null; office_goal: number | null }>(
      '/weekly-planners/my-goals', body),
  weeklyPlannerTeamRoster: (week?: string) =>
    api.get<{ week_ending: string; items: Array<{ id: string; name: string; role: string; has_planner: boolean; updated_at?: string | null }> }>(
      '/weekly-planners/team/roster', { params: week ? { week } : undefined }),
  // Who's written TODAY's daily-plan box — trainees + leaders + admins alike.
  // Only returns people who HAVE written something (no day box at all on Sunday).
  weeklyPlannerDailyRoster: () =>
    api.get<{
      date: string; is_plannable_day: boolean; day_index: number | null; week_ending: string | null;
      total_eligible: number;
      items: Array<{ id: string; name: string; role: string; updated_at?: string | null }>;
    }>('/weekly-planners/team/daily-roster'),
  // ── Office Primetime ─────────────────────────────────────────────────
  // The whole office's coaching grid for a week: one row per person per day
  // (learning / teaching / watching + topic + who with). Every leader READS
  // the whole office — that is the point — but `can_edit` per person limits
  // writes to your own tree. The roster is computed live from the tree on
  // every read and never stored, which is why someone who leaves drops off
  // future days while their existing rows survive as ghost records.
  primetimeWeek: (week?: string, office?: string) =>
    api.get<PrimetimeWeek>('/primetime/week', {
      params: { ...(week ? { week } : {}), ...(office ? { office } : {}) },
    }),
  // Compact Home-card payload for the next plannable day (Sunday looks ahead
  // to Monday, since there is no Primetime on a Sunday).
  primetimeHome: (office?: string) =>
    api.get<PrimetimeHome>('/primetime/home', { params: office ? { office } : undefined }),
  // Sending mode: null clears the row — an empty toggle IS "nothing planned".
  savePrimetimeEntry: (body: {
    week_ending: string; day_index: number; subject_user_id: string;
    mode: PrimetimeMode | null; topic?: string; with_ids?: string[];
    with_text?: string; session_id?: string; office?: string;
  }) => api.put<{ ok: boolean; cleared?: boolean; entry?: PrimetimeEntry }>('/primetime/entry', body),
  // Add one of MY people to a session another team is running. This writes my
  // person's row, never the host's, so it needs no access to their team.
  joinPrimetimeSession: (body: {
    session_id: string; subject_user_id: string;
    mode?: 'learning' | 'watching'; office?: string;
  }) => api.post<{ ok: boolean; entry: PrimetimeEntry }>('/primetime/session/join', body),
  clearPrimetimeEntry: (params: {
    week_ending: string; day_index: number; subject_user_id: string; office?: string;
  }) => api.delete<{ ok: boolean; deleted: number }>('/primetime/entry', { params }),

  // Monday-meeting summary for a whole office: last week's numbers + money
  // leaderboard, and every leader's plan for the week being planned.
  // Admin-only; super admins may pass an office id.
  officeWeeklyReview: (week?: string, office?: string) =>
    api.get<OfficeWeeklyReview>('/weekly-planners/office/weekly-review', {
      params: { ...(week ? { week } : {}), ...(office ? { office } : {}) },
    }),
  scanWeeklyNotes: (data: { uri: string; name?: string; type?: string }) => {
    const form = new FormData();
    // @ts-ignore — RN FormData accepts {uri,name,type}
    form.append('file', { uri: data.uri, name: data.name || 'notes.jpg', type: data.type || 'image/jpeg' });
    return api.post('/weekly-planners/scan-notes', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120_000,
    });
  },
  monthlyPlannerSalesActual: (month: string) =>
    api.get(`/monthly-planners/${month}/sales-actual`),
  monthlyPlannerTeamRoster: () => api.get('/monthly-planners/team/roster'),
  // Guided Goal Builder — KPI presets + Rock suggestions (admin-editable per office)
  getPlannerGoalMenu: () => api.get('/monthly-planners/goal-menu'),
  updatePlannerGoalMenu: (body: { kpis?: string[]; rock_suggestions?: string[] }) =>
    api.put('/monthly-planners/goal-menu', body),

  // Admin
  createLeader: (data: { email: string; password: string; name: string }) =>
    api.post('/admin/create-leader', data),
  // Admin "Add User" — creates leader OR trainee, no OTP. Optionally emails creds.
  createUser: (data: {
    email: string;
    password: string;
    name: string;
    role: 'leader' | 'trainee';
    reports_to?: string | null;
    send_email?: boolean;
  }) => api.post('/admin/create-user', data),
  getUsers: (office?: string) => api.get('/admin/users', { params: office ? { office } : {} }),
  updateUserRole: (userId: string, role: string) =>
    api.put(`/admin/users/${userId}/role`, { role }),
  // Admin: make a Coach a Coach+ (whole-office numbers and ID badges), or take it back.
  setCoachPlus: (userId: string, enabled: boolean) =>
    api.put(`/admin/users/${userId}/coach-plus`, { enabled }),
  deleteUser: (userId: string) => api.delete(`/admin/users/${userId}`),

  // Bundled-content force-sync — replaces the deployed Mongo's curated
  // collections (Product Knowledge / Manual / Modules / Assessments /
  // Checklist / COD codes / configs) with the JSON snapshot baked into
  // the deploy. Admin-only, super-admin-gated in the UI.
  forceImportSeed: (collections?: string[]) =>
    api.post<{ results: Array<{ collection: string; status: string; before?: number; after?: number; json_docs?: number; error?: string }>; total_collections: number }>(
      '/admin/seed/force-import',
      collections ? { collections } : {},
    ),
  getSeedStatus: () =>
    api.get<{ all_seeded: boolean; seedable: any[]; protected: any[] }>('/admin/seed-status'),
  // Recovery helper: walks every active trainee and creates blank
  // Pending daily_assessments for any day 1-8 they're missing, plus the
  // matching delivery_checklist rows from training_manual. Idempotent.
  regenerateAssessmentSkeletons: (dryRun = false) =>
    api.post<{ dry_run: boolean; active_new_hires_scanned: number; orphan_trainees_linked: number; assessments_created: number; checklist_rows_created: number; per_trainee: Array<{ name: string; office_id: string; missing_days: number[]; assessments_created: number; checklist_created: number }> }>(
      '/admin/recovery/regenerate-assessments',
      { dry_run: dryRun },
    ),
  // Restore Manual / Modules content from the bundle, mapping preview's
  // office_ids onto the deployed office of the same NAME. Existing rows
  // are preserved (additive merge by office_id+day+sequence). Offices
  // that don't exist in the bundle (e.g. Cleveland) are untouched.
  restoreManualByName: (dryRun = false, offices?: string[]) =>
    api.post<{
      dry_run: boolean;
      offices: Array<{ name: string; src_id: string; dst_id: string | null; skipped?: string }>;
      results: Array<{ collection: string; status: string; inserted?: number; skipped_already_present?: number; skipped_office_unmatched?: number; error?: string; reason?: string }>;
    }>(
      '/admin/recovery/restore-manual',
      offices ? { dry_run: dryRun, offices } : { dry_run: dryRun },
    ),
  updateUserName: (userId: string, name: string) =>
    api.put(`/admin/users/${userId}/name`, { name }),
  updateUserEmail: (userId: string, email: string) =>
    api.put<{ message: string; email: string; old_email: string }>(
      `/admin/users/${userId}/email`, { email },
    ),
  // Admin: set/clear another user's phone number (tap-to-call from the roster).
  updateUserPhone: (userId: string, phone: string) =>
    api.put<{ message: string; phone: string }>(`/admin/users/${userId}/phone`, { phone }),
  // Self-rename: any authenticated user can update their own display name.
  updateMyName: (name: string) =>
    api.put<{ message: string; name: string }>('/users/me/name', { name }),
  updateMyPhone: (phone: string) =>
    api.put<{ message: string; phone: string }>('/users/me/phone', { phone }),
  // Self-serve email change — only open to accounts still on an Indeed relay
  // address (…@indeedemail.com). Two-step: request sends a 6-digit code to the
  // NEW address; confirm performs the swap.
  requestMyEmailChange: (email: string) =>
    api.post<{ message: string; email: string }>('/auth/change-email/request', { email }),
  confirmMyEmailChange: (code: string) =>
    api.post<{ message: string; email: string; old_email: string }>('/auth/change-email/confirm', { code }),

  // ── Multi-stage Training Modules (Stage 2 / Stage 3 / Stage 4) ──
  getStageStatus: () =>
    api.get<{
      is_trainee: boolean; is_leader: boolean; is_admin: boolean;
      is_leader_or_admin: boolean; team_has_junior_leader: boolean;
      stage_1_days_submitted: number[]; stage_1_days_passed_off: number[]; stage_1_total_days: number;
      stage_2_visible: boolean; stage_3_visible: boolean; stage_4_visible: boolean; stage_5_visible: boolean;
      stage_2_unlocked: boolean; stage_3_unlocked: boolean; stage_4_unlocked: boolean; stage_5_unlocked: boolean;
      sales_path_enabled?: boolean; sales_level?: number | null; sales_level_name?: string | null;
      ramp_status?: string | null; ramp_week?: number | null;
    }>('/stage-status/me'),

  // ── Sales Development Path (30-day ramp + proficiency ladder) ──
  // Two ladders, one person: these run BESIDE the COD stages. Server is the
  // single oracle (core/sales_path.py); the UI only renders what it returns.
  getMySalesPath: () =>
    api.get<{ enabled: boolean; path?: SalesPathDoc; meta?: SalesPathMeta; content?: SalesPathContent; can_edit?: boolean }>('/sales-path/me'),
  getSalesPathFor: (userId: string) =>
    api.get<{ enabled: boolean; path: SalesPathDoc; meta: SalesPathMeta; content?: SalesPathContent; can_edit?: boolean }>(`/sales-path/user/${userId}`),
  getSalesPathSettings: () =>
    api.get<{ office_id: string; content: SalesPathContent; defaults: SalesPathContent; can_edit: boolean }>('/sales-path/settings'),
  updateSalesPathSettings: (body: Partial<Omit<SalesPathContent, 'updated_at'>>) =>
    api.put<{ ok: boolean; office_id: string; content: SalesPathContent }>('/sales-path/settings', body),
  getSalesPathTeam: () =>
    api.get<{ team: SalesPathTeamRow[]; meta: SalesPathMeta }>('/sales-path/team'),
  getSalesPathLeaderboard: () =>
    api.get<{
      top: SalesPathLeaderboardRow[];
      total: number;
      my_rank: number | null;
      me: SalesPathLeaderboardRow | null;
    }>('/sales-path/leaderboard'),
  setSalesPathReady: (level: 5 | 6, ready: boolean, targetUserId?: string) =>
    api.put('/sales-path/ready', { level, ready, target_user_id: targetUserId }),
  signOffSalesPath: (userId: string, level: 5 | 6, note?: string) =>
    api.post(`/sales-path/${userId}/sign-off`, { level, note }),
  revokeSalesPathLevel: (userId: string, level: number, reason: string) =>
    api.post(`/sales-path/${userId}/revoke`, { level, reason }),
  salesPathRampCheckin: (userId: string, weekEnding: string, note: string) =>
    api.post(`/sales-path/${userId}/ramp-checkin`, { week_ending: weekEnding, note }),
  setReadyForCheck: (moduleId: string, body: { ready: boolean; target_user_id?: string; note?: string }) =>
    api.post<any>(`/module-progress/${moduleId}/ready`, body),
  getPendingChecks: () => api.get<{ checks: any[] }>('/cod/checks'),
  codVettingList: () => api.get<{ modules: any[] }>('/cod/vetting'),
  codVetModule: (body: { stage: number; topic: string; updates?: any; vetted?: boolean }) =>
    api.put('/cod/vetting', body),
  getCodVideos: () =>
    api.get<{ intro: string | null; stage1: string | null; stage2: string | null; stage3: string | null; stage4: string | null; stage5: string | null }>('/cod/videos'),
  setCodVideos: (body: Partial<Record<'intro' | 'stage1' | 'stage2' | 'stage3' | 'stage4' | 'stage5', string>>) =>
    api.put('/cod/videos', body),
  getModuleScale: () =>
    api.get<{ bands: Array<{min:number;max:number;label:string}>; dimensions: string[] }>('/modules/scale'),
  listModules: (stage: 1 | 2 | 3 | 4 | 5, office?: string) =>
    api.get<{ stage: number; unlocked: boolean; modules: Array<any> }>(`/modules`, { params: { stage, ...(office ? { office } : {}) } }),
  getModule: (moduleId: string) =>
    api.get<any>(`/modules/${moduleId}`),
  getModuleQuiz: (moduleId: string) =>
    api.get<{ quiz_id: string; questions: Array<{ id: string; question: string; choices: string[] }> }>(`/modules/${moduleId}/quiz`),
  submitModuleQuiz: (moduleId: string, body: { quiz_id: string; answers: Record<string, number> }) =>
    api.post<{ score: number; total: number; passed: boolean; results: Array<{ id: string; correct: number; chosen: number; ok: boolean }> }>(`/modules/${moduleId}/quiz/submit`, body),
  getMyModuleProgress: (stage: 1 | 2 | 3 | 4 | 5) =>
    api.get<{ stage: number; progress: Array<any> }>(`/module-progress/me`, { params: { stage } }),
  upsertModuleProgress: (
    moduleId: string,
    scores: { knowledge?: number; skill?: number; consistency?: number; independence?: number; leader_notes?: string; ladder?: number; ladder_dates?: Record<string, string>; wgll_checked?: number[] },
    targetUserId?: string,
  ) =>
    api.put<any>(
      `/module-progress/${moduleId}`,
      scores,
      targetUserId ? { params: { target_user_id: targetUserId } } : undefined,
    ),
  // Leader-grades-trainee endpoints
  listMyTrainees: () => api.get<{ trainees: Array<{ id: string; name: string; email: string; role: string; new_hire_id?: string; office_id?: string }> }>('/leader/trainees'),
  listUnassignedHires: () => api.get<{ hires: Array<{ hire_id: string; name: string; start_date?: string; campaign?: string; current_day?: number }> }>('/admin/unassigned-hires'),
  getTraineeModuleProgress: (traineeUserId: string, stage: 1 | 2 | 3 | 4 | 5 = 2) =>
    api.get<{ stage: number; trainee_user_id: string; progress: Array<any> }>(
      `/leader/trainees/${traineeUserId}/module-progress`, { params: { stage } }),
  passOffModule: (moduleId: string, targetUserId: string, passedOff = true, note?: string) =>
    api.post<any>(`/module-progress/${moduleId}/pass-off`, { passed_off: passedOff, note }, { params: { target_user_id: targetUserId } }),
  // Manual editor — Stage 2/3/4 module CRUD (admin only). Auth piggy-backs on
  // the user's normal Bearer/cookie session via the backend's _check_auth.
  adminListModules: (stage: 2 | 3 | 4 | 5, officeId?: string | null) =>
    api.get<{ stage: number; office_id: string | null; is_global: boolean; items: Array<any> }>(
      `/manual-editor/modules`,
      { params: { stage, ...(officeId !== undefined ? { office_id: officeId === null ? '__global__' : officeId } : {}) } }),
  adminPatchModule: (moduleId: string, patch: { topic?: string; category?: string; trainee_content?: string; what_good_looks_like?: string[]; how_measured?: string[]; leader_coaching_notes?: string[]; assessment_prompts?: Record<string, string>; sequence?: number }) =>
    api.patch<any>(`/manual-editor/module/${moduleId}`, patch),
  adminCreateModule: (body: { stage: number; category?: string; topic?: string; trainee_content?: string; what_good_looks_like?: string[]; how_measured?: string[]; leader_coaching_notes?: string[]; assessment_prompts?: Record<string, string>; office_id?: string | null }) =>
    api.post<any>(`/manual-editor/module`, body),
  adminDeleteModule: (moduleId: string) =>
    api.delete<any>(`/manual-editor/module/${moduleId}`),
  passOffDailyAssessment: (assessmentId: string, passedOff = true, note?: string) =>
    api.post<any>(`/daily-assessments/${assessmentId}/pass-off`, { passed_off: passedOff, note }),
  // Trainee-owner path of the same endpoint — "I've read my feedback".
  // Backend sets acknowledged/acknowledged_at only; leader pass-off untouched.
  acknowledgeDailyAssessment: (assessmentId: string) =>
    api.post<{ ok: boolean; acknowledged: boolean }>(`/daily-assessments/${assessmentId}/pass-off`, { passed_off: true }),
  removeUserProfileImage: (userId: string) =>
    api.delete(`/admin/users/${userId}/profile-image`),
  getLeaderRankings: () => api.get('/admin/leader-rankings'),
  getTraineeProgress: () => api.get('/trainee/my-progress'),

  // Onboarding Hub ("Start Here")
  getOnboarding: () =>
    api.get<{
      content: OnboardingContent;
      leader: OnboardingContact & { profile_image?: string } | null;
      office: { id: string; name: string; city?: string; state?: string; new_hire_training_pay?: boolean } | null;
      can_edit: boolean;
    }>('/onboarding'),
  saveOnboardingContent: (data: Partial<OnboardingContent>) =>
    api.put<{ content: OnboardingContent; office_id: string | null }>('/onboarding/content', data),

  // New Hires
  getNewHires: (office?: string) => api.get<NewHire[]>('/new-hires' + (office ? `?office=${encodeURIComponent(office)}` : '')),
  createNewHire: (data: NewHireCreate) => api.post<NewHire>('/new-hires', data),
  getNewHire: (id: string) => api.get<NewHire>(`/new-hires/${id}`),
  setFinalOutcome: (id: string, outcome: string) => 
    api.put(`/new-hires/${id}/outcome?outcome=${outcome}`),
  deleteNewHire: (id: string) => api.delete(`/new-hires/${id}`),
  backfillMissingNewHires: () => api.post<{ fixed: number; skipped: number }>('/admin/backfill-missing-new-hires', {}),
  reassignLeader: (id: string, leader: string) =>
    api.put(`/new-hires/${id}/reassign-leader`, { leader }),

  // Assessments
  getAssessments: (hireId: string) => api.get<DailyAssessment[]>(`/assessments/${hireId}`),
  getAssessment: (assessmentId: string) => api.get<DailyAssessment>(`/assessment/${assessmentId}`),
  updateAssessment: (assessmentId: string, data: Partial<DailyAssessment>) => 
    api.put(`/assessment/${assessmentId}`, data),

  // Targets (office-scoped)
  getTargets: (office?: string) => api.get<DayTarget[]>(`/targets${office ? `?office=${office}` : ''}`),
  getDayTarget: (dayNumber: number, office?: string) => api.get<DayTarget>(`/targets/${dayNumber}${office ? `?office=${office}` : ''}`),
  updateDayTarget: (dayNumber: number, data: Partial<DayTarget>, office?: string, applyAll?: boolean) =>
    api.put(`/targets/${dayNumber}?${office ? `office=${office}&` : ''}${applyAll ? 'apply_all=true' : ''}`, data),

  // Training Manual (office-scoped)
  getTrainingManual: (office?: string) => api.get<TrainingManualItem[]>(`/training-manual${office ? `?office=${office}` : ''}`),
  getTrainingManualDay: (dayNumber: number, office?: string) => 
    api.get<TrainingManualItem[]>(`/training-manual/${dayNumber}${office ? `?office=${office}` : ''}`),
  updateManualItem: (dayNumber: number, sequence: number, data: Partial<TrainingManualItem>, office?: string, applyAll?: boolean) =>
    api.put(`/training-manual/${dayNumber}/${sequence}?${office ? `office=${office}&` : ''}${applyAll ? 'apply_all=true' : ''}`, data),
  addManualItem: (data: { day_number: number; category: string; topic: string; what_good_looks_like: string; expected_outcome: string; grade_options: string[] }, office?: string, applyAll?: boolean) =>
    api.post(`/training-manual/add?${office ? `office=${office}&` : ''}${applyAll ? 'apply_all=true' : ''}`, data),
  deleteManualItem: (dayNumber: number, sequence: number, office?: string, applyAll?: boolean) =>
    api.delete(`/training-manual/${dayNumber}/${sequence}?${office ? `office=${office}&` : ''}${applyAll ? 'apply_all=true' : ''}`),
  reorderManualItems: (dayNumber: number, orderedSequences: number[], office?: string, applyAll?: boolean) =>
    api.put(`/training-manual/${dayNumber}/reorder?${office ? `office=${office}&` : ''}${applyAll ? 'apply_all=true' : ''}`, { ordered_sequences: orderedSequences }),
  getGradePresets: () => api.get<GradePreset[]>('/grade-presets'),
  getCommissionFees: (office?: string) => api.get(`/commission-fees${office ? `?office=${office}` : ''}`),
  updateCommissionFees: (fees: any, office?: string, applyAll?: boolean) => api.put(`/commission-fees?${office ? `office=${office}&` : ''}${applyAll ? 'apply_all=true' : ''}`, fees),
  // Settings (office-scoped)
  getSettings: (office?: string) => api.get(`/settings${office ? `?office=${office}` : ''}`),
  updateSettings: (data: any, office?: string, applyAll?: boolean) => api.put(`/settings?${office ? `office=${office}&` : ''}${applyAll ? 'apply_all=true' : ''}`, data),
  // Offices
  getOffices: () => api.get('/offices'),
  createOffice: (data: { name: string; city: string; state: string }) => api.post('/offices', data),
  deleteOffice: (id: string) => api.delete(`/offices/${id}`),
  getOfficeShareCode: (officeId: string) => api.get(`/admin/offices/${officeId}/share-code`),
  setOfficeShareCode: (officeId: string, share_code: string) => api.put(`/admin/offices/${officeId}/share-code`, { share_code }),
  // The server makes a long random code (the normal way to turn sharing on).
  generateOfficeShareCode: (officeId: string) => api.put(`/admin/offices/${officeId}/share-code`, { generate: true }),
  updateUserOffices: (userId: string, data: { office_id?: string; accessible_offices?: string[] }) =>
    api.put(`/admin/users/${userId}/offices`, data),
  bulkUpdateGradeOptions: (items: { day_number: number; sequence: number; grade_options: string[] }[]) =>
    api.put('/training-manual/bulk-grade-update', { items }),

  // Checklist
  getChecklist: (assessmentId: string) => api.get<DeliveryChecklist[]>(`/checklist/${assessmentId}`),
  updateChecklistItem: (itemId: string, data: Partial<DeliveryChecklist>) => 
    api.put(`/checklist/${itemId}`, data),

  // Dashboard
  getDashboardStats: (office?: string) => api.get<DashboardStats>('/dashboard/stats' + (office ? `?office=${encodeURIComponent(office)}` : '')),
  getLeaderStats: () => api.get('/dashboard/leader-stats'),
  getLeaderToday: (office?: string) =>
    api.get<{
      grading: Array<{
        hire_id: string; trainee_user_id?: string | null; name: string;
        current_day: number; current_status: string;
        assessment_id: string; day_number: number; days_pending: number;
        acknowledged_yesterday?: boolean | null;
        leader_user_id?: string | null;
      }>;
      new_starts?: Array<{
        hire_id: string; trainee_user_id?: string | null; name: string;
        current_day: number; days_done: number;
        next_assessment_id?: string | null; next_day?: number | null;
        cod1: { done: number; total: number }; cod2: { done: number; total: number };
        /** Their Coach's name, and whether the viewer coaches them (a Coach
         *  sees every new start in the office; only their own can be graded). */
        coach?: string | null; mine?: boolean;
      }>;
      planner: { month: string; exists: boolean; locked: boolean };
      counts: { active: number; awaiting: number; graded_today: number };
      sales_today: {
        date: string; units: number; reps_in: number; bells?: number;
        week_units?: number; week_bells?: number;
        week_goal?: number | null; week_goal_raw?: string | null; week_ending?: string;
        week_goal_source?: 'crew' | 'personal' | null;
        week_gold_pct?: number | null; week_mem_pct?: number | null;
      };
      team_health: {
        unassigned_aging: Array<{ name: string; days: number }>;
        idle_leaders: string[];
      } | null;
    }>('/leader/today' + (office ? `?office=${encodeURIComponent(office)}` : '')),
  // Admin one-tap "Remind" on Home's grading queue — one push to that leader,
  // server-throttled to one admin nudge per leader per 3h (429 when hot).
  remindLeader: (leaderUserId: string) =>
    api.post<{ ok: boolean; nudged: string }>(`/leader/today/remind/${leaderUserId}`),
  // Orientation mass-grader (admin) — the Day-1/Day-2 "mark the class" flow.
  // Cohort = active hires started in the last 8 app-time days whose Day-N assessment
  // isn't completed; bulk-grade applies the Excellent preset (10s + "Learnt"
  // checklist) with per-hire overrides riding on top. Super admins may scope
  // with ?office=.
  getOrientationCohort: (day: 1 | 2, office?: string) =>
    api.get<{
      day: number;
      items: Array<{ hire_id: string; assessment_id: string; name: string; start_date: string; has_leader: boolean }>;
    }>(`/orientation/cohort?day=${day}${office ? `&office=${encodeURIComponent(office)}` : ''}`),
  bulkGradeOrientation: (payload: {
    day: 1 | 2;
    hire_ids: string[];
    overrides: Record<string, { assessment?: Record<string, number>; checklist?: Record<string, string> }>;
  }) =>
    api.post<{
      graded: number;
      skipped: number;
      results: Array<{ hire_id: string; ok: boolean; detail: string | null }>;
    }>('/orientation/bulk-grade', payload),

  getLeaders: () => api.get<string[]>('/leaders'),

  // Team hierarchy
  // This week's Field IQ (OwnerIQ Performance Hub): own week + the caller's team.
  getFieldIqWeek: () => api.get('/owneriq/performance/week'),
  // One person's whole picture (admin: their office; Coach: their own team).
  getPersonBreakdown: (userId: string) => api.get(`/people/${userId}/breakdown`),
  // The Timeline: sign-ups hour by hour, per-BA productivity, an average day
  // and best/average/low week patterns, for the office, chosen teams or one person.
  getFieldInsights: (p: { from?: string; to?: string; teams?: string[]; userId?: string }) =>
    api.get('/insights/field', { params: {
      ...(p.from ? { from: p.from } : {}), ...(p.to ? { to: p.to } : {}),
      ...(p.teams?.length ? { teams: p.teams.join(',') } : {}), ...(p.userId ? { user_id: p.userId } : {}),
    } }),
  // The Performance Hub for one week: the office, one team (OwnerIQ team id) or 'none' (no team).
  getOwneriqHub: (weekStart?: string, team?: string) =>
    api.get('/owneriq/hub', { params: { ...(weekStart ? { week_start: weekStart } : {}), ...(team ? { team } : {}) } }),
  // Admin: change someone in OwnerIQ (promote = advance a stage, demote = back one).
  owneriqRepAction: (body: { cg1_user_id: string; action: 'promote' | 'demote'; dry_run?: boolean }) =>
    api.post('/owneriq/rep-action', { dry_run: false, ...body }),
  getTeamTree: (office?: string) => api.get('/team/tree' + (office ? `?office=${encodeURIComponent(office)}` : '')),
  setReportsTo: (userId: string, parentId: string | null) =>
    api.put(`/admin/users/${userId}/reports-to`, { reports_to: parentId }),
  syncHierarchy: () => api.post('/admin/sync-hierarchy'),
  getAvailableLeaders: () => api.get('/available-leaders'),
  forgotPassword: (email: string) => api.post('/auth/forgot-password', { email }),
  resetPassword: (email: string, code: string, new_password: string) => api.post('/auth/reset-password', { email, code, new_password }),

  // ── Coaching Resources ──────────────────────────────────────────────────
  coachingTree: () => api.get('/coaching/tree'),
  coachingUsage: () => api.get('/coaching/usage'),
  coachingCreateFolder: (data: { name: string; parent_id?: string | null; order?: number }) =>
    api.post('/coaching/folders', data),
  coachingUpdateFolder: (id: string, data: { name?: string; parent_id?: string | null; order?: number }) =>
    api.put(`/coaching/folders/${id}`, data),
  coachingDeleteFolder: (id: string, recursive = false) =>
    api.delete(`/coaching/folders/${id}${recursive ? '?recursive=true' : ''}`),
  coachingCreateResource: (data: {
    title: string; description?: string;
    folder_id?: string | null;
    type: 'pdf' | 'link';
    audience: string[];
    file_b64?: string; file_name?: string; mime_type?: string;
    link_url?: string;
  }) => api.post('/coaching/resources', data),
  coachingUpdateResource: (id: string, data: any) => api.put(`/coaching/resources/${id}`, data),
  coachingDeleteResource: (id: string) => api.delete(`/coaching/resources/${id}`),
  coachingFile: (id: string) => api.get(`/coaching/resources/${id}/file`),

  // Leadership Hub — structured impacts
  coachingImpacts: () => api.get('/coaching/impacts'),
  coachingCreateImpact: (data: { title: string; summary?: string; body?: string; key_takeaways?: string[]; stage: number; category?: string; source?: string; order?: number }) =>
    api.post('/coaching/impacts', data),
  coachingUpdateImpact: (id: string, data: { title?: string; summary?: string; body?: string; key_takeaways?: string[]; stage?: number; category?: string; source?: string; order?: number }) =>
    api.put(`/coaching/impacts/${id}`, data),
  coachingDeleteImpact: (id: string) => api.delete(`/coaching/impacts/${id}`),

  // Leadership Hub — impact quick-check quizzes (COD Learn mode). Contract
  // mirrors the module quizzes in routes/modules.py exactly: GET returns
  // { quiz_id, questions: [{ id, question, choices }] } with a 404 when no
  // quiz can be generated (frontend hides the quiz CTA); submit grades
  // server-side ({ quiz_id, answers: {question_id: choiceIndex} } →
  // { score, total, passed, results }); quiz-state backs the hub's ticks.
  coachingImpactQuiz: (impactId: string) => api.get(`/coaching/impacts/${impactId}/quiz`),
  coachingImpactQuizSubmit: (impactId: string, data: { quiz_id: string; answers: Record<string, number> }) =>
    api.post(`/coaching/impacts/${impactId}/quiz/submit`, data),
  coachingImpactQuizState: () => api.get('/coaching/impacts/quiz-state'),

  // Leadership Hub — AI Coaching Assistant
  coachingAssistantAsk: (data: { message: string; conversation_id?: string }) =>
    api.post('/coaching/assistant/ask', data),
  coachingAssistantConversations: () => api.get('/coaching/assistant/conversations'),
  coachingAssistantConversation: (id: string) => api.get(`/coaching/assistant/conversations/${id}`),
  coachingAssistantDeleteConversation: (id: string) => api.delete(`/coaching/assistant/conversations/${id}`),

  // Product Knowledge — campaign/product topics + exam
  productKnowledgeStatus: () => api.get('/product-knowledge/status'),
  productKnowledgeTopics: () => api.get('/product-knowledge/topics'),
  productKnowledgeAdminQuestions: () => api.get('/product-knowledge/questions'),
  productKnowledgeStartExam: () => api.post('/product-knowledge/exam/start', {}),
  productKnowledgeSubmitExam: (attemptId: string, answers: Array<{ question_id: string; response: number | boolean }>) =>
    api.post(`/product-knowledge/exam/${attemptId}/submit`, { answers }),
  productKnowledgeMyAttempts: () => api.get('/product-knowledge/exam/my-attempts'),
  productKnowledgeAttempt: (attemptId: string) => api.get(`/product-knowledge/exam/attempts/${attemptId}`),
  productKnowledgeTraineeExam: (traineeId: string) => api.get(`/leader/trainees/${traineeId}/product-exam`),
  productKnowledgePassOff: (traineeId: string, passOff: boolean) =>
    api.post(`/leader/trainees/${traineeId}/product-exam/pass-off`, { pass_off: passOff }),

  // ── Admin user management — rep badge numbers (stored as amplifi_codes) ──
  updateUserAmplifiCodes: (userId: string, codes: string[]) =>
    api.put(`/admin/users/${encodeURIComponent(userId)}/amplifi-codes`, { amplifi_codes: codes }),

  // ── Daily Breakdown ────────────────────────────────────────────────
  generateDailyBreakdown: (date: string) =>
    api.post('/bells/daily-breakdown', { date }),
  setOfficeWeeklyGoal: (officeId: string, weekly_goal: number) =>
    api.put(`/offices/${encodeURIComponent(officeId)}/weekly-goal`, { weekly_goal }),

  // Daily-Breakdown PROMPT editor (admin-only, per-office)
  getDailyBreakdownSettings: (officeId?: string) =>
    api.get<{ office_id: string; custom_instructions: string; updated_at?: string; updated_by_name?: string }>(
      '/bells/daily-breakdown/settings',
      { params: officeId ? { office_id: officeId } : {} },
    ),
  saveDailyBreakdownSettings: (custom_instructions: string, officeId?: string) =>
    api.put<{ office_id: string; custom_instructions: string; updated_at: string; updated_by_name: string }>(
      '/bells/daily-breakdown/settings',
      officeId ? { custom_instructions, office_id: officeId } : { custom_instructions },
    ),
  resetDailyBreakdownSettings: (officeId?: string) =>
    api.post<{ office_id: string; custom_instructions: string; reset: boolean }>(
      '/bells/daily-breakdown/settings/reset',
      officeId ? { office_id: officeId } : {},
    ),

  // ── Per-user UI prefs (custom bottom tab bar) ───────────────────────
  getTabPrefs: () =>
    api.get<{ items: Array<{ id: string; visible: boolean }>; updated_at?: string }>(
      '/me/tab-prefs',
    ),
  saveTabPrefs: (items: Array<{ id: string; visible: boolean }>) =>
    api.put<{ items: Array<{ id: string; visible: boolean }>; updated_at: string }>(
      '/me/tab-prefs',
      { items },
    ),
  // Profile "Schedule Reminders" master toggle — persisted server-side so the
  // web-push sender (core/schedule_reminders.py) honors it, not just the
  // on-device local notifications.
  setScheduleReminders: (enabled: boolean) =>
    api.put<{ enabled: boolean }>('/me/schedule-reminders', { enabled }),

  // ── Learning days — account-bound cumulative count (legacy /streak paths;
  // count/best mirror the total for pre-pivot clients) ──────────────────
  getStreak: () =>
    api.get<{ total?: number; count: number; best: number; last_date: string | null }>('/me/streak'),
  streakActivity: (date: string) =>
    api.post<{ total?: number; count: number; best: number; last_date: string | null; extended: boolean }>(
      '/me/streak/activity',
      { date },
    ),
  streakSync: (state: { total?: number; count: number; best: number; last_date: string | null }) =>
    api.post<{ total?: number; count: number; best: number; last_date: string | null }>(
      '/me/streak/sync',
      state,
    ),

  // ── Achievement engine — earned badges + the static catalog ─────────
  getAchievementCatalog: () =>
    api.get<Array<{ key: string; title: string; subtitle: string; emoji: string; how?: string }>>('/achievements/catalog'),
  getMyBadges: () =>
    api.get<Array<{ id: string; key: string; title: string; subtitle: string; emoji: string; how?: string; earned_at: string; seen: boolean }>>('/me/badges'),
  markBadgesSeen: (ids: string[]) =>
    api.post<{ updated: number }>('/me/badges/mark-seen', { ids }),
  getBadgeEarners: (key: string, office?: string) =>
    api.get<{ key: string; office_id: string; earners: Array<{ user_id: string; name: string; role: string; earned_at: string }> }>(
      `/achievements/${key}/earners${office ? `?office=${encodeURIComponent(office)}` : ''}`),

  // ── Notification inbox — in-app history of every push we've sent ────
  listNotifications: (params?: { limit?: number; before?: string }) =>
    api.get<Array<{
      id: string; user_id: string; title: string; body: string; type: string;
      data?: Record<string, any>; office_id?: string; read: boolean; created_at: string;
    }>>('/notifications', { params: params || {} }),
  getUnreadNotificationCount: () =>
    api.get<{ count: number }>('/notifications/unread-count'),
  markNotificationRead: (id: string) =>
    api.post<{ ok: boolean }>(`/notifications/${encodeURIComponent(id)}/read`),
  markAllNotificationsRead: () =>
    api.post<{ ok: boolean; updated: number }>('/notifications/read-all'),
  getNotificationPrefs: () =>
    api.get<{ categories: Array<{ key: string; label: string; description: string; enabled: boolean }> }>(
      '/notifications/prefs',
    ),
  setNotificationPref: (key: string, enabled: boolean) =>
    api.put<{ ok: boolean; prefs: Record<string, boolean> }>('/notifications/prefs', { key, enabled }),

};
