"""Vertex pay rules on the server: the fee knobs, Bells' sign-up fees, and
GET /bells/my-summary (the Pay tab's own-numbers feed).

Bells day fields keep their original names: `under30` = £12 Standard
sign-ups, `over30` = £15+ (Target/Premium) sign-ups, `memberships` = legacy,
never paid or counted.

Pure in-memory: mongomock_motor, no network, no real Mongo.
"""
import asyncio
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.app_time import APP_TZ  # noqa: E402
from core.vertex_pay import DEFAULT_FEES, clean_fee_update, normalize_fees, sign_up_fees  # noqa: E402
from routes import bells  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


def _day(over30=None, under30=None, memberships=None, status="in"):
    return {"over30": over30, "under30": under30, "memberships": memberships, "status": status}


def _week(*days):
    days = list(days) + [_day(status="off")] * 7
    return days[:7]


# ── core/vertex_pay ────────────────────────────────────────────────────────

def test_worked_example_three_standard_sign_ups_is_165():
    # The hub's own example: 3 × £12 Standard at £55 = £165.
    assert sign_up_fees(3, 0, None)["sign_up_fees"] == 165


def test_target_tier_uses_fee_target():
    out = sign_up_fees(2, 3, {"fee_standard": 55, "fee_target": 62})
    assert out["standard_earnings"] == 110
    assert out["target_earnings"] == 186
    assert out["sign_up_fees"] == 296
    assert out["standard_count"] == 2 and out["target_count"] == 3


def test_normalize_fills_defaults_and_ignores_legacy_shape():
    assert normalize_fees(None) == DEFAULT_FEES
    legacy = {"base": {"first": 35}, "volume_threshold": 12, "fee_standard": True}
    assert normalize_fees(legacy) == DEFAULT_FEES
    assert normalize_fees({"quality_lag_months": 3.6})["quality_lag_months"] == 4
    assert normalize_fees({"fee_standard": "57.5"})["fee_standard"] == 57.5


def test_clean_fee_update_drops_unknown_and_rejects_bad():
    assert clean_fee_update({"fee_target": 61, "office_name": "X"}) == {"fee_target": 61}
    with pytest.raises(ValueError):
        clean_fee_update({"quality_gate_pct": 150})
    with pytest.raises(ValueError):
        clean_fee_update(["fee_target", 61])


# ── compute_totals ─────────────────────────────────────────────────────────

def test_compute_totals_prices_the_two_tiers_and_ignores_memberships():
    entry = {"days": _week(_day(over30=1, under30=2, memberships=4), _day(under30=1))}
    t = bells.compute_totals(entry, None)
    assert t["total_sales"] == 4          # 1 × £15+ + 3 × £12 — memberships never count
    assert t["total_under30"] == 3 and t["total_over30"] == 1
    assert t["earnings"] == 3 * 55 + 60   # defaults when nothing is stored
    bd = t["earnings_breakdown"]
    assert bd["standard_earnings"] == 165 and bd["target_earnings"] == 60
    assert bd["sign_up_fees"] == t["earnings"]


def test_compute_totals_uses_the_office_knobs():
    entry = {"days": _week(_day(over30=2, under30=1))}
    t = bells.compute_totals(entry, {"office_id": "o", "fee_standard": 50, "fee_target": 65})
    assert t["earnings"] == 50 + 2 * 65


def test_compute_totals_tolerates_the_old_fee_document():
    entry = {"days": _week(_day(over30=1, under30=1))}
    old = {"base": {"first": 35, "second": 20, "fourth": 10}, "targets": {}, "base_commission": 25}
    assert bells.compute_totals(entry, old)["earnings"] == 115


# ── GET /bells/my-summary ──────────────────────────────────────────────────

class _Req:
    headers: dict = {}


@pytest.fixture
def summary_db(monkeypatch):
    db = AsyncMongoMockClient()["vertex_summary_test"]

    async def _user(_request):
        return {"id": "me", "role": "trainee", "office_id": "off-ldn"}

    monkeypatch.setattr(bells, "db", db)
    monkeypatch.setattr(bells, "get_current_user", _user)
    return db


def _this_sunday() -> date:
    today = datetime.now(APP_TZ).date()
    return today + timedelta(days=(6 - today.weekday()) % 7)


def test_my_summary_reads_only_my_row_for_this_week(summary_db):
    we = _this_sunday().isoformat()
    _run(summary_db.bells_entries.insert_many([
        {"id": "a", "office_id": "off-ldn", "user_id": "me", "week_ending": we,
         "days": _week(_day(over30=1, under30=2), _day(under30=1, memberships=3))},
        {"id": "b", "office_id": "off-ldn", "user_id": "someone-else", "week_ending": we,
         "days": _week(_day(over30=9, under30=9))},
    ]))
    _run(summary_db.commission_fees.insert_one({"office_id": "off-ldn", "fee_standard": 50}))
    out = _run(bells.my_bells_summary(_Req()))
    assert out["week_ending"] == we
    assert out["has_entry"] is True
    assert out["this_week"]["standard"] == 3
    assert out["this_week"]["target"] == 1
    assert out["this_week"]["sign_ups"] == 4
    assert out["this_week"]["earnings"] == 3 * 50 + 60
    assert out["fees"]["fee_standard"] == 50 and out["fees"]["fee_target"] == 60


def test_my_summary_with_no_row_is_zero(summary_db):
    out = _run(bells.my_bells_summary(_Req()))
    assert out["has_entry"] is False
    assert out["this_week"] == {"standard": 0, "target": 0, "sign_ups": 0, "days_worked": 0, "earnings": 0}
    assert len(out["months"]) == 6
    assert out["fees"] == DEFAULT_FEES


def test_my_summary_splits_a_week_across_two_months(summary_db, monkeypatch):
    """Week ending Sun 4 Oct 2026 runs Mon 28 Sep → Sun 4 Oct: sign-ups on the
    Mon–Wed count for September, Thu onwards for October."""
    class _FixedNow(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 20, 12, 0, tzinfo=tz)

    monkeypatch.setattr(bells, "datetime", _FixedNow)
    days = _week(
        _day(under30=1), _day(over30=1), _day(under30=2),   # Mon 28, Tue 29, Wed 30 Sep
        _day(under30=1), _day(over30=2),                     # Thu 1, Fri 2 Oct
    )
    _run(summary_db.bells_entries.insert_many([
        {"id": "a", "office_id": "off-ldn", "user_id": "me", "week_ending": "2026-10-04", "days": days},
        {"id": "b", "office_id": "off-ldn", "user_id": "me", "week_ending": "2026-09-13",
         "days": _week(_day(under30=5))},
        # Too old for a 3-month window — ignored.
        {"id": "c", "office_id": "off-ldn", "user_id": "me", "week_ending": "2026-06-07",
         "days": _week(_day(under30=7))},
    ]))
    out = _run(bells.my_bells_summary(_Req(), months=3))
    by_month = {m["month"]: m for m in out["months"]}
    assert list(by_month) == ["2026-08", "2026-09", "2026-10"]
    assert by_month["2026-09"]["sign_ups"] == 5 + 4
    assert by_month["2026-09"]["standard"] == 5 + 3 and by_month["2026-09"]["target"] == 1
    assert by_month["2026-10"]["sign_ups"] == 3
    assert by_month["2026-10"]["target"] == 2
    assert by_month["2026-08"]["sign_ups"] == 0
    assert by_month["2026-09"]["weeks"] == 2 and by_month["2026-10"]["weeks"] == 1


def test_extra_incentive_knobs_have_defaults_and_bounds():
    fees = normalize_fees({"incentive_week_signups": "14", "incentive_call_pct": 300})
    assert fees["incentive_week_signups"] == 14          # stored, whole number
    assert fees["incentive_call_pct"] == 85              # out of range → default
    assert fees["incentive_min_age"] == 45 and fees["incentive_week_amount"] == 50
    assert fees["incentive_week_top_signups"] == 16 and fees["incentive_week_top_amount"] == 100
    assert fees["incentive_month_signups"] == 50 and fees["incentive_month_amount"] == 100
    assert clean_fee_update({"incentive_month_amount": 150}) == {"incentive_month_amount": 150}


def test_mc_fee_is_a_knob_with_a_default_and_prices_every_sign_up_alike():
    from core.vertex_pay import ADMIN_ONLY_FEE_KEYS, DEFAULT_FEES, clean_fee_update, mc_fees, normalize_fees
    assert DEFAULT_FEES["fee_mc"] == 30 and "fee_mc" in ADMIN_ONLY_FEE_KEYS
    assert mc_fees(5, None) == 150                     # the office's sheet: 5 sign-ups → £150
    assert mc_fees(13, {"fee_mc": 32.5}) == 422.5
    assert mc_fees(None, None) == 0 and mc_fees(-3, None) == 0
    assert normalize_fees({"fee_mc": "40"})["fee_mc"] == 40
    assert normalize_fees({"fee_mc": 99999})["fee_mc"] == 30   # out of range → the default
    assert clean_fee_update({"fee_mc": 28}) == {"fee_mc": 28}
