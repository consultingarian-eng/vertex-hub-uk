/**
 * COD stage DISPLAY order — the single source of truth for the sequence.
 *
 * The Cycle of Development runs:
 *   Stage 1 Foundation → Stage 2 Self Management → Stage 3 Leader →
 *   Stage SL Sector/Site Leader → Stage 4 Team Builder
 *   → Stage 5 Assistant Owner  (NOT BUILT — see below)
 *
 * ── The Assistant Owner collision ──────────────────────────────────────────
 * The real Stage 5 is Assistant Owner, and it comes after Stage 4. Its COD
 * content is not written yet, so it does not exist in the app.
 *
 * The number 5 is ALREADY TAKEN: Sector/Site Leader is stored as stage 5,
 * because (stage, topic) is the identity key for every module, module_progress
 * row, COD sheet rung and check-queue card in production. SL cannot be
 * renumbered without orphaning all of them.
 *
 * So when Assistant Owner is built it needs a DIFFERENT stored number — 6 is
 * the obvious one — and one line added to COD_STAGE_ORDER after the 4:
 *     export const COD_STAGE_ORDER = [1, 2, 3, 5, 4, 6];
 * plus its name in COD_STAGE_NAME. Nothing else in the app should need to
 * change, which is the whole point of this file. Do NOT give it stage 5.
 *
 * Stage SL is STORED as stage 5 in Mongo, and it must stay 5: `(stage, topic)`
 * is the identity key for every training module, module_progress row, COD
 * sheet rung and check-queue card in production, so renumbering it would
 * orphan all of them. Only the order we PRESENT stages in changes — SL sits
 * between Stage 3 and Stage 4.
 *
 * Every list, tab rail, segmented control, ladder, picker, progress rail and
 * section list that shows stages in sequence routes through here, so a future
 * stage change is one edit to COD_STAGE_ORDER instead of eight.
 */

/** Stored stage numbers, in the order a person actually meets them. */
export const COD_STAGE_ORDER: readonly number[] = [1, 2, 3, 5, 4];

/**
 * Where a stored stage number sits in the display order. Stages the COD
 * doesn't know about sort after the known ones, in numeric order, so an
 * unexpected value never jumps to the front of a rail.
 */
export function codStageRank(stage: number): number {
  const i = COD_STAGE_ORDER.indexOf(stage);
  return i === -1 ? COD_STAGE_ORDER.length + stage : i;
}

/** A copy of `stages` in COD display order. Never mutates the input. */
export function sortCodStages<T extends number>(stages: readonly T[]): T[] {
  return [...stages].sort((a, b) => codStageRank(a) - codStageRank(b));
}

/** A copy of `rows` in COD display order, read through `stageOf`. */
export function sortByCodStage<T>(rows: readonly T[], stageOf: (row: T) => number): T[] {
  return [...rows].sort((a, b) => codStageRank(stageOf(a)) - codStageRank(stageOf(b)));
}

/**
 * Canonical stage NAMES, by stored stage number. Lived in three screens with
 * three slightly different spellings; anything showing a stage name to a user
 * should read it from here.
 */
export const COD_STAGE_NAME: Record<number, string> = {
  1: 'Foundation',
  2: 'Self Management',
  3: 'Leader',
  4: 'Team Builder',
  5: 'Sector/Site Leader',
};

/**
 * Short stage names for tight places — the Home hero, where the column is
 * ~156px wide. "Sector/Site Leader" has no space to break at, so the renderer
 * split it mid-word as "SECTOR/SIT E LEADER"; "Sector Leader" (already the
 * wording used on the Two Ladders rail) wraps cleanly or fits outright.
 */
export const COD_STAGE_SHORT: Record<number, string> = {
  ...COD_STAGE_NAME,
  5: 'Sector Leader',
};

/** Short stage name for display. */
export function codStageShortName(stage: number): string {
  return COD_STAGE_SHORT[stage] || `Stage ${codStageLabel(stage)}`;
}

/** Stage name for display, falling back to "Stage <label>" for an unknown one. */
export function codStageName(stage: number): string {
  return COD_STAGE_NAME[stage] || `Stage ${codStageLabel(stage)}`;
}

/**
 * The furthest stage reached, in COD DISPLAY order — NOT `Math.max`. SL is
 * stored as 5 but sits between 3 and 4, so taking the highest stored number
 * reports SL as the furthest stage for someone who has already passed it and
 * unlocked Team Builder.
 */
export function furthestCodStage(stages: readonly number[], fallback = 1): number {
  let best = fallback;
  for (const s of stages) if (codStageRank(s) > codStageRank(best)) best = s;
  return best;
}

/** Stored stage number for Sector/Site Leader. Stored as 5, never shown as 5. */
export const COD_SL_STAGE = 5;

/**
 * How a stage is SPELLED on screen: "SL" for Sector/Site Leader, the number
 * otherwise. SL is stored as 5 but sits between 3 and 4, so printing the
 * stored number puts a "5" between a "3" and a "4" and reads like a mistake.
 * Anywhere a stage number reaches a user, it goes through here.
 */
export function codStageLabel(stage: number): string {
  return stage === COD_SL_STAGE ? 'SL' : String(stage);
}

/** Two-character form for numbered section headers ("01", "02", "SL"). */
export function codStagePad(stage: number): string {
  return stage === COD_SL_STAGE ? 'SL' : String(stage).padStart(2, '0');
}

/**
 * True when stage `a` comes before stage `b` in the COD. Use this instead of
 * `a < b` anywhere a stage is compared for done/upcoming, because 3 → SL → 4
 * is no longer numerically ascending.
 */
export function codStageIsBefore(a: number, b: number): boolean {
  return codStageRank(a) < codStageRank(b);
}
