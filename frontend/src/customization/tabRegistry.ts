/**
 * Tab registry — every screen that's eligible to live on the bottom bar
 * (or in the Profile Quick Access list when hidden).
 *
 * IDs are stable strings persisted to /api/me/tab-prefs. Adding a new tab
 * here is automatic — existing users will see it as visible by default
 * (controlled by `defaultVisibleByRole`).
 *
 * `kind: 'tab'` items are screens hosted inside the (tabs)/_layout.tsx
 * navigator — selecting them switches the current tab.
 * `kind: 'route'` items are external screens (push them onto the stack).
 */
import { Ionicons } from '@expo/vector-icons';

export type Role = 'trainee' | 'leader' | 'admin';

export type TabItem = {
  id: string;
  /** Short label shown on the bottom bar (max ~7 chars looks best). */
  label: string;
  /** Short label for the collapsed sidebar rail, when `label` is too long for it. */
  short?: string;
  /** Longer label shown in the customize screen. */
  longLabel: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  /** 'tab' = expo-router Tabs.Screen name; 'route' = push via router.push. */
  kind: 'tab' | 'route';
  /** For kind='tab' this is the screen name; for kind='route' the href. */
  target: string;
  visibleFor: Role[];
  /** Whether this item is on by default in the bottom bar (per role). */
  defaultVisibleByRole: Partial<Record<Role, boolean>>;
};

export const TAB_REGISTRY: TabItem[] = [
  // ── Existing (tabs)/ screens ────────────────────────────────────────
  {
    id: 'home', label: 'Home', longLabel: 'Home Dashboard',
    icon: 'home-outline', kind: 'tab', target: 'index',
    visibleFor: ['trainee', 'leader', 'admin'],
    defaultVisibleByRole: { trainee: true, leader: true, admin: true },
  },
  {
    id: 'hires', label: 'Performance Hub', short: 'Performance', longLabel: 'Performance Hub — figures, teams and the spider diagram',
    icon: 'people-outline', kind: 'tab', target: 'hires',
    visibleFor: ['leader', 'admin'],
    defaultVisibleByRole: { leader: true, admin: true },
  },
  {
    id: 'schedule', label: 'Schedule', longLabel: 'Schedule',
    icon: 'calendar-outline', kind: 'tab', target: 'schedule',
    visibleFor: ['trainee', 'leader', 'admin'],
    defaultVisibleByRole: { trainee: true, leader: true, admin: true },
  },
  {
    // One surface for the whole Cycle of Development: trainees see their
    // journey + Stage 2, leaders/admins the full Stage 1→SL hub. "My
    // Progress" and "COD" were two names for the same thing — now it's one.
    id: 'progress', label: 'COD', longLabel: 'COD — Cycle of Development (all stages)',
    icon: 'trending-up-outline', kind: 'tab', target: 'progress',
    visibleFor: ['trainee', 'leader', 'admin'],
    defaultVisibleByRole: { trainee: true, leader: true, admin: true },
  },
  {
    // Trainee-only: the day-by-day 8-day journey (profile + JourneyPath +
    // assessments) on its own surface, so "my progress" and "the COD" are
    // two different doors — the COD tab stays the capability/proof-ladder
    // view, mirroring what leaders see.
    id: 'assessments', label: 'My Progress', longLabel: 'My Progress — My 8-Day Journey',
    icon: 'footsteps-outline', kind: 'route', target: '/assessments',
    visibleFor: ['trainee'],
    defaultVisibleByRole: { trainee: true },
  },
  {
    id: 'pay', label: 'Earnings Calculator', short: 'Earnings', longLabel: 'Earnings Calculator',
    icon: 'calculator-outline', kind: 'tab', target: 'pay',
    visibleFor: ['trainee', 'leader', 'admin'],
    defaultVisibleByRole: { trainee: false, leader: false, admin: false },
  },
  {
    id: 'admin', label: 'Admin', longLabel: 'Admin',
    icon: 'shield-outline', kind: 'tab', target: 'admin',
    visibleFor: ['admin'],
    defaultVisibleByRole: { admin: true },
  },

  // ── External routes (renamed per product owner) ─────────────────────
  {
    id: 'cod', label: 'Coaching', longLabel: 'Coaching Hub — Impacts & Library',
    icon: 'school-outline', kind: 'route', target: '/coaching',
    visibleFor: ['trainee', 'leader', 'admin'],
    defaultVisibleByRole: { trainee: false, leader: true, admin: true },
  },
  // The Library has no sidebar item of its own: it is a section of Coaching
  // (/coaching?tab=library).
  // Bells has no sidebar item of its own: it is the third section of the
  // Performance Hub (Performance | Spider | Bells). The /bells route still
  // opens the same board for links and notifications.
  {
    id: 'mgp', label: 'MGP', longLabel: 'Monthly Goal Planners',
    icon: 'bar-chart-outline', kind: 'route', target: '/monthly-planner',
    visibleFor: ['trainee', 'leader', 'admin'],
    defaultVisibleByRole: { trainee: false, leader: false, admin: false },
  },
  // Badges has no sidebar item of its own: a badge is made and printed from
  // the person's own page (tap a name in Admin), and the full list of saved
  // badges opens from Admin, under Office tools (/badges).
  {
    id: 'manual', label: 'Manual', longLabel: 'Training Manual',
    icon: 'book-outline', kind: 'tab', target: 'manual',
    // Trainees too: Home's quick actions already deep-link them to the
    // Manual tab, so they must be able to pin it (hidden by default).
    visibleFor: ['trainee', 'leader', 'admin'],
    defaultVisibleByRole: { trainee: false, leader: false, admin: false },
  },
  {
    id: 'weekly-planner', label: 'Planner', longLabel: 'Daily / Weekly Planner',
    icon: 'calendar-number-outline', kind: 'route', target: '/weekly-planner',
    visibleFor: ['trainee', 'leader', 'admin'],
    defaultVisibleByRole: { trainee: false, leader: false, admin: false },
  },
  {
    id: 'field-kpis', label: 'KPIs', longLabel: 'Field KPIs (OwnerIQ / DataByte)',
    icon: 'speedometer-outline', kind: 'route', target: '/field-kpis',
    visibleFor: ['trainee', 'leader', 'admin'],
    // Opt-in: users pin it from Customize Tabs (off by default per role).
    defaultVisibleByRole: { trainee: false, leader: false, admin: false },
  },
  {
    // New id (was 'sectors', hidden by default): a fresh id is added to
    // everyone's saved sidebar with the defaults below, so Coaches and admins
    // get Live Operations pinned without touching their other choices.
    id: 'live-ops', label: 'Live Operations', short: 'Live Ops', longLabel: 'Live Operations — sectors in the field, door by door',
    icon: 'radio-outline', kind: 'route', target: '/live-ops',
    visibleFor: ['trainee', 'leader', 'admin'],
    defaultVisibleByRole: { trainee: false, leader: true, admin: true },
  },
  {
    id: 'notifications', label: 'Inbox', longLabel: 'Inbox — Notification History',
    icon: 'mail-outline', kind: 'route', target: '/notifications',
    visibleFor: ['trainee', 'leader', 'admin'],
    // Hidden by default — the bell on Home is the everyday way in.
    defaultVisibleByRole: { trainee: false, leader: false, admin: false },
  },
];


/** Items eligible for a given user role. */
export function eligibleForRole(role: Role | undefined | null): TabItem[] {
  if (!role) return [];
  return TAB_REGISTRY.filter((t) => t.visibleFor.includes(role));
}


/** The default ordered list (visible items first) for a given role. */
export function defaultPrefsForRole(role: Role | undefined | null): { id: string; visible: boolean }[] {
  if (!role) return [];
  const items = eligibleForRole(role);
  return items.map((t) => ({
    id: t.id,
    visible: !!t.defaultVisibleByRole[role],
  }));
}


/** Resolve saved prefs against the registry, dropping items the user
 *  cannot see (e.g. role changed) and appending newly-added items at the
 *  bottom (visible by default per role). */
export function resolveTabPrefs(
  saved: { id: string; visible: boolean }[] | null | undefined,
  role: Role | undefined | null,
): { item: TabItem; visible: boolean }[] {
  if (!role) return [];
  const eligible = eligibleForRole(role);
  const eligibleIds = new Set(eligible.map((e) => e.id));
  const out: { item: TabItem; visible: boolean }[] = [];
  const used = new Set<string>();
  for (const sv of saved || []) {
    if (!eligibleIds.has(sv.id) || used.has(sv.id)) continue;
    const item = eligible.find((e) => e.id === sv.id)!;
    out.push({ item, visible: !!sv.visible });
    used.add(sv.id);
  }
  // Append any new items not in saved prefs at end — except Home, which
  // goes FIRST so users with older saved prefs get it in the leftmost slot
  // (it's the landing screen; burying it past the 5-tab cutoff would make
  // it unreachable from the bar).
  for (const e of eligible) {
    if (used.has(e.id)) continue;
    const entry = { item: e, visible: !!e.defaultVisibleByRole[role] };
    if (e.id === 'home') out.unshift(entry);
    else out.push(entry);
  }
  return out;
}


/** Maximum pinned sidebar items (Profile is always there). The name is historical. */
export const MAX_BOTTOM_TABS = 12;
/** Minimum bottom-bar items the user must keep enabled. */
export const MIN_BOTTOM_TABS = 1;
