"""No-network regression tests for the security-critical authorization paths."""

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from bson import ObjectId
from fastapi import HTTPException, Response
from starlette.requests import Request


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import auth  # noqa: E402
from core import office_helpers  # noqa: E402
from routes import auth_routes, bells, manual_editor, schedule, training_routes  # noqa: E402


def _request(*, method="GET", headers=None, body=None):
    raw = b"" if body is None else json.dumps(body).encode()
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": raw, "more_body": False}

    pairs = []
    for key, value in (headers or {}).items():
        pairs.append((key.lower().encode(), value.encode()))
    return Request({
        "type": "http",
        "method": method,
        "path": "/test",
        "query_string": b"",
        "headers": pairs,
        "client": ("127.0.0.1", 50000),
        "server": ("test", 443),
        "scheme": "https",
    }, receive)


class _FindOne:
    def __init__(self, callback):
        self.callback = callback

    async def find_one(self, query, *args, **kwargs):
        return self.callback(query, *args, **kwargs)


class _Cursor:
    def __init__(self, rows):
        self.rows = list(rows)

    def sort(self, *_args, **_kwargs):
        return self

    async def to_list(self, _limit):
        return list(self.rows)


def test_resolve_office_pins_ordinary_user_and_validates_super(monkeypatch):
    calls = []

    def lookup(query, *_args, **_kwargs):
        calls.append(query)
        return {"id": "office-b"} if query.get("id") == "office-b" else None

    monkeypatch.setattr(office_helpers, "db", SimpleNamespace(offices=_FindOne(lookup)))
    req = _request()
    ordinary = {"role": "admin", "office_id": "office-a"}
    assert asyncio.run(office_helpers.resolve_office_id(req, ordinary, "office-b")) == "office-a"
    assert calls == []

    super_admin = {"role": "admin", "is_super_admin": True, "accessible_offices": ["office-b"]}
    assert asyncio.run(office_helpers.resolve_office_id(req, super_admin, "office-b")) == "office-b"
    with pytest.raises(HTTPException) as exc:
        asyncio.run(office_helpers.resolve_office_id(req, super_admin, "office-x"))
    assert exc.value.status_code == 403


def test_explicit_bearer_wins_over_stale_cookie(monkeypatch):
    oid = ObjectId()
    token = auth.create_access_token(str(oid), "user@example.test", 4)

    def user_lookup(query, *_args, **_kwargs):
        assert query["_id"] == oid
        return {
            "_id": oid,
            "email": "user@example.test",
            "role": "leader",
            "session_version": 4,
        }

    monkeypatch.setattr(auth, "db", SimpleNamespace(users=_FindOne(user_lookup)))
    req = _request(headers={
        "Authorization": f"Bearer {token}",
        "Cookie": "access_token=definitely-stale",
    })
    user = asyncio.run(auth.get_current_user(req))
    assert user["id"] == str(oid)


def test_refresh_body_wins_over_stale_cookie_and_malformed_sub_is_401(monkeypatch):
    oid = ObjectId()
    refresh = auth.create_refresh_token(str(oid), 2)

    def user_lookup(query, *_args, **_kwargs):
        return {
            "_id": oid,
            "email": "user@example.test",
            "role": "leader",
            "session_version": 2,
        }

    fake_db = SimpleNamespace(users=_FindOne(user_lookup))
    monkeypatch.setattr(auth_routes, "db", fake_db)
    response = Response()
    req = _request(
        method="POST",
        headers={"Cookie": "refresh_token=definitely-stale", "Content-Type": "application/json"},
        body={"refresh_token": refresh},
    )
    result = asyncio.run(auth_routes.refresh_token(req, response))
    assert result["token"]

    malformed = auth.create_access_token("not-an-object-id", "bad@example.test")
    monkeypatch.setattr(auth, "db", fake_db)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth.get_current_user(_request(headers={"Authorization": f"Bearer {malformed}"})))
    assert exc.value.status_code == 401


def test_linked_hire_does_not_use_duplicate_leader_name_fallback(monkeypatch):
    leader_id = str(ObjectId())
    unrelated_trainee_id = str(ObjectId())

    async def subtree(_user_id):
        return [leader_id]

    class Users:
        def find(self, *_args, **_kwargs):
            return _Cursor([])

        async def find_one(self, *_args, **_kwargs):
            return {"name": "Duplicate Name", "role": "leader", "office_id": "office-a"}

    hire = {
        "id": "hire-other",
        "office_id": "office-a",
        "leader": "Duplicate Name",
        "trainee_user_id": unrelated_trainee_id,
    }
    monkeypatch.setattr(auth, "get_subtree_ids", subtree)
    monkeypatch.setattr(auth, "db", SimpleNamespace(
        users=Users(),
        new_hires=_FindOne(lambda *_args, **_kwargs: hire),
    ))
    allowed = asyncio.run(auth.can_access_hire({
        "id": leader_id,
        "role": "leader",
        "name": "Duplicate Name",
        "office_id": "office-a",
    }, "hire-other"))
    assert allowed is False


def test_trainee_hire_list_uses_stable_own_links_only(monkeypatch):
    captured = {}

    class Hires:
        def find(self, query):
            captured.update(query)
            return _Cursor([])

    async def current_user(_request):
        return {
            "id": "trainee-user",
            "role": "trainee",
            "office_id": "office-a",
            # Deliberately absent new_hire_id: trainee_user_id remains a
            # valid stable backlink and must not widen to the whole office.
        }

    monkeypatch.setattr(training_routes, "get_current_user", current_user)
    monkeypatch.setattr(training_routes, "db", SimpleNamespace(new_hires=Hires()))
    result = asyncio.run(training_routes.get_new_hires(_request()))
    assert result == []
    assert captured["office_id"] == "office-a"
    assert captured["$or"] == [{"trainee_user_id": "trainee-user"}]


def test_bells_rejects_foreign_target_and_manual_editor_pins_office(monkeypatch):
    async def current_user(_request):
        return {"id": str(ObjectId()), "role": "admin", "office_id": "office-a"}

    async def resolved(*_args, **_kwargs):
        return "office-a"

    foreign_id = ObjectId()
    monkeypatch.setattr(bells, "get_current_user", current_user)
    monkeypatch.setattr(bells, "resolve_office_id", resolved)
    monkeypatch.setattr(bells, "db", SimpleNamespace(users=_FindOne(
        lambda *_args, **_kwargs: {
            "_id": foreign_id,
            "name": "Canonical User",
            "role": "trainee",
            "office_id": "office-b",
        }
    )))
    req = _request(method="POST", body={
        "week_ending": "2026-07-12",
        "office_id": "office-a",
        "user_id": str(foreign_id),
        "user_name": "Spoofed Name",
        "days": [],
    })
    with pytest.raises(HTTPException) as exc:
        asyncio.run(bells.upsert_bell(req))
    assert exc.value.status_code == 403

    ctx = {"mode": "user", "user": {"role": "admin", "office_id": "office-a"}}
    assert manual_editor._scoped_office(ctx, None) == "office-a"
    with pytest.raises(HTTPException):
        manual_editor._scoped_office(ctx, "office-b")


def test_schedule_scope_and_reports_to_unlink_clear_cached_leader(monkeypatch):
    monkeypatch.setattr(schedule, "db", SimpleNamespace(
        schedule_blocks=_FindOne(lambda *_args, **_kwargs: {"id": "block-b", "office_id": "office-b"})
    ))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(schedule._scoped_block({"role": "admin", "office_id": "office-a"}, "block-b"))
    assert exc.value.status_code == 403

    target_id = ObjectId()
    user_updates = []
    hire_updates = []

    class Users:
        async def find_one(self, *_args, **_kwargs):
            return {
                "_id": target_id,
                "id": str(target_id),
                "name": "Trainee",
                "role": "trainee",
                "office_id": "office-a",
                "new_hire_id": "hire-a",
                "reports_to": str(ObjectId()),
            }

        async def update_one(self, query, update):
            user_updates.append((query, update))

    class Hires:
        async def update_one(self, query, update):
            hire_updates.append((query, update))

        async def update_many(self, query, update):
            hire_updates.append((query, update))

    async def require_admin(_request):
        return {"id": str(ObjectId()), "role": "admin", "office_id": "office-a"}

    monkeypatch.setattr(training_routes, "require_admin", require_admin)
    monkeypatch.setattr(training_routes, "db", SimpleNamespace(users=Users(), new_hires=Hires()))
    req = _request(method="PUT", body={"reports_to": None})
    asyncio.run(training_routes.set_reports_to(str(target_id), req))
    assert any(update.get("$unset", {}).get("reports_to") == "" for _, update in user_updates)
    assert any(update.get("$set", {}).get("leader") == "Unassigned" for _, update in hire_updates)
