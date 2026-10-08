"""Orientation nudge tick unit tests (core/orientation_nudge.py).

orientation_nudge_tick(day):
  • Pushes every ACTIVE ADMIN of each office whose Day-N orientation cohort
    is non-empty — leaders, deleted/inactive admins and empty offices get
    nothing at all.
  • Payload contract: title carries the cohort count + day, data is
    {"type": "orientation_grading", "url": "/orientation-grading?day=N"} —
    the type maps to the "grading" notification-prefs category.
  • Dedupe: one send per (office, day, app-time date) via orientation_nudge_sends;
    a re-run the same day is silent, a different day still fires.
  • Invalid day / empty cohorts → no pushes, no dedupe claims.

Pure in-memory: mongomock_motor, no network, no real Mongo.
"""
import asyncio
import sys
from datetime import datetime
from pathlib import Path

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import orientation_nudge, push  # noqa: E402
from core.app_time import APP_TZ  # noqa: E402

# The cohort window runs on the app clock (core.app_time) — date.today() on a
# machine in another zone can already be "tomorrow" (or still "yesterday")
# near midnight app time, which the window rejects
# as a future start.
_TODAY_LOCAL = datetime.now(APP_TZ).date()


def _db():
    return AsyncMongoMockClient()["cg1_orientation_nudge_test"]


def _run(coro):
    return asyncio.run(coro)


def _patch(monkeypatch, db):
    sent: list[dict] = []

    async def _push(user_id, title, body, data=None):
        sent.append({"user_id": user_id, "title": title, "body": body, "data": data})

    monkeypatch.setattr(orientation_nudge, "db", db)
    monkeypatch.setattr(orientation_nudge, "send_push_to_user", _push)
    return sent


def _seed_office(db, office_id, *, admins=(), extras=()):
    _run(db.offices.insert_one({"id": office_id, "name": office_id}))
    ids = {}
    for name in admins:
        oid = ObjectId()
        _run(db.users.insert_one({
            "_id": oid, "name": name, "role": "admin", "office_id": office_id,
        }))
        ids[name] = str(oid)
    for name, doc in extras:
        oid = ObjectId()
        _run(db.users.insert_one({"_id": oid, "name": name, "office_id": office_id, **doc}))
        ids[name] = str(oid)
    return ids


def _seed_pending_hire(db, hire_id, office_id, *, days=(1, 2)):
    _run(db.new_hires.insert_one({
        "id": hire_id, "name": hire_id, "leader": "", "office_id": office_id,
        "active": True, "start_date": _TODAY_LOCAL.isoformat(),
    }))
    for day in days:
        _run(db.daily_assessments.insert_one({
            "id": f"{hire_id}-d{day}", "new_hire_id": hire_id,
            "day_number": day, "completed": False,
        }))


# ── Who gets pushed ───────────────────────────────────────────────────────

def test_nudge_fires_only_for_offices_with_a_cohort(monkeypatch):
    db = _db()
    ids_a = _seed_office(db, "office-A", admins=("Ada", "Alan"), extras=(
        ("Dora", {"role": "admin", "deleted": True}),
        ("Ivy", {"role": "admin", "is_active": False}),
        ("Lena", {"role": "leader"}),
    ))
    _seed_office(db, "office-B", admins=("Bea",))  # graded already → no push
    _seed_pending_hire(db, "h-a1", "office-A")
    _seed_pending_hire(db, "h-a2", "office-A")
    _run(db.new_hires.insert_one({
        "id": "h-b1", "name": "h-b1", "office_id": "office-B", "active": True,
        "start_date": _TODAY_LOCAL.isoformat(),
    }))
    _run(db.daily_assessments.insert_one({
        "id": "h-b1-d1", "new_hire_id": "h-b1", "day_number": 1, "completed": True,
    }))
    sent = _patch(monkeypatch, db)

    out = _run(orientation_nudge.orientation_nudge_tick(1))
    assert out["offices"] == 1 and out["sent"] == 2
    assert {p["user_id"] for p in sent} == {ids_a["Ada"], ids_a["Alan"]}
    p = sent[0]
    assert p["title"] == "🎓 2 orientation Day 1 assessments ready"
    assert p["body"] == "Tap to mark the Monday class — all of them at once"
    assert p["data"] == {"type": "orientation_grading", "url": "/orientation-grading?day=1"}


def test_payload_type_maps_to_grading_prefs_category():
    assert push.notification_category({"type": "orientation_grading"}) == "grading"


# ── Dedupe ────────────────────────────────────────────────────────────────

def test_nudge_dedupes_per_office_and_day_per_local_date(monkeypatch):
    db = _db()
    _seed_office(db, "office-A", admins=("Ada",))
    _seed_pending_hire(db, "h-a1", "office-A")
    sent = _patch(monkeypatch, db)

    first = _run(orientation_nudge.orientation_nudge_tick(1))
    assert first["sent"] == 1 and len(sent) == 1

    second = _run(orientation_nudge.orientation_nudge_tick(1))
    assert second["sent"] == 0 and len(sent) == 1  # same office+day+date → silent
    assert second["details"][0]["status"] == "deduped"

    # A DIFFERENT day is its own dedupe key — Tuesday's Day-2 nudge still fires.
    # The seeded hire's Day 1 is STILL ungraded, so the Day-2 pass must not
    # hide it: the push covers both days and lands on Day 1 first.
    third = _run(orientation_nudge.orientation_nudge_tick(2))
    assert third["sent"] == 1 and len(sent) == 2
    assert sent[-1]["data"]["url"] == "/orientation-grading?day=1"
    assert "Day 1" in sent[-1]["title"] and "Day 2" in sent[-1]["title"]


def test_empty_cohort_or_invalid_day_sends_and_claims_nothing(monkeypatch):
    db = _db()
    _seed_office(db, "office-A", admins=("Ada",))
    sent = _patch(monkeypatch, db)

    out = _run(orientation_nudge.orientation_nudge_tick(1))
    assert out["sent"] == 0 and sent == []
    assert _run(db.orientation_nudge_sends.count_documents({})) == 0

    bad = _run(orientation_nudge.orientation_nudge_tick(3))
    assert bad["sent"] == 0 and sent == []
