"""Morning bells read-out unit tests (routes/weekly_planners.py).

GET /weekly-planners/bells-readout:
  • Admin-only, scoped to the admin's own office.
  • Reads yesterday's bells: trainees need 2+ sales, everyone else 3+,
    sorted ascending (2s first, then 3s, 4s…).
  • Monday (day=0) reads LAST week's Saturday — plus any Sunday sale,
    even a single one, in a separate list.
  • Thursday (day=3) adds the top-5 high rollers from Mon–Wed of the
    current week.
  • Sales are over30 + under30. MEMBERSHIPS ARE NOT SALES — see
    test_memberships_are_never_sales, which is the regression guard for the
    2026-08-25 → 2026-09-14 bug.

Pure in-memory: mongomock_motor, no network, no real Mongo.
"""
import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import weekly_planners  # noqa: E402


def _db():
    return AsyncMongoMockClient()["cg1_bells_readout_test"]


def _run(coro):
    return asyncio.run(coro)


ADMIN = {"id": "u-admin", "name": "Ada", "role": "admin", "office_id": "office-A"}
LEADER = {"id": "u-leader", "name": "Lena", "role": "leader", "office_id": "office-A"}

WEEK = "2026-08-30"        # Sunday
PREV_WEEK = "2026-08-23"


def _days(sales_by_idx: dict, mems_by_idx: dict | None = None) -> list:
    """Seven bells days. `mems_by_idx` exists so a test can put a membership on
    a day — the old fixture hard-coded memberships to 0 on every day, so the
    read-out's membership double-count was unreachable by this entire suite
    and shipped unnoticed. Any new day-total test should set it."""
    mems = mems_by_idx or {}
    out = []
    for i in range(7):
        out.append({
            "over30": sales_by_idx.get(i, 0),
            "under30": 0,
            "memberships": mems.get(i, 0),
            "status": "in",
        })
    return out


def _seed(db, name, role, week, sales_by_idx, office_id="office-A", mems_by_idx=None):
    _run(db.bells_entries.insert_one({
        "office_id": office_id, "week_ending": week, "user_name": name,
        "role": role, "days": _days(sales_by_idx, mems_by_idx),
    }))


def _patch(monkeypatch, db, caller):
    async def _user(_request):
        return dict(caller)
    monkeypatch.setattr(weekly_planners, "get_current_user", _user)
    monkeypatch.setattr(weekly_planners, "db", db)


def test_thresholds_and_ascending_order(monkeypatch):
    db = _db()
    _seed(db, "Tia Trainee", "trainee", WEEK, {0: 2})     # in (2 ≥ 2)
    _seed(db, "Tom Trainee", "trainee", WEEK, {0: 1})     # out (1 < 2)
    _seed(db, "Lou Leader", "leader", WEEK, {0: 2})       # out (2 < 3)
    _seed(db, "Len Leader", "leader", WEEK, {0: 3})       # in
    _seed(db, "Abe Admin", "admin", WEEK, {0: 4})         # in
    _seed(db, "Far Away", "leader", WEEK, {0: 9}, office_id="office-B")  # other office
    _patch(monkeypatch, db, ADMIN)

    out = _run(weekly_planners.bells_readout(None, week=WEEK, day=1))  # Tuesday reads Monday
    assert out["source_date"] == "2026-08-24"
    assert [(r["name"], r["sales"]) for r in out["readout"]] == [
        ("Tia Trainee", 2), ("Len Leader", 3), ("Abe Admin", 4),
    ]
    assert "sunday" not in out and "top5" not in out


def test_monday_reads_last_saturday_plus_any_sunday_sale(monkeypatch):
    db = _db()
    _seed(db, "Sat Star", "leader", PREV_WEEK, {5: 3})            # Saturday qualifier
    _seed(db, "Sat Short", "leader", PREV_WEEK, {5: 2})           # below Saturday threshold
    _seed(db, "Sun Solo", "trainee", PREV_WEEK, {6: 1})           # ANY Sunday sale counts
    _seed(db, "This Week", "leader", WEEK, {0: 5})                # current week — not Monday's source
    _patch(monkeypatch, db, ADMIN)

    out = _run(weekly_planners.bells_readout(None, week=WEEK, day=0))
    assert out["source_date"] == "2026-08-22"                      # last Saturday
    assert [r["name"] for r in out["readout"]] == ["Sat Star"]
    assert out["sunday_date"] == "2026-08-23"
    assert [(r["name"], r["sales"]) for r in out["sunday"]] == [("Sun Solo", 1)]


def test_thursday_adds_top5_week_so_far(monkeypatch):
    db = _db()
    # Six sellers Mon–Wed — only the top five make the halfway review.
    for i, (name, spread) in enumerate([
        ("A Big", {0: 4, 1: 4, 2: 4}),   # 12
        ("B Mid", {0: 3, 1: 3}),         # 6
        ("C Mid", {0: 2, 1: 2, 2: 1}),   # 5
        ("D Low", {0: 1, 1: 1, 2: 1}),   # 3
        ("E Low", {0: 2}),               # 2
        ("F Out", {0: 1}),               # 1 — sixth, cut
    ]):
        _seed(db, name, "leader", WEEK, spread)
    # Thursday+ sales must NOT count toward the halfway review.
    _seed(db, "Late Larry", "leader", WEEK, {3: 9, 4: 9})
    _patch(monkeypatch, db, ADMIN)

    out = _run(weekly_planners.bells_readout(None, week=WEEK, day=3))
    assert [r["name"] for r in out["top5"]] == ["A Big", "B Mid", "C Mid", "D Low", "E Low"]
    assert out["top5"][0]["sales"] == 12
    # Wednesday's ordinary read-out still rides along (Wed = idx 2).
    assert {r["name"] for r in out["readout"]} == {"A Big"}


def test_memberships_are_never_sales(monkeypatch):
    """A membership is an add-on, not a sale (core/sales_path.py says so).

    Reproduces the real Boston read-out for Saturday 12 Sep 2026, when this
    endpoint added memberships into the sales figure. Three leaders sitting on
    2 real sales were read out as 3 or 4 and a fourth was read out as 6 on 3
    sales. The count was wrong AND the threshold is applied to that count, so
    it changed WHO appeared — the part that actually cost something.
    """
    db = _db()
    # name, sales Monday, memberships Monday  — the live numbers.
    _seed(db, "Ash", "leader", WEEK, {0: 2}, mems_by_idx={0: 1})   # showed 3
    _seed(db, "Bea", "leader", WEEK, {0: 2}, mems_by_idx={0: 1})  # showed 3
    _seed(db, "Cal", "leader", WEEK, {0: 2}, mems_by_idx={0: 2})   # showed 4
    _seed(db, "Dev", "leader", WEEK, {0: 3}, mems_by_idx={0: 3})   # showed 6
    _patch(monkeypatch, db, ADMIN)

    out = _run(weekly_planners.bells_readout(None, week=WEEK, day=1))
    # Only Dev cleared the leader threshold of 3, and at 3 — not 6.
    assert [(r["name"], r["sales"]) for r in out["readout"]] == [("Dev", 3)]


def test_memberships_excluded_from_sunday_and_top5(monkeypatch):
    """The Sunday ride-along and the Thursday top-5 read the same day-total
    helper, so they inherited the same inflation. Both are covered here."""
    db = _db()
    # Sunday: a membership alone is not a sale, so this rep must not appear.
    _seed(db, "Mem Only", "trainee", PREV_WEEK, {}, mems_by_idx={6: 2})
    _seed(db, "Real Sun", "trainee", PREV_WEEK, {6: 1}, mems_by_idx={6: 3})
    _patch(monkeypatch, db, ADMIN)
    out = _run(weekly_planners.bells_readout(None, week=WEEK, day=0))
    assert [(r["name"], r["sales"]) for r in out["sunday"]] == [("Real Sun", 1)]

    # Thursday top-5: the weekly total must exclude memberships too.
    db2 = _db()
    _seed(db2, "Seller", "leader", WEEK, {0: 2, 1: 2, 2: 2}, mems_by_idx={0: 5, 1: 5, 2: 5})
    _patch(monkeypatch, db2, ADMIN)
    out2 = _run(weekly_planners.bells_readout(None, week=WEEK, day=3))
    assert out2["top5"][0]["sales"] == 6          # 6 sales, not 21


def test_admin_only(monkeypatch):
    db = _db()
    _patch(monkeypatch, db, LEADER)
    with pytest.raises(HTTPException) as exc:
        _run(weekly_planners.bells_readout(None, week=WEEK, day=1))
    assert exc.value.status_code == 403
