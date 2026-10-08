"""Checks for the sales-goal audit trail.

The point of the trail is to answer "who set this goal, and from where" when
a leader disputes one. So the things that matter are: a real change is
recorded with both sides of the transition, a no-op rewrite is NOT (or the
trail fills with noise from every sheet save), and an auditing failure never
takes the user's save down with it.
"""
import asyncio
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.goal_audit import record_goal_change, _norm  # noqa: E402


class _Coll:
    def __init__(self):
        self.rows = []

    async def insert_one(self, doc):
        self.rows.append(doc)


class _DB:
    def __init__(self):
        self.goal_audit = _Coll()


class _ExplodingDB:
    class _Boom:
        async def insert_one(self, _doc):
            raise RuntimeError("mongo is down")

    goal_audit = _Boom()


ACTOR = {"id": "A1", "name": "Ada Admin", "role": "admin"}


def _rec(db, old, new, field="weekly_goal"):
    return asyncio.run(record_goal_change(
        db, user_id="U1", week_ending="2026-07-26", field=field,
        old=old, new=new, actor=ACTOR, source="POST /bells",
    ))


def test_records_both_sides_of_a_real_change():
    db = _DB()
    _rec(db, 16, 21)
    assert len(db.goal_audit.rows) == 1
    r = db.goal_audit.rows[0]
    assert (r["old"], r["new"]) == (16.0, 21.0)
    assert r["user_id"] == "U1" and r["field"] == "weekly_goal"
    assert r["actor_name"] == "Ada Admin" and r["source"] == "POST /bells"
    assert r["week_ending"] == "2026-07-26" and r["at"]


def test_no_op_rewrite_is_not_recorded():
    """POST /bells resends the goal on every sheet save. Logging those would
    bury the one write that actually matters."""
    db = _DB()
    _rec(db, 16, 16)
    _rec(db, None, None)
    _rec(db, None, "")
    assert db.goal_audit.rows == []


def test_int_float_rewrite_is_not_a_change():
    """The Bells path stores ints, the planner path floats. 16 → 16.0 is the
    same goal and must not look like an edit."""
    db = _DB()
    _rec(db, 16, 16.0)
    _rec(db, 40.0, 40)
    assert db.goal_audit.rows == []


def test_setting_and_clearing_are_both_changes():
    db = _DB()
    _rec(db, None, 12)
    _rec(db, 12, None)
    assert [(r["old"], r["new"]) for r in db.goal_audit.rows] == [(None, 12.0), (12.0, None)]


def test_team_goal_is_recorded_under_its_own_field():
    db = _DB()
    _rec(db, 40, 48, field="team_weekly_goal")
    assert db.goal_audit.rows[0]["field"] == "team_weekly_goal"


def test_audit_failure_never_breaks_the_save():
    """A save must succeed even if the trail cannot be written."""
    _rec(_ExplodingDB(), 16, 21)  # must not raise


def test_norm_handles_junk():
    assert _norm("") is None and _norm(None) is None
    assert _norm("not a number") is None
    assert _norm("18") == 18.0
