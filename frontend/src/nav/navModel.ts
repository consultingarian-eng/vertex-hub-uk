import type { Ionicons } from '@expo/vector-icons';
import { TAB_REGISTRY, type TabItem } from '../customization/tabRegistry';

// What the sidebar and the top tabs know about a screen: its label, icon and
// the href that opens it. Registry items (the customisable nav) come first;
// any other screen gets a title from ROUTE_TITLES.

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export type NavEntry = {
  key: string;
  label: string;
  icon: IconName;
  href: string;
  /** Registry id, when the screen is a nav item. */
  itemId?: string;
};

export const PROFILE_ITEM: TabItem = {
  id: 'profile', label: 'Profile', longLabel: 'Profile', icon: 'person-circle-outline',
  kind: 'tab', target: 'profile', visibleFor: ['trainee', 'leader', 'admin'], defaultVisibleByRole: {},
};

export function hrefOf(it: Pick<TabItem, 'kind' | 'target'>): string {
  if (it.kind === 'route') return it.target;
  return it.target === 'index' ? '/(tabs)' : `/(tabs)/${it.target}`;
}

const ROUTE_TITLES: Record<string, [string, IconName]> = {
  badges: ['Badges', 'ribbon-outline'],
  module: ['Module', 'book-outline'],
  leadership: ['My Progress', 'footsteps-outline'],
  bells: ['Bells', 'notifications-outline'],
  'field-kpis': ['Field KPIs', 'speedometer-outline'],
  assessments: ['My Progress', 'footsteps-outline'],
  assessment: ['Daily Assessment', 'clipboard-outline'],
  report: ['AI Report', 'sparkles-outline'],
  'owneriq-admin': ['OwnerIQ Sync', 'sync-outline'],
  'live-ops': ['Live Operations', 'radio-outline'],
  'live-sector': ['Sector', 'map-outline'],
  'live-ba': ['BA', 'person-outline'],
  'monthly-planner': ['Monthly Planner', 'bar-chart-outline'],
  'monthly-planner-team': ['Team Planner', 'bar-chart-outline'],
  'weekly-planner': ['Weekly Planner', 'calendar-number-outline'],
  'absence-approvals': ['Absences', 'moon-outline'],
  'weekly-review': ['Monday Review', 'stats-chart-outline'],
  coaching: ['Coaching', 'school-outline'],
  'product-knowledge': ['Campaign Knowledge', 'library-outline'],
  'customize-tabs': ['Customise', 'options-outline'],
  notifications: ['Inbox', 'mail-outline'],
  'weekly-share': ['Weekly Share', 'share-social-outline'],
  'share-bulletins': ['Bulletins', 'megaphone-outline'],
  bulletin: ['Bulletin', 'megaphone-outline'],
  'team-bulletin': ['Team Bulletin', 'megaphone-outline'],
  'new-hire': ['New Starter', 'person-add-outline'],
  'add-hire': ['Add New Starter', 'person-add-outline'],
  day: ['Day', 'today-outline'],
  cod: ['COD', 'trending-up-outline'],
  'cod-vetting': ['COD Vetting', 'checkmark-done-outline'],
  'cod-sheet': ['COD Sheet', 'document-text-outline'],
  'cod-checks': ['COD Checks', 'checkmark-done-outline'],
  'cod-intro': ['COD', 'trending-up-outline'],
  checklist: ['Skill Grading', 'checkbox-outline'],
  'orientation-grading': ['Orientation', 'checkbox-outline'],
  onboarding: ['Start Here', 'flag-outline'],
  quality: ['Quality', 'shield-checkmark-outline'],
  snapshot: ['Snapshot', 'camera-outline'],
  'sales-path-intro': ['Sales Path', 'trail-sign-outline'],
  'planner-goal-menu': ['Goals', 'flag-outline'],
  leader: ['Team member', 'person-outline'],
  person: ['Person', 'person-circle-outline'],
};

// Screens that keep to ONE top tab however many are opened: tapping through
// ten people re-points the Person tab instead of opening ten of them.
const SHARED_TAB = new Set(['person']);

function cleanPath(pathname: string): string {
  return (pathname || '/').replace(/^\/\(tabs\)/, '') || '/';
}

/** The nav item a path belongs to (longest route prefix, else exact tab). */
export function matchItem(pathname: string, items: TabItem[]): TabItem | null {
  const p = cleanPath(pathname);
  let best: TabItem | null = null;
  for (const it of items) {
    if (it.kind !== 'route') continue;
    const t = it.target;
    if (t.includes('?')) continue;
    if ((p === t || (p.startsWith(t) && p.charAt(t.length) === '/')) && (!best || t.length > best.target.length)) best = it;
  }
  if (best) return best;
  for (const it of items) {
    if (it.kind !== 'tab') continue;
    if (it.target === 'index' ? p === '/' || p === '/index' : p === `/${it.target}`) return it;
  }
  return null;
}

/** The tab a path opens as. */
export function entryForPath(pathname: string): NavEntry {
  const all = [...TAB_REGISTRY, PROFILE_ITEM];
  const it = matchItem(pathname, all);
  if (it) return { key: it.id, label: it.label, icon: it.icon, href: hrefOf(it), itemId: it.id };
  const p = cleanPath(pathname);
  const seg = p.split('/').filter(Boolean)[0] || '';
  const known = ROUTE_TITLES[seg];
  const label = known?.[0] || seg.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) || 'Page';
  return { key: SHARED_TAB.has(seg) ? seg : p, label, icon: known?.[1] || 'document-outline', href: p };
}

/** The filled twin of an outline Ionicon (every nav icon has one). */
export function filledIcon(name: IconName): IconName {
  return (name.endsWith('-outline') ? name.slice(0, -'-outline'.length) : name) as IconName;
}
