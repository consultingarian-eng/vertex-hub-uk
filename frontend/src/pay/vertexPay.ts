/**
 * Vertex pay — the pure formulas behind the Pay tab. No React, no imports, so
 * it can be checked with plain `node` (see the scratch check script).
 *
 * A Brand Ambassador (BA) is paid per sign-up, by the donor's monthly gift:
 *   £12 Standard sign-up → fee_standard (£55)
 *   £15 Target sign-up   → fee_target   (£60)
 *   £20 Premium sign-up  → fee_premium  (£60)
 * + third_dd_bonus (£15) per confirmed 3rd direct debit that week
 * − leadership_deduction (£5) per sign-up that week, for a leader whose call
 *   completion rate is below leadership_threshold_pct (70 %).
 *
 * Quality payments: in a month whose quality rate is at least
 * quality_gate_pct (70 %), floor(sign-ups × rate / 100) supporters qualify
 * (they reach their 3rd direct debit) and each pays quality_payment (£15),
 * quality_lag_months (4) after the sign-up month — September sign-ups are
 * paid in January.
 *
 * Extra incentives: a week of incentive_week_signups (12) or more sign-ups
 * with an average donor age of incentive_min_age (45) or more and a call
 * completion rate of incentive_call_pct (85 %) or more earns
 * incentive_week_amount (£50); at incentive_week_top_signups (16) or more it
 * is incentive_week_top_amount (£100) instead. A month of
 * incentive_month_signups (50) or more with the same two gates earns
 * incentive_month_amount (£100).
 *
 * Mirrors backend/core/vertex_pay.py (defaults + tolerance of old-shape fee
 * documents) — change both together.
 */

export type VertexFees = {
  fee_standard: number;
  fee_target: number;
  fee_premium: number;
  third_dd_bonus: number;
  leadership_threshold_pct: number;
  leadership_deduction: number;
  quality_gate_pct: number;
  quality_payment: number;
  quality_lag_months: number;
  incentive_min_age: number;
  incentive_call_pct: number;
  incentive_week_signups: number;
  incentive_week_amount: number;
  incentive_week_top_signups: number;
  incentive_week_top_amount: number;
  incentive_month_signups: number;
  incentive_month_amount: number;
  /** The office's (MC's) own fee per sign-up. Admins only: the server leaves
   *  it out for everyone else, so it falls back to the default and is never shown. */
  fee_mc: number;
};

export const DEFAULT_FEES: VertexFees = {
  fee_standard: 55,
  fee_target: 60,
  fee_premium: 60,
  third_dd_bonus: 15,
  leadership_threshold_pct: 70,
  leadership_deduction: 5,
  quality_gate_pct: 70,
  quality_payment: 15,
  quality_lag_months: 4,
  incentive_min_age: 45,
  incentive_call_pct: 85,
  incentive_week_signups: 12,
  incentive_week_amount: 50,
  incentive_week_top_signups: 16,
  incentive_week_top_amount: 100,
  incentive_month_signups: 50,
  incentive_month_amount: 100,
  fee_mc: 30,
};

export const FEE_KEYS = Object.keys(DEFAULT_FEES) as Array<keyof VertexFees>;

/** Inclusive bounds per knob — the same ranges the server enforces. */
export const FEE_BOUNDS: Record<keyof VertexFees, [number, number]> = {
  fee_standard: [0, 1000],
  fee_target: [0, 1000],
  fee_premium: [0, 1000],
  third_dd_bonus: [0, 1000],
  leadership_threshold_pct: [0, 100],
  leadership_deduction: [0, 1000],
  quality_gate_pct: [0, 100],
  quality_payment: [0, 1000],
  quality_lag_months: [0, 24],
  incentive_min_age: [0, 120],
  incentive_call_pct: [0, 100],
  incentive_week_signups: [0, 999],
  incentive_week_amount: [0, 10000],
  incentive_week_top_signups: [0, 999],
  incentive_week_top_amount: [0, 10000],
  incentive_month_signups: [0, 9999],
  incentive_month_amount: [0, 10000],
  fee_mc: [0, 1000],
};

const INT_KEYS: Array<keyof VertexFees> = ['quality_lag_months', 'incentive_week_signups', 'incentive_week_top_signups', 'incentive_month_signups'];

/** Defaults where the server's document lacks a valid knob (old-shape docs included). */
export function normalizeFees(raw: unknown): VertexFees {
  const out: VertexFees = { ...DEFAULT_FEES };
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const key of FEE_KEYS) {
    const v = src[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    const [lo, hi] = FEE_BOUNDS[key];
    if (Number.isFinite(n) && n >= lo && n <= hi) {
      out[key] = INT_KEYS.includes(key) ? Math.round(n) : n;
    }
  }
  return out;
}

/** A non-negative whole count from anything a text input can hold. */
export function toCount(v: unknown, max = 999): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.floor(n));
}

/** A percentage clamped to 0–100 (decimals allowed). */
export function toPct(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// ── This week ──────────────────────────────────────────────────────────────

export type WeekInput = {
  /** £12 Standard sign-ups. */
  standard: number;
  /** £15+ sign-ups (Target £15 and Premium £20 together — what Bells records). */
  targetPlus: number;
  /** Of `targetPlus`, how many were £20 Premium (priced at fee_premium). */
  premium?: number;
  /** Confirmed 3rd direct debits this week. */
  thirdDDs: number;
  /** Leadership level — the call-completion rule applies. */
  leadership: boolean;
  /** Call completion rate, %. Only read when `leadership`. */
  callCompletionPct: number;
};

export type WeekPay = {
  signUps: number;
  standardFees: number;
  targetFees: number;
  premiumFees: number;
  signUpFees: number;
  thirdDDBonus: number;
  /** Sign-up fees + 3rd DD bonus, before any deduction. */
  gross: number;
  deductionApplies: boolean;
  leadershipDeduction: number;
  total: number;
};

export function weekPay(input: WeekInput, fees: VertexFees = DEFAULT_FEES): WeekPay {
  const standard = toCount(input.standard);
  const targetPlus = toCount(input.targetPlus);
  const premium = Math.min(targetPlus, toCount(input.premium ?? 0));
  const target = targetPlus - premium;
  const thirdDDs = toCount(input.thirdDDs);
  const signUps = standard + targetPlus;

  const standardFees = standard * fees.fee_standard;
  const targetFees = target * fees.fee_target;
  const premiumFees = premium * fees.fee_premium;
  const signUpFees = standardFees + targetFees + premiumFees;
  const thirdDDBonus = thirdDDs * fees.third_dd_bonus;
  const gross = signUpFees + thirdDDBonus;
  const deductionApplies = !!input.leadership && toPct(input.callCompletionPct) < fees.leadership_threshold_pct;
  const leadershipDeduction = deductionApplies ? signUps * fees.leadership_deduction : 0;
  return {
    signUps, standardFees, targetFees, premiumFees, signUpFees, thirdDDBonus, gross,
    deductionApplies, leadershipDeduction, total: gross - leadershipDeduction,
  };
}

// ── Extra incentives ───────────────────────────────────────────────────────

export type Incentive = {
  /** Enough sign-ups for the (first) tier. */
  signUpsMet: boolean;
  /** Average donor age at or above incentive_min_age. */
  ageMet: boolean;
  /** Call completion at or above incentive_call_pct. */
  callsMet: boolean;
  /** 0 = none, 1 = the first tier, 2 = the top tier. */
  tier: 0 | 1 | 2;
  amount: number;
};

function gates(avgAge: number, callPct: number, fees: VertexFees) {
  const age = Number.isFinite(avgAge) ? avgAge : 0;
  return { ageMet: age >= fees.incentive_min_age, callsMet: toPct(callPct) >= fees.incentive_call_pct };
}

/** The week's extra incentive: both quality gates and enough sign-ups. */
export function weekIncentive(signUps: number, avgAge: number, callPct: number, fees: VertexFees = DEFAULT_FEES): Incentive {
  const n = toCount(signUps);
  const { ageMet, callsMet } = gates(avgAge, callPct, fees);
  const signUpsMet = n >= fees.incentive_week_signups;
  const top = n >= fees.incentive_week_top_signups && fees.incentive_week_top_signups >= fees.incentive_week_signups;
  const tier = !(signUpsMet && ageMet && callsMet) ? 0 : top ? 2 : 1;
  return { signUpsMet, ageMet, callsMet, tier, amount: tier === 2 ? fees.incentive_week_top_amount : tier === 1 ? fees.incentive_week_amount : 0 };
}

/** The month's extra incentive: the same two gates and the month's sign-ups. */
export function monthIncentive(signUps: number, avgAge: number, callPct: number, fees: VertexFees = DEFAULT_FEES): Incentive {
  const { ageMet, callsMet } = gates(avgAge, callPct, fees);
  const signUpsMet = toCount(signUps, 9999) >= fees.incentive_month_signups;
  const tier = signUpsMet && ageMet && callsMet ? 1 : 0;
  return { signUpsMet, ageMet, callsMet, tier, amount: tier ? fees.incentive_month_amount : 0 };
}

// ── Quality payments ───────────────────────────────────────────────────────

/** 'YYYY-MM' */
export type MonthKey = string;

export function monthKey(d: { year: number; month: number }): MonthKey {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}`;
}

export function parseMonthKey(key: MonthKey): { year: number; month: number } {
  const [y, m] = key.split('-').map((x) => parseInt(x, 10));
  return { year: y, month: m };
}

export function addMonths(key: MonthKey, n: number): MonthKey {
  const { year, month } = parseMonthKey(key);
  const idx = year * 12 + (month - 1) + n;
  return monthKey({ year: Math.floor(idx / 12), month: (idx % 12 + 12) % 12 + 1 });
}

/** "January 2027" / "Jan 2027" — month names in the given locale (en-GB by default). */
export function formatMonth(key: MonthKey, style: 'long' | 'short' = 'long', locale = 'en-GB'): string {
  const { year, month } = parseMonthKey(key);
  return new Date(Date.UTC(year, month - 1, 15)).toLocaleDateString(locale, {
    month: style, year: 'numeric', timeZone: 'UTC',
  });
}

/** Supporters who reach their 3rd direct debit: floor(sign-ups × rate / 100). */
export function qualifyingSupporters(signUps: number, ratePct: number): number {
  // The epsilon keeps 7 × 70 / 100 = 4.8999… style float noise from dropping one.
  return Math.floor((toCount(signUps) * toPct(ratePct)) / 100 + 1e-9);
}

export type QualityMonth = {
  signUpMonth: MonthKey;
  signUps: number;
  qualifying: number;
  meetsGate: boolean;
  payment: number;
  paidMonth: MonthKey;
};

export function qualityMonth(signUpMonth: MonthKey, signUps: number, ratePct: number, fees: VertexFees = DEFAULT_FEES): QualityMonth {
  const n = toCount(signUps);
  const qualifying = qualifyingSupporters(n, ratePct);
  const meetsGate = toPct(ratePct) >= fees.quality_gate_pct;
  return {
    signUpMonth,
    signUps: n,
    qualifying,
    meetsGate,
    payment: meetsGate ? qualifying * fees.quality_payment : 0,
    paidMonth: addMonths(signUpMonth, fees.quality_lag_months),
  };
}

/** `months` consecutive sign-up months from `startMonth`, one rate for all (the hub's projection). */
export function qualityProjection(
  startMonth: MonthKey,
  signUpsByMonth: number[],
  ratePct: number,
  fees: VertexFees = DEFAULT_FEES,
  months = 12,
): { rows: QualityMonth[]; total: number } {
  const rows = Array.from({ length: months }, (_, i) =>
    qualityMonth(addMonths(startMonth, i), signUpsByMonth[i] ?? 0, ratePct, fees));
  return { rows, total: rows.reduce((s, r) => s + r.payment, 0) };
}
