"""Per-user UI preferences (custom bottom-tab-bar order/visibility).

GET /api/me/tab-prefs   → { items: [{id, visible}], updated_at }
PUT /api/me/tab-prefs   → save user's chosen tab order + visibility

Stored as `tab_prefs` field on the users document. If not set, the frontend
falls back to a role-based default registry.

Also the Profile tab's "Schedule Reminders" master toggle:

GET /api/me/schedule-reminders → { enabled }
PUT /api/me/schedule-reminders → persist it server-side

Stored as `schedule_reminders_enabled` on the users document (missing =
enabled). The server-side web-push sender (core/schedule_reminders.py) honors
it — the toggle used to be device-local only, which silenced on-device local
notifications but not the server pushes PWA users actually receive. Kept
separate from notification_prefs['schedule']: that Inbox category also gates
absence_request/absence_decision pushes and must not be silenced by this.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user
from database import db

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TabPrefItem(BaseModel):
    id: str
    visible: bool = True


class TabPrefsBody(BaseModel):
    items: List[TabPrefItem] = Field(default_factory=list)


@router.get("/me/tab-prefs")
async def get_tab_prefs(request: Request):
    user = await get_current_user(request)
    prefs = user.get("tab_prefs") or {}
    return {
        "items": list(prefs.get("items") or []),
        "updated_at": prefs.get("updated_at"),
    }


@router.put("/me/tab-prefs")
async def put_tab_prefs(body: TabPrefsBody, request: Request):
    user = await get_current_user(request)
    uid = user.get("id")
    try:
        oid = ObjectId(uid)
    except (InvalidId, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Bad user id")
    cleaned: List[dict] = []
    seen = set()
    for it in body.items:
        if not it.id or it.id in seen:
            continue
        seen.add(it.id)
        cleaned.append({"id": it.id, "visible": bool(it.visible)})
    payload = {"items": cleaned, "updated_at": _now()}
    await db.users.update_one({"_id": oid}, {"$set": {"tab_prefs": payload}})
    return payload


class ScheduleRemindersBody(BaseModel):
    enabled: bool = True


@router.get("/me/schedule-reminders")
async def get_schedule_reminders(request: Request):
    user = await get_current_user(request)
    return {"enabled": user.get("schedule_reminders_enabled") is not False}


@router.put("/me/schedule-reminders")
async def put_schedule_reminders(body: ScheduleRemindersBody, request: Request):
    user = await get_current_user(request)
    try:
        oid = ObjectId(user.get("id"))
    except (InvalidId, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Bad user id")
    await db.users.update_one(
        {"_id": oid},
        {"$set": {"schedule_reminders_enabled": bool(body.enabled), "schedule_reminders_updated_at": _now()}},
    )
    return {"enabled": bool(body.enabled)}
