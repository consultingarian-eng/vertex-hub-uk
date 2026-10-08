/**
 * How a live counter is allowed to print itself next to a tick box.
 *
 * The whole point of the NEXT UP checklist is that a rep's own number and the
 * tick beside it tell the same story. Rounding broke that: the gate wants
 * 3.0 sales a day, a rep sitting on 2.96 is NOT there yet, and `toFixed(1)`
 * printed "3.0 of 3.0" beside an empty box. A counter that argues with the
 * award is worse than no counter at all, so this file exists to make that
 * one line impossible.
 *
 * The rule: **a number printed against a target it has not reached may never
 * read as reached.** Normal rounding first — so the score matches the same
 * average printed elsewhere on the screen — and only when rounding would land
 * on (or past) the target does the number drop the rounding and show its real
 * digits instead. 2.4 stays "2.4"; 2.96 becomes "2.96", never "3.0".
 *
 * Kept free of every React Native import so it can be exercised directly:
 * `node --test frontend/src/components/salespath/nextUpFormat.test.ts`.
 */

/** Whole numbers stay whole; a pace keeps its single decimal ("2.4 of 3.0"). */
export function fmt(n: number, decimals = 0): string {
  return decimals > 0 ? n.toFixed(decimals) : String(Math.round(n));
}

/** How many extra decimals a nearly-there number may borrow to stay honest. */
const MAX_EXTRA_DECIMALS = 4;

/**
 * A rep's own number, printed against the target the gate measures it on.
 *
 * `met` is the gate's verdict and is never second-guessed here — when it is
 * true the number prints plainly, however far past the bar it is. When it is
 * false the returned string is guaranteed to parse strictly below `target`.
 *
 *   fmtScore(2.4,  1, 3.0, false)  →  "2.4"    (rounding was already honest)
 *   fmtScore(2.96, 1, 3.0, false)  →  "2.96"   (was "3.0" — the bug)
 *   fmtScore(2.999,1, 3.0, false)  →  "2.99"
 *   fmtScore(3.0,  1, 3.0, true)   →  "3.0"    (ticked, so it may read as met)
 */
export function fmtScore(
  n: number,
  decimals: number,
  target: number | null | undefined,
  met: boolean,
): string {
  if (met || target == null) return fmt(n, decimals);

  // Normal rounding, as long as the result still READS below the target.
  const rounded = fmt(n, decimals);
  if (Number(rounded) < target) return rounded;

  // It would round up onto the target. Drop the rounding and add precision
  // until the number is visibly short — "0.04 to go" deserves two decimals
  // more than it deserves a silent "you're there".
  for (let d = decimals + 1; d <= decimals + MAX_EXTRA_DECIMALS; d++) {
    const p = 10 ** d;
    const down = Math.floor(n * p) / p;
    if (down < target) return down.toFixed(d);
  }

  // Unreachable from the engine: `met: false` guarantees `current < target`
  // (backend test_next_up_never_prints_its_own_target). If a future payload
  // ever broke that, the tick box is the one that must be believed — so the
  // score steps back to the last value below the bar rather than ticking
  // itself in type while the box stays empty.
  const step = 1 / 10 ** decimals;
  return fmt(Math.max(0, target - step), decimals);
}
