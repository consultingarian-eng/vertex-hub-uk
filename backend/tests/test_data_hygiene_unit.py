"""Unit tests for the startup data-hygiene sweep (core/data_hygiene.py).

Pure in-memory: every test runs against a fresh mongomock database — no
network, no real Mongo, no app import.
"""

import asyncio
import sys
from datetime import date
from pathlib import Path

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import data_hygiene


TODAY = date(2026, 8, 17)          # fixed "today" (app time) for boundary maths
CUTOFF = "2026-07-03"              # TODAY − 45 days: start_date must be < this

BOSTON = "b7f1c9d0-boston-office"
NEWHAVEN = "3a9e5f10-newhaven-office"


def _db():
    return AsyncMongoMockClient()["cg1_hygiene_test"]


def _run(coro):
    return asyncio.run(coro)


def _seed_offices(db):
    _run(db.offices.insert_many([
        {"id": BOSTON, "name": "Boston"},
        {"id": NEWHAVEN, "name": "New Haven"},
    ]))


# ── 1. Ghost-hire archive ────────────────────────────────────────────────

def test_ghost_archive_45_day_boundary_and_linked_user_states():
    db = _db()
    live_uid = ObjectId()
    deleted_uid = ObjectId()
    missing_uid = ObjectId()  # never inserted → hard-deleted account
    _run(db.users.insert_many([
        {"_id": live_uid, "name": "Alive"},
        {"_id": deleted_uid, "name": "Gone", "deleted": True},
    ]))
    _run(db.new_hires.insert_many([
        # Ghosts: stale + no live account behind them
        {"id": "h-no-user", "active": True, "current_day": 1, "start_date": "2026-06-01"},
        {"id": "h-deleted-user", "active": True, "current_day": None, "start_date": "2026-06-01",
         "trainee_user_id": str(deleted_uid)},
        {"id": "h-missing-user", "active": True, "current_day": 0, "start_date": "2026-06-01",
         "trainee_user_id": str(missing_uid)},
        {"id": "h-bad-oid", "active": True, "current_day": 1, "start_date": "2026-06-01",
         "trainee_user_id": "not-an-object-id"},
        # Kept: boundary day is NOT stale (strictly < today − 45)
        {"id": "h-boundary", "active": True, "current_day": 1, "start_date": CUTOFF},
        # Kept: recent
        {"id": "h-recent", "active": True, "current_day": 1, "start_date": "2026-07-10"},
        # Kept: linked account is alive
        {"id": "h-live-user", "active": True, "current_day": 1, "start_date": "2026-06-01",
         "trainee_user_id": str(live_uid)},
        # Kept: made real progress, whatever the account state
        {"id": "h-progressed", "active": True, "current_day": 4, "start_date": "2026-05-01"},
    ]))

    archived = _run(data_hygiene._archive_ghost_hires(db, today=TODAY))
    assert archived == 4

    ghosts = {"h-no-user", "h-deleted-user", "h-missing-user", "h-bad-oid"}
    for h in _run(db.new_hires.find({}).to_list(length=100)):
        if h["id"] in ghosts:
            assert h["active"] is False
            assert h["archived_reason"] == "auto_ghost_cleanup"
            assert h["archived_at"]
        else:
            assert h["active"] is True
            assert "archived_reason" not in h

    # Repeat-safe: archived rows never match again.
    assert _run(data_hygiene._archive_ghost_hires(db, today=TODAY)) == 0


# ── 2. Bad office_id heal ────────────────────────────────────────────────

def test_office_heal_prefers_linked_user_then_name_then_flags():
    db = _db()
    _seed_offices(db)
    boston_uid = ObjectId()
    stale_office_uid = ObjectId()
    _run(db.users.insert_many([
        {"_id": boston_uid, "name": "Rep", "office_id": BOSTON},
        {"_id": stale_office_uid, "name": "Rep2", "office_id": "office-that-died"},
    ]))
    _run(db.new_hires.insert_many([
        # Linked user's office wins even when a name field disagrees
        {"id": "h-user-heal", "active": True, "office_id": "5f0123456789abcdef012345",
         "trainee_user_id": str(boston_uid), "office_name": "New Haven"},
        # User's office is itself phantom → falls through to the name field
        {"id": "h-name-heal", "active": True, "office_id": "bogus-1",
         "trainee_user_id": str(stale_office_uid), "office_name": "New Haven"},
        # Nothing to heal from → parked for a human
        {"id": "h-flag", "active": True, "office_id": "bogus-2"},
        # Healthy rows untouched
        {"id": "h-good", "active": True, "office_id": NEWHAVEN},
        # Inactive rows out of scope
        {"id": "h-inactive", "active": False, "office_id": "bogus-3"},
    ]))

    result = _run(data_hygiene._heal_bad_office_ids(db))
    assert result == {"healed": 2, "flagged": 1}

    rows = {h["id"]: h for h in _run(db.new_hires.find({}).to_list(length=100))}
    assert rows["h-user-heal"]["office_id"] == BOSTON
    assert rows["h-name-heal"]["office_id"] == NEWHAVEN
    assert rows["h-flag"]["office_id"] is None
    assert rows["h-flag"]["needs_office_review"] is True
    assert rows["h-good"]["office_id"] == NEWHAVEN
    assert "needs_office_review" not in rows["h-good"]
    assert rows["h-inactive"]["office_id"] == "bogus-3"

    # Repeat-safe: healed rows stopped matching, the flagged row is skipped.
    assert _run(data_hygiene._heal_bad_office_ids(db)) == {"healed": 0, "flagged": 0}


def test_office_heal_refuses_to_run_without_offices():
    # A wiped/unseeded offices collection must not mass-flag every hire.
    db = _db()
    _run(db.new_hires.insert_one({"id": "h1", "active": True, "office_id": "whatever"}))
    assert _run(data_hygiene._heal_bad_office_ids(db)) == {"healed": 0, "flagged": 0}
    row = _run(db.new_hires.find_one({"id": "h1"}))
    assert row["office_id"] == "whatever"
    assert "needs_office_review" not in row


# ── 4. One-shot orphan cleanup ───────────────────────────────────────────

def _seed_orphan_world(db):
    """A db with one real hire/user/office and one orphan of each kind."""
    _seed_offices(db)
    real_uid = ObjectId()
    soft_deleted_uid = ObjectId()
    hard_deleted_uid = ObjectId()  # no users doc
    _run(db.users.insert_many([
        {"_id": real_uid, "name": "Alive"},
        {"_id": soft_deleted_uid, "name": "Soft", "deleted": True},
    ]))
    _run(db.new_hires.insert_one({"id": "hire-1", "active": True, "office_id": BOSTON}))
    _run(db.daily_assessments.insert_many([
        {"id": "a-keep", "new_hire_id": "hire-1", "day_number": 1},
        {"id": "a-orphan", "new_hire_id": "hire-gone", "day_number": 1},
    ]))
    _run(db.module_progress.insert_many([
        {"id": "p-keep", "target_user_id": str(real_uid), "module_id": "m1"},
        {"id": "p-soft-keep", "target_user_id": str(soft_deleted_uid), "module_id": "m1"},
        {"id": "p-orphan", "target_user_id": str(hard_deleted_uid), "module_id": "m1"},
        {"id": "p-legacy-orphan", "user_id": str(hard_deleted_uid), "module_id": "m2"},
    ]))
    _run(db.settings.insert_many([
        {"key": "app_settings", "theme": "dark"},                      # singleton — kept
        {"key": "checklist_learnt_recalc_v1", "ran_at": "x"},          # marker — kept
        {"office_id": BOSTON, "start_time": "08:30"},                  # real office — kept
        {"office_id": "phantom-office", "start_time": "08:30"},        # orphan — deleted
    ]))
    _run(db.training_modules.insert_many([
        {"id": "m-real", "topic": "Door Approach", "stage": 2, "office_id": BOSTON},
        {"id": "m-stranded-dupe", "topic": "Door Approach", "stage": 2, "office_id": "c0fb035e-phantom"},
        {"id": "m-stranded-unique", "topic": "Only Copy Anywhere", "stage": 2, "office_id": "c0fb035e-phantom"},
    ]))


def test_orphan_cleanup_deletes_orphans_and_writes_marker():
    db = _db()
    _seed_orphan_world(db)

    counts = _run(data_hygiene._cleanup_orphan_rows(db))
    assert counts == {"assessments": 1, "module_progress": 2, "settings": 1, "training_modules": 1}

    assert {a["id"] for a in _run(db.daily_assessments.find({}).to_list(length=10))} == {"a-keep"}
    # Hard-deleted user's rows go; the soft-deleted user's history stays.
    assert {p["id"] for p in _run(db.module_progress.find({}).to_list(length=10))} == {"p-keep", "p-soft-keep"}
    kept_settings = _run(db.settings.find({}).to_list(length=10))
    assert len(kept_settings) == 3
    assert all(s.get("office_id") != "phantom-office" for s in kept_settings)
    # Stranded module with a real-office copy goes; the only-copy survives.
    assert {m["id"] for m in _run(db.training_modules.find({}).to_list(length=10))} == {"m-real", "m-stranded-unique"}

    marker = _run(db.data_hygiene_markers.find_one({"key": data_hygiene.ORPHAN_MARKER}))
    assert marker is not None
    assert marker["deleted_assessments"] == 1

    # One-shot: a second call is a no-op.
    assert _run(data_hygiene._cleanup_orphan_rows(db)) is None


def test_orphan_cleanup_respects_existing_marker():
    db = _db()
    _seed_orphan_world(db)
    _run(db.data_hygiene_markers.insert_one({"key": data_hygiene.ORPHAN_MARKER, "ran_at": "2026-08-01"}))

    assert _run(data_hygiene._cleanup_orphan_rows(db)) is None

    # Nothing was touched — the orphans are all still there.
    assert _run(db.daily_assessments.count_documents({})) == 2
    assert _run(db.module_progress.count_documents({})) == 4
    assert _run(db.settings.count_documents({})) == 4
    assert _run(db.training_modules.count_documents({})) == 3


def test_orphan_cleanup_refuses_when_reference_collections_look_empty():
    # No offices/users/new_hires → skip AND leave the marker unwritten so the
    # real cleanup still happens on a healthy boot.
    db = _db()
    _run(db.daily_assessments.insert_one({"id": "a1", "new_hire_id": "hire-gone"}))
    assert _run(data_hygiene._cleanup_orphan_rows(db)) is None
    assert _run(db.daily_assessments.count_documents({})) == 1
    assert _run(db.data_hygiene_markers.find_one({"key": data_hygiene.ORPHAN_MARKER})) is None


# ── Entry point ──────────────────────────────────────────────────────────

def test_run_data_hygiene_returns_full_summary_and_never_raises():
    db = _db()
    _seed_orphan_world(db)
    summary = _run(data_hygiene.run_data_hygiene(db))
    assert set(summary) == {
        "ghost_hires_archived",
        "office_ids_healed",
        "office_ids_flagged",
        "push_tokens_unset",
        "web_push_subs_deleted",
        "orphan_rows_deleted",
        "indexes_ensured",
    }
    assert summary["orphan_rows_deleted"] == 5
    assert summary["indexes_ensured"] == len(data_hygiene._INDEXES)
