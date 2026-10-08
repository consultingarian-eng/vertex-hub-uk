"""In-app notification inbox + admin broadcast + audit-log viewer.

GET  /api/notifications               → current user's inbox rows, newest first
GET  /api/notifications/unread-count  → {count}
GET  /api/notifications/prefs         → role-relevant category toggles
PUT  /api/notifications/prefs         → save one toggle ({key, enabled}) or many ({prefs})
POST /api/notifications/{id}/read     → mark one row read
POST /api/notifications/read-all      → mark everything read
POST /api/notifications/broadcast     → admin push to an audience (IMPROVEMENT-PACK A4)
GET  /api/admin/audit-log             → admin action trail (IMPROVEMENT-PACK A5)

Rows are written by core/notify.record_notification, which core/push.py calls
for every push — this router only reads/flags them (plus the broadcast sender).
"""
from __future__ import annotations

from typing import Dict, Optional

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from auth import get_current_user, require_admin
from core.audit import audit
from core.push import NOTIFICATION_CATEGORIES, send_push_to_user
from database import db

router = APIRouter()

AUDIENCES = ("office", "leaders", "trainees", "everyone")


@router.get("/notifications")
async def list_notifications(request: Request, limit: int = 50, before: Optional[str] = None):
    """The current user's inbox, newest first. `before` (ISO timestamp from the
    last row of the previous page) pages further back."""
    user = await get_current_user(request)
    limit = max(1, min(int(limit or 50), 200))
    query: dict = {"user_id": user["id"]}
    if before:
        query["created_at"] = {"$lt": before}
    rows = await db.notifications.find(query, {"_id": 0}).sort(
        "created_at", -1
    ).to_list(limit)
    return rows


@router.get("/notifications/unread-count")
async def unread_count(request: Request):
    user = await get_current_user(request)
    count = await db.notifications.count_documents(
        {"user_id": user["id"], "read": {"$ne": True}}
    )
    return {"count": count}


@router.get("/notifications/prefs")
async def get_notification_prefs(request: Request):
    """The current user's notification-type toggles, filtered to the
    categories their role can actually receive. Missing pref = enabled —
    off is always an explicit choice."""
    user = await get_current_user(request)
    role = user.get("role")
    prefs = user.get("notification_prefs")
    if not isinstance(prefs, dict):
        prefs = {}
    categories = [
        {
            "key": c["key"],
            "label": c["label"],
            "description": c["description"],
            "enabled": prefs.get(c["key"]) is not False,
        }
        for c in NOTIFICATION_CATEGORIES
        if c["roles"] is None or role in c["roles"]
    ]
    return {"categories": categories}


class NotificationPrefsBody(BaseModel):
    key: Optional[str] = None
    enabled: Optional[bool] = None
    prefs: Optional[Dict[str, bool]] = None


@router.put("/notifications/prefs")
async def put_notification_prefs(body: NotificationPrefsBody, request: Request):
    """Persist toggles to users.notification_prefs — either one switch
    ({key, enabled}) or a batch ({prefs: {key: bool}}). Unknown keys in a
    batch are dropped (forward-compat); a single unknown key is a 400."""
    user = await get_current_user(request)
    valid = {c["key"] for c in NOTIFICATION_CATEGORIES}
    updates: Dict[str, bool] = {}
    if body.prefs:
        updates = {k: bool(v) for k, v in body.prefs.items() if k in valid}
    if body.key is not None:
        if body.key not in valid:
            raise HTTPException(status_code=400, detail=f"Unknown category '{body.key}'")
        if body.enabled is None:
            raise HTTPException(status_code=400, detail="enabled is required with key")
        updates[body.key] = bool(body.enabled)
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    try:
        oid = ObjectId(user["id"])
    except (InvalidId, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Bad user id")
    await db.users.update_one(
        {"_id": oid},
        {"$set": {f"notification_prefs.{k}": v for k, v in updates.items()}},
    )
    return {"ok": True, "prefs": updates}


@router.post("/notifications/read-all")
async def mark_all_read(request: Request):
    user = await get_current_user(request)
    res = await db.notifications.update_many(
        {"user_id": user["id"], "read": {"$ne": True}},
        {"$set": {"read": True}},
    )
    return {"ok": True, "updated": getattr(res, "modified_count", 0)}


@router.post("/notifications/{notification_id}/read")
async def mark_read(notification_id: str, request: Request):
    user = await get_current_user(request)
    res = await db.notifications.update_one(
        {"id": notification_id, "user_id": user["id"]},
        {"$set": {"read": True}},
    )
    if not getattr(res, "matched_count", 0):
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"ok": True}


class BroadcastBody(BaseModel):
    title: str
    body: str
    audience: str = "everyone"  # "office" | "leaders" | "trainees" | "everyone"
    office_id: Optional[str] = None  # super-admin only; plain admins are pinned


@router.post("/notifications/broadcast")
async def broadcast_notification(body: BroadcastBody, request: Request):
    """Push a message to an audience of active users (each send also lands an
    inbox row via the send_push_to_user choke point). Writes one audit row."""
    admin = await require_admin(request)
    title = (body.title or "").strip()
    text = (body.body or "").strip()
    if not title or not text:
        raise HTTPException(status_code=400, detail="title and body are required")
    audience = (body.audience or "everyone").strip().lower()
    if audience not in AUDIENCES:
        raise HTTPException(
            status_code=400,
            detail=f"audience must be one of {', '.join(AUDIENCES)}",
        )

    query: dict = {"deleted": {"$ne": True}, "is_active": {"$ne": False}}
    if audience == "leaders":
        query["role"] = "leader"
    elif audience == "trainees":
        query["role"] = "trainee"

    if not admin.get("is_super_admin"):
        # Plain admins are pinned to their own office regardless of payload.
        if not admin.get("office_id"):
            raise HTTPException(status_code=403, detail="No office is assigned to this account")
        query["office_id"] = admin["office_id"]
    elif body.office_id:
        accessible = set(admin.get("accessible_offices") or [])
        if accessible and body.office_id not in accessible:
            raise HTTPException(status_code=403, detail="That office is not available to this account")
        query["office_id"] = body.office_id
    elif audience != "everyone" and admin.get("office_id"):
        # Super-admin with no explicit office: "everyone" spans all offices,
        # the office-scoped audiences default to their own office.
        query["office_id"] = admin["office_id"]

    sent = 0
    async for u in db.users.find(query, {"_id": 1}):
        await send_push_to_user(
            str(u["_id"]), title, text,
            data={"type": "broadcast", "url": "/notifications"},
        )
        sent += 1

    await audit(admin, "broadcast_notification", details={
        "audience": audience,
        "office_id": query.get("office_id"),
        "title": title,
        "sent": sent,
    })
    return {"sent": sent}


@router.get("/admin/audit-log")
async def get_audit_log(request: Request, limit: int = 200):
    """Recent admin actions, newest first. Plain admins see their own office;
    super-admins see everything."""
    admin = await require_admin(request)
    limit = max(1, min(int(limit or 200), 200))
    query: dict = {}
    if not admin.get("is_super_admin"):
        query["office_id"] = admin.get("office_id")
    rows = await db.admin_audit_log.find(query, {"_id": 0}).sort(
        "created_at", -1
    ).to_list(limit)
    return rows
