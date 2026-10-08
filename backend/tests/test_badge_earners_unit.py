"""routes/achievements — the admin earners list + super-admin synthetic badges.

  • /achievements/{key}/earners: admin-only, office-scoped, and the join
    drops deleted / deactivated / demo accounts;
  • /me/badges: super admins get every catalog badge (synthetic, seen=True,
    never persisted) merged with their real earns — everyone else gets only
    what they actually earned.

Pure in-memory: mongomock + patched get_current_user.
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

from routes import achievements as ach_route  # noqa: E402
from core.achievements import ACHIEVEMENTS  # noqa: E402

OFFICE = "office-boston"
OTHER = "office-newhaven"
KEY = ACHIEVEMENTS[0]["key"]


def _run(coro):
    return asyncio.run(coro)


def _db():
    return AsyncMongoMockClient()["cg1_badges_test"]


def _patch_auth(monkeypatch, user):
    async def fake(_request):
        return user
    monkeypatch.setattr(ach_route, "get_current_user", fake)


def _mk_user(db, office=OFFICE, **extra):
    oid = ObjectId()
    _run(db.users.insert_one({"_id": oid, "name": extra.pop("name", "Rep"), "role": "trainee", "office_id": office, **extra}))
    return str(oid)


def _award(db, uid, key=KEY, when="2026-08-01T00:00:00"):
    _run(db.user_badges.insert_one({"id": f"b-{uid}-{key}", "user_id": uid, "key": key, "earned_at": when, "seen": True}))


def test_earners_admin_only(monkeypatch):
    db = _db()
    monkeypatch.setattr(ach_route, "db", db)
    _patch_auth(monkeypatch, {"id": "u1", "role": "leader", "office_id": OFFICE})
    with pytest.raises(HTTPException) as e:
        _run(ach_route.get_badge_earners(KEY, None))
    assert e.value.status_code == 403


def test_earners_unknown_key_404(monkeypatch):
    db = _db()
    monkeypatch.setattr(ach_route, "db", db)
    _patch_auth(monkeypatch, {"id": "u1", "role": "admin", "office_id": OFFICE})
    with pytest.raises(HTTPException) as e:
        _run(ach_route.get_badge_earners("not-a-badge", None))
    assert e.value.status_code == 404


def test_earners_scoped_and_filtered(monkeypatch):
    db = _db()
    monkeypatch.setattr(ach_route, "db", db)
    keeper = _mk_user(db, name="Keeper")
    other_office = _mk_user(db, office=OTHER, name="Foreign")
    deleted = _mk_user(db, name="Binned", deleted=True)
    inactive = _mk_user(db, name="Left", is_active=False)
    demo = _mk_user(db, name="Demo", is_demo=True)
    for uid in (keeper, other_office, deleted, inactive, demo):
        _award(db, uid)
    _patch_auth(monkeypatch, {"id": "adm", "role": "admin", "office_id": OFFICE})

    out = _run(ach_route.get_badge_earners(KEY, None))
    names = [e["name"] for e in out["earners"]]
    assert names == ["Keeper"]
    assert out["office_id"] == OFFICE


def test_super_admin_gets_synthetic_full_set(monkeypatch):
    db = _db()
    monkeypatch.setattr(ach_route, "db", db)
    _award(db, "super-1", key=ACHIEVEMENTS[0]["key"])  # one REAL earn
    _patch_auth(monkeypatch, {"id": "super-1", "role": "admin", "office_id": OFFICE, "is_super_admin": True})

    # Sales Development Path dark (default env): the five sales_* ladder
    # badges are hidden from the synthetic set too — locked tiles describing
    # the feature would announce it before launch.
    monkeypatch.delenv("SALES_PATH_ENABLED", raising=False)
    rows = _run(ach_route.get_my_badges(None))
    visible = [a for a in ACHIEVEMENTS if not a["key"].startswith("sales_")]
    assert len(rows) == len(visible)
    by_key = {r["key"]: r for r in rows}
    # The real earn stays real; the rest are synthetic + pre-seen (no confetti).
    assert not by_key[ACHIEVEMENTS[0]["key"]].get("synthetic")
    others = [r for r in rows if r["key"] != ACHIEVEMENTS[0]["key"]]
    assert others and all(r.get("synthetic") and r.get("seen") for r in others)
    # Nothing synthetic ever persisted — the earners list stays honest.
    assert _run(db.user_badges.count_documents({})) == 1

    # Flag on for the office → the full catalog, sales ladder included.
    monkeypatch.setenv("SALES_PATH_ENABLED", "true")
    monkeypatch.delenv("SALES_PATH_OFFICES", raising=False)
    rows_on = _run(ach_route.get_my_badges(None))
    assert len(rows_on) == len(ACHIEVEMENTS)


def test_regular_user_gets_only_real_badges(monkeypatch):
    db = _db()
    monkeypatch.setattr(ach_route, "db", db)
    _award(db, "rep-1")
    _patch_auth(monkeypatch, {"id": "rep-1", "role": "trainee", "office_id": OFFICE})
    rows = _run(ach_route.get_my_badges(None))
    assert len(rows) == 1 and rows[0]["key"] == KEY
