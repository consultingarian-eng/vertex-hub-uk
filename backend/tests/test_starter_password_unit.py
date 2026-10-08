"""The shared starter password: it opens only the change-password door, it
expires, and choosing your own password lifts the hold."""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from bson import ObjectId
from fastapi import HTTPException

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import auth  # noqa: E402
from routes import auth_routes  # noqa: E402


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


class _Users:
    def __init__(self, doc):
        self.doc = doc

    async def find_one(self, q, *a, **k):
        return dict(self.doc)


def _request(path, uid, ver=0):
    token = auth.create_access_token(str(uid), "a@b.co", ver)
    return SimpleNamespace(headers={"Authorization": f"Bearer {token}"}, cookies={}, url=SimpleNamespace(path=path))


def test_starter_account_can_only_reach_the_password_change(monkeypatch):
    uid = ObjectId()
    monkeypatch.setattr(auth, "db", SimpleNamespace(users=_Users({"_id": uid, "email": "a@b.co", "role": "trainee", "must_change_password": True})))
    for ok in ("/api/auth/me", "/api/auth/change-password", "/api/auth/logout"):
        assert _run(auth.get_current_user(_request(ok, uid)))["id"] == str(uid)
    for blocked in ("/api/bells", "/api/team/tree", "/api/owneriq/hub"):
        with pytest.raises(HTTPException) as e:
            _run(auth.get_current_user(_request(blocked, uid)))
        assert e.value.status_code == 403


def test_normal_account_is_not_held(monkeypatch):
    uid = ObjectId()
    monkeypatch.setattr(auth, "db", SimpleNamespace(users=_Users({"_id": uid, "email": "a@b.co", "role": "trainee"})))
    assert _run(auth.get_current_user(_request("/api/bells", uid)))["id"] == str(uid)


def test_starter_password_expires():
    now = datetime.now(timezone.utc)
    assert auth_routes._starter_expired({"starter_password_expires_at": (now - timedelta(minutes=1)).isoformat()}) is True
    assert auth_routes._starter_expired({"starter_password_expires_at": (now + timedelta(days=1)).isoformat()}) is False
    assert auth_routes._starter_expired({}) is False
    assert auth_routes._starter_expired({"starter_password_expires_at": "nonsense"}) is False


def test_scope_leaves_admins_and_the_caller_out():
    me = str(ObjectId())
    q = auth_routes._starter_scope({"id": me}, include_admins=False)
    assert q["role"] == {"$ne": "admin"} and q["_id"] == {"$ne": ObjectId(me)}
    assert "role" not in auth_routes._starter_scope({"id": me}, include_admins=True)
