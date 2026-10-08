"""Achievement engine endpoints — read the catalog, read earned badges,
acknowledge celebrations already shown to the user.

    GET  /api/achievements/catalog        → the static achievement list (locked/unlocked UI)
    GET  /api/achievements/{key}/earners  → admin: everyone in the office who earned it
    GET  /api/me/badges                   → this user's earned badges, newest first
    POST /api/me/badges/mark-seen         → mark celebrations as played
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from auth import get_current_user
from database import db
from core.achievements import ACHIEVEMENTS, ACHIEVEMENTS_BY_KEY

router = APIRouter()


class MarkSeenBody(BaseModel):
    ids: List[str] = []


def _catalog_for(user: dict) -> list:
    """The catalog this user should see. Sales-ladder badges stay REGISTERED
    (the boot cleanup deletes unknown user_badges keys) but are hidden from
    the locked-tile grid while the Sales Development Path is dark for the
    user's office — five locked badges describing Green Weeks and coach
    sign-off would announce the unreleased feature."""
    from core.sales_path import sales_path_office_enabled
    if sales_path_office_enabled(user.get("office_id")):
        return ACHIEVEMENTS
    return [a for a in ACHIEVEMENTS if not a["key"].startswith("sales_")]


@router.get("/achievements/catalog")
async def get_catalog(request: Request):
    user = await get_current_user(request)
    return _catalog_for(user)


@router.get("/achievements/{key}/earners")
async def get_badge_earners(key: str, request: Request, office: Optional[str] = None):
    """Everyone in the office who has earned this badge — admin-only, so the
    owner can see who's picked what up. Office-scoped; super admins may pass
    ?office= to flip. Synthetic super-admin unlocks never appear here (they
    are never stored)."""
    user = await get_current_user(request)
    if (user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if key not in ACHIEVEMENTS_BY_KEY:
        raise HTTPException(status_code=404, detail="Unknown badge")
    office_id = office if (user.get("is_super_admin") and office) else user.get("office_id")
    if not office_id:
        raise HTTPException(status_code=400, detail="Your account is not assigned to an office")

    # Office roster FIRST, badges second — so another office's badge volume
    # can never crowd this office's earners out of a result cap.
    people: dict = {}
    async for u in db.users.find(
        {"office_id": office_id, "deleted": {"$ne": True},
         "is_active": {"$ne": False}, "is_demo": {"$ne": True}},
        {"_id": 1, "name": 1, "role": 1},
    ):
        people[str(u["_id"])] = u

    earners = []
    if people:
        rows = await db.user_badges.find(
            {"key": key, "user_id": {"$in": list(people.keys())}},
            {"_id": 0, "user_id": 1, "earned_at": 1},
        ).sort("earned_at", -1).to_list(2000)
        for r in rows:
            u = people.get(r.get("user_id"))
            if not u:
                continue
            earners.append({
                "user_id": r["user_id"],
                "name": u.get("name") or "",
                "role": u.get("role") or "",
                "earned_at": r.get("earned_at"),
            })
    return {"key": key, "office_id": office_id, "earners": earners}


@router.get("/me/badges")
async def get_my_badges(request: Request):
    user = await get_current_user(request)
    rows = await db.user_badges.find(
        {"user_id": user["id"]}, {"_id": 0}
    ).sort("earned_at", -1).to_list(200)
    # Super admins hold every badge by office(s)-owner's prerogative — the
    # grid shows them all unlocked without polluting user_badges (so the
    # admin earners list above stays honest). seen=True keeps the confetti
    # watcher quiet; mark-seen on a synthetic id is a harmless no-op.
    if user.get("is_super_admin"):
        have = {r.get("key") for r in rows}
        stamp = user.get("created_at") or datetime.now(timezone.utc).isoformat()
        for a in _catalog_for(user):
            if a["key"] in have:
                continue
            rows.append({
                "id": f"synthetic:{a['key']}",
                "user_id": user["id"],
                **a,
                "earned_at": stamp,
                "seen": True,
                "synthetic": True,
            })
    return rows


@router.post("/me/badges/mark-seen")
async def mark_badges_seen(body: MarkSeenBody, request: Request):
    user = await get_current_user(request)
    if not body.ids:
        return {"updated": 0}
    res = await db.user_badges.update_many(
        {"user_id": user["id"], "id": {"$in": body.ids}},
        {"$set": {"seen": True}},
    )
    return {"updated": res.modified_count}
