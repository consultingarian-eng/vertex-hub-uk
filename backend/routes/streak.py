"""Learning days — account-bound cumulative learning counter.

One learning action per local day (PK quiz answer, lesson finish, exam
submit) adds ONE day to a lifetime total. Deliberately NOT a streak:
missing a day costs nothing and there is no "consecutive" concept anywhere
(owner call, 2026-07-12 — rewarding unbroken daily activity pressures
people to never take a day off). Badges reward hitting count milestones.

    GET  /api/me/streak           → { total, last_date, count, best }
    POST /api/me/streak/activity  → count today (idempotent), returns state + extended
    POST /api/me/streak/sync      → max-merge a device-local total (migration/offline heal)

Endpoint paths keep the legacy /streak name (and mirror `count`/`best` to
the total) so clients built before the pivot keep working; they simply
display the cumulative total instead of a consecutive count.

Day boundaries are the CLIENT's local calendar day — the client sends its
own YYYY-MM-DD so "today" means the rep's day, not the server's timezone.
Stored as a `learning_days` field on the users document; legacy
`learning_streak` data seeds the total on first read (best-ever streak is
a lower bound on true learning days — per-day history was never kept).
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user
from database import db
from core.achievements import award_learning_days

router = APIRouter()

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_day(s: str) -> date:
    if not s or not _DATE_RE.match(s):
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid date")


def _read(user: dict) -> dict:
    cur = user.get("learning_days") or {}
    total = int(cur.get("total") or 0)
    last_date = cur.get("last_date") or None
    if not total:
        # Seed from the legacy streak record: the best consecutive run is a
        # lower bound on total learning days.
        legacy = user.get("learning_streak") or {}
        total = max(int(legacy.get("best") or 0), int(legacy.get("count") or 0))
        last_date = last_date or legacy.get("last_date") or None
    return {"total": total, "last_date": last_date}


async def _write(user: dict, state: dict) -> None:
    # `user` comes from get_current_user, which strips `_id` (only `id`
    # remains as a string) — user["_id"] would KeyError.
    await db.users.update_one(
        {"_id": ObjectId(user["id"])},
        {"$set": {"learning_days": {**state, "updated_at": _now()}}},
    )


def _payload(state: dict) -> dict:
    # `count`/`best` mirror the total for clients from before the pivot.
    return {**state, "count": state["total"], "best": state["total"]}


class ActivityBody(BaseModel):
    date: str = Field(..., description="Client-local day, YYYY-MM-DD")


class SyncBody(BaseModel):
    total: int = 0
    count: int = 0   # legacy clients send their old streak fields
    best: int = 0
    last_date: Optional[str] = None


@router.get("/me/streak")
async def get_streak(request: Request):
    user = await get_current_user(request)
    return _payload(_read(user))


@router.post("/me/streak/activity")
async def record_activity(body: ActivityBody, request: Request):
    user = await get_current_user(request)
    today = _parse_day(body.date)
    cur = _read(user)
    last = date.fromisoformat(cur["last_date"]) if cur["last_date"] else None

    # Idempotent per day; a client clock behind the stored date is treated
    # the same way rather than double-counting.
    if last is not None and last >= today:
        return {**_payload(cur), "extended": False}

    state = {"total": cur["total"] + 1, "last_date": today.isoformat()}
    await _write(user, state)
    try:
        await award_learning_days(user["id"], state["total"])
    except Exception:
        pass
    return {**_payload(state), "extended": True}


@router.post("/me/streak/sync")
async def sync_streak(body: SyncBody, request: Request):
    """Merge a device-local total into the account (first-login migration,
    or healing days logged while offline). Never lowers the account state."""
    user = await get_current_user(request)
    cur = _read(user)

    dev_total = max(0, min(max(int(body.total or 0), int(body.count or 0), int(body.best or 0)), 10000))
    dev_last = _parse_day(body.last_date).isoformat() if body.last_date else None

    state = dict(cur)
    state["total"] = max(cur["total"], dev_total)
    if dev_last and (not cur["last_date"] or dev_last > cur["last_date"]):
        state["last_date"] = dev_last

    if state != cur:
        await _write(user, state)
        try:
            await award_learning_days(user["id"], state["total"])
        except Exception:
            pass
    return _payload(state)
