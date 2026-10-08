"""core/goal_sync — one office sales goal, three mirrors.

Pins the rules the review hammered out:
  • _as_int reads the number OUT of free text ("220 sales" → 220) — a texty
    goal must never read as a destructive clear;
  • the week-less offices.weekly_goal is only written by the CURRENT week —
    planning next week can't clobber the live target;
  • bells-row mirrors honor bells' own future clamp;
  • goal_for_week finds the goal already on record for a week;
  • an admin who runs their own crew inside the office is left alone by
    both — their crew goal is one team's target, not the office's.

Pure in-memory: mongomock, no network.
"""

import asyncio
import sys
from datetime import datetime, timedelta
from pathlib import Path

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import goal_sync  # noqa: E402
from core.app_time import APP_TZ  # noqa: E402
from core.goal_sync import _as_int, sync_office_weekly_goal, goal_for_week  # noqa: E402

OFFICE = "office-boston"


def _run(coro):
    return asyncio.run(coro)


def _db():
    return AsyncMongoMockClient()["cg1_goal_sync_test"]


def _current_sunday() -> str:
    today = datetime.now(APP_TZ).date()
    return (today + timedelta(days=(6 - today.weekday()))).isoformat()


def _actor():
    return {"id": "actor-1", "name": "Owner", "role": "admin", "office_id": OFFICE}


def _seed_admin(db, name="Boss", reports_to=None):
    oid = ObjectId()
    _run(db.users.insert_one({
        "_id": oid, "name": name, "role": "admin", "office_id": OFFICE,
        "reports_to": reports_to,
    }))
    return str(oid)


# ── _as_int ──────────────────────────────────────────────────────────────

def test_as_int_reads_number_out_of_text():
    assert _as_int("220") == 220
    assert _as_int("220 sales") == 220
    assert _as_int("hit 220!") == 220
    assert _as_int("1,200") == 1200
    assert _as_int(16.5) == 16
    assert _as_int(220) == 220


def test_as_int_none_only_when_no_number():
    assert _as_int("") is None
    assert _as_int(None) is None
    assert _as_int("TBD") is None
    assert _as_int(0) is None


# ── office-doc guard ─────────────────────────────────────────────────────

def test_current_week_writes_office_doc(monkeypatch):
    db = _db()
    monkeypatch.setattr(goal_sync, "db", db)
    _run(db.offices.insert_one({"id": OFFICE, "name": "Boston", "weekly_goal": 100}))
    _seed_admin(db)
    _run(sync_office_weekly_goal(OFFICE, _current_sunday(), 250, _actor(), "test"))
    office = _run(db.offices.find_one({"id": OFFICE}))
    assert office["weekly_goal"] == 250


def test_non_current_week_never_touches_office_doc(monkeypatch):
    db = _db()
    monkeypatch.setattr(goal_sync, "db", db)
    _run(db.offices.insert_one({"id": OFFICE, "name": "Boston", "weekly_goal": 100}))
    _seed_admin(db)
    next_week = (datetime.fromisoformat(_current_sunday()).date() + timedelta(days=7)).isoformat()
    _run(sync_office_weekly_goal(OFFICE, next_week, 300, _actor(), "test"))
    office = _run(db.offices.find_one({"id": OFFICE}))
    assert office["weekly_goal"] == 100  # live target untouched
    # Next week's Sunday sits beyond bells' own +7d write clamp for most of
    # the week, so no bells row is conjured either — the goal lives in the
    # plan until the week arrives, then list_bells' read-path heal adopts it.
    row = _run(db.bells_entries.find_one({"office_id": OFFICE, "week_ending": next_week}))
    assert row is None or row.get("team_weekly_goal") in (None, 300.0)


def test_far_future_week_skips_bells_rows(monkeypatch):
    db = _db()
    monkeypatch.setattr(goal_sync, "db", db)
    _run(db.offices.insert_one({"id": OFFICE, "weekly_goal": 100}))
    _seed_admin(db)
    far = (datetime.fromisoformat(_current_sunday()).date() + timedelta(days=21)).isoformat()
    _run(sync_office_weekly_goal(OFFICE, far, 300, _actor(), "test"))
    assert _run(db.bells_entries.count_documents({})) == 0


# ── bells rows + agenda mirrors ──────────────────────────────────────────

def test_admin_rows_written_and_skip_respected(monkeypatch):
    db = _db()
    monkeypatch.setattr(goal_sync, "db", db)
    _run(db.offices.insert_one({"id": OFFICE, "weekly_goal": 0}))
    a1 = _seed_admin(db, "Owner")
    a2 = _seed_admin(db, "Marcus")
    # A demo admin and a deleted admin must never get rows.
    _run(db.users.insert_one({"_id": ObjectId(), "name": "Demo", "role": "admin", "office_id": OFFICE, "is_demo": True}))
    _run(db.users.insert_one({"_id": ObjectId(), "name": "Gone", "role": "admin", "office_id": OFFICE, "deleted": True}))
    wk = _current_sunday()
    _run(sync_office_weekly_goal(OFFICE, wk, 200, _actor(), "test", skip_bells_user_id=a1))
    rows = _run(db.bells_entries.find({"week_ending": wk}).to_list(10))
    assert {r["user_id"] for r in rows} == {a2}
    assert rows[0]["team_weekly_goal"] == 200.0


def test_agenda_mirrored_only_when_plan_exists(monkeypatch):
    db = _db()
    monkeypatch.setattr(goal_sync, "db", db)
    _run(db.offices.insert_one({"id": OFFICE, "weekly_goal": 0}))
    _seed_admin(db)
    wk = _current_sunday()
    # No agenda yet → nothing conjured.
    _run(sync_office_weekly_goal(OFFICE, wk, 150, _actor(), "test"))
    assert _run(db.weekly_agendas.count_documents({})) == 0
    # With a plan → stats.weekly_goal follows.
    _run(db.weekly_agendas.insert_one({"id": "ag1", "office_id": OFFICE, "week_ending": wk, "stats": {"weekly_goal": ""}}))
    _run(sync_office_weekly_goal(OFFICE, wk, 175, _actor(), "test"))
    ag = _run(db.weekly_agendas.find_one({"id": "ag1"}))
    assert ag["stats"]["weekly_goal"] == "175"


def test_goal_for_week_max_admin_goal(monkeypatch):
    db = _db()
    monkeypatch.setattr(goal_sync, "db", db)
    a1 = _seed_admin(db, "Owner")
    a2 = _seed_admin(db, "Marcus")
    wk = _current_sunday()
    _run(db.bells_entries.insert_many([
        {"id": "b1", "office_id": OFFICE, "week_ending": wk, "user_id": a1, "team_weekly_goal": 180.0},
        {"id": "b2", "office_id": OFFICE, "week_ending": wk, "user_id": a2, "team_weekly_goal": 220.0},
    ]))
    assert _run(goal_for_week(OFFICE, wk)) == 220
    assert _run(goal_for_week(OFFICE, "2020-01-05")) is None


# ── the crew-leading admin (core/admin_scope) ────────────────────────────

def test_office_goal_leaves_a_crew_leading_admins_row_alone(monkeypatch):
    """Olivia moves the office goal; Marcus's crew goal must survive it."""
    db = _db()
    monkeypatch.setattr(goal_sync, "db", db)
    owner = _seed_admin(db, "Owner")
    crew_admin = _seed_admin(db, "Marcus", reports_to=owner)
    wk = _current_sunday()
    _run(db.bells_entries.insert_one({
        "id": "crew", "office_id": OFFICE, "week_ending": wk,
        "user_id": crew_admin, "team_weekly_goal": 40.0,
    }))
    _run(sync_office_weekly_goal(OFFICE, wk, 200, _actor(), "test"))
    rows = {r["user_id"]: r.get("team_weekly_goal")
            for r in _run(db.bells_entries.find({"week_ending": wk}).to_list(10))}
    assert rows[owner] == 200.0
    assert rows[crew_admin] == 40.0


def test_goal_for_week_ignores_a_crew_leading_admins_goal(monkeypatch):
    """A team's target must never seed the office plan."""
    db = _db()
    monkeypatch.setattr(goal_sync, "db", db)
    owner = _seed_admin(db, "Owner")
    crew_admin = _seed_admin(db, "Marcus", reports_to=owner)
    wk = _current_sunday()
    _run(db.bells_entries.insert_many([
        {"id": "b1", "office_id": OFFICE, "week_ending": wk,
         "user_id": owner, "team_weekly_goal": 180.0},
        {"id": "b2", "office_id": OFFICE, "week_ending": wk,
         "user_id": crew_admin, "team_weekly_goal": 220.0},
    ]))
    assert _run(goal_for_week(OFFICE, wk)) == 180
