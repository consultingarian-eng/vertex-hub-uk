"""/owneriq/summary team_of — the planner's Team tab is the PLAN OWNER's crew.

The summary is scoped to the CALLER (super admin → everything, admin →
office, leader → subtree). The weekly planner's LOA review passes
team_of=<plan owner> so the Team tab shows that person's crew regardless of
who is looking: a leader target narrows to their reports subtree, an admin
target narrows to their office (an admin's crew IS the office). team_of only
ever narrows the caller-scoped rows — it can never widen access.

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

from routes import owneriq  # noqa: E402

LEADER_ID = str(ObjectId())
REP_A = str(ObjectId())      # in leader's subtree
REP_B = str(ObjectId())      # other team, same office
ADMIN_ID = str(ObjectId())   # Boston admin
SUPER = {"id": "u-super", "role": "admin", "office_id": "off-bos", "is_super_admin": True}

FROM, TO = "2026-08-24", "2026-08-29"


def _db():
    return AsyncMongoMockClient()["cg1_owneriq_test"]


def _run(coro):
    return asyncio.run(coro)


def _kpi(db, uid, badge, sales, pin="4005"):
    _run(db.owneriq_kpis.insert_one({
        "date": FROM, "badge_number": badge, "rep_name": badge,
        "cg1_user_id": uid, "mc_pin": pin,
        "doors_knocked": 100, "spoken_to": 50, "pitches_commenced": 20,
        "pitches_closed": 10, "sales": sales,
    }))


def _patch(monkeypatch, db):
    async def _caller(_request):
        return dict(SUPER)

    async def _subtree(uid):
        return [LEADER_ID, REP_A] if uid == LEADER_ID else [uid]

    monkeypatch.setattr(owneriq, "db", db)
    monkeypatch.setattr(owneriq, "get_current_user", _caller)
    monkeypatch.setattr(owneriq, "get_subtree_ids", _subtree)
    _run(db.users.insert_one({"_id": ObjectId(LEADER_ID), "role": "leader", "office_id": "off-bos"}))
    _run(db.users.insert_one({"_id": ObjectId(ADMIN_ID), "role": "admin", "office_id": "off-bos"}))
    # The office is mapped to its OwnerIQ company explicitly (owneriq_config).
    _run(db.offices.insert_one({"id": "off-bos", "name": "Boston", "owneriq_pin": "4005"}))
    _kpi(db, LEADER_ID, "B-LEAD", 3)
    _kpi(db, REP_A, "B-A", 2)
    _kpi(db, REP_B, "B-B", 7)                 # same office, different team
    _kpi(db, None, "B-UNLINKED", 5, pin="4006")  # New Haven, unlinked


def test_team_of_leader_narrows_to_their_subtree(monkeypatch):
    db = _db()
    _patch(monkeypatch, db)
    out = _run(owneriq.owneriq_summary(None, from_date=FROM, to_date=TO, team_of=LEADER_ID))
    keys = {r["badge_number"] for r in out["reps"]}
    assert keys == {"B-LEAD", "B-A"}          # not B-B (other team), not New Haven
    assert out["group_totals"]["sales"] == 5  # 3 + 2


def test_team_of_admin_narrows_to_their_office(monkeypatch):
    db = _db()
    _patch(monkeypatch, db)
    out = _run(owneriq.owneriq_summary(None, from_date=FROM, to_date=TO, team_of=ADMIN_ID))
    keys = {r["badge_number"] for r in out["reps"]}
    assert keys == {"B-LEAD", "B-A", "B-B"}   # whole Boston office, incl. unlinked teams
    assert out["group_totals"]["sales"] == 12


def test_without_team_of_super_admin_still_sees_everything(monkeypatch):
    db = _db()
    _patch(monkeypatch, db)
    out = _run(owneriq.owneriq_summary(None, from_date=FROM, to_date=TO))
    assert {r["badge_number"] for r in out["reps"]} == {"B-LEAD", "B-A", "B-B", "B-UNLINKED"}
