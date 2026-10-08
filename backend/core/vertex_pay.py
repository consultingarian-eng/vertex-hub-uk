"""Vertex pay rules — the one place the fee schedule's shape and defaults live.

A Brand Ambassador (BA) is paid per sign-up, by the donor's monthly gift:

    £12 Standard sign-up         → fee_standard  (default £55)
    £15 Target sign-up           → fee_target    (default £60)
    £20 Premium sign-up          → fee_premium   (default £60)

plus `third_dd_bonus` (£15) for every confirmed 3rd direct debit, minus
`leadership_deduction` (£5) per sign-up that week when a leader's call
completion rate is below `leadership_threshold_pct` (70 %). Quality payments
(`quality_payment`, £15 per supporter reaching their 3rd direct debit) are paid
`quality_lag_months` (4) after the sign-up month, only in a month whose
quality rate is at least `quality_gate_pct` (70 %).

Extra incentives (the Earnings Calculator works these out; Bells does not):
a week of `incentive_week_signups` (12) or more sign-ups with an average donor
age of `incentive_min_age` (45) or more and a call completion rate of
`incentive_call_pct` (85 %) or more earns `incentive_week_amount` (£50); at
`incentive_week_top_signups` (16) or more it is `incentive_week_top_amount`
(£100) instead. A month of `incentive_month_signups` (50) or more sign-ups
with the same two quality gates earns `incentive_month_amount` (£100).

The office (the Marketing Company, MC) is paid its own fee for every sign-up:
`fee_mc` (default £30). It is the office's figure, not a BA's: Bells shows the
MC fees column to Admins only, and the rates endpoint leaves the knob out for
everyone else.

Bells records two tiers per day: `under30` = £12 Standard sign-ups and
`over30` = £15+ (Target or Premium) sign-ups — the field names are kept from
the original data model. Bells cannot tell a £15 from a £20 sign-up, so its
£15+ tier is paid at `fee_target`.

The per-office knobs are stored in the `commission_fees` collection (one doc
per office). Documents written by the old pay model (nested base/volume/...
tiers) are tolerated: any key that is not a valid Vertex knob is ignored and
the default is used instead. The frontend mirrors these formulas in
frontend/src/pay/vertexPay.ts — change both together.
"""
from __future__ import annotations

import math
from typing import Any, Optional

DEFAULT_FEES: dict[str, float] = {
    "fee_standard": 55,
    "fee_target": 60,
    "fee_premium": 60,
    "third_dd_bonus": 15,
    "leadership_threshold_pct": 70,
    "leadership_deduction": 5,
    "quality_gate_pct": 70,
    "quality_payment": 15,
    "quality_lag_months": 4,
    "incentive_min_age": 45,
    "incentive_call_pct": 85,
    "incentive_week_signups": 12,
    "incentive_week_amount": 50,
    "incentive_week_top_signups": 16,
    "incentive_week_top_amount": 100,
    "incentive_month_signups": 50,
    "incentive_month_amount": 100,
    "fee_mc": 30,
}

# Knobs only an Admin is shown (the office's own income, not a BA's).
ADMIN_ONLY_FEE_KEYS: tuple[str, ...] = ("fee_mc",)

FEE_KEYS: tuple[str, ...] = tuple(DEFAULT_FEES)

# Inclusive bounds per knob. Money is whole or part pounds, percentages are
# 0–100, the lag is whole months.
_BOUNDS: dict[str, tuple[float, float]] = {
    "fee_standard": (0, 1000),
    "fee_target": (0, 1000),
    "fee_premium": (0, 1000),
    "third_dd_bonus": (0, 1000),
    "leadership_threshold_pct": (0, 100),
    "leadership_deduction": (0, 1000),
    "quality_gate_pct": (0, 100),
    "quality_payment": (0, 1000),
    "quality_lag_months": (0, 24),
    "incentive_min_age": (0, 120),
    "incentive_call_pct": (0, 100),
    "incentive_week_signups": (0, 999),
    "incentive_week_amount": (0, 10000),
    "incentive_week_top_signups": (0, 999),
    "incentive_week_top_amount": (0, 10000),
    "incentive_month_signups": (0, 9999),
    "incentive_month_amount": (0, 10000),
    "fee_mc": (0, 1000),
}
_INT_KEYS = {"quality_lag_months", "incentive_week_signups", "incentive_week_top_signups", "incentive_month_signups"}


def _as_number(v: Any) -> Optional[float]:
    """A finite number, or None. Booleans and dicts (old nested tiers) are not numbers."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        f = float(v)
    elif isinstance(v, str) and v.strip():
        try:
            f = float(v.strip())
        except ValueError:
            return None
    else:
        return None
    return f if math.isfinite(f) else None


def _tidy(key: str, f: float) -> float | int:
    if key in _INT_KEYS:
        return int(round(f))
    return int(f) if float(f).is_integer() else round(f, 2)


def normalize_fees(doc: Optional[dict]) -> dict:
    """The office's Vertex knobs: stored values where valid, defaults elsewhere.

    Never raises — an old-shape or partly-filled document just falls back to
    the defaults for whatever it lacks."""
    out: dict = dict(DEFAULT_FEES)
    if not isinstance(doc, dict):
        return out
    for key in FEE_KEYS:
        f = _as_number(doc.get(key))
        if f is None:
            continue
        lo, hi = _BOUNDS[key]
        if lo <= f <= hi:
            out[key] = _tidy(key, f)
    return out


def clean_fee_update(body: Any) -> dict:
    """Validate an admin's fee edit. Unknown keys are dropped; a known key with
    a missing/invalid value raises ValueError (so the editor can say which)."""
    if not isinstance(body, dict):
        raise ValueError("Send the fees as a JSON object")
    out: dict = {}
    for key in FEE_KEYS:
        if key not in body:
            continue
        f = _as_number(body.get(key))
        lo, hi = _BOUNDS[key]
        if f is None or not (lo <= f <= hi):
            raise ValueError(f"{key} must be a number from {int(lo)} to {int(hi)}")
        out[key] = _tidy(key, f)
    return out


def mc_fees(sign_ups: float, fees: Optional[dict]) -> float:
    """The office's (MC's) fees for a number of sign-ups, at `fee_mc` each."""
    return round(max(0.0, float(sign_ups or 0)) * float(normalize_fees(fees)["fee_mc"]), 2)


def sign_up_fees(standard: float, target: float, fees: Optional[dict]) -> dict:
    """BA sign-up fees for a week of Bells: £12 sign-ups at fee_standard, £15+
    sign-ups at fee_target. Before the 3rd DD bonus and any leadership
    deduction (Bells records neither)."""
    f = normalize_fees(fees)
    standard = max(0.0, float(standard or 0))
    target = max(0.0, float(target or 0))
    standard_earnings = standard * float(f["fee_standard"])
    target_earnings = target * float(f["fee_target"])
    return {
        "fee_standard": f["fee_standard"],
        "fee_target": f["fee_target"],
        "standard_count": int(standard),
        "target_count": int(target),
        "standard_earnings": round(standard_earnings, 2),
        "target_earnings": round(target_earnings, 2),
        "sign_up_fees": round(standard_earnings + target_earnings, 2),
    }
