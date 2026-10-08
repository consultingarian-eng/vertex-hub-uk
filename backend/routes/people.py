"""One person's whole picture, for the person page an Admin opens by tapping a
name: who they are, this week in the field, their law of averages, where they
are in the COD, and their ID badge.

  GET /api/people/{user_id}/breakdown

Scope (never trusted from the client): the Owner sees anyone; an Admin or a
Coach+ sees their own office; a Coach sees themselves and the people under
them in full, and any other new start in the office in a limited form: their
development only (COD and Days 1-8), with no contact details, field numbers
or badge. Badges are for Admins and Coach+.

Read only: nothing here writes, and nothing asks OwnerIQ. It reads what the
hourly sync has already stored.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request

from auth import can_use_badges, get_subtree_ids, require_admin_or_leader, sees_whole_office
from core.app_time import APP_TZ
from core.module_seed import LADDER_COMPLETED_AT
from core.person_breakdown import COD_STAGE_NAME, cod_position, law_of_averages, stage_label
from core.vertex_pay import sign_up_fees
from database import db
from owneriq_config import office_pin
from owneriq_sync import ID_LINKED
from owneriq_sync import aggregate_rows

router = APIRouter()

WEEKS_BACK = 8          # weeks in the "recent weeks" table
LOA_DAYS = 28           # the longer law-of-averages window


def _oid(value: str) -> ObjectId:
    try:
        return ObjectId(str(value))
    except Exception:
        raise HTTPException(status_code=404, detail="Person not found")


async def _load_person(viewer: dict, user_id: str) -> tuple[dict, bool]:
    """(the person, limited). `limited` = a Coach looking at a new start who
    is not on their team: development only."""
    person = await db.users.find_one({"_id": _oid(user_id), "deleted": {"$ne": True}}, {"password_hash": 0})
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    if viewer.get("is_super_admin"):
        return person, False
    if person.get("office_id") != viewer.get("office_id"):
        raise HTTPException(status_code=403, detail="That person is in a different office")
    if sees_whole_office(viewer):
        return person, False
    uid = str(person["_id"])
    if uid in set(await get_subtree_ids(viewer["id"])):
        return person, False
    if person.get("role") == "trainee" and await db.new_hires.find_one(
            {"trainee_user_id": uid, "active": True, "office_id": viewer.get("office_id")}, {"_id": 1}):
        return person, True
    raise HTTPException(status_code=403, detail="That person is not on your team")


async def _module_totals(office_id: str | None) -> dict[int, int]:
    """Live COD modules per stage: the office's own set, else the shared
    default set (the same fallback GET /modules uses)."""
    out: dict[int, int] = {}
    for stage in COD_STAGE_NAME:
        n = await db.training_modules.count_documents({"stage": stage, "office_id": office_id, "retired": {"$ne": True}})
        if not n:
            n = await db.training_modules.count_documents({"stage": stage, "office_id": None, "retired": {"$ne": True}})
        out[stage] = n
    return out


async def _cod(person: dict, uid: str) -> dict:
    marked: dict[int, set] = {}
    met: dict[int, set] = {}
    async for r in db.module_progress.find(
        {"$or": [{"target_user_id": uid}, {"target_user_id": {"$exists": False}, "user_id": uid}]},
        {"_id": 0, "stage": 1, "module_id": 1, "passed_off": 1, "completed": 1, "ladder": 1},
    ):
        stage = int(r.get("stage") or 0)
        if r.get("passed_off"):
            marked.setdefault(stage, set()).add(r.get("module_id"))
        if r.get("passed_off") or r.get("completed") or int(r.get("ladder") or 0) >= LADDER_COMPLETED_AT:
            met.setdefault(stage, set()).add(r.get("module_id"))
    out = cod_position({s: len(v) for s, v in marked.items()}, await _module_totals(person.get("office_id")),
                       {s: len(v) for s, v in met.items()})

    # Days 1-8, for someone who came through as a new start.
    hire = None
    if person.get("new_hire_id"):
        hire = await db.new_hires.find_one({"id": person["new_hire_id"]}, {"_id": 0})
    if not hire:
        hire = await db.new_hires.find_one({"trainee_user_id": uid}, {"_id": 0})
    out["new_start"] = None
    if hire:
        rows = await db.daily_assessments.find(
            {"new_hire_id": hire["id"]}, {"_id": 0, "id": 1, "day_number": 1, "completed": 1, "passed_off": 1, "overall_score": 1},
        ).to_list(50)
        rows.sort(key=lambda a: int(a.get("day_number") or 99))
        current_day = int(hire.get("current_day") or 1)
        pending = [a for a in rows if not a.get("completed") and int(a.get("day_number") or 99) <= current_day]
        out["new_start"] = {
            "hire_id": hire["id"],
            "active": hire.get("active", True) is not False,
            "start_date": hire.get("start_date"),
            "status": hire.get("current_status"),
            "current_day": current_day,
            "days_done": sum(1 for a in rows if a.get("completed")),
            "days_total": 8,
            "next_assessment_id": pending[0]["id"] if pending else None,
            "days": [{"day": int(a.get("day_number") or 0), "completed": bool(a.get("completed")),
                      "passed_off": bool(a.get("passed_off")), "score": a.get("overall_score")} for a in rows],
        }
    return out


async def _kpi_rows(q: dict, from_date: str, to_date: str) -> list[dict]:
    return await db.owneriq_kpis.find({**q, "date": {"$gte": from_date, "$lte": to_date}, **ID_LINKED}, {"_id": 0}).to_list(20000)


async def _loa(person: dict, uid: str, from_date: str, to_date: str, pin: str | None) -> dict:
    out = law_of_averages(await _kpi_rows({"cg1_user_id": uid}, from_date, to_date))
    out["from"], out["to"] = from_date, to_date
    # The office over the same days, per BA per day in the field, to stand beside it.
    office = None
    if pin:
        agg = aggregate_rows(await _kpi_rows({"mc_pin": pin}, from_date, to_date), include_zero=False)
        if agg["included_count"]:
            office = {m: round(v, 1) for m, v in agg["avg_per_rep_day"].items()}
    out["office_avg_per_day"] = office
    return out


async def _badges(person: dict, uid: str) -> list[dict]:
    """Saved ID badges that are this person's: linked to them, carrying one of
    their badge numbers, or (an unlinked badge only) made out in their name."""
    codes = [str(c).upper() for c in (person.get("amplifi_codes") or []) if c]
    ors: list[dict] = [{"user_id": uid}]
    if codes:
        ors.append({"badge_number": {"$in": codes}})
    name = (person.get("name") or "").strip()
    if name:
        ors.append({"user_id": None, "full_name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}})
    q: dict = {"$or": ors}
    if person.get("office_id"):
        q["office_id"] = person["office_id"]
    rows = await db.badges.find(q, {"_id": 0, "photo_base64": 0, "photo_key": 0, "qr_base64": 0}).sort("created_at", -1).to_list(20)
    return [{"id": b["id"], "full_name": b.get("full_name"), "badge_number": b.get("badge_number"),
             "expiry_date": b.get("expiry_date"), "created_at": b.get("created_at"),
             "created_by_name": b.get("created_by_name")} for b in rows]


@router.get("/people/{user_id}/breakdown")
async def person_breakdown(user_id: str, request: Request):
    viewer = await require_admin_or_leader(request)
    person, limited = await _load_person(viewer, user_id)
    uid = str(person["_id"])
    today = datetime.now(APP_TZ).date()
    week_start = today - timedelta(days=today.weekday())
    week_ending = (week_start + timedelta(days=6)).isoformat()

    # Who they are.
    coach = None
    if person.get("reports_to") and ObjectId.is_valid(str(person["reports_to"])):
        c = await db.users.find_one({"_id": ObjectId(str(person["reports_to"])), "deleted": {"$ne": True}}, {"name": 1, "role": 1})
        if c:
            coach = {"id": str(c["_id"]), "name": c.get("name"), "role": c.get("role")}
    office = await db.offices.find_one({"id": person.get("office_id")}, {"_id": 0, "name": 1}) if person.get("office_id") else None
    direct = await db.users.count_documents({"reports_to": uid, "deleted": {"$ne": True}, "is_active": {"$ne": False}})
    subtree = [i for i in await get_subtree_ids(uid) if i != uid]
    legacy = person.get("legacy_vertex_hub") or {}
    stage = stage_label(person.get("owneriq_stage")) or stage_label(legacy.get("stage"))
    cod = await _cod(person, uid)
    start_date = (cod.get("new_start") or {}).get("start_date") or legacy.get("start_date")
    who = {
        "id": uid,
        "name": person.get("name") or "",
        "role": person.get("role"),
        "coach_plus": person.get("role") == "leader" and bool(person.get("coach_plus")),
        "is_super_admin": bool(person.get("is_super_admin")),
        "profile_image": person.get("profile_image"),
        "stage": stage,
        "office_name": (office or {}).get("name"),
        "coach": coach,
        "team": {"direct": direct, "total": len(subtree)},
        "start_date": start_date,
        "is_active": person.get("is_active", True) is not False,
    }
    if limited:
        if cod.get("new_start"):
            cod["new_start"]["next_assessment_id"] = None   # grading is their own Coach's
        return {"limited": True, "can_badge": False, "person": who, "today": today.isoformat(), "cod": cod}

    # This week and the weeks before it (Field IQ, as the hourly sync stored
    # it), each with its Bells sign-ups priced at the office's rates.
    stats = {w.get("week_ending"): w for w in await db.owneriq_weekly_stats.find(
        {"user_id": uid}, {"_id": 0}).sort("week_ending", -1).to_list(WEEKS_BACK)}
    stats.setdefault(week_ending, {})
    fees = await db.commission_fees.find_one({"office_id": person.get("office_id")}, {"_id": 0})
    bells = {b.get("week_ending"): b.get("days") or [] async for b in db.bells_entries.find(
        {"user_id": uid, "week_ending": {"$in": list(stats)}}, {"_id": 0, "week_ending": 1, "days": 1})}
    weeks = []
    for we in sorted(stats, reverse=True)[:WEEKS_BACK]:
        w = stats[we]
        days = bells.get(we)
        weeks.append({
            "week_ending": we,
            "week_start": (datetime.fromisoformat(we).date() - timedelta(days=6)).isoformat(),
            "team_name": w.get("team_name"),
            "kpis": w.get("kpis"),
            "days": w.get("days") or [],
            "sign_ups": sign_up_fees(sum((d.get("under30") or 0) for d in days),
                                     sum((d.get("over30") or 0) for d in days), fees) if days is not None else None,
        })

    pin = await office_pin(person.get("office_id"), db)
    recent_from = (today - timedelta(days=LOA_DAYS - 1)).isoformat()
    daily = await _kpi_rows({"cg1_user_id": uid}, recent_from, today.isoformat())
    state = await db.owneriq_sync_state.find_one({"_id": "performance"}, {"_id": 0, "synced_at": 1})

    can_badge = can_use_badges(viewer)
    # The full COD screen belongs to whoever coaches them: an Admin, or a Coach
    # with this person under them.
    can_open_cod = (person.get("role") in ("trainee", "leader") and uid != str(viewer["id"])
                    and (viewer.get("role") == "admin" or uid in set(await get_subtree_ids(viewer["id"]))))
    return {
        "limited": False,
        "can_badge": can_badge,
        "can_open_cod": can_open_cod,
        "person": {
            **who,
            "email": person.get("email"),
            "phone": person.get("phone"),
            "badge_numbers": [str(c) for c in (person.get("amplifi_codes") or []) if c],
            # Whether someone has set their own password is the office's business, not a Coach's.
            "on_starter_password": bool(person.get("must_change_password")) and viewer.get("role") == "admin",
        },
        "today": today.isoformat(),
        "week_ending": week_ending,
        "weeks": weeks,          # newest first; always includes this week
        "loa": {
            "week": await _loa(person, uid, week_start.isoformat(), today.isoformat(), pin),
            "recent": await _loa(person, uid, recent_from, today.isoformat(), pin),
            "recent_days": LOA_DAYS,
            "days": sorted(({"date": r.get("date"), **{m: r.get(m) or 0 for m in (
                "doors_knocked", "spoken_to", "pitches_commenced", "pitches_closed", "sales", "points")}} for r in daily),
                key=lambda r: r["date"] or "", reverse=True),
        },
        "cod": cod,
        "badges": await _badges(person, uid) if can_badge else [],
        "synced_at": (state or {}).get("synced_at"),
    }
