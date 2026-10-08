"""Sales Development Path API — 30-day ramp + Sales Proficiency Ladder.

Thin HTTP layer over core/sales_path.py (the evaluator). Feature-flagged
CI-style: routes are registered unconditionally but 403 until
SALES_PATH_ENABLED=true, with a per-office allowlist (SALES_PATH_OFFICES)
on top so one office can go first.

Sign-off model (mirrors the COD proof ladder's trust boundary): levels 2–4
auto-award from data; Expert is coach-signed and Mastery is admin-signed —
bells numbers are hand-typed by leaders, so the top of the ladder gets a
human signature. Nobody signs their own claim.
"""
from __future__ import annotations

import logging
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from auth import get_current_user, get_subtree_ids, is_demo_request
from core.office_helpers import resolve_office_id
from core.sales_path import (
    DEFAULT_CONTENT,
    GREEN_WEEK_SALES,
    LEVEL_BADGE_KEYS,
    LEVEL_NAMES,
    MASTERY_HOLD_DAYS,
    MIN_SCORED_DAY_SALES,
    THRESHOLDS,
    TYPICAL_WEEKS,
    _today_local_iso,
    _now_iso,
    get_sales_path_content,
    recompute_sales_path,
    sales_path_enabled,
    sales_path_office_enabled,
)
from database import db

logger = logging.getLogger(__name__)
router = APIRouter()


def _require_flag(office_id: str | None):
    if not sales_path_office_enabled(office_id):
        raise HTTPException(status_code=403, detail="Sales Development Path is not enabled")


async def _can_view(viewer: dict, target_user_id: str) -> bool:
    """Same scope shape as CI: self / super admin / admin same office /
    leader subtree."""
    if str(viewer.get("id")) == str(target_user_id):
        return True
    if viewer.get("is_super_admin"):
        return True
    try:
        target = await db.users.find_one({"_id": ObjectId(str(target_user_id))}, {"office_id": 1})
    except Exception:
        target = None
    if not target or target.get("office_id") != viewer.get("office_id"):
        return False
    if viewer.get("role") == "admin":
        return True
    if viewer.get("role") == "leader":
        return str(target_user_id) in set(await get_subtree_ids(viewer["id"]))
    return False


async def _can_coach(viewer: dict, target_user_id: str) -> bool:
    """Coach rights over someone ELSE — never self (a signer must not be the
    person whose hand-typed numbers they are certifying)."""
    if str(viewer.get("id")) == str(target_user_id):
        return False
    return await _can_view(viewer, target_user_id)


async def _target_office(target_user_id: str) -> Optional[str]:
    try:
        u = await db.users.find_one({"_id": ObjectId(str(target_user_id))}, {"office_id": 1})
    except Exception:
        u = None
    return (u or {}).get("office_id")


def _public_doc(doc: dict) -> dict:
    doc = dict(doc)
    doc.pop("_id", None)
    return doc


# ── Read ────────────────────────────────────────────────────────────────────


@router.get("/sales-path/me")
async def my_sales_path(request: Request):
    """The caller's own path — recomputed on read so ramp status is live
    without a scheduler. Returns {enabled: false} (200) when the feature is
    dark for this office so every consumer can render nothing quietly."""
    user = await get_current_user(request)
    if not sales_path_office_enabled(user.get("office_id")):
        return {"enabled": False}
    # Recompute-on-read is fine for a real rep, but this demo login is shared
    # with several outside viewers — none of them should be able to fire a
    # level-up push at a real employee just by opening a page.
    doc = await recompute_sales_path(str(user["id"]), notify=not await is_demo_request(request))
    if not doc:
        return {"enabled": False}
    return {
        "enabled": True,
        "path": _public_doc(doc),
        "meta": _meta(),
        "content": await get_sales_path_content(user.get("office_id")),
        "can_edit": (user.get("role") or "").lower() == "admin",
    }


@router.get("/sales-path/user/{target_user_id}")
async def sales_path_for(target_user_id: str, request: Request):
    """A coach's view of one person's path (leader subtree / admin office)."""
    user = await get_current_user(request)
    target_office = await _target_office(target_user_id) or user.get("office_id")
    _require_flag(target_office)
    if not await _can_view(user, target_user_id):
        raise HTTPException(status_code=403, detail="Not allowed for this user")
    doc = await recompute_sales_path(target_user_id, notify=not await is_demo_request(request))
    if not doc:
        raise HTTPException(status_code=404, detail="No sales path for this user")
    return {
        "enabled": True,
        "path": _public_doc(doc),
        "meta": _meta(),
        "content": await get_sales_path_content(target_office),
        "can_edit": (user.get("role") or "").lower() == "admin",
    }


def _meta() -> dict:
    """Static thresholds the UI renders on level cards — served so copy and
    server criteria can never drift apart."""
    return {
        "green_week_sales": GREEN_WEEK_SALES,
        "level_names": LEVEL_NAMES,
        "thresholds": THRESHOLDS,
        "typical_weeks": TYPICAL_WEEKS,
        "mastery_hold_days": MASTERY_HOLD_DAYS,
        # A day only scores at this many sales — the industry minimum. UI
        # copy renders "2+" from here so words and criteria can't drift.
        "min_scored_day_sales": MIN_SCORED_DAY_SALES,
    }


@router.get("/sales-path/team")
async def team_sales_paths(request: Request):
    """Level + form + ramp status for everyone in the viewer's scope —
    powers the leadership hub card and the per-person drill-in list.
    Leader: reports-to subtree. Admin: their office. Super: ?office=."""
    user = await get_current_user(request)
    role = (user.get("role") or "").lower()
    if role not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    office_id = await resolve_office_id(request, user, request.query_params.get("office"))
    _require_flag(office_id)

    if role == "leader" and not user.get("is_super_admin"):
        # Subtree ids re-filtered through CURRENT user docs with the standard
        # listing set — get_subtree_ids keeps deactivated descendants and
        # follows reports_to across an office transfer, so raw ids would leak
        # a transferred rep's data across an office boundary.
        sub = set(await get_subtree_ids(user["id"]))
        sub.add(str(user["id"]))
        sub_obj = []
        for x in sub:
            try:
                sub_obj.append(ObjectId(x))
            except Exception:
                pass
        ids = [
            str(u["_id"]) async for u in db.users.find(
                {"_id": {"$in": sub_obj}, "office_id": office_id,
                 "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}},
                {"_id": 1},
            )
        ]
    else:
        # Standard listing filter set — office + active + not deleted + not
        # demo — resolved from CURRENT user docs (never stale sales_path
        # office stamps).
        ids = [
            str(u["_id"]) async for u in db.users.find(
                {"office_id": office_id, "role": {"$in": ["trainee", "leader", "admin"]},
                 "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}},
                {"_id": 1},
            )
        ]
    rows = []
    async for doc in db.sales_path.find({"user_id": {"$in": ids}}, {"_id": 0}):
        rows.append({
            "user_id": doc.get("user_id"),
            "level": doc.get("level"),
            "level_name": doc.get("level_name"),
            "form": doc.get("form"),
            "ramp_status": (doc.get("ramp") or {}).get("status"),
            "ramp_week": (doc.get("ramp") or {}).get("week"),
            "expert_data_eligible": doc.get("expert_data_eligible"),
            "green_weeks": doc.get("green_weeks"),
        })
    # Names from live user docs (sales_path stores no denormalized name).
    name_map = {}
    obj_ids = []
    for t in ids:
        try:
            obj_ids.append(ObjectId(t))
        except Exception:
            pass
    async for u in db.users.find({"_id": {"$in": obj_ids}}, {"name": 1, "role": 1}):
        name_map[str(u["_id"])] = {"name": u.get("name"), "role": u.get("role")}
    for r in rows:
        r.update(name_map.get(r["user_id"], {}))
    rows.sort(key=lambda r: (-(r.get("level") or 1), r.get("name") or ""))
    return {"team": rows, "meta": _meta()}


@router.get("/sales-path/leaderboard")
async def sales_path_leaderboard(request: Request):
    """The office Top 5 — the gamified face of the ladder. Every role in
    the office can see it (that's the point of a leaderboard). Ranked by
    level, then Green Weeks, then sales per day — but the RANKING is all
    that's published: nobody sees anyone else's Green Week counts or
    numbers (owner rule, 2026-09-12). The viewer gets their own full row
    and rank so someone at #9 knows exactly what they're chasing.
    Standard listing filters through CURRENT user docs."""
    user = await get_current_user(request)
    office_id = await resolve_office_id(request, user, request.query_params.get("office"))
    _require_flag(office_id)

    people: dict[str, dict] = {}
    # `leaderboard_excluded` keeps office owners off the board (owner rule,
    # 2026-09-16). They carry years of Green Weeks and sit at the top levels,
    # so they occupied the slots the floor is actually racing for — the Top 5
    # is meant to be five people you can catch. It's a per-user flag rather
    # than a role check because not every admin is an owner, and never a name
    # match: "Jordan Grant" is a leader who belongs on the board.
    async for u in db.users.find(
        {"office_id": office_id, "role": {"$in": ["trainee", "leader", "admin"]},
         "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True},
         "leaderboard_excluded": {"$ne": True}},
        {"_id": 1, "name": 1, "role": 1},
    ):
        people[str(u["_id"])] = u

    rows = []
    async for sp in db.sales_path.find({"user_id": {"$in": list(people.keys())}}, {"_id": 0}):
        u = people.get(sp.get("user_id"))
        if not u:
            continue
        form = sp.get("form") or {}
        rows.append({
            "user_id": sp.get("user_id"),
            "name": u.get("name") or "Unknown",
            "level": int(sp.get("level") or 1),
            "level_name": sp.get("level_name") or "Beginner",
            "green_weeks": int(sp.get("green_weeks") or 0),
            "piece_avg": form.get("piece_avg_20d"),
            "ramp_status": (sp.get("ramp") or {}).get("status"),
        })
    rows.sort(key=lambda r: (-r["level"], -r["green_weeks"], -(r["piece_avg"] or 0), r["name"]))
    for i, r in enumerate(rows):
        r["rank"] = i + 1

    me = str(user["id"])
    my_row = next((r for r in rows if r["user_id"] == me), None)
    # Publish rank + level only — the numbers behind the ranking are each
    # person's own business. The viewer's own row keeps its full detail.
    def public(r: dict) -> dict:
        return {k: r[k] for k in ("rank", "user_id", "name", "level", "level_name")}
    return {
        "top": [({**public(r), "green_weeks": r["green_weeks"]} if my_row and r["user_id"] == me else public(r))
                for r in rows[:5]],
        "total": len(rows),
        "my_rank": my_row["rank"] if my_row else None,
        "me": my_row,
    }


# ── Expert / Mastery claims + sign-off ──────────────────────────────────────


class ReadyBody(BaseModel):
    level: int  # 5 = Expert, 6 = Mastery
    ready: bool = True
    target_user_id: Optional[str] = None


@router.put("/sales-path/ready")
async def set_ready(payload: ReadyBody, request: Request):
    """Raise (or clear) an Expert/Mastery claim. Anyone may raise their OWN
    claim once the data says they're eligible; a coach may raise or clear it
    for someone in their scope. Claims land in the coach's /cod/checks queue."""
    user = await get_current_user(request)
    uid = str(user["id"])
    target = payload.target_user_id or uid
    if payload.level not in (5, 6):
        raise HTTPException(status_code=400, detail="level must be 5 (Expert) or 6 (Mastery)")
    _require_flag(await _target_office(target))
    if target != uid and not await _can_coach(user, target):
        raise HTTPException(status_code=403, detail="Not allowed for this user")

    doc = await recompute_sales_path(target)
    if not doc:
        raise HTTPException(status_code=404, detail="No sales path for this user")
    field = "expert" if payload.level == 5 else "mastery"
    if payload.ready:
        if doc.get("level", 1) >= payload.level:
            raise HTTPException(status_code=400, detail="Already at or above this level")
        if not doc.get(f"{field}_data_eligible"):
            raise HTTPException(status_code=400, detail="The data criteria for this level aren't met yet")
    await db.sales_path.update_one({"user_id": target}, {"$set": {
        f"{field}_ready_for_check": bool(payload.ready),
        f"{field}_ready_at": _now_iso() if payload.ready else None,
    }})
    return {"ok": True, "level": payload.level, "ready": bool(payload.ready)}


class SignOffBody(BaseModel):
    level: int
    note: Optional[str] = None


@router.post("/sales-path/{target_user_id}/sign-off")
async def sign_off(target_user_id: str, payload: SignOffBody, request: Request):
    """Sign a claimed level. Expert: any coach with scope (leader subtree /
    admin). Mastery: admin only — it certifies a contribution, not just data.
    Signing re-validates the data criteria at check time and never signs the
    signer's own row."""
    user = await get_current_user(request)
    role = (user.get("role") or "").lower()
    if payload.level not in (5, 6):
        raise HTTPException(status_code=400, detail="level must be 5 (Expert) or 6 (Mastery)")
    if payload.level == 6 and role != "admin":
        raise HTTPException(status_code=403, detail="Mastery is admin-signed")
    _require_flag(await _target_office(target_user_id))
    if not await _can_coach(user, target_user_id):
        raise HTTPException(status_code=403, detail="Not allowed for this user")

    # Re-evaluate NOW — eligibility is recomputed at check time, so a claim
    # that has gone stale (form collapsed since the tap) can't be signed.
    doc = await recompute_sales_path(target_user_id)
    if not doc:
        raise HTTPException(status_code=404, detail="No sales path for this user")
    field = "expert" if payload.level == 5 else "mastery"
    if doc.get("level", 1) >= payload.level:
        raise HTTPException(status_code=400, detail="Already at or above this level")
    if not doc.get(f"{field}_data_eligible"):
        raise HTTPException(status_code=400, detail="The data criteria are no longer met — nothing to sign")

    level_dates = dict(doc.get("level_dates") or {})
    level_dates[field] = _today_local_iso()
    update = {
        "level": payload.level,
        "level_name": LEVEL_NAMES[payload.level],
        "level_dates": level_dates,
        f"{field}_signed_at": _now_iso(),
        f"{field}_signed_by_id": str(user["id"]),
        f"{field}_ready_for_check": False,
        f"{field}_ready_at": None,
        "updated_at": _now_iso(),
    }
    if payload.note:
        update[f"{field}_sign_note"] = str(payload.note)[:500]
    await db.sales_path.update_one({"user_id": target_user_id}, {"$set": update})

    from core.achievements import award
    live = sales_path_office_enabled(doc.get("office_id"))
    await award(target_user_id, LEVEL_BADGE_KEYS[payload.level], notify=live, seen=not live)
    return {"ok": True, "level": payload.level}


class RevokeBody(BaseModel):
    level: int
    reason: str


@router.post("/sales-path/{target_user_id}/revoke")
async def revoke_level(target_user_id: str, payload: RevokeBody, request: Request):
    """Admin-only DATA-CORRECTION revoke — the only way down the ladder
    (never a performance demotion; that's what the form chip is for). Clears
    the signed/awarded state at and above the given level, deletes the badge
    rows, and re-evaluates from the corrected data."""
    user = await get_current_user(request)
    if (user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if payload.level not in (2, 3, 4, 5, 6):
        raise HTTPException(status_code=400, detail="level must be 2–6")
    if not (payload.reason or "").strip():
        raise HTTPException(status_code=400, detail="A reason is required — this is a data correction")
    _require_flag(await _target_office(target_user_id))
    if not user.get("is_super_admin"):
        if await _target_office(target_user_id) != user.get("office_id"):
            raise HTTPException(status_code=403, detail="Not allowed for this user")

    doc = await db.sales_path.find_one({"user_id": target_user_id})
    if not doc:
        raise HTTPException(status_code=404, detail="No sales path for this user")

    from core.sales_path import LEVELS
    level_dates = dict(doc.get("level_dates") or {})
    for n, meta in LEVELS.items():
        if n >= payload.level:
            level_dates.pop(meta["key"], None)
    update: dict = {
        "level": max(1, payload.level - 1),
        "level_name": LEVEL_NAMES[max(1, payload.level - 1)],
        "level_dates": level_dates,
        "updated_at": _now_iso(),
        "mastery_signed_at": None, "mastery_signed_by_id": None,
        "mastery_ready_for_check": False, "mastery_ready_at": None,
    }
    if payload.level <= 5:
        update.update({"expert_signed_at": None, "expert_signed_by_id": None,
                       "expert_ready_for_check": False, "expert_ready_at": None})
    await db.sales_path.update_one({"user_id": target_user_id}, {
        "$set": update,
        "$push": {"revoked": {
            "level": payload.level, "reason": payload.reason.strip()[:500],
            "by_id": str(user["id"]), "at": _now_iso(),
        }},
    })
    stale_keys = [LEVEL_BADGE_KEYS[n] for n in range(payload.level, 7) if n in LEVEL_BADGE_KEYS]
    await db.user_badges.delete_many({"user_id": target_user_id, "key": {"$in": stale_keys}})
    # Re-evaluate from corrected data — high-water restarts from the new floor.
    doc = await recompute_sales_path(target_user_id, notify=False)
    return {"ok": True, "path": _public_doc(doc) if doc else None}


# ── Ramp check-ins ──────────────────────────────────────────────────────────


class CheckinBody(BaseModel):
    week_ending: str
    note: str


@router.post("/sales-path/{target_user_id}/ramp-checkin")
async def ramp_checkin(target_user_id: str, payload: CheckinBody, request: Request):
    """A leader logs the required check-in for a behind ramp week — the
    'intensive 30-day coaching' obligation made visible. Stored on the ramp
    week row; admins can see behind-hires with no logged check-in."""
    user = await get_current_user(request)
    if (user.get("role") or "").lower() not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    _require_flag(await _target_office(target_user_id))
    if not await _can_view(user, target_user_id):
        raise HTTPException(status_code=403, detail="Not allowed for this user")
    if not (payload.note or "").strip():
        raise HTTPException(status_code=400, detail="A check-in note is required")

    doc = await db.sales_path.find_one({"user_id": target_user_id}, {"_id": 0, "ramp": 1})
    weekly = ((doc or {}).get("ramp") or {}).get("weekly") or []
    hit = False
    for row in weekly:
        if row.get("week_ending") == payload.week_ending:
            row["checkin"] = {
                "note": payload.note.strip()[:500],
                "by_id": str(user["id"]),
                "by_name": user.get("name"),
                "at": _now_iso(),
            }
            hit = True
    if not hit:
        raise HTTPException(status_code=404, detail="No ramp week with that week_ending")
    await db.sales_path.update_one({"user_id": target_user_id},
                                   {"$set": {"ramp.weekly": weekly, "updated_at": _now_iso()}})
    return {"ok": True}


# ── Office settings (ramp weekly targets) ───────────────────────────────────


class SettingsBody(BaseModel):
    """Partial update — only provided fields change (onboarding-editor
    pattern). Copy fields land in the office's sales_path_settings doc and
    merge over the global doc and code defaults on read."""
    ramp_targets: Optional[list[int]] = None
    arc_line: Optional[str] = None
    level_arc: Optional[dict[str, str]] = None
    long_game_title: Optional[str] = None
    long_game_body: Optional[str] = None
    journey_ramp_body: Optional[str] = None


@router.get("/sales-path/settings")
async def get_settings(request: Request):
    """The editor's read: merged content + the code defaults (so 'reset to
    default' is a client-side affair)."""
    user = await get_current_user(request)
    office_id = await resolve_office_id(request, user, request.query_params.get("office"))
    _require_flag(office_id)
    return {
        "office_id": office_id,
        "content": await get_sales_path_content(office_id),
        "defaults": DEFAULT_CONTENT,
        "can_edit": (user.get("role") or "").lower() == "admin",
    }


@router.put("/sales-path/settings")
async def put_settings(payload: SettingsBody, request: Request):
    """Admin: tune the ramp weekly targets + the long-game copy for the
    office, in-app (like the onboarding editor). Level thresholds stay
    company-wide code — an 'Advanced' badge must certify the same thing in
    every office — and the Green Week finish line always keys on the
    company constant (12), so tuning week C never moves the badge or the
    bonus."""
    user = await get_current_user(request)
    if (user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    office_id = await resolve_office_id(request, user, request.query_params.get("office"))
    _require_flag(office_id)

    update: dict = {}
    if payload.ramp_targets is not None:
        targets = payload.ramp_targets
        if not (2 <= len(targets) <= 6) or any((not isinstance(t, int)) or t < 1 or t > 50 for t in targets):
            raise HTTPException(status_code=400, detail="ramp_targets must be 2-6 integers between 1 and 50")
        update["ramp_targets"] = targets
    for field in ("arc_line", "long_game_title", "long_game_body", "journey_ramp_body"):
        val = getattr(payload, field)
        if val is not None:
            update[field] = str(val)[:2000].strip()
    if payload.level_arc is not None:
        clean = {}
        for n, line in payload.level_arc.items():
            if str(n) in {"1", "2", "3", "4", "5", "6"} and isinstance(line, str):
                clean[str(n)] = line[:1000].strip()
        update["level_arc"] = clean
    if not update:
        raise HTTPException(status_code=400, detail="Nothing to update")

    update.update({"office_id": office_id, "updated_at": _now_iso(), "updated_by_id": str(user["id"])})
    await db.sales_path_settings.update_one({"office_id": office_id}, {"$set": update}, upsert=True)
    return {"ok": True, "office_id": office_id, "content": await get_sales_path_content(office_id)}
