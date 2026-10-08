"""Checks for the office Monday-review summary.

Covers the parts that are easy to get quietly wrong: the review week is the
one BEFORE the planned week, money ranks the highrollers, each leader's crew
roll-up walks the reporting tree (and survives a legacy cycle), and the whole
thing is admin-only.
"""
import asyncio
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from fastapi import HTTPException  # noqa: E402

import core.office_helpers as office_helpers  # noqa: E402
from routes import weekly_planners as wp  # noqa: E402

OFFICE = "off1"
PLAN_WEEK = "2026-07-26"
REVIEW_WEEK = "2026-07-19"

# Vertex fee knobs picked for easy arithmetic: £10 a £12 sign-up (under30)
# and £40 a £15+ sign-up (over30). Memberships are a legacy field and are
# never paid.
FEES = {
    "fee_standard": 10,
    "fee_target": 40,
    "fee_premium": 40,
}


def d_in(over30=0, under30=0, memberships=0):
    return {"status": "in", "over30": over30, "under30": under30, "memberships": memberships}


def d_off():
    return {"status": "off", "over30": None, "under30": None, "memberships": None}


def pad(days):
    return (days + [d_off()] * 6)[:6]


class _Cursor:
    def __init__(self, rows):
        self.rows = list(rows)

    async def to_list(self, _limit=None):
        return list(self.rows)

    def sort(self, *_a, **_kw):
        return self

    def __aiter__(self):
        self._i = 0
        return self

    async def __anext__(self):
        if self._i >= len(self.rows):
            raise StopAsyncIteration
        row = self.rows[self._i]
        self._i += 1
        return row


class _Collection:
    """Matches only the query shapes this endpoint actually issues."""

    def __init__(self, rows):
        self.rows = rows

    def _match(self, query):
        out = []
        for r in self.rows:
            ok = True
            for k, v in query.items():
                if isinstance(v, dict):
                    if "$in" in v and r.get(k) not in v["$in"]:
                        ok = False
                    if "$ne" in v and r.get(k) == v["$ne"]:
                        ok = False
                elif r.get(k) != v:
                    ok = False
            if ok:
                out.append(r)
        return out

    def find(self, query=None, _projection=None):
        return _Cursor(self._match(query or {}))

    async def find_one(self, query=None, _projection=None, **_kw):
        rows = self._match(query or {})
        return rows[0] if rows else None


class _DB:
    def __init__(self, users, bells, planners, offices, fees):
        self.users = _Collection(users)
        self.bells_entries = _Collection(bells)
        self.weekly_planners = _Collection(planners)
        self.offices = _Collection(offices)
        self.commission_fees = _Collection(fees)


def _user(uid, name, role, reports_to=None):
    return {
        "_id": uid, "name": name, "role": role, "reports_to": reports_to,
        "office_id": OFFICE, "is_active": True, "deleted": False,
    }


def _bells(uid, name, week, days, weekly_goal=None, team_weekly_goal=None):
    return {
        "office_id": OFFICE, "user_id": uid, "user_name": name, "week_ending": week,
        "days": pad(days), "weekly_goal": weekly_goal, "team_weekly_goal": team_weekly_goal,
    }


def _fixture():
    users = [
        _user("L1", "Lena One", "leader"),
        _user("T1", "Tia One", "trainee", "L1"),
        _user("T2", "Tom Two", "trainee", "L1"),
        _user("L2", "Leo Two", "leader"),
        _user("T3", "Tess Three", "trainee", "L2"),
        _user("A1", "Ada Admin", "admin"),
    ]
    bells = [
        # Review week — the numbers everything retrospective is built from.
        _bells("T1", "Tia One", REVIEW_WEEK, [d_in(2, 1), d_in(1, 0), d_in(0, 0)], weekly_goal=5),
        _bells("T2", "Tom Two", REVIEW_WEEK, [d_in(0, 0), d_in(0, 0)], weekly_goal=3),
        # Lena reports to nobody, so her crew goal IS the office target.
        _bells("L1", "Lena One", REVIEW_WEEK, [d_in(1, 0, 1)], weekly_goal=2, team_weekly_goal=30),
        _bells("T3", "Tess Three", REVIEW_WEEK,
               [d_in(2, 1), d_in(1, 1), d_in(2, 0), d_in(0, 0)], weekly_goal=10),
        # Planned week — only goals are read off these.
        _bells("L1", "Lena One", PLAN_WEEK, [], weekly_goal=6, team_weekly_goal=25),
    ]
    planners = [{
        "user_id": "L1", "week_ending": PLAN_WEEK, "updated_at": "2026-07-27T09:00:00Z",
        "review": {
            "wins": ["Team hit goal", "Two new starts"],
            "learnings": ["Ask better questions"],
            "focus_next_week": ["Primetime discipline"],
            "theme": "Own the morning",
            "concentration": "Doors before noon",
            "team_management": {"meetings": "Mon 9am"},
            "eight_steps": {"scores": {"Attitude": 5, "Time Management": 2}, "focus": "Get out earlier"},
            "developing": [{"who": "Tia", "what": "closing"}],
            "recruitment": {"booked_in": "6", "attended": "4", "newstarts": "2"},
        },
    }]
    offices = [{"id": OFFICE, "name": "Boston"}]
    return _DB(users, bells, planners, offices, [dict(FEES, office_id=OFFICE)])


@pytest.fixture
def patched(monkeypatch):
    admin = {"id": "A1", "role": "admin", "office_id": OFFICE}

    async def fake_user(_request):
        return admin

    async def fake_office(_request, _user=None, _office_param=None):
        return OFFICE

    monkeypatch.setattr(wp, "db", _fixture())
    monkeypatch.setattr(wp, "get_current_user", fake_user)
    monkeypatch.setattr(office_helpers, "resolve_office_id", fake_office)
    return admin


def _call(week=PLAN_WEEK):
    return asyncio.run(wp.office_weekly_review(request=None, week=week, office=None))


def test_review_week_is_the_week_before_the_planned_week(patched):
    r = _call()
    assert r["week_ending"] == PLAN_WEEK
    assert r["review_week_ending"] == REVIEW_WEEK
    assert r["office"] == {"id": OFFICE, "name": "Boston"}


def test_office_totals_aggregate_every_bells_row(patched):
    t = _call()["totals"]
    assert t["sales"] == 12          # 4 + 0 + 1 + 7
    assert t["over30"] == 9
    assert t["memberships"] == 1
    assert t["earnings"] == 390.0    # 130 + 0 + 40 + 220
    assert t["ba_days"] == 10
    assert t["piece_avg"] == 1.2
    assert t["scoring_pct"] == 60    # 6 scoring days of 10 worked
    assert t["gold_pct"] == 75
    assert t["goal"] == 20 and t["goal_pct"] == 60
    assert t["reps"] == 4 and t["reps_worked"] == 4
    assert t["reps_zero"] == 1       # Tom worked two days and rang nothing


def test_office_target_is_top_down_not_the_sum_of_individual_goals(patched):
    """`goal` sums what each person committed to; `target` is what the office
    committed to. Lena's crew goal sits at the top of the tree (she reports to
    nobody), so it is the office's number — and it deliberately differs from
    the bottom-up sum."""
    t = _call()["totals"]
    assert t["goal"] == 20            # bottom-up: 5 + 3 + 2 + 10
    assert t["target"] == 30          # top-down: Lena's review-week crew goal
    assert t["target_source"] == "crew"
    assert t["target_pct"] == 40      # 12 of 30
    assert t["goal_pct"] == 60        # 12 of 20 — the misleading one


def test_explicit_office_target_wins_over_the_tree(monkeypatch, patched):
    db = _fixture()
    db.offices = _Collection([{"id": OFFICE, "name": "Boston", "weekly_goal": 45}])
    monkeypatch.setattr(wp, "db", db)
    t = _call()["totals"]
    assert t["target"] == 45 and t["target_source"] == "office"


def test_no_target_anywhere_reports_none(monkeypatch, patched):
    """No office goal and nobody at the top with a crew goal — say so rather
    than falling back to the bottom-up sum and calling it a target."""
    db = _fixture()
    for r in db.bells_entries.rows:
        r.pop("team_weekly_goal", None)
    monkeypatch.setattr(wp, "db", db)
    t = _call()["totals"]
    assert t["target"] is None and t["target_pct"] is None and t["target_source"] is None
    assert t["goal"] == 20  # the bottom-up sum is still reported


def test_highrollers_rank_by_money_not_units(patched):
    hr = _call()["highrollers"]
    assert [h["name"] for h in hr] == ["Tess Three", "Tia One", "Lena One"]
    assert [h["earnings"] for h in hr] == [220.0, 130.0, 40.0]
    assert [h["rank"] for h in hr] == [1, 2, 3]
    # Whose crew they're on — the meeting wants to credit the leader too.
    assert hr[0]["leader_name"] == "Leo Two"
    assert hr[1]["leader_name"] == "Lena One"
    assert hr[2]["leader_name"] == ""   # Lena reports to nobody
    # A zero week never appears, however many days were worked.
    assert "Tom Two" not in [h["name"] for h in hr]


def test_leader_rollups_follow_the_reporting_tree(patched):
    by_name = {l["name"]: l for l in _call()["leaders"]}

    lena = by_name["Lena One"]
    assert lena["crew_size"] == 2
    assert lena["last_week"]["sales"] == 5          # her 1 + Tia's 4 + Tom's 0
    assert lena["last_week"]["earnings"] == 170.0
    assert lena["last_week"]["goal"] == 10 and lena["last_week"]["goal_pct"] == 50
    assert lena["last_week"]["reps_zero"] == 1
    assert lena["last_week"]["own"]["sales"] == 1
    assert [t["name"] for t in lena["last_week"]["top"]] == ["Tia One", "Lena One"]

    leo = by_name["Leo Two"]
    assert leo["crew_size"] == 1
    assert leo["last_week"]["sales"] == 7           # Tess only — Leo has no row
    assert leo["last_week"]["earnings"] == 220.0
    assert leo["last_week"]["own"] is None

    # Leaders before admins, biggest crew earnings first.
    assert [l["name"] for l in _call()["leaders"]] == ["Leo Two", "Lena One", "Ada Admin"]


def test_leader_last_week_team_goal_is_the_review_week_commitment(patched):
    """The retrospective block reports the crew goal the leader set for the
    week under review (30), not the one just entered for the week being
    planned (25) — the review grades last week's call."""
    by_name = {l["name"]: l for l in _call()["leaders"]}
    assert by_name["Lena One"]["last_week"]["team_goal"] == 30
    assert by_name["Leo Two"]["last_week"]["team_goal"] is None


def test_plan_contents_surface_and_pool(patched):
    r = _call()
    lena = next(l for l in r["leaders"] if l["name"] == "Lena One")
    assert lena["plan"]["submitted"] is True
    assert lena["plan"]["steps_done"] == 5
    assert lena["plan"]["goals"] == {"personal": 6, "team": 25}
    assert lena["plan"]["theme"] == "Own the morning"
    # Lowest-rated steps first — what NOT to give positives around.
    assert lena["plan"]["eight_steps"]["lowest"][0] == {"step": "Time Management", "score": 2}

    assert [w["text"] for w in r["wins"]] == ["Team hit goal", "Two new starts"]
    assert {w["name"] for w in r["wins"]} == {"Lena One"}
    assert [f["text"] for f in r["focuses"]] == ["Primetime discipline"]
    assert [l["text"] for l in r["learnings"]] == ["Ask better questions"]
    assert r["recruitment"] == {"booked_in": 6, "attended": 4, "newstarts": 2}
    assert r["eight_steps_office"][0] == {"step": "Time Management", "avg": 2.0, "raters": 1}

    assert r["plans_submitted"] == 1 and r["plans_total"] == 3
    assert [m["name"] for m in r["missing_plans"]] == ["Leo Two", "Ada Admin"]


def test_non_admin_is_refused(monkeypatch):
    async def fake_user(_request):
        return {"id": "L1", "role": "leader", "office_id": OFFICE}

    monkeypatch.setattr(wp, "db", _fixture())
    monkeypatch.setattr(wp, "get_current_user", fake_user)
    with pytest.raises(HTTPException) as e:
        _call()
    assert e.value.status_code == 403


def test_bad_week_is_rejected(patched):
    with pytest.raises(HTTPException) as e:
        _call(week="not-a-date")
    assert e.value.status_code == 400


def test_reporting_cycle_does_not_hang(monkeypatch):
    """Legacy rows can point at each other; the tree walk must still finish."""
    admin = {"id": "A1", "role": "admin", "office_id": OFFICE}

    async def fake_user(_request):
        return admin

    async def fake_office(_request, _user=None, _office_param=None):
        return OFFICE

    users = [
        _user("L1", "Lena One", "leader", "L2"),   # ← cycle
        _user("L2", "Leo Two", "leader", "L1"),    # ← cycle
        _user("T1", "Tia One", "trainee", "L1"),
    ]
    db = _DB(users, [], [], [{"id": OFFICE, "name": "Boston"}], [dict(FEES, office_id=OFFICE)])
    monkeypatch.setattr(wp, "db", db)
    monkeypatch.setattr(wp, "get_current_user", fake_user)
    monkeypatch.setattr(office_helpers, "resolve_office_id", fake_office)

    async def run():
        return await asyncio.wait_for(
            wp.office_weekly_review(request=None, week=PLAN_WEEK, office=None), timeout=10
        )

    r = asyncio.run(run())
    by_name = {l["name"]: l for l in r["leaders"]}
    # Each leader sees the other plus the trainee, counted once.
    assert by_name["Lena One"]["crew_size"] == 2
    assert by_name["Leo Two"]["crew_size"] == 2


def test_defaults_to_the_week_being_planned(patched):
    """No ?week= — the default lands on a Sunday, with the review a week back."""
    r = asyncio.run(wp.office_weekly_review(request=None, week=None, office=None))
    from datetime import date
    assert date.fromisoformat(r["week_ending"]).weekday() == 6
    assert date.fromisoformat(r["week_ending"]) > date.today()
    assert (date.fromisoformat(r["week_ending"])
            - date.fromisoformat(r["review_week_ending"])).days == 7
