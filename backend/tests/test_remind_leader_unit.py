"""Admin one-tap remind-leader nudge (IMPROVEMENT-PACK 4.5) unit tests.

POST /leader/today/remind/{leader_user_id}:
  • Admin-only — the REAL require_admin guard runs (only get_current_user is
    faked), so a leader/trainee caller genuinely 403s.
  • Sends exactly ONE push ("📋 {admin first name} nudged you — …",
    data {"type": "grading_reminder", "url": "/"}) and stamps admin_nudge_at
    on the leader's assessment_reminder_state doc.
  • Throttle: a second nudge inside MIN_GAP_HOURS 429s with a friendly
    retry-time detail and sends nothing; after the gap it flows again.
  • Sibling-key isolation: the automatic tick's last_sent_at must NOT block
    an admin nudge (and the admin key never touches last_sent_at).
  • Unknown / non-leader targets 404.

Pure in-memory: mongomock_motor, no network, no real Mongo.
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from bson import ObjectId
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import auth  # noqa: E402
from routes import leader_today  # noqa: E402
from routes.leader_today import MIN_GAP_HOURS  # noqa: E402


def _db():
    return AsyncMongoMockClient()["cg1_remind_leader_test"]


def _run(coro):
    return asyncio.run(coro)


ADMIN = {"id": "u-admin", "name": "Ada Lovelace", "role": "admin", "office_id": "office-A"}
LEADER = {"id": "u-leader", "name": "Lena", "role": "leader", "office_id": "office-A"}

LEADER_OID = ObjectId()
LEADER_UID = str(LEADER_OID)


def _patch(monkeypatch, db, caller):
    """Wire the route to mongomock + a push recorder. Only get_current_user is
    faked — require_admin itself stays real, so the role guard is exercised."""
    sent: list[dict] = []

    async def _user(_request):
        return dict(caller)

    async def _push(user_id, title, body, data=None):
        sent.append({"user_id": user_id, "title": title, "body": body, "data": data})

    monkeypatch.setattr(auth, "get_current_user", _user)
    monkeypatch.setattr(leader_today, "db", db)
    monkeypatch.setattr(leader_today, "send_push_to_user", _push)
    return sent


def _seed_leader(db):
    _run(db.users.insert_one(
        {"_id": LEADER_OID, "name": "Lena Lee", "role": "leader", "office_id": "office-A"}
    ))


# ── Happy path ────────────────────────────────────────────────────────────

def test_remind_sends_one_push_and_stamps_state(monkeypatch):
    db = _db()
    _seed_leader(db)
    sent = _patch(monkeypatch, db, ADMIN)

    out = _run(leader_today.remind_leader(LEADER_UID, request=None))
    assert out == {"ok": True, "nudged": LEADER_UID}

    assert len(sent) == 1
    p = sent[0]
    assert p["user_id"] == LEADER_UID
    assert p["title"] == "📋 Ada nudged you — assessments waiting"
    assert p["data"] == {"type": "grading_reminder", "url": "/"}

    state = _run(db.assessment_reminder_state.find_one({"_id": LEADER_UID}))
    assert state["admin_nudge_at"]
    assert state["admin_nudge_by"] == ADMIN["id"]
    # Sibling key only — the automatic tick's throttle field is untouched.
    assert "last_sent_at" not in state


# ── Throttle ──────────────────────────────────────────────────────────────

def test_second_nudge_inside_gap_429s_and_sends_nothing(monkeypatch):
    db = _db()
    _seed_leader(db)
    sent = _patch(monkeypatch, db, ADMIN)

    _run(leader_today.remind_leader(LEADER_UID, request=None))
    with pytest.raises(HTTPException) as exc:
        _run(leader_today.remind_leader(LEADER_UID, request=None))
    assert exc.value.status_code == 429
    assert "try again after" in exc.value.detail
    assert len(sent) == 1  # the 429 attempt pushed nothing


def test_nudge_flows_again_after_gap(monkeypatch):
    db = _db()
    _seed_leader(db)
    stale = (datetime.now(timezone.utc) - timedelta(hours=MIN_GAP_HOURS, minutes=1)).isoformat()
    _run(db.assessment_reminder_state.insert_one(
        {"_id": LEADER_UID, "admin_nudge_at": stale, "admin_nudge_by": "u-other-admin"}
    ))
    sent = _patch(monkeypatch, db, ADMIN)

    out = _run(leader_today.remind_leader(LEADER_UID, request=None))
    assert out["ok"] is True
    assert len(sent) == 1
    state = _run(db.assessment_reminder_state.find_one({"_id": LEADER_UID}))
    assert state["admin_nudge_at"] > stale
    assert state["admin_nudge_by"] == ADMIN["id"]


def test_cron_tick_throttle_does_not_block_admin_nudge(monkeypatch):
    """The automatic tick's last_sent_at is a SIBLING key — a cron reminder
    five minutes ago must not swallow an explicit admin tap."""
    db = _db()
    _seed_leader(db)
    _run(db.assessment_reminder_state.insert_one({
        "_id": LEADER_UID,
        "last_sent_at": datetime.now(timezone.utc).isoformat(),
        "pending_count": 2,
    }))
    sent = _patch(monkeypatch, db, ADMIN)

    out = _run(leader_today.remind_leader(LEADER_UID, request=None))
    assert out["ok"] is True
    assert len(sent) == 1
    state = _run(db.assessment_reminder_state.find_one({"_id": LEADER_UID}))
    assert state["admin_nudge_at"]
    assert state["pending_count"] == 2  # cron fields survive the $set


# ── Guards ────────────────────────────────────────────────────────────────

def test_non_admin_caller_403s_via_real_guard(monkeypatch):
    db = _db()
    _seed_leader(db)
    sent = _patch(monkeypatch, db, LEADER)

    with pytest.raises(HTTPException) as exc:
        _run(leader_today.remind_leader(LEADER_UID, request=None))
    assert exc.value.status_code == 403
    assert sent == []
    assert _run(db.assessment_reminder_state.find_one({"_id": LEADER_UID})) is None


def test_unknown_or_non_leader_target_404s(monkeypatch):
    db = _db()
    trainee_oid = ObjectId()
    _run(db.users.insert_one(
        {"_id": trainee_oid, "name": "Terry", "role": "trainee", "office_id": "office-A"}
    ))
    sent = _patch(monkeypatch, db, ADMIN)

    # No such user at all (also covers a malformed id → lookup fails → 404)
    with pytest.raises(HTTPException) as exc:
        _run(leader_today.remind_leader(str(ObjectId()), request=None))
    assert exc.value.status_code == 404

    # Exists but is a trainee — not a nudgeable grading owner
    with pytest.raises(HTTPException) as exc2:
        _run(leader_today.remind_leader(str(trainee_oid), request=None))
    assert exc2.value.status_code == 404
    assert sent == []
