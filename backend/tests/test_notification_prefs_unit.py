"""No-network unit tests for notification-type preferences.

Covers the category map, the send_push_to_user enforcement gate (off means
off: no expo push, no inbox row, no web push), the schedule web-push helper,
and the GET/PUT /notifications/prefs endpoints.
"""

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from bson import ObjectId
from fastapi import HTTPException
from starlette.requests import Request


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import notify, push, webpush  # noqa: E402
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


# ─── category mapping ────────────────────────────────────────────────────────

def test_notification_category_maps_every_known_type():
    expected = {
        "broadcast": "announcements",
        "weekly_bulletins": "announcements",
        "grading_reminder": "grading",
        "morning_briefing": "briefing",
        "assessment_complete": "briefing",
        "weekly_planner_nudge": "planning",
        "primetime_nudge": "planning",
        "ci_ready": "coaching",
        "ci_comment": "coaching",
        "schedule": "schedule",
        "absence_request": "schedule",
        "absence_decision": "schedule",
        "badge_earned": "milestones",
        "promotion": "milestones",
        "new_hire": "milestones",
    }
    for push_type, category in expected.items():
        assert push.notification_category({"type": push_type}) == category
    # Every mapped category is a real, listed category.
    keys = {c["key"] for c in push.NOTIFICATION_CATEGORIES}
    assert set(expected.values()) <= keys
    assert "other" in keys


def test_notification_category_unknown_or_missing_is_other():
    assert push.notification_category({"type": "brand_new_thing"}) == "other"
    assert push.notification_category({"url": "/x"}) == "other"
    assert push.notification_category({}) == "other"
    assert push.notification_category(None) == "other"


def test_is_category_enabled_defaults_on_and_honors_explicit_off():
    data = {"type": "broadcast"}
    assert push.is_category_enabled(None, data) is True
    assert push.is_category_enabled({}, data) is True
    assert push.is_category_enabled({"notification_prefs": None}, data) is True
    assert push.is_category_enabled({"notification_prefs": "junk"}, data) is True
    assert push.is_category_enabled({"notification_prefs": {}}, data) is True
    assert push.is_category_enabled(
        {"notification_prefs": {"announcements": True}}, data) is True
    # Only an explicit False switches a category off — and only that category.
    prefs = {"notification_prefs": {"announcements": False}}
    assert push.is_category_enabled(prefs, data) is False
    assert push.is_category_enabled(prefs, {"type": "promotion"}) is True
    assert push.is_category_enabled(
        {"notification_prefs": {"other": False}}, {"type": "mystery"}) is False


# ─── send_push_to_user enforcement ───────────────────────────────────────────

class _Users:
    def __init__(self, doc=None, fail=False):
        self.doc = doc
        self.fail = fail

    async def find_one(self, _query, _projection=None):
        if self.fail:
            raise RuntimeError("mongo down")
        return dict(self.doc) if self.doc else None


def _wire_push(monkeypatch, users):
    """Fake every channel behind send_push_to_user; return the capture lists."""
    expo, inbox, web = [], [], []

    async def fake_expo(token, title, body, data=None):
        expo.append({"token": token, "title": title})

    async def fake_inbox(user_id, title, body, data=None, office_id=None):
        inbox.append({"user_id": user_id, "title": title, "data": data})

    async def fake_web(user_id, title, body, data=None):
        web.append({"user_id": user_id, "title": title})

    monkeypatch.setattr(push, "db", SimpleNamespace(users=users))
    monkeypatch.setattr(push, "send_push_to_token", fake_expo)
    # push.py imports these lazily at call time, so patch the source modules.
    monkeypatch.setattr(notify, "record_notification", fake_inbox)
    monkeypatch.setattr(webpush, "send_web_push_to_user", fake_web)
    return expo, inbox, web


_UID = str(ObjectId())


def test_disabled_category_skips_expo_inbox_and_web(monkeypatch):
    users = _Users({
        "_id": ObjectId(_UID), "expo_push_token": "ExponentPushToken[x]",
        "office_id": "office-a",
        "notification_prefs": {"announcements": False},
    })
    expo, inbox, web = _wire_push(monkeypatch, users)

    asyncio.run(push.send_push_to_user(_UID, "T", "B", {"type": "broadcast"}))

    assert expo == [] and inbox == [] and web == []


def test_enabled_and_missing_prefs_send_on_every_channel(monkeypatch):
    # No prefs field at all → everything sends.
    users = _Users({
        "_id": ObjectId(_UID), "expo_push_token": "ExponentPushToken[x]",
        "office_id": "office-a",
    })
    expo, inbox, web = _wire_push(monkeypatch, users)
    asyncio.run(push.send_push_to_user(_UID, "T", "B", {"type": "broadcast"}))
    assert len(expo) == len(inbox) == len(web) == 1

    # A different category switched off doesn't touch this one.
    users = _Users({
        "_id": ObjectId(_UID), "expo_push_token": "ExponentPushToken[x]",
        "notification_prefs": {"grading": False},
    })
    expo, inbox, web = _wire_push(monkeypatch, users)
    asyncio.run(push.send_push_to_user(_UID, "T", "B", {"type": "broadcast"}))
    assert len(expo) == len(inbox) == len(web) == 1


def test_prefs_read_failure_never_blocks_the_send(monkeypatch):
    # The users lookup blows up entirely → inbox + web still fire (expo can't:
    # there is no token to send to), exactly as before the pref gate existed.
    expo, inbox, web = _wire_push(monkeypatch, _Users(fail=True))
    asyncio.run(push.send_push_to_user(_UID, "T", "B", {"type": "broadcast"}))
    assert expo == []
    assert len(inbox) == 1 and len(web) == 1


def test_missing_user_still_sends_nothing(monkeypatch):
    expo, inbox, web = _wire_push(monkeypatch, _Users(doc=None))
    asyncio.run(push.send_push_to_user(_UID, "T", "B", {"type": "broadcast"}))
    assert expo == [] and inbox == [] and web == []


def test_is_category_enabled_for_user_id_gates_and_fails_open(monkeypatch):
    data = {"type": "schedule"}
    monkeypatch.setattr(push, "db", SimpleNamespace(users=_Users({
        "_id": ObjectId(_UID), "notification_prefs": {"schedule": False},
    })))
    assert asyncio.run(push.is_category_enabled_for_user_id(_UID, data)) is False

    monkeypatch.setattr(push, "db", SimpleNamespace(users=_Users({
        "_id": ObjectId(_UID),
    })))
    assert asyncio.run(push.is_category_enabled_for_user_id(_UID, data)) is True

    monkeypatch.setattr(push, "db", SimpleNamespace(users=_Users(fail=True)))
    assert asyncio.run(push.is_category_enabled_for_user_id(_UID, data)) is True


# ─── GET /notifications/prefs ────────────────────────────────────────────────

def _wire_prefs(monkeypatch, user, users_coll=None):
    async def fake_get_current_user(_request):
        return user

    monkeypatch.setattr(notifications, "get_current_user", fake_get_current_user)
    if users_coll is not None:
        monkeypatch.setattr(notifications, "db", SimpleNamespace(users=users_coll))


def _visible_keys(result):
    return [c["key"] for c in result["categories"]]


def test_get_prefs_filters_categories_by_role(monkeypatch):
    _wire_prefs(monkeypatch, {"id": _UID, "role": "admin"})
    admin_keys = _visible_keys(asyncio.run(
        notifications.get_notification_prefs(_request())))
    assert "grading" in admin_keys and "planning" in admin_keys
    assert "briefing" not in admin_keys

    _wire_prefs(monkeypatch, {"id": _UID, "role": "leader"})
    leader_keys = _visible_keys(asyncio.run(
        notifications.get_notification_prefs(_request())))
    assert "briefing" not in leader_keys
    assert "grading" in leader_keys and "planning" in leader_keys

    _wire_prefs(monkeypatch, {"id": _UID, "role": "trainee"})
    trainee_keys = _visible_keys(asyncio.run(
        notifications.get_notification_prefs(_request())))
    assert "briefing" in trainee_keys
    for hidden in ("grading", "planning"):
        assert hidden not in trainee_keys
    # The everyone categories reach every role.
    for role_keys in (admin_keys, leader_keys, trainee_keys):
        for common in ("announcements", "coaching", "schedule", "milestones", "other"):
            assert common in role_keys


def test_get_prefs_reflects_saved_toggles_and_defaults_on(monkeypatch):
    _wire_prefs(monkeypatch, {
        "id": _UID, "role": "trainee",
        "notification_prefs": {"briefing": False, "milestones": True},
    })
    result = asyncio.run(notifications.get_notification_prefs(_request()))
    by_key = {c["key"]: c for c in result["categories"]}
    assert by_key["briefing"]["enabled"] is False
    assert by_key["milestones"]["enabled"] is True
    assert by_key["schedule"]["enabled"] is True  # never saved → on
    assert by_key["briefing"]["label"] and by_key["briefing"]["description"]


# ─── PUT /notifications/prefs ────────────────────────────────────────────────

class _UsersWrite:
    def __init__(self):
        self.updates = []

    async def update_one(self, query, update):
        self.updates.append((query, update))
        return SimpleNamespace(matched_count=1, modified_count=1)


def test_put_prefs_persists_single_key(monkeypatch):
    coll = _UsersWrite()
    _wire_prefs(monkeypatch, {"id": _UID, "role": "admin"}, users_coll=coll)

    body = notifications.NotificationPrefsBody(key="planning", enabled=False)
    result = asyncio.run(notifications.put_notification_prefs(body, _request(method="PUT")))

    assert result == {"ok": True, "prefs": {"planning": False}}
    query, update = coll.updates[0]
    assert query == {"_id": ObjectId(_UID)}
    assert update == {"$set": {"notification_prefs.planning": False}}


def test_put_prefs_persists_batch_and_drops_unknown_keys(monkeypatch):
    coll = _UsersWrite()
    _wire_prefs(monkeypatch, {"id": _UID, "role": "leader"}, users_coll=coll)

    body = notifications.NotificationPrefsBody(
        prefs={"grading": False, "schedule": True, "made_up": False})
    result = asyncio.run(notifications.put_notification_prefs(body, _request(method="PUT")))

    assert result["prefs"] == {"grading": False, "schedule": True}
    _query, update = coll.updates[0]
    assert update == {"$set": {
        "notification_prefs.grading": False,
        "notification_prefs.schedule": True,
    }}


def test_put_prefs_rejects_unknown_single_key_and_empty_body(monkeypatch):
    coll = _UsersWrite()
    _wire_prefs(monkeypatch, {"id": _UID, "role": "admin"}, users_coll=coll)

    body = notifications.NotificationPrefsBody(key="made_up", enabled=False)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(notifications.put_notification_prefs(body, _request(method="PUT")))
    assert exc.value.status_code == 400

    body = notifications.NotificationPrefsBody()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(notifications.put_notification_prefs(body, _request(method="PUT")))
    assert exc.value.status_code == 400

    body = notifications.NotificationPrefsBody(key="planning")  # no enabled
    with pytest.raises(HTTPException) as exc:
        asyncio.run(notifications.put_notification_prefs(body, _request(method="PUT")))
    assert exc.value.status_code == 400
    assert coll.updates == []
