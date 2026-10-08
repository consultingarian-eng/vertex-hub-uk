/**
 * What a person's rank is CALLED on screen.
 *
 * `role` is an authorisation value — 'admin' | 'leader' | 'trainee' — and the
 * app gates real permissions on it, so it must never be edited to change what
 * somebody is called. An owner and a stand-in office admin are both `admin`
 * and need to stay that way; they just should not read the same on screen.
 *
 * So an optional `title` on the user document overrides the label and nothing
 * else. Set it to "Owner" for an owner; leave it unset for everyone else and
 * they keep the ordinary role word.
 *
 * Vertex wording (the owner's Latest Terminology Guide — everyone is
 * self-employed, so no employment titles on screen):
 *   role 'leader'  → "Coach" (the person a BA reports to), or "Stage 3" where
 *                    the screen names a RANK rather than the coaching role
 *   role 'trainee' → "BA" ("New BA" / "new starter" in first-weeks copy)
 *   role 'admin'   → "Admin" (the company head is "the Owner")
 * Earned titles arrive from the API as the backend's own strings
 * (core/team_leader.py); they are mapped for display here, never rewritten
 * in data.
 */
const ROLE_WORD: Record<string, string> = {
  admin: 'Admin',
  leader: 'Coach',
  trainee: 'BA',
};

const ROLE_WORD_PLURAL: Record<string, string> = {
  admin: 'Admins',
  leader: 'Coaches',
  trainee: 'BAs',
};

/** The rank a role stands for when the screen names a rank, not a job to do. */
const ROLE_RANK: Record<string, string> = {
  admin: 'Admin',
  leader: 'Stage 3',
  trainee: 'BA',
};

/** Stored title → on-screen title (full, and short for tight ribbons). */
const TITLE_DISPLAY: Record<string, { full: string; short: string }> = {
  'team leader': { full: 'Stage 4 · Crew Leadership', short: 'Stage 4' },
  'assistant owner': { full: 'Stage 5 · Assistant Ownership', short: 'Stage 5' },
  owner: { full: 'Stage 6 · Owner', short: 'Stage 6' },
};

export type TitledUser = { role?: string; title?: string } | null | undefined;

/** A stored title (e.g. "Team Leader") as it reads on screen. */
export function displayTitle(title: string | null | undefined, opts?: { short?: boolean }): string {
  const t = (title || '').trim();
  if (!t) return '';
  const hit = TITLE_DISPLAY[t.toLowerCase()];
  if (!hit) return t;
  return opts?.short ? hit.short : hit.full;
}

/** The ordinary word for a role value: 'leader' → "Coach", 'trainee' → "BA". */
export function roleWord(role: string | null | undefined): string {
  const r = (role || '').trim().toLowerCase();
  return ROLE_WORD[r] || (r ? r.charAt(0).toUpperCase() + r.slice(1) : '');
}

/** Coach+: a Coach (`role: 'leader'`) with the `coach_plus` flag. */
export function isCoachPlus(user: { role?: string; coach_plus?: boolean } | null | undefined): boolean {
  return (user?.role || '').toLowerCase() === 'leader' && !!user?.coach_plus;
}

/** Sees the whole office's field numbers and handles ID badges: Admin or Coach+. */
export function seesWholeOffice(user: { role?: string; coach_plus?: boolean } | null | undefined): boolean {
  return (user?.role || '').toLowerCase() === 'admin' || isCoachPlus(user);
}

/** roleWord for a person, where Coach+ reads "Coach+". */
export function levelWord(user: { role?: string; coach_plus?: boolean } | null | undefined): string {
  return isCoachPlus(user) ? 'Coach+' : roleWord(user?.role);
}

/** Plural of roleWord: 'leader' → "Coaches", 'trainee' → "BAs". */
export function roleWordPlural(role: string | null | undefined): string {
  const r = (role || '').trim().toLowerCase();
  return ROLE_WORD_PLURAL[r] || (r ? `${roleWord(r)}s` : '');
}

/** Display title: the explicit override (mapped), else the role's ordinary word. */
export function roleTitle(user: TitledUser): string {
  const t = displayTitle(user?.title);
  if (t) return t;
  return roleWord(user?.role);
}

/** Same, upper-cased. */
export function roleTitleUpper(user: TitledUser): string {
  return roleTitle(user).toUpperCase();
}

/**
 * The person's RANK, for rank ribbons: an explicit title (mapped), else the
 * stage their role stands for — a leader is "Stage 3", a trainee a "BA".
 * `short` trims an earned title to its stage ("Stage 4") for tight ribbons.
 */
export function rankTitle(user: TitledUser, opts?: { short?: boolean }): string {
  const t = displayTitle(user?.title, opts);
  if (t) return t;
  const r = (user?.role || '').trim().toLowerCase();
  return ROLE_RANK[r] || roleWord(r);
}

/**
 * The big rank line on the Home hero.
 *
 * An explicit `title` IS the person's rank and outranks their COD stage: an
 * Owner is not "Team Builder", and a Stage 4 is not "Leader". The COD
 * stage is only the fallback, for the majority who have no override.
 *
 * Pass the COD stage name already resolved (codStageShortName), so this file
 * stays free of COD knowledge.
 */
export function heroRankTitle(user: TitledUser, codStageName?: string | null): string | null {
  const t = displayTitle(user?.title);
  if (t) return t;
  return (codStageName || '').trim() || null;
}
