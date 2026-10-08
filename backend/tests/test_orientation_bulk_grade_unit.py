"""Orientation bulk-grading unit tests (routes/orientation.py).

GET /orientation/cohort:
  • Admin-only (the REAL require_admin guard runs — only get_current_user is
    faked), day must be 1 or 2.
  • Cohort = active hires of the caller's office, start_date within the last
    8 days (app time), whose Day-N assessment exists and is NOT completed. Graded,
    stale, future-dated, inactive and foreign-office hires never appear.
  • Super-admin may pass ?office=; plain admin is pinned to their own office.

POST /orientation/bulk-grade:
  • Every ticked hire gets the EXCELLENT PRESET — the six office-day
    behaviour fields = 10 (customer_service is field-days-only so it is
    never preset; Day 2 adds all six skill fields = 10), every checklist row graded
    "Learnt" when its options contain it else the top option, taught=True,
    outcome_achieved=True — then completion runs through the SAME
    update_assessment path the single grader uses (real function, not a
    copy): scores + checklist grade recompute, status, current_day advance,
    trainee "day ready" push.
  • Overrides beat the preset (assessment fields + per-row checklist grades);
    an invalid override fails that hire BEFORE any write.
  • Already-completed assessments are skipped (ok=false, "already graded")
    and never rewritten; results/counts follow the contract shape.

Pure in-memory: mongomock_motor, no network, no real Mongo.
"""
import asyncio
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from bson import ObjectId
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import auth  # noqa: E402
from core.app_time import APP_TZ  # noqa: E402
import scoring  # noqa: E402
from core import office_helpers, orientation_nudge  # noqa: E402
from routes import orientation, training_routes  # noqa: E402


def _db():
    return AsyncMongoMockClient()["cg1_orientation_test"]


def _run(coro):
    return asyncio.run(coro)


ADMIN = {"id": "u-admin", "name": "Ada", "role": "admin", "office_id": "office-A"}
SUPER = {"id": "u-super", "name": "Sam", "role": "admin", "office_id": "office-A", "is_super_admin": True}
LEADER = {"id": "u-leader", "name": "Lena", "role": "leader", "office_id": "office-A"}

# The cohort window runs on the app clock (core.app_time) — date.today() on a
# machine in another zone can already be "tomorrow" (or still "yesterday")
# near midnight app time, which the window rejects
# as a future start.
TODAY = datetime.now(APP_TZ).date()


def _patch(monkeypatch, db, caller):
    """Wire every module the flow touches to mongomock. Only get_current_user
    is faked — require_admin / can_access_hire / update_assessment stay real."""
    sent: list[dict] = []

    async def _user(_request):
        return dict(caller)

    async def _push(user_id, title, body, data=None):
        sent.append({"user_id": user_id, "title": title, "body": body, "data": data})

    async def _award(hire_id, user_id):
        return None

    monkeypatch.setattr(auth, "get_current_user", _user)
    monkeypatch.setattr(auth, "db", db)
    monkeypatch.setattr(orientation, "db", db)
    monkeypatch.setattr(orientation_nudge, "db", db)
    monkeypatch.setattr(office_helpers, "db", db)
    monkeypatch.setattr(training_routes, "db", db)
    monkeypatch.setattr(training_routes, "get_current_user", _user)
    monkeypatch.setattr(training_routes, "send_push_to_user", _push)
    monkeypatch.setattr(training_routes, "award_stage1_milestones", _award)
    monkeypatch.setattr(scoring, "db", db)
    return sent


def _seed_hire(db, hire_id, *, name=None, start=TODAY, office_id="office-A",
               leader="", active=True, completed_days=()):
    """A hire with Day 1+2 assessments and two checklist rows per day:
    one binary Learnt/Not Learnt row and one Excellent/Average/Below row."""
    trainee_uid = str(ObjectId())
    _run(db.new_hires.insert_one({
        "id": hire_id, "name": name or hire_id, "leader": leader,
        "start_date": start.isoformat(), "office_id": office_id,
        "active": active, "current_day": 1, "current_status": "In Progress",
        "trainee_user_id": trainee_uid,
    }))
    for day in (1, 2):
        aid = f"{hire_id}-d{day}"
        _run(db.daily_assessments.insert_one({
            "id": aid, "new_hire_id": hire_id, "new_hire_name": name or hire_id,
            "day_number": day, "assessment_date": None,
            "completed": day in completed_days, "completed_by": None,
            "behaviour_punctuality": None, "behaviour_engagement": None,
            "behaviour_image": None, "behaviour_coachability": None,
            "behaviour_attitude": None,
            "behaviour_comfort_zones": None, "behaviour_customer_service": None,
            "skill_intro": None, "skill_presentation": None,
            "skill_short_story": None, "skill_close": None,
            "skill_signup": None, "skill_rehash": None,
            "status": "Pending",
        }))
        _run(db.delivery_checklist.insert_one({
            "id": f"{aid}-r1", "assessment_id": aid, "topic": "Work Ethic",
            "category": "Behaviour", "taught": False, "outcome_achieved": False,
            "grade": None, "grade_options": ["Learnt", "Not Learnt"],
        }))
        _run(db.delivery_checklist.insert_one({
            "id": f"{aid}-r2", "assessment_id": aid, "topic": "Image",
            "category": "Behaviour", "taught": False, "outcome_achieved": False,
            "grade": None, "grade_options": ["Excellent", "Average", "Below Average"],
        }))
    return trainee_uid


# ── Cohort ────────────────────────────────────────────────────────────────

def test_cohort_filters_window_grading_office_and_shape(monkeypatch):
    db = _db()
    _seed_hire(db, "h-new", leader="")                                # in
    _seed_hire(db, "h-led", leader="Lena Lee")                        # in, has leader
    _seed_hire(db, "h-edge", start=TODAY - timedelta(days=7))         # in (day 8 of window)
    _seed_hire(db, "h-old", start=TODAY - timedelta(days=8))          # out: too old
    _seed_hire(db, "h-future", start=TODAY + timedelta(days=1))       # out: not started
    _seed_hire(db, "h-done", completed_days=(1,))                     # out: day 1 graded
    _seed_hire(db, "h-gone", active=False)                            # out: inactive
    _seed_hire(db, "h-other", office_id="office-B")                   # out: other office
    _patch(monkeypatch, db, ADMIN)

    out = _run(orientation.get_orientation_cohort(None, day=1))
    assert out["day"] == 1
    by_id = {i["hire_id"]: i for i in out["items"]}
    assert set(by_id) == {"h-new", "h-led", "h-edge"}
    item = by_id["h-new"]
    assert set(item) == {"hire_id", "assessment_id", "name", "start_date", "has_leader"}
    assert item["assessment_id"] == "h-new-d1"
    assert item["start_date"] == TODAY.isoformat()
    assert item["has_leader"] is False
    assert by_id["h-led"]["has_leader"] is True

    # h-done's Day 2 is still pending — the Day-2 cohort picks it up.
    out2 = _run(orientation.get_orientation_cohort(None, day=2))
    assert "h-done" in {i["hire_id"] for i in out2["items"]}


def test_cohort_day_validation_and_admin_guard(monkeypatch):
    db = _db()
    _patch(monkeypatch, db, ADMIN)
    with pytest.raises(HTTPException) as exc:
        _run(orientation.get_orientation_cohort(None, day=3))
    assert exc.value.status_code == 400

    _patch(monkeypatch, db, LEADER)
    with pytest.raises(HTTPException) as exc2:
        _run(orientation.get_orientation_cohort(None, day=1))
    assert exc2.value.status_code == 403


def test_cohort_super_admin_office_param(monkeypatch):
    db = _db()
    _run(db.offices.insert_one({"id": "office-A", "name": "New Haven"}))
    _run(db.offices.insert_one({"id": "office-B", "name": "Boston"}))
    _seed_hire(db, "h-a", office_id="office-A")
    _seed_hire(db, "h-b", office_id="office-B")
    _patch(monkeypatch, db, SUPER)

    out = _run(orientation.get_orientation_cohort(None, day=1, office="office-B"))
    assert [i["hire_id"] for i in out["items"]] == ["h-b"]
    # No param → the super admin's own office.
    out_own = _run(orientation.get_orientation_cohort(None, day=1))
    assert [i["hire_id"] for i in out_own["items"]] == ["h-a"]


# ── Bulk grade: the Excellent preset ─────────────────────────────────────

def test_day1_preset_grades_completes_and_pushes(monkeypatch):
    db = _db()
    trainee_uid = _seed_hire(db, "h1")
    sent = _patch(monkeypatch, db, ADMIN)

    out = _run(orientation.bulk_grade_orientation(
        orientation.BulkGradeBody(day=1, hire_ids=["h1"]), None))
    assert out == {"graded": 1, "skipped": 0,
                   "results": [{"hire_id": "h1", "ok": True, "detail": None}]}

    a = _run(db.daily_assessments.find_one({"id": "h1-d1"}))
    for f in ("behaviour_punctuality", "behaviour_engagement", "behaviour_image",
              "behaviour_coachability", "behaviour_attitude", "behaviour_comfort_zones"):
        assert a[f] == 10, f
    # Customer Service is field-days-only — stays ungraded on orientation days.
    assert a["behaviour_customer_service"] is None
    # Day 1 has no skill block — the preset must not touch it.
    assert a["skill_intro"] is None
    assert a["completed"] is True
    assert a["assessment_date"]
    assert a["behaviour_score"] == 10 and a["overall_score"] == 10
    assert a["status"] == "S-GREEN"
    assert a["checklist_grade_score"] == 10.0  # binary Learnt = 10, Excellent = 10

    r1 = _run(db.delivery_checklist.find_one({"id": "h1-d1-r1"}))
    r2 = _run(db.delivery_checklist.find_one({"id": "h1-d1-r2"}))
    assert r1["grade"] == "Learnt"        # options contain Learnt
    assert r2["grade"] == "Excellent"     # else the top option
    for r in (r1, r2):
        assert r["taught"] is True and r["outcome_achieved"] is True

    # The single grader's side effects ran: day advanced + trainee push.
    hire = _run(db.new_hires.find_one({"id": "h1"}))
    assert hire["current_day"] == 2 and hire["current_status"] == "S-GREEN"
    assert len(sent) == 1
    assert sent[0]["user_id"] == trainee_uid
    assert sent[0]["data"]["type"] == "assessment_complete"
    assert sent[0]["data"]["assessment_id"] == "h1-d1"


def test_day2_preset_also_maxes_all_skill_fields(monkeypatch):
    db = _db()
    _seed_hire(db, "h1", completed_days=(1,))
    _patch(monkeypatch, db, ADMIN)

    out = _run(orientation.bulk_grade_orientation(
        orientation.BulkGradeBody(day=2, hire_ids=["h1"]), None))
    assert out["graded"] == 1

    a = _run(db.daily_assessments.find_one({"id": "h1-d2"}))
    for f in ("skill_intro", "skill_presentation", "skill_short_story",
              "skill_close", "skill_signup", "skill_rehash"):
        assert a[f] == 10, f
    assert a["behaviour_attitude"] == 10
    assert a["completed"] is True
    assert a["skill_score"] == 10 and a["overall_score"] == 10


# ── Overrides beat the preset ────────────────────────────────────────────

def test_overrides_replace_preset_values_and_checklist_rows(monkeypatch):
    db = _db()
    _seed_hire(db, "h1")
    _patch(monkeypatch, db, ADMIN)

    body = orientation.BulkGradeBody(day=1, hire_ids=["h1"], overrides={
        "h1": {"assessment": {"behaviour_attitude": 6, "leader_notes": "Late back from lunch"},
               "checklist": {"h1-d1-r1": "Not Learnt"}},
    })
    out = _run(orientation.bulk_grade_orientation(body, None))
    assert out["graded"] == 1

    a = _run(db.daily_assessments.find_one({"id": "h1-d1"}))
    assert a["behaviour_attitude"] == 6          # override wins
    assert a["behaviour_punctuality"] == 10      # rest of the preset stands
    assert a["leader_notes"] == "Late back from lunch"
    assert a["behaviour_score"] == 9.33          # (5×10 + 6) / 6 — really recomputed
    assert a["status"] == "Green"
    assert a["checklist_grade_score"] == 7.0     # Not Learnt 4 + Excellent 10

    r1 = _run(db.delivery_checklist.find_one({"id": "h1-d1-r1"}))
    r2 = _run(db.delivery_checklist.find_one({"id": "h1-d1-r2"}))
    assert r1["grade"] == "Not Learnt"           # per-row override
    assert r2["grade"] == "Excellent"            # untouched rows keep the preset


def test_invalid_overrides_fail_before_any_write(monkeypatch):
    db = _db()
    _seed_hire(db, "h1")
    _patch(monkeypatch, db, ADMIN)

    for overrides in (
        {"h1": {"assessment": {"vibe_check": 10}}},                 # unknown field
        {"h1": {"checklist": {"h1-d1-r1": "Banana"}}},              # grade not in options
        {"h1": {"checklist": {"ghost-row": "Learnt"}}},             # row of another assessment
    ):
        out = _run(orientation.bulk_grade_orientation(
            orientation.BulkGradeBody(day=1, hire_ids=["h1"], overrides=overrides), None))
        assert out == {"graded": 0, "skipped": 1, "results": [
            {"hire_id": "h1", "ok": False, "detail": out["results"][0]["detail"]}]}
        assert out["results"][0]["detail"]

        a = _run(db.daily_assessments.find_one({"id": "h1-d1"}))
        assert a["completed"] is False and a["behaviour_punctuality"] is None
        r1 = _run(db.delivery_checklist.find_one({"id": "h1-d1-r1"}))
        assert r1["grade"] is None and r1["taught"] is False


# ── Skips, scoping and result shape ──────────────────────────────────────

def test_already_graded_missing_and_foreign_hires_are_skipped(monkeypatch):
    db = _db()
    _seed_hire(db, "h1")
    _seed_hire(db, "h2", completed_days=(1,))
    _seed_hire(db, "h3", office_id="office-B")
    sent = _patch(monkeypatch, db, ADMIN)

    out = _run(orientation.bulk_grade_orientation(
        orientation.BulkGradeBody(day=1, hire_ids=["h1", "h2", "ghost", "h3"]), None))
    assert out["graded"] == 1 and out["skipped"] == 3
    by_id = {r["hire_id"]: r for r in out["results"]}
    assert by_id["h1"] == {"hire_id": "h1", "ok": True, "detail": None}
    assert by_id["h2"] == {"hire_id": "h2", "ok": False, "detail": "already graded"}
    assert by_id["ghost"]["ok"] is False
    assert by_id["h3"] == {"hire_id": "h3", "ok": False, "detail": "not in your office"}

    # Skipped hires stay untouched — no preset leaked into h2 or h3.
    for aid in ("h2-d1", "h3-d1"):
        a = _run(db.daily_assessments.find_one({"id": aid}))
        assert a["behaviour_punctuality"] is None
    # Only h1's trainee got a "day ready" push.
    assert len(sent) == 1


def test_bulk_guards_day_role_and_duplicate_ids(monkeypatch):
    db = _db()
    _seed_hire(db, "h1")
    sent = _patch(monkeypatch, db, ADMIN)

    with pytest.raises(HTTPException) as exc:
        _run(orientation.bulk_grade_orientation(
            orientation.BulkGradeBody(day=5, hire_ids=["h1"]), None))
    assert exc.value.status_code == 400

    # Duplicate ticks collapse to one grade — not one grade + one "already".
    out = _run(orientation.bulk_grade_orientation(
        orientation.BulkGradeBody(day=1, hire_ids=["h1", "h1"]), None))
    assert out["graded"] == 1 and out["skipped"] == 0 and len(out["results"]) == 1
    assert len(sent) == 1

    _patch(monkeypatch, db, LEADER)
    with pytest.raises(HTTPException) as exc2:
        _run(orientation.bulk_grade_orientation(
            orientation.BulkGradeBody(day=1, hire_ids=["h1"]), None))
    assert exc2.value.status_code == 403
