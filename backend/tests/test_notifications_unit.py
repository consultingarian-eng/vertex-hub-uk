"""No-network unit tests for the in-app notification inbox + admin broadcast."""

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import notify  # noqa: E402
from routes import notifications  # noqa: E402


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


def _match(doc, query):
    for key, cond in query.items():
        if key == "$or":
            if not any(_match(doc, sub) for sub in cond):
                return False
            continue
        val = doc.get(key)
        if isinstance(cond, dict) and "$ne" in cond:
            if val == cond["$ne"]:
                return False
        elif isinstance(val, list):
            if cond not in val:
                return False
        elif val != cond:
            return False
    return True


class _Cursor:
    def __init__(self, rows):
        self.rows = list(rows)

    def sort(self, field, direction=1):
        self.rows.sort(key=lambda r: r.get(field), reverse=(direction == -1))
        return self

    def skip(self, n):
        self.rows = self.rows[n:]
        return self

    async def to_list(self, limit):
        return self.rows[:limit]

    def __aiter__(self):
        self._it = iter(self.rows)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _Notifications:
    def __init__(self, rows=None, fail_insert=False):
        self.rows = list(rows or [])
        self.fail_insert = fail_insert
        self.deleted_ids = []

    async def insert_one(self, doc):
        if self.fail_insert:
            raise RuntimeError("mongo down")
        self.rows.append(dict(doc))

    def find(self, query, _projection=None):
        return _Cursor([dict(r) for r in self.rows if _match(r, query)])

    async def delete_many(self, query):
        ids = set(query["id"]["$in"])
        self.deleted_ids.extend(sorted(ids))
        self.rows = [r for r in self.rows if r["id"] not in ids]


# ─── record_notification ─────────────────────────────────────────────────────

def test_record_notification_writes_row_and_caps_read_rows(monkeypatch):
    read_rows = [
        {"id": f"n{i:03d}", "user_id": "user-1", "read": True, "created_at": f"t{i:04d}"}
        for i in range(notify.READ_CAP + 50)
    ]
    coll = _Notifications(rows=read_rows)
    monkeypatch.setattr(notify, "db", SimpleNamespace(notifications=coll))

    asyncio.run(notify.record_notification(
        "user-1", "Hello", "World",
        data={"type": "broadcast", "url": "/x"},
        office_id="office-a",
    ))

    new = [r for r in coll.rows if r.get("read") is False]
    assert len(new) == 1
    row = new[0]
    assert row["user_id"] == "user-1"
    assert row["title"] == "Hello"
    assert row["body"] == "World"
    assert row["type"] == "broadcast"
    assert row["data"] == {"type": "broadcast", "url": "/x"}
    assert row["office_id"] == "office-a"
    assert row["id"] and row["created_at"]

    # The 50 OLDEST read rows were pruned; the newest READ_CAP survive.
    assert set(coll.deleted_ids) == {f"n{i:03d}" for i in range(50)}
    assert sum(1 for r in coll.rows if r.get("read")) == notify.READ_CAP


def test_record_notification_defaults_type_and_never_raises(monkeypatch):
    coll = _Notifications()
    monkeypatch.setattr(notify, "db", SimpleNamespace(notifications=coll))
    asyncio.run(notify.record_notification("user-1", "T", "B"))
    assert coll.rows[0]["type"] == "general"
    assert coll.rows[0]["data"] == {}
    assert coll.rows[0]["office_id"] is None

    broken = _Notifications(fail_insert=True)
    monkeypatch.setattr(notify, "db", SimpleNamespace(notifications=broken))
    # Must swallow the failure — inbox writes are fire-and-forget.
    asyncio.run(notify.record_notification("user-1", "T", "B"))
    assert broken.rows == []


# ─── broadcast ───────────────────────────────────────────────────────────────

class _Users:
    def __init__(self, rows):
        self.rows = rows
        self.queries = []

    def find(self, query, _projection=None):
        self.queries.append(query)
        return _Cursor([r for r in self.rows if _match(r, query)])


def _wire_broadcast(monkeypatch, admin, users):
    pushes = []
    audits = []

    async def fake_require_admin(_request):
        return admin

    async def fake_push(user_id, title, body, data=None):
        pushes.append({"user_id": user_id, "title": title, "body": body, "data": data})

    async def fake_audit(actor_user, action, target=None, details=None):
        audits.append({"actor": actor_user, "action": action, "details": details})

    monkeypatch.setattr(notifications, "require_admin", fake_require_admin)
    monkeypatch.setattr(notifications, "send_push_to_user", fake_push)
    monkeypatch.setattr(notifications, "audit", fake_audit)
    monkeypatch.setattr(notifications, "db", SimpleNamespace(users=users))
    return pushes, audits


_USER_ROWS = [
    {"_id": "trainee-a", "role": "trainee", "office_id": "office-a"},
    {"_id": "trainee-b", "role": "trainee", "office_id": "office-b"},
    {"_id": "leader-a", "role": "leader", "office_id": "office-a"},
    {"_id": "trainee-a-del", "role": "trainee", "office_id": "office-a", "deleted": True},
    {"_id": "trainee-a-off", "role": "trainee", "office_id": "office-a", "is_active": False},
]


def test_broadcast_pins_plain_admin_to_own_office(monkeypatch):
    users = _Users(_USER_ROWS)
    admin = {"id": "admin-1", "name": "Ada", "role": "admin", "office_id": "office-a"}
    pushes, audits = _wire_broadcast(monkeypatch, admin, users)

    body = notifications.BroadcastBody(
        title="Heads up", body="Meeting at 9",
        audience="trainees", office_id="office-b",  # must be ignored
    )
    result = asyncio.run(notifications.broadcast_notification(body, _request(method="POST")))

    assert result == {"sent": 1}
    assert [p["user_id"] for p in pushes] == ["trainee-a"]
    assert pushes[0]["data"]["type"] == "broadcast"
    assert users.queries[0]["office_id"] == "office-a"
    assert users.queries[0]["role"] == "trainee"
    assert len(audits) == 1
    assert audits[0]["action"] == "broadcast_notification"
    assert audits[0]["details"]["audience"] == "trainees"
    assert audits[0]["details"]["sent"] == 1


def test_broadcast_super_admin_office_param_and_everyone(monkeypatch):
    users = _Users(_USER_ROWS)
    admin = {
        "id": "super-1", "name": "Sue", "role": "admin", "office_id": "office-a",
        "is_super_admin": True, "accessible_offices": ["office-a", "office-b"],
    }
    pushes, _audits = _wire_broadcast(monkeypatch, admin, users)

    body = notifications.BroadcastBody(title="T", body="B", audience="office", office_id="office-b")
    result = asyncio.run(notifications.broadcast_notification(body, _request(method="POST")))
    assert result == {"sent": 1}
    assert [p["user_id"] for p in pushes] == ["trainee-b"]
    assert users.queries[0]["office_id"] == "office-b"

    # "everyone" with no office param spans ALL offices (active users only).
    pushes.clear()
    body = notifications.BroadcastBody(title="T", body="B", audience="everyone")
    result = asyncio.run(notifications.broadcast_notification(body, _request(method="POST")))
    assert result == {"sent": 3}
    assert "office_id" not in users.queries[-1]

    # An office outside accessible_offices fails closed.
    body = notifications.BroadcastBody(title="T", body="B", audience="office", office_id="office-x")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(notifications.broadcast_notification(body, _request(method="POST")))
    assert exc.value.status_code == 403


def test_broadcast_rejects_bad_audience_and_empty_title(monkeypatch):
    users = _Users(_USER_ROWS)
    admin = {"id": "admin-1", "name": "Ada", "role": "admin", "office_id": "office-a"}
    _wire_broadcast(monkeypatch, admin, users)

    body = notifications.BroadcastBody(title="T", body="B", audience="managers")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(notifications.broadcast_notification(body, _request(method="POST")))
    assert exc.value.status_code == 400

    body = notifications.BroadcastBody(title="  ", body="B", audience="everyone")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(notifications.broadcast_notification(body, _request(method="POST")))
    assert exc.value.status_code == 400
