"""_ensure_seeded (routes/modules): duplicate-copy self-heal + atomic seeding.

The old read-then-insert pattern raced when two requests hit a freshly-added
stage at once — exactly how Stage 1's 16 Foundation modules got doubled per
office in Sep 2026. These tests pin the fix:

  • duplicate (stage, topic) copies in one office scope are merged;
  • progress rows on a dropped copy re-point to the keeper (never doubled);
  • a vetted copy always survives the merge;
  • repeated seeding stays idempotent — one copy per (stage, topic).

Pure in-memory: mongomock, no network, no app import.
"""

import asyncio
import sys
from pathlib import Path

from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import modules as modules_route  # noqa: E402
from core.module_seed import all_seed_modules  # noqa: E402

OFFICE = "office-boston"
TOPIC = "5-Step Sign-Up Process"


def _db():
    return AsyncMongoMockClient()["cg1_seed_dedupe_test"]


def _run(coro):
    return asyncio.run(coro)


def _mod(mid: str, topic: str = TOPIC, **extra) -> dict:
    return {
        "id": mid, "office_id": OFFICE, "stage": 1, "topic": topic,
        "category": "Commercial Craft", "created_at": extra.pop("created_at", "2026-09-01T00:00:00"),
        **extra,
    }


def test_duplicates_merge_and_progress_repoints(monkeypatch):
    db = _db()
    monkeypatch.setattr(modules_route, "db", db)
    _run(db.training_modules.insert_many([
        _mod("copy-a", created_at="2026-09-01T00:00:00"),
        _mod("copy-b", created_at="2026-09-01T00:00:05"),
    ]))
    # Progress lives on the newer copy — it must survive the merge.
    _run(db.module_progress.insert_one(
        {"id": "p1", "module_id": "copy-b", "target_user_id": "u1", "user_id": "u1", "stage": 1, "ladder": 2}
    ))

    _run(modules_route._ensure_seeded(OFFICE))

    remaining = _run(db.training_modules.find({"office_id": OFFICE, "topic": TOPIC}).to_list(10))
    assert len(remaining) == 1
    assert remaining[0]["id"] == "copy-b"  # most progress wins
    prog = _run(db.module_progress.find_one({"target_user_id": "u1"}))
    assert prog["module_id"] == "copy-b" and prog["ladder"] == 2


def test_progress_on_both_copies_never_doubles(monkeypatch):
    db = _db()
    monkeypatch.setattr(modules_route, "db", db)
    _run(db.training_modules.insert_many([
        _mod("copy-a", created_at="2026-09-01T00:00:00"),
        _mod("copy-b", created_at="2026-09-01T00:00:05"),
    ]))
    _run(db.module_progress.insert_many([
        {"id": "p1", "module_id": "copy-a", "target_user_id": "u1", "user_id": "u1", "stage": 1, "ladder": 3},
        {"id": "p2", "module_id": "copy-a", "target_user_id": "u2", "user_id": "u2", "stage": 1, "ladder": 1},
        {"id": "p3", "module_id": "copy-b", "target_user_id": "u1", "user_id": "u1", "stage": 1, "ladder": 1},
    ]))

    _run(modules_route._ensure_seeded(OFFICE))

    remaining = _run(db.training_modules.find({"office_id": OFFICE, "topic": TOPIC}).to_list(10))
    assert len(remaining) == 1
    keeper_id = remaining[0]["id"]
    assert keeper_id == "copy-a"  # two progress rows beat one
    # u1 had rows on BOTH copies → exactly one survives, on the keeper.
    u1_rows = _run(db.module_progress.find({"target_user_id": "u1"}).to_list(10))
    assert len(u1_rows) == 1 and u1_rows[0]["module_id"] == keeper_id
    # u2's row re-pointed, not lost.
    u2 = _run(db.module_progress.find_one({"target_user_id": "u2"}))
    assert u2["module_id"] == keeper_id


def test_vetted_copy_survives_over_progress(monkeypatch):
    db = _db()
    monkeypatch.setattr(modules_route, "db", db)
    _run(db.training_modules.insert_many([
        _mod("copy-vetted", cod_vetted_at="2026-09-01T12:00:00", created_at="2026-09-01T00:00:05"),
        _mod("copy-graded", created_at="2026-09-01T00:00:00"),
    ]))
    _run(db.module_progress.insert_one(
        {"id": "p1", "module_id": "copy-graded", "target_user_id": "u1", "user_id": "u1", "stage": 1, "ladder": 2}
    ))

    _run(modules_route._ensure_seeded(OFFICE))

    remaining = _run(db.training_modules.find({"office_id": OFFICE, "topic": TOPIC}).to_list(10))
    assert len(remaining) == 1
    assert remaining[0]["id"] == "copy-vetted"  # leadership's wording is never lost
    prog = _run(db.module_progress.find_one({"target_user_id": "u1"}))
    assert prog["module_id"] == "copy-vetted"


def test_repeated_seeding_is_idempotent(monkeypatch):
    db = _db()
    monkeypatch.setattr(modules_route, "db", db)

    _run(modules_route._ensure_seeded(OFFICE))
    _run(modules_route._ensure_seeded(OFFICE))

    total = _run(db.training_modules.count_documents({"office_id": OFFICE}))
    assert total == len(all_seed_modules())
    keys = _run(db.training_modules.distinct("topic", {"office_id": OFFICE, "stage": 1}))
    stage1 = [m for m in all_seed_modules() if m["stage"] == 1]
    assert len(keys) == len(stage1)
