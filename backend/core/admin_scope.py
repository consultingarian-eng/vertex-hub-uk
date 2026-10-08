"""Which admins ARE the office, and which just hold admin rights.

Until Sep 2026 `role == "admin"` meant exactly one thing: the office owner,
whose "crew" is the whole office. Every goal surface leaned on that —
an admin's crew goal IS the office goal (see core/goal_sync.py) — and the
Team Bulletin deliberately excludes admins, because an owner's team is the
entire office and would dwarf every real crew.

Then a team leader was promoted to admin so he could see and edit
assessments and bells office-wide while still running his own crew, and
both assumptions mis-fired: his crew goal overwrote the office goal (and
the office goal overwrote his crew goal), and his team vanished from the
Team Bulletin.

The distinction is already in the org chart, so there is no new field to
set and nothing to remember when the next leader is promoted: an
office-level admin sits at the TOP of their office's tree. An admin who
reports up to another admin in the same office is a crew leader who
happens to hold admin rights, and every TEAM surface must treat them as
the leader they are — while every permission check still sees a plain
admin, because their rights genuinely are office-wide.

Super admins are office-level wherever they sit in the chart.
"""
from __future__ import annotations

import logging
from typing import Optional

from bson import ObjectId

from database import db

logger = logging.getLogger(__name__)

# A reports_to chain deep enough for any real office; also the cycle guard's
# backstop (visited-set catches cycles first).
_MAX_UPLINE_HOPS = 12

_ACTIVE = {"is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}}


def _doc_id(user_doc: dict) -> str:
    raw = user_doc.get("id") or user_doc.get("_id")
    return str(raw) if raw else ""


async def _has_admin_upline(user_doc: dict, database=None) -> bool:
    """True when an active admin of the SAME office sits above this user.

    Cross-office parents don't count: a leader parked under another office's
    owner by a stale reports_to is not that office's subordinate admin.
    """
    _db = database if database is not None else db
    office_id = user_doc.get("office_id") or ""
    seen = {_doc_id(user_doc)}
    parent_id = user_doc.get("reports_to")
    for _ in range(_MAX_UPLINE_HOPS):
        pid = str(parent_id or "")
        if not pid or pid in seen:
            return False
        seen.add(pid)
        try:
            parent = await _db.users.find_one(
                {"_id": ObjectId(pid)},
                {"_id": 1, "role": 1, "office_id": 1, "reports_to": 1,
                 "deleted": 1, "is_active": 1},
            )
        except Exception:
            return False
        if not parent:
            return False
        if (
            (parent.get("role") or "").lower() == "admin"
            and not parent.get("deleted")
            and parent.get("is_active") is not False
            and (parent.get("office_id") or "") == office_id
        ):
            return True
        parent_id = parent.get("reports_to")
    return False


async def _hydrated(user_doc: dict, database=None) -> dict:
    """The doc, with `role` guaranteed present.

    A doc without `role` reads as "not an admin" — a confident, silently
    wrong answer — so re-read it by id instead of guessing. `reports_to`,
    `office_id` and `is_super_admin` are legitimately absent on a complete
    user doc (an owner reports to nobody), so their absence can't be told
    from a thin projection and is taken at face value: callers that project
    fields explicitly must include all four.
    """
    if "role" in user_doc:
        return user_doc
    uid = _doc_id(user_doc)
    if not uid:
        return user_doc
    _db = database if database is not None else db
    try:
        fresh = await _db.users.find_one(
            {"_id": ObjectId(uid)},
            {"_id": 1, "role": 1, "reports_to": 1, "office_id": 1, "is_super_admin": 1},
        )
    except Exception:
        fresh = None
    return {**user_doc, **fresh} if fresh else user_doc


async def is_office_level_admin(user_doc: dict, database=None) -> bool:
    """True when this admin's crew IS the office — the owner-shaped admin.

    Non-admins are never office-level. Fails SAFE: any error resolving the
    upline keeps the historical behaviour (admin == office).

    `database` overrides the module handle for callers that hold their own
    (goal_sync's tests swap in an in-memory db).
    """
    user_doc = await _hydrated(user_doc, database)
    if (user_doc.get("role") or "").lower() != "admin":
        return False
    if user_doc.get("is_super_admin"):
        return True
    try:
        return not await _has_admin_upline(user_doc, database)
    except Exception as e:
        logger.warning(f"admin scope: upline check failed for {_doc_id(user_doc)}: {e}")
        return True


async def leads_own_crew(user_doc: dict, database=None) -> bool:
    """True for an admin who runs their OWN crew inside the office.

    These are the rows that must behave like a leader on every team surface:
    their `team_weekly_goal` is their crew's target and nothing else, and
    their team belongs in the Team Bulletin rankings.
    """
    user_doc = await _hydrated(user_doc, database)
    if (user_doc.get("role") or "").lower() != "admin":
        return False
    return not await is_office_level_admin(user_doc, database)


async def leads_own_crew_by_id(user_id: str, database=None) -> bool:
    """`leads_own_crew` when the caller only has an id. Unknown id → False."""
    _db = database if database is not None else db
    try:
        doc = await _db.users.find_one(
            {"_id": ObjectId(str(user_id))},
            {"_id": 1, "role": 1, "office_id": 1, "reports_to": 1, "is_super_admin": 1},
        )
    except Exception:
        doc = None
    return await leads_own_crew(doc, database) if doc else False


async def office_level_admin_ids(
    office_id: str, extra_fields: Optional[dict] = None, database=None
) -> list[dict]:
    """Active, non-demo admins of an office whose crew IS the office.

    Returns dicts carrying `_id` plus any `extra_fields` projection, so
    callers that need the name (to stamp a fresh bells row) get it in the
    same query.

    Safety valve: if the office has admins but the upline walk classifies
    every one of them as subordinate — only reachable through a reports_to
    cycle among admins — fall back to all of them rather than silently
    leaving the office with no goal mirror at all.
    """
    projection = {"_id": 1, "role": 1, "office_id": 1, "reports_to": 1, "is_super_admin": 1}
    projection.update(extra_fields or {})
    _db = database if database is not None else db
    admins = await _db.users.find(
        {"office_id": office_id, "role": "admin", **_ACTIVE}, projection
    ).to_list(50)
    if not admins:
        return []
    office_level = [a for a in admins if await is_office_level_admin(a, database)]
    if not office_level:
        logger.warning(
            f"admin scope: no office-level admin resolved for {office_id}; "
            "falling back to every admin (check reports_to for a cycle)"
        )
        return admins
    return office_level
