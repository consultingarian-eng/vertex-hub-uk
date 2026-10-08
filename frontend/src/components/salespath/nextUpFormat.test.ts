/**
 * The one invariant the NEXT UP checklist cannot be allowed to break: a score
 * printed beside an empty tick box must never read as the target.
 *
 * Run it (no bundler, no jest — Node strips the types):
 *   node --test frontend/src/components/salespath/nextUpFormat.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fmt, fmtScore } from './nextUpFormat.ts';

test('fmt keeps whole numbers whole and paces at one decimal', () => {
  assert.equal(fmt(3, 0), '3');
  assert.equal(fmt(2.6, 0), '3');
  assert.equal(fmt(2.4, 1), '2.4');
});

test('a pace short of the bar never prints the bar (the 2.96 bug)', () => {
  // toFixed(1) used to render this as "3.0 of 3.0" with the box unticked.
  assert.equal(fmtScore(2.96, 1, 3.0, false), '2.96');
  assert.equal(fmtScore(2.95, 1, 3.0, false), '2.95');
  assert.equal(fmtScore(2.99, 1, 3.0, false), '2.99');
  assert.equal(fmtScore(2.999, 1, 3.0, false), '2.99');
});

test('a number that already rounded honestly is left alone', () => {
  assert.equal(fmtScore(2.4, 1, 3.0, false), '2.4');
  assert.equal(fmtScore(2.35, 1, 3.0, false), '2.4'); // matches the PER DAY stat
  assert.equal(fmtScore(2.75, 1, 3.0, false), '2.8'); // a rep, live today
  assert.equal(fmtScore(0, 1, 3.0, false), '0.0');
});

test('a met row prints plainly, target and beyond', () => {
  assert.equal(fmtScore(3.0, 1, 3.0, true), '3.0');
  assert.equal(fmtScore(3.42, 1, 3.0, true), '3.4');
  assert.equal(fmtScore(11, 0, 3, true), '11');
});

test('whole-number rows obey the same rule', () => {
  assert.equal(fmtScore(2, 0, 3, false), '2');
  assert.equal(fmtScore(13, 0, 14, false), '13');
  assert.equal(fmtScore(2.6, 0, 3, false), '2.6'); // would have rounded to "3"
});

test('no unmet value can read as target-or-better, over the whole range', () => {
  for (const target of [1, 3, 12, 14, 84, 3.0, 2.4]) {
    const decimals = Number.isInteger(target) && target > 6 ? 0 : 1;
    for (let i = 0; i <= 2000; i++) {
      const n = (target * i) / 2000;
      if (n >= target) continue; // the gate would have ticked it
      const printed = Number(fmtScore(n, decimals, target, false));
      assert.ok(
        printed < target,
        `fmtScore(${n}, ${decimals}, ${target}, false) printed ${printed} — reads as met`,
      );
    }
  }
});

test('a target-or-better value with met false still cannot tick itself in type', () => {
  // Unreachable from the engine, guarded anyway — the tick box wins.
  assert.ok(Number(fmtScore(3.0, 1, 3.0, false)) < 3.0);
  assert.ok(Number(fmtScore(4.2, 1, 3.0, false)) < 3.0);
});

test('a sales COUNT one part-sale short cannot round onto its target', () => {
  // The pace row counts sales against the total its pace implies (45 of 60),
  // so the trap moved from "2.96 reads as 3.0" to "59.5 reads as 60". Same
  // rule, whole numbers: an unticked total must print visibly short.
  assert.equal(fmtScore(59.5, 0, 60, false), '59.5');
  assert.equal(fmtScore(59.9, 0, 60, false), '59.9');
  assert.equal(fmtScore(59, 0, 60, false), '59');   // already honest
  assert.equal(fmtScore(60, 0, 60, true), '60');    // ticked, prints plainly
  // And across a real window's worth of part-sale totals.
  for (let i = 1; i <= 600; i++) {
    const n = 60 - i / 100;
    assert.ok(Number(fmtScore(n, 0, 60, false)) < 60, `${n} printed as met`);
  }
});
