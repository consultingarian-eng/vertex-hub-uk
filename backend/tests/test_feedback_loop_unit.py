"""Trainee feedback loop (IMPROVEMENT-PACK 3.3 / 4.5) unit tests.

Covers the three backend pieces that close the loop:
  • POST /daily-assessments/{id}/pass-off grew a trainee-OWNER path that sets
    acknowledged/acknowledged_at only — the leader pass-off semantics
    (passed_off/by/at + forced completed) must stay byte-identical.
  • GET /assessment/{id} now surfaces prev_day_focus (+ prev_day_acknowledged)
    so the grader opens day N seeing yesterday's "focus for tomorrow".
  • GET /stage-status/me reports stage_1_days_completed — the ACTUAL Stage-2
    gate — so the UI counter can stop rendering the always-0 passed-off list.
  • /leader/today grading rows carry acknowledged_yesterday (batched, no
    extra queries).

Pure in-memory: mongomock_motor, no network, no real Mongo.
"""
import asyncio
import sys
from pathlib import Path

import pytest
from bson import ObjectId
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import modules, training_routes, leader_today  # noqa: E402
from routes.modules import PassOffBody  # noqa: E402


def _db():
    return AsyncMongoMockClient()["cg1_feedback_loop_test"]


def _run(coro):
    return asyncio.run(coro)


HIRE_ID = "hire-1"
OTHER_HIRE_ID = "hire-2"

TRAINEE = {"id": "u-trainee", "name": "Terry", "role": "trainee",
           "office_id": "office-A", "new_hire_id": HIRE_ID}
LEADER = {"id": "u-leader", "name": "Lena", "role": "leader", "office_id": "office-A"}


def _patch_modules(monkeypatch, db, user):
    async def _user(_request):
        return dict(user)

    async def _award(*_a, **_k):
        return None

    monkeypatch.setattr(modules, "db", db)
    monkeypatch.setattr(modules, "get_current_user", _user)
    monkeypatch.setattr(modules, "award_stage1_milestones", _award)


def _patch_can_access(monkeypatch, allowed=True):
    async def _can(_user, _hire_id):
        return allowed
    # pass_off_daily does `from auth import can_access_hire` at call time.
    import auth
    monkeypatch.setattr(auth, "can_access_hire", _can)


# ── Trainee-owner acknowledgement path ────────────────────────────────────

def test_trainee_acknowledges_own_graded_day(monkeypatch):
    db = _db()
    _run(db.daily_assessments.insert_one({
        "id": "a1", "new_hire_id": HIRE_ID, "day_number": 3,
        "completed": True, "status": "Green",
    }))
    _patch_modules(monkeypatch, db, TRAINEE)

    out = _run(modules.pass_off_daily("a1", PassOffBody(), request=None))
    assert out == {"ok": True, "acknowledged": True}

    a = _run(db.daily_assessments.find_one({"id": "a1"}))
    assert a["acknowledged"] is True
    assert a["acknowledged_at"]
    # Leader-only fields untouched: acknowledgement never masquerades as a
    # pass-off, and completed/status stay whatever grading set them to.
    assert "passed_off" not in a
    assert "passed_off_by_id" not in a
    assert a["completed"] is True
    assert a["status"] == "Green"


def test_trainee_via_hire_link_can_acknowledge(monkeypatch):
    """Ownership also resolves through new_hires.trainee_user_id for accounts
    missing the user→hire link."""
    db = _db()
    _run(db.daily_assessments.insert_one({
        "id": "a1", "new_hire_id": HIRE_ID, "day_number": 2, "completed": True,
    }))
    _run(db.new_hires.insert_one({"id": HIRE_ID, "trainee_user_id": "u-unlinked"}))
    user = {"id": "u-unlinked", "role": "trainee", "office_id": "office-A"}
    _patch_modules(monkeypatch, db, user)

    out = _run(modules.pass_off_daily("a1", PassOffBody(), request=None))
    assert out["acknowledged"] is True


def test_trainee_cannot_acknowledge_someone_elses_day(monkeypatch):
    db = _db()
    _run(db.daily_assessments.insert_one({
        "id": "a2", "new_hire_id": OTHER_HIRE_ID, "day_number": 3, "completed": True,
    }))
    _run(db.new_hires.insert_one({"id": OTHER_HIRE_ID, "trainee_user_id": "u-somebody-else"}))
    _patch_modules(monkeypatch, db, TRAINEE)

    with pytest.raises(HTTPException) as exc:
        _run(modules.pass_off_daily("a2", PassOffBody(), request=None))
    assert exc.value.status_code == 403
    a = _run(db.daily_assessments.find_one({"id": "a2"}))
    assert "acknowledged" not in a


def test_trainee_cannot_acknowledge_ungraded_day(monkeypatch):
    db = _db()
    _run(db.daily_assessments.insert_one({
        "id": "a3", "new_hire_id": HIRE_ID, "day_number": 4, "completed": False,
    }))
    _patch_modules(monkeypatch, db, TRAINEE)

    with pytest.raises(HTTPException) as exc:
        _run(modules.pass_off_daily("a3", PassOffBody(), request=None))
    assert exc.value.status_code == 400
    a = _run(db.daily_assessments.find_one({"id": "a3"}))
    assert "acknowledged" not in a
    assert a["completed"] is False  # trainee path must never force-complete


def test_leader_pass_off_path_unchanged(monkeypatch):
    db = _db()
    _run(db.daily_assessments.insert_one({
        "id": "a4", "new_hire_id": HIRE_ID, "day_number": 5, "completed": False,
    }))
    _patch_modules(monkeypatch, db, LEADER)
    _patch_can_access(monkeypatch, allowed=True)

    out = _run(modules.pass_off_daily("a4", PassOffBody(note="solid day"), request=None))
    assert out == {"ok": True, "passed_off": True}

    a = _run(db.daily_assessments.find_one({"id": "a4"}))
    assert a["passed_off"] is True
    assert a["passed_off_by_id"] == LEADER["id"]
    assert a["passed_off_note"] == "solid day"
    assert a["completed"] is True  # pass-off still forces completion
    assert "acknowledged" not in a  # leader path never fakes a trainee ack


# ── prev_day_focus in the grader GET ──────────────────────────────────────

def _patch_training(monkeypatch, db, user, allowed=True):
    async def _user(_request):
        return dict(user)

    async def _can(_user, _hire_id):
        return allowed

    monkeypatch.setattr(training_routes, "db", db)
    monkeypatch.setattr(training_routes, "get_current_user", _user)
    monkeypatch.setattr(training_routes, "can_access_hire", _can)


def _asmt(aid, day, **extra):
    return {"id": aid, "new_hire_id": HIRE_ID, "new_hire_name": "Terry",
            "day_number": day, **extra}


def test_prev_day_focus_surfaces_on_grader_get(monkeypatch):
    db = _db()
    _run(db.daily_assessments.insert_one(
        _asmt("d3", 3, completed=True, focus_tomorrow="Slow the close down")))
    _run(db.daily_assessments.insert_one(_asmt("d4", 4)))
    _patch_training(monkeypatch, db, LEADER)

    out = _run(training_routes.get_assessment("d4", request=None))
    assert out["prev_day_focus"] == "Slow the close down"
    assert out["prev_day_acknowledged"] is False
    # Extras the strict model used to swallow are present on the row itself
    assert out["passed_off"] is False
    assert out["acknowledged"] is False


def test_prev_day_focus_none_when_prev_ungraded_or_day1(monkeypatch):
    db = _db()
    # Day 1 — no previous day at all
    _run(db.daily_assessments.insert_one(_asmt("d1", 1)))
    # Day 2 whose day-1 exists but is NOT completed → focus not surfaced
    _run(db.daily_assessments.insert_one(
        _asmt("d2", 2)))
    _patch_training(monkeypatch, db, LEADER)

    out1 = _run(training_routes.get_assessment("d1", request=None))
    assert out1["prev_day_focus"] is None
    assert out1["prev_day_acknowledged"] is None

    out2 = _run(training_routes.get_assessment("d2", request=None))
    assert out2["prev_day_focus"] is None
    assert out2["prev_day_acknowledged"] is None


def test_prev_day_acknowledged_via_ack_or_passoff(monkeypatch):
    db = _db()
    _run(db.daily_assessments.insert_one(
        _asmt("d5", 5, completed=True, focus_tomorrow="Door pace", acknowledged=True)))
    _run(db.daily_assessments.insert_one(_asmt("d6", 6)))
    _run(db.daily_assessments.insert_one(
        _asmt("d6b", 7)))
    _patch_training(monkeypatch, db, LEADER)

    out = _run(training_routes.get_assessment("d6", request=None))
    assert out["prev_day_acknowledged"] is True

    # A leader pass-off counts as acknowledged too (UI treats either)
    _run(db.daily_assessments.update_one(
        {"id": "d6"}, {"$set": {"completed": True, "passed_off": True}}))
    out2 = _run(training_routes.get_assessment("d6b", request=None))
    assert out2["prev_day_acknowledged"] is True


# ── stage-status completed-days count ─────────────────────────────────────

def test_stage_status_reports_completed_days(monkeypatch):
    db = _db()
    for day, completed in [(1, True), (2, True), (3, False), (4, True)]:
        _run(db.daily_assessments.insert_one({
            "id": f"s{day}", "new_hire_id": HIRE_ID, "day_number": day,
            "completed": completed,
        }))
    _patch_modules(monkeypatch, db, TRAINEE)

    out = _run(modules.my_stage_status(request=None))
    assert out["stage_1_days_submitted"] == [1, 2, 3, 4]
    assert out["stage_1_days_completed"] == [1, 2, 4]
    assert out["stage_1_days_passed_off"] == []
    assert out["stage_2_unlocked"] is False  # gate is all 8 completed


# ── /leader/today acknowledged_yesterday ──────────────────────────────────

def test_leader_today_rows_carry_acknowledged_yesterday(monkeypatch):
    db = _db()
    admin = {"id": "u-admin", "name": "Ada", "role": "admin", "office_id": "office-A"}
    uid_a, uid_b, uid_c = ObjectId(), ObjectId(), ObjectId()
    _run(db.users.insert_many([
        {"_id": uid_a, "name": "Amy", "role": "trainee", "office_id": "office-A"},
        {"_id": uid_b, "name": "Ben", "role": "trainee", "office_id": "office-A"},
        {"_id": uid_c, "name": "Cal", "role": "trainee", "office_id": "office-A"},
    ]))
    _run(db.new_hires.insert_many([
        {"id": "hA", "name": "Amy", "active": True, "office_id": "office-A",
         "current_day": 2, "trainee_user_id": str(uid_a), "leader": "Ada"},
        {"id": "hB", "name": "Ben", "active": True, "office_id": "office-A",
         "current_day": 2, "trainee_user_id": str(uid_b), "leader": "Ada"},
        {"id": "hC", "name": "Cal", "active": True, "office_id": "office-A",
         "current_day": 1, "trainee_user_id": str(uid_c), "leader": "Ada"},
    ]))
    _run(db.daily_assessments.insert_many([
        # Amy read her graded day 1; day 2 awaits grading
        {"id": "aA1", "new_hire_id": "hA", "day_number": 1, "completed": True,
         "acknowledged": True},
        {"id": "aA2", "new_hire_id": "hA", "day_number": 2, "completed": False},
        # Ben's day 1 is graded but unread
        {"id": "aB1", "new_hire_id": "hB", "day_number": 1, "completed": True},
        {"id": "aB2", "new_hire_id": "hB", "day_number": 2, "completed": False},
        # Cal has nothing graded yet → flag not applicable
        {"id": "aC1", "new_hire_id": "hC", "day_number": 1, "completed": False},
    ]))

    async def _user(_request):
        return dict(admin)

    monkeypatch.setattr(leader_today, "db", db)
    monkeypatch.setattr(leader_today, "require_admin_or_leader", _user)

    out = _run(leader_today.leader_today(request=None))
    by_hire = {g["hire_id"]: g for g in out["grading"]}
    assert by_hire["hA"]["acknowledged_yesterday"] is True
    assert by_hire["hB"]["acknowledged_yesterday"] is False
    assert by_hire["hC"]["acknowledged_yesterday"] is None


# ── /leader/today new_starts (Home "Vertex New Starts") ───────────────────

def test_leader_today_lists_every_new_start_with_cod_progress(monkeypatch):
    db = _db()
    admin = {"id": "u-admin", "name": "Ada", "role": "admin", "office_id": "office-A"}
    uid_a, uid_b = ObjectId(), ObjectId()
    _run(db.users.insert_many([
        {"_id": uid_a, "name": "Amy", "role": "trainee", "office_id": "office-A"},
        {"_id": uid_b, "name": "Ben", "role": "trainee", "office_id": "office-A"},
    ]))
    _run(db.new_hires.insert_many([
        {"id": "hA", "name": "Amy", "active": True, "office_id": "office-A",
         "current_day": 3, "trainee_user_id": str(uid_a), "leader": "Ada"},
        {"id": "hB", "name": "Ben", "active": True, "office_id": "office-A",
         "current_day": 1, "trainee_user_id": str(uid_b), "leader": "Ada"},
    ]))
    _run(db.daily_assessments.insert_many([
        {"id": "aA1", "new_hire_id": "hA", "day_number": 1, "completed": True},
        {"id": "aA2", "new_hire_id": "hA", "day_number": 2, "completed": True},
        {"id": "aA3", "new_hire_id": "hA", "day_number": 3, "completed": False},
        {"id": "aB1", "new_hire_id": "hB", "day_number": 1, "completed": True},
    ]))
    _run(db.training_modules.insert_many([
        {"id": "m1", "stage": 1, "office_id": "office-A"},
        {"id": "m2", "stage": 1, "office_id": "office-A"},
        {"id": "m3", "stage": 1, "office_id": "office-A", "retired": True},
        {"id": "m4", "stage": 2, "office_id": None},      # shared default set
    ]))
    _run(db.module_progress.insert_many([
        {"module_id": "m1", "stage": 1, "target_user_id": str(uid_a), "passed_off": True},
        {"module_id": "m2", "stage": 1, "target_user_id": str(uid_a), "passed_off": False},
        {"module_id": "m4", "stage": 2, "user_id": str(uid_a), "passed_off": True},
    ]))

    async def _user(_request):
        return dict(admin)

    monkeypatch.setattr(leader_today, "db", db)
    monkeypatch.setattr(leader_today, "require_admin_or_leader", _user)

    out = _run(leader_today.leader_today(request=None))
    rows = out["new_starts"]
    assert [r["name"] for r in rows] == ["Ben", "Amy"]          # newest starter first
    amy = rows[1]
    assert amy["days_done"] == 2 and amy["next_assessment_id"] == "aA3" and amy["next_day"] == 3
    assert amy["cod1"] == {"done": 1, "total": 2}                # retired module not counted
    assert amy["cod2"] == {"done": 1, "total": 1}                # falls back to the shared set
    ben = rows[0]
    assert ben["next_assessment_id"] is None and ben["cod1"] == {"done": 0, "total": 2}
