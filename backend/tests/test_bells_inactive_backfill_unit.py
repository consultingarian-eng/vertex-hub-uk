"""An admin can finish a deactivated person's existing Bells week row, and
nothing else about a binned account becomes writable."""

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from bson import ObjectId
from fastapi import HTTPException

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import bells  # noqa: E402
from tests.test_security_unit import _request  # noqa: E402

WEEK = "2026-09-27"
GONE_ID = ObjectId()
GONE = {"_id": GONE_ID, "name": "Gone Rep", "role": "leader", "office_id": "office-a", "deleted": True}


class _Users:
    def __init__(self):
        self.updates = []

    async def find_one(self, query, *_a, **_k):
        # Mirrors Mongo: the active-only lookup never matches a binned account.
        if query.get("deleted") or query.get("is_active"):
            return None
        if query.get("_id") == GONE_ID and query.get("office_id") == GONE["office_id"]:
            return GONE
        return None

    async def update_one(self, *args, **_k):
        self.updates.append(args)


class _Bells:
    def __init__(self, row):
        self.row = row
        self.inserted = []
        self.updated = []

    async def find_one(self, query, *_a, **_k):
        if self.row and all(self.row.get(k) == v for k, v in query.items() if not isinstance(v, dict)):
            return dict(self.row)
        return None

    async def insert_one(self, doc):
        self.inserted.append(doc)

    async def update_one(self, query, update):
        self.updated.append(update["$set"])


class _Fees:
    async def find_one(self, *_a, **_k):
        return None


def _setup(monkeypatch, role, row):
    async def current_user(_request):
        return {"id": str(ObjectId()), "role": role, "office_id": "office-a"}

    async def resolved(*_a, **_k):
        return "office-a"

    async def subtree(_uid):
        return [str(GONE_ID)]

    side_effects = []

    async def noted(*a, **_k):
        side_effects.append(a)

    async def goal_change(*_a, **_k):
        return None

    users, rows = _Users(), _Bells(row)
    monkeypatch.setattr(bells, "get_current_user", current_user)
    monkeypatch.setattr(bells, "resolve_office_id", resolved)
    monkeypatch.setattr(bells, "get_subtree_ids", subtree)
    monkeypatch.setattr(bells, "record_goal_change", goal_change)
    monkeypatch.setattr(bells, "award_sales_milestones", noted)
    monkeypatch.setattr(bells, "reconcile_sales_and_team_badges", noted)
    monkeypatch.setattr(bells, "db", SimpleNamespace(users=users, bells_entries=rows, commission_fees=_Fees()))
    return users, rows, side_effects


def _body():
    days = [{"over30": None, "under30": None, "memberships": None, "status": "off"} for _ in range(7)]
    days[2] = {"over30": 3, "under30": 1, "memberships": 1, "status": "in"}
    return {"week_ending": WEEK, "office_id": "office-a", "user_id": str(GONE_ID), "user_name": "Gone Rep", "days": days}


def _existing_row():
    return {"id": "row-1", "office_id": "office-a", "user_id": str(GONE_ID), "user_name": "Gone Rep",
            "week_ending": WEEK, "days": [], "weekly_goal": 16}


def test_admin_can_finish_existing_row_of_deactivated_account(monkeypatch):
    users, rows, side_effects = _setup(monkeypatch, "admin", _existing_row())
    entry = asyncio.run(bells.upsert_bell(_request(method="POST", body=_body())))
    assert rows.updated and rows.updated[0]["days"][2]["over30"] == 3
    assert entry["total_sales"] == 4
    assert not rows.inserted
    # The account stays binned: no sale stamp, no badges, no sales-path work.
    assert not users.updates and not side_effects


def test_admin_cannot_start_a_new_row_for_deactivated_account(monkeypatch):
    _, rows, _ = _setup(monkeypatch, "admin", None)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(bells.upsert_bell(_request(method="POST", body=_body())))
    assert exc.value.status_code == 400
    assert not rows.inserted


def test_leader_cannot_edit_deactivated_account_row(monkeypatch):
    _, rows, _ = _setup(monkeypatch, "leader", _existing_row())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(bells.upsert_bell(_request(method="POST", body=_body())))
    assert exc.value.status_code == 400
    assert not rows.updated
