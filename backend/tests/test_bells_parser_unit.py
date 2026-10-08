"""WhatsApp Bells paste — Vertex meaning of the emoji report.

🥇 = one £15+ sign-up (Target/Premium) → Bells `over30`
🥈 = one £12 sign-up (Standard)        → Bells `under30`
⭕️ = ignored (Vertex has no memberships) — never counted, never written.

Pure in-memory: mongomock_motor, no network, no real Mongo.
"""
import asyncio
import sys
from pathlib import Path

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import core.sales_path as sales_path  # noqa: E402
from routes import bells_parser as bp  # noqa: E402

REPORT = """Mason 6
🥇
🥈
🥇⭕️
🥇⭕️
🥈
🥇

Rosa - 2
🥈⭕️
🥇

Owen 0
"""


def test_gold_is_15_plus_silver_is_12_and_circles_are_ignored():
    reps = {r.raw_name: r for r in bp.deterministic_parse(REPORT)}
    mason = reps["Mason"]
    assert (mason.over30, mason.under30, mason.sales_count) == (4, 2, 6)
    assert mason.memberships == 0
    rosa = reps["Rosa"]
    assert (rosa.over30, rosa.under30, rosa.sales_count) == (1, 1, 2)
    assert rosa.memberships == 0
    assert reps["Owen"].sales_count == 0


def test_a_circle_alone_is_not_a_sign_up():
    reps = bp.deterministic_parse("Tess 1\n⭕️\n🥈")
    assert reps[0].under30 == 1 and reps[0].over30 == 0 and reps[0].sales_count == 1


def test_count_after_the_name_is_ignored_emojis_win():
    reps = bp.deterministic_parse("August -9\n🥇\n🥇")
    assert reps[0].raw_name == "August"
    assert reps[0].over30 == 2 and reps[0].sales_count == 2


def _run(coro):
    return asyncio.run(coro)


class _Req:
    headers: dict = {}


def _patch(monkeypatch):
    db = AsyncMongoMockClient()["vertex_parser_test"]
    admin = {"id": "admin-1", "role": "admin", "office_id": "off-ldn"}

    async def _user(_request):
        return admin

    async def _office(_request, _user, office):
        return office

    async def _noop(*_a, **_k):
        return None

    monkeypatch.setattr(bp, "db", db)
    monkeypatch.setattr(bp, "get_current_user", _user)
    monkeypatch.setattr(bp, "resolve_office_id", _office)
    monkeypatch.setattr(bp, "award_sales_milestones", _noop)
    monkeypatch.setattr(sales_path, "recompute_sales_path", _noop)
    return db


def test_apply_writes_the_tiers_and_keeps_a_legacy_membership_value(monkeypatch):
    db = _patch(monkeypatch)
    uid = ObjectId()
    _run(db.users.insert_one({"_id": uid, "name": "Mason Reed", "office_id": "off-ldn"}))
    # 2026-09-30 is a Wednesday → week ending Sun 2026-10-04, day index 2.
    legacy_days = [{"over30": None, "under30": None, "memberships": None, "status": "off"} for _ in range(7)]
    legacy_days[2] = {"over30": 1, "under30": 0, "memberships": 1, "status": "in"}
    _run(db.bells_entries.insert_one({
        "id": "row-1", "office_id": "off-ldn", "user_id": str(uid), "user_name": "Mason Reed",
        "week_ending": "2026-10-04", "days": legacy_days,
    }))
    req = bp.ApplyRequest(date="2026-09-30", office_id="off-ldn", reps=[
        bp.ApplyRep(user_id=str(uid), user_name="Mason Reed", over30=4, under30=2, memberships=3),
    ])
    out = _run(bp.apply_bulk(req, _Req()))
    assert out["upserted"] == 1
    row = _run(db.bells_entries.find_one({"id": "row-1"}))
    day = row["days"][2]
    assert day["over30"] == 4 and day["under30"] == 2 and day["status"] == "in"
    # The paste can't write memberships; the stored legacy value is left alone.
    assert day["memberships"] == 1


def test_apply_creates_a_row_without_memberships_and_a_circle_only_day_stays_off(monkeypatch):
    db = _patch(monkeypatch)
    uid = ObjectId()
    _run(db.users.insert_one({"_id": uid, "name": "Rosa Cole", "office_id": "off-ldn"}))
    req = bp.ApplyRequest(date="2026-09-29", office_id="off-ldn", reps=[
        bp.ApplyRep(user_id=str(uid), user_name="Rosa Cole", over30=0, under30=0, memberships=2),
    ])
    _run(bp.apply_bulk(req, _Req()))
    row = _run(db.bells_entries.find_one({"user_id": str(uid)}))
    day = row["days"][1]
    assert day["memberships"] is None
    assert day["status"] == "off"   # a membership alone is not a working sign-up day
