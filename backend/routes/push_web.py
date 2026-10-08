"""Web Push subscription endpoints (installed PWA notifications).

  GET  /api/push/vapid-key        public VAPID key for the client to subscribe
  POST /api/push/web-subscribe    store this browser's push subscription
  POST /api/push/web-unsubscribe  remove it (on toggle-off / logout)
  POST /api/push/web-test         send a test notification to the caller

Subscriptions are stored in `web_push_subscriptions`, keyed by the browser
endpoint (unique) and tagged with the user id, so a person can be subscribed on
several devices and each is addressable/prunable independently.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

from auth import get_current_user
from database import db
from core.brand import APP_NAME
from core.webpush import is_allowed_push_endpoint, vapid_public_key, send_web_push_to_user

logger = logging.getLogger(__name__)
router = APIRouter()


class SubKeys(BaseModel):
    p256dh: str
    auth: str


class SubBody(BaseModel):
    endpoint: str
    keys: SubKeys
    expirationTime: Optional[float] = None


class UnsubBody(BaseModel):
    endpoint: str


@router.get("/push/vapid-key")
async def push_vapid_key(request: Request):
    await get_current_user(request)
    key = vapid_public_key()
    if not key:
        raise HTTPException(status_code=503, detail="Web push not configured")
    return {"publicKey": key}


@router.post("/push/web-subscribe")
async def push_web_subscribe(request: Request, body: SubBody):
    user = await get_current_user(request)
    if not is_allowed_push_endpoint(body.endpoint):
        raise HTTPException(status_code=400, detail="That isn't a browser push service address.")
    if len(body.keys.p256dh) > 200 or len(body.keys.auth) > 100:
        raise HTTPException(status_code=400, detail="Invalid push subscription keys.")
    await db.web_push_subscriptions.update_one(
        {"endpoint": body.endpoint},
        {"$set": {
            "endpoint": body.endpoint,
            "keys": {"p256dh": body.keys.p256dh, "auth": body.keys.auth},
            "user_id": str(user["id"]),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "user_agent": request.headers.get("user-agent", "")[:200],
        }, "$setOnInsert": {"created_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"ok": True}


@router.post("/push/web-unsubscribe")
async def push_web_unsubscribe(request: Request, body: UnsubBody):
    user = await get_current_user(request)
    # Only ever your own subscription.
    await db.web_push_subscriptions.delete_one({"endpoint": body.endpoint, "user_id": str(user["id"])})
    return {"ok": True}


@router.post("/push/web-test")
async def push_web_test(request: Request):
    user = await get_current_user(request)
    await send_web_push_to_user(
        str(user["id"]),
        f"{APP_NAME} notifications are on 🎉",
        "You'll get updates here even when the app is closed.",
        {"url": "/"},
    )
    return {"ok": True}


@router.post("/push/web-schedule-test")
async def push_web_schedule_test(request: Request):
    """Send the caller a sample "Starting in 5 min" schedule reminder right now,
    so they can confirm schedule reminders render on the installed PWA without
    waiting for a real block time."""
    user = await get_current_user(request)
    await send_web_push_to_user(
        str(user["id"]),
        "Starting in 5 min: MORNING MEETING",
        "Tap to view details",
        {"type": "schedule", "kind": "schedule", "url": "/schedule", "tag": "schedule-test"},
    )
    return {"ok": True}


@router.get("/push/schedule-reminder-preview")
async def push_schedule_reminder_preview(request: Request):
    """Dry-run the schedule-reminder tick: reports which blocks are 'due' right
    now and how many web subscribers each would reach — without sending."""
    await get_current_user(request)
    from core.schedule_reminders import schedule_reminder_tick
    return await schedule_reminder_tick(dry_run=True)
