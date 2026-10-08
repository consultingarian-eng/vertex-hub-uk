"""Office scoping helpers — resolve which office_id to use for a given request."""
from typing import Optional
from fastapi import HTTPException, Request
from database import db
from auth import get_current_user


async def get_office_filter(user: dict) -> dict:
    """Return a Mongo filter limiting queries to the user's office (super-admins see all)."""
    if user.get("is_super_admin"):
        return {}
    if user.get("office_id"):
        return {"office_id": user["office_id"]}
    raise HTTPException(status_code=403, detail="No office is assigned to this account")


async def resolve_office_id(request: Request, user: dict = None, office_param: str = None) -> str:
    """Resolve which office_id to use for content queries.
    Super admin: uses ?office= param or defaults to first office.
    Regular admin/leader: uses their own office_id.
    Missing or unauthenticated office context fails closed.
    """
    if user and user.get("is_super_admin"):
        if office_param:
            accessible = set(user.get("accessible_offices") or [])
            if accessible and office_param not in accessible:
                raise HTTPException(status_code=403, detail="That office is not available to this account")
            if not await db.offices.find_one({"id": office_param}, {"_id": 1}):
                raise HTTPException(status_code=400, detail="Office not found")
            return office_param
        if user.get("office_id"):
            return user["office_id"]
        first_office = await db.offices.find_one({}, sort=[("created_at", 1)])
        return first_office["id"] if first_office else ""
    if user and user.get("office_id"):
        return user["office_id"]
    raise HTTPException(status_code=403, detail="No office is assigned to this account")


async def try_get_user(request: Request) -> Optional[dict]:
    """Try to get current user, return None if not authenticated (used for public-ish endpoints)."""
    try:
        return await get_current_user(request)
    except Exception:
        return None
