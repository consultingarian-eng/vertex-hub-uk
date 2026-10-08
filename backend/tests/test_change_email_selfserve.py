"""Self-serve email change: open ONLY to @indeedemail.com relay accounts.

Candidates hired through Indeed may be created with the relay address they
applied with; the app prompts them to swap in their real email. Everyone else
stays admin-only (PUT /admin/users/{id}/email).
"""
import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes import auth_routes  # noqa: E402


class _FakeRequest:
    def __init__(self, body):
        self._body = body
        self.headers = {}
        self.cookies = {}
        self.client = None

    async def json(self):
        return self._body


RELAY_USER = {"id": "64b000000000000000000001", "email": "jamie_a2q@indeedemail.com",
              "name": "Jamie Doe"}
NORMAL_USER = {"id": "64b000000000000000000002", "email": "someone@gmail.com", "name": "Someone"}


def _db(existing_user=None, otp_record=None):
    db = MagicMock()
    db.users.find_one = AsyncMock(return_value=existing_user)
    db.users.update_one = AsyncMock()
    db.email_change_otps.find_one = AsyncMock(return_value=otp_record)
    db.email_change_otps.find_one_and_delete = AsyncMock(return_value=otp_record)
    db.email_change_otps.find_one_and_update = AsyncMock(return_value=None)
    db.email_change_otps.delete_many = AsyncMock()
    db.email_change_otps.insert_one = AsyncMock()
    db.email_otps.delete_many = AsyncMock()
    db.password_resets.delete_many = AsyncMock()
    return db


def _run(coro):
    return asyncio.run(coro)


def test_non_relay_account_is_refused():
    with patch.object(auth_routes, "get_current_user", AsyncMock(return_value=NORMAL_USER)):
        with pytest.raises(HTTPException) as exc:
            _run(auth_routes.request_own_email_change(_FakeRequest({"email": "new@x.com"})))
    assert exc.value.status_code == 403


def test_new_indeed_address_is_refused():
    with patch.object(auth_routes, "get_current_user", AsyncMock(return_value=RELAY_USER)):
        with pytest.raises(HTTPException) as exc:
            _run(auth_routes.request_own_email_change(_FakeRequest({"email": "again@indeedemail.com"})))
    assert exc.value.status_code == 400


def test_request_sends_code_to_new_address():
    db = _db(existing_user=None)
    sent = MagicMock()
    with patch.object(auth_routes, "get_current_user", AsyncMock(return_value=RELAY_USER)), \
         patch.object(auth_routes, "db", db), \
         patch.object(auth_routes, "send_otp_email", sent), \
         patch.object(auth_routes, "_enforce_rate"), patch.object(auth_routes, "_record_rate"):
        res = _run(auth_routes.request_own_email_change(_FakeRequest({"email": "JamieDoe10@Example.com"})))
    assert res["email"] == "jamiedoe10@example.com"
    stored = db.email_change_otps.insert_one.call_args.args[0]
    assert stored["new_email"] == "jamiedoe10@example.com"
    assert stored["user_id"] == RELAY_USER["id"]
    # The code goes to the NEW address — that's the typo/lockout protection.
    assert sent.call_args.args[1] == "jamiedoe10@example.com"
    assert sent.call_args.args[2] == stored["code"]


def test_confirm_swaps_email():
    from datetime import datetime, timezone
    record = {"user_id": RELAY_USER["id"], "new_email": "jamiedoe10@example.com",
              "code": "123456", "created_at": datetime.now(timezone.utc).isoformat(),
              "expires_minutes": 10, "attempts": 0}
    db = _db(existing_user=None, otp_record=record)
    with patch.object(auth_routes, "get_current_user", AsyncMock(return_value=RELAY_USER)), \
         patch.object(auth_routes, "db", db), \
         patch.object(auth_routes, "_enforce_rate"), patch.object(auth_routes, "_record_rate"), \
         patch.object(auth_routes, "_clear_rate"):
        res = _run(auth_routes.confirm_own_email_change(_FakeRequest({"code": "123456"})))
    assert res["email"] == "jamiedoe10@example.com"
    assert res["old_email"] == "jamie_a2q@indeedemail.com"
    update = db.users.update_one.call_args.args[1]
    assert update["$set"]["email"] == "jamiedoe10@example.com"
    assert "$inc" not in update  # session_version untouched — user stays signed in


def test_confirm_wrong_code_rejected():
    from datetime import datetime, timezone
    record = {"user_id": RELAY_USER["id"], "new_email": "x@y.com", "code": "123456",
              "created_at": datetime.now(timezone.utc).isoformat(), "expires_minutes": 10, "attempts": 0}
    db = _db(otp_record=record)
    with patch.object(auth_routes, "get_current_user", AsyncMock(return_value=RELAY_USER)), \
         patch.object(auth_routes, "db", db), \
         patch.object(auth_routes, "_enforce_rate"), patch.object(auth_routes, "_record_rate"):
        with pytest.raises(HTTPException) as exc:
            _run(auth_routes.confirm_own_email_change(_FakeRequest({"code": "999999"})))
    assert exc.value.status_code == 400
    db.users.update_one.assert_not_called()
