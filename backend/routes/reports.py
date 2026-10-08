"""AI performance reports (admin-only).

  POST /api/reports/generate   { scope, user_id | leader_id, period, ai }
      scope 'individual' → one BA's Field + Bells + AI narrative
      scope 'team'       → a leader's subtree: team rollup + per-member + narrative

Numbers come from report_builder (deterministic); the narrative is Claude.
"""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from bson import ObjectId

from auth import require_admin, get_subtree_ids
from database import db
from core.rate_limit import take_ai_quota
from report_builder import (
    period_range, resolve_period, parse_intent,
    build_individual, build_team, ai_narrative,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class ReportBody(BaseModel):
    scope: str = "individual"           # 'individual' | 'team'
    user_id: Optional[str] = None       # individual subject
    leader_id: Optional[str] = None     # team subtree root
    period: str = "month"               # week | month | quarter
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    ai: bool = True


async def _name_of(user_id: str) -> str:
    try:
        u = await db.users.find_one({"_id": ObjectId(user_id)}, {"name": 1})
        return (u or {}).get("name") or "Unknown"
    except Exception:
        return "Unknown"


def _office_filter(admin: dict) -> dict:
    """Office admins only ever see their own office; super admins see all."""
    if admin.get("is_super_admin"):
        return {}
    return {"office_id": admin.get("office_id") or "__none__"}


async def _guard_subject(admin: dict, user_id: str) -> None:
    if admin.get("is_super_admin"):
        return
    try:
        u = await db.users.find_one({"_id": ObjectId(user_id)}, {"office_id": 1})
    except Exception:
        u = None
    if not u or not admin.get("office_id") or u.get("office_id") != admin.get("office_id"):
        raise HTTPException(status_code=403, detail="That person isn’t in your office")


async def _team_ids(admin: dict, leader_id: str) -> list[str]:
    """The leader's subtree, trimmed to the admin's office (the tree is
    office-local, but a stray cross-office reports_to must not widen it)."""
    ids = await get_subtree_ids(leader_id)
    if admin.get("is_super_admin"):
        return ids
    oids = [ObjectId(i) for i in ids if ObjectId.is_valid(i)]
    return [str(u["_id"]) async for u in db.users.find(
        {"_id": {"$in": oids}, **_office_filter(admin)}, {"_id": 1})]


@router.post("/reports/generate")
async def generate_report(request: Request, body: ReportBody):
    admin = await require_admin(request)
    iso_from, iso_to = period_range(body.period, body.from_date, body.to_date)

    if body.scope == "team":
        if not body.leader_id:
            raise HTTPException(status_code=400, detail="leader_id required for a team report")
        await _guard_subject(admin, body.leader_id)
        ids = await _team_ids(admin, body.leader_id)
        team_name = f"{await _name_of(body.leader_id)}’s team"
        structured = await build_team(ids, team_name, iso_from, iso_to)
    else:
        if not body.user_id:
            raise HTTPException(status_code=400, detail="user_id required for an individual report")
        await _guard_subject(admin, body.user_id)
        structured = await build_individual(body.user_id, iso_from, iso_to)

    narrative = ""
    if body.ai:
        take_ai_quota(admin)  # per-person hourly AI cap (core/rate_limit.py)
        try:
            narrative = await ai_narrative(structured)
        except Exception as ex:
            logger.error("report narrative failed: %s", ex)

    return {"period": body.period, "range": {"from": iso_from, "to": iso_to},
            "structured": structured, "narrative": narrative}


class PromptBody(BaseModel):
    text: str


async def _resolve_individual(name: str, scope: dict | None = None) -> tuple[str, str] | None:
    """(user_id, name) for the best user-name match, else None. `scope` is
    the caller's office filter (_office_filter)."""
    q = name.strip().lower()
    if not q:
        return None
    best = None
    async for u in db.users.find({"deleted": {"$ne": True}, **(scope or {})}, {"_id": 1, "name": 1}):
        nm = (u.get("name") or "").strip().lower()
        if not nm:
            continue
        if nm == q:
            return str(u["_id"]), u["name"]
        if best is None and q in nm:
            best = (str(u["_id"]), u["name"])
    return best


async def _resolve_team(name: str, scope: dict | None = None) -> tuple[str, str] | None:
    """(leader_id, team_label) — match team_name first, then a leader's name.
    `scope` is the caller's office filter (_office_filter)."""
    q = name.strip().lower()
    if not q:
        return None
    by_name = None
    async for u in db.users.find(
        {"role": {"$in": ["leader", "admin"]}, "deleted": {"$ne": True}, **(scope or {})},
        {"_id": 1, "name": 1, "team_name": 1},
    ):
        tn = (u.get("team_name") or "").strip().lower()
        if tn and (tn == q or q in tn):
            return str(u["_id"]), (u.get("team_name") or u.get("name"))
        nm = (u.get("name") or "").strip().lower()
        if by_name is None and nm and q in nm:
            by_name = (str(u["_id"]), f"{u.get('name')}’s team")
    return by_name


@router.post("/reports/prompt")
async def generate_from_prompt(request: Request, body: PromptBody):
    admin = await require_admin(request)
    scope_q = _office_filter(admin)
    # Two model calls (reading the request, then the narrative): 2 units of
    # the per-person hourly AI cap (core/rate_limit.py).
    take_ai_quota(admin, units=2)
    intent = await parse_intent(body.text or "")
    if not intent or not intent.get("name"):
        raise HTTPException(status_code=422, detail="Couldn’t read that request — try e.g. “Team Thryve’s report for July”.")

    scope = "team" if intent.get("scope") == "team" else "individual"
    iso_from, iso_to, label = resolve_period(intent.get("period") or {})
    name = str(intent.get("name"))

    if scope == "team":
        match = await _resolve_team(name, scope_q)
        if not match:
            raise HTTPException(status_code=404, detail=f"No team or coach matching “{name}”.")
        leader_id, team_label = match
        ids = await _team_ids(admin, leader_id)
        structured = await build_team(ids, team_label, iso_from, iso_to)
        resolved = {"scope": "team", "entity_id": leader_id, "name": team_label}
    else:
        match = await _resolve_individual(name, scope_q)
        if not match:
            raise HTTPException(status_code=404, detail=f"No one matching “{name}”.")
        user_id, uname = match
        structured = await build_individual(user_id, iso_from, iso_to)
        resolved = {"scope": "individual", "entity_id": user_id, "name": uname}

    narrative = ""
    try:
        narrative = await ai_narrative(structured)
    except Exception as ex:
        logger.error("prompt report narrative failed: %s", ex)

    return {"resolved": {**resolved, "period_label": label},
            "range": {"from": iso_from, "to": iso_to},
            "structured": structured, "narrative": narrative}
