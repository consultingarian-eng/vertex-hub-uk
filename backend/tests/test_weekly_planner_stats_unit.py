"""Planner review stats — the crew goal is the leader's call, not a sum.

GET /weekly-planners/{week}/stats feeds the planner's Review card for the
week just gone (week − 7). Its `team.goal` must be the crew goal the leader
actually SET for that review week (team_weekly_goal on their own bells row —
the same field the Bells tab, crew table and Home pulse write), never the
accumulation of each member's personal weekly_goal: a crew's personal goals
can sum to 8 when the leader's committed call was 30, and the review grades
the call. An unset crew goal stays None — no silent fallback to the sum.

`goals.team` / `goals.personal` (the This Week's Goals boxes) still read the
PLANNING week's row, untouched.

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

from routes import weekly_planners as wp  # noqa: E402

PLAN_WEEK = "2026-07-26"
REVIEW_WEEK = "2026-07-19"

LEADER_ID = str(ObjectId())
M1_ID = str(ObjectId())
M2_ID = str(ObjectId())
LEADER = {"id": LEADER_ID, "name": "Lena", "role": "leader", "office_id": "off1"}


def _db():
    return AsyncMongoMockClient()["cg1_planner_stats_test"]


def _run(coro):
    return asyncio.run(coro)


def _bells(db, uid, week, *, weekly_goal=None, team_weekly_goal=None):
    _run(db.bells_entries.insert_one({
        "id": f"{uid}-{week}", "office_id": "off1", "user_id": uid,
        "week_ending": week, "days": [], "weekly_goal": weekly_goal,
        "team_weekly_goal": team_weekly_goal,
    }))


def _patch(monkeypatch, db):
    async def _resolve(_request, _user_id):
        return dict(LEADER), dict(LEADER)

    async def _subtree(_uid):
        return [LEADER_ID, M1_ID, M2_ID]

    async def _quality(*_a, **_kw):
        return {}

    monkeypatch.setattr(wp, "db", db)
    monkeypatch.setattr(wp, "_resolve_target_user", _resolve)
    monkeypatch.setattr(wp, "get_subtree_ids", _subtree)
    monkeypatch.setattr(wp, "_quality_kpis", _quality)
    for uid, name in ((LEADER_ID, "Lena"), (M1_ID, "Mia"), (M2_ID, "Moe")):
        _run(db.users.insert_one({"_id": ObjectId(uid), "name": name,
                                  "role": "leader" if uid == LEADER_ID else "trainee"}))


def test_review_crew_goal_is_the_leader_set_goal_not_the_sum(monkeypatch):
    db = _db()
    _patch(monkeypatch, db)
    # Review week: members' personal goals sum to 8; the leader's committed
    # crew goal was 30. Planning week carries a different crew goal (25) that
    # must NOT bleed into the review.
    _bells(db, M1_ID, REVIEW_WEEK, weekly_goal=5)
    _bells(db, M2_ID, REVIEW_WEEK, weekly_goal=3)
    _bells(db, LEADER_ID, REVIEW_WEEK, weekly_goal=2, team_weekly_goal=30)
    _bells(db, LEADER_ID, PLAN_WEEK, weekly_goal=6, team_weekly_goal=25)

    out = _run(wp.weekly_planner_stats(PLAN_WEEK, None))
    assert out["review_week_ending"] == REVIEW_WEEK
    assert out["team"]["goal"] == 30          # the leader's call, not 5+3+2
    assert out["personal"]["goal"] == 2       # own personal goal, review week
    # The This Week's Goals boxes still read the planning week.
    assert out["goals"] == {"personal": 6, "team": 25}


def test_unset_review_crew_goal_stays_none_without_sum_fallback(monkeypatch):
    db = _db()
    _patch(monkeypatch, db)
    _bells(db, M1_ID, REVIEW_WEEK, weekly_goal=5)
    _bells(db, M2_ID, REVIEW_WEEK, weekly_goal=3)
    _bells(db, LEADER_ID, REVIEW_WEEK, weekly_goal=2)  # no team goal set

    out = _run(wp.weekly_planner_stats(PLAN_WEEK, None))
    assert out["team"]["goal"] is None
    # Members and totals are unaffected by the goal source change.
    assert {m["user_id"] for m in out["team"]["members"]} == {LEADER_ID, M1_ID, M2_ID}
