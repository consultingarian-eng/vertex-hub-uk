"""Weekly Schedule — recurring (single template per office) meeting blocks.

Data model (collection: schedule_blocks):
    {
        id: str,
        office_id: str,
        day_of_week: int,    # 0=Mon ... 5=Sat (Sundays not used per template)
        start_time: str,     # 'HH:MM' 24-hour
        end_time: str,       # 'HH:MM' 24-hour, must be > start
        title: str,
        audience: 'all' | 'leaders' | 'trainees' | 'core_leaders' | 'personal',
        groups: ['s4','ld','s2','s1'],  # timetable lanes (see core/schedule_template)
        date: 'YYYY-MM-DD' | None,      # a one-off on that date; None repeats weekly
        kind: 'event' | 'task',         # tasks tick off per date (done_dates)
        reminder_minutes: int | None,   # minutes before start; None = no reminder
        color: str,          # hex like '#3a7a56' (palette suggestion only)
        presenter: str | None,    # free-text, e.g. 'Mike'
        topic: str | None,        # short topic line
        details: str | None,      # longer notes / agenda
        created_at, updated_at
    }
"""
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from dotenv import load_dotenv

from auth import get_current_user, require_admin
from core.bells_absence import current_week_absence
from core.office_helpers import resolve_office_id
from core.schedule_template import (GROUP_LABELS, VERTEX_DAY_LABELS, TEMPLATE_ID, clean_groups,
                                    template_docs, user_group)

load_dotenv()
# Same MONGO_URL fallback as database.py: a blank MONGO_URL line in .env
# (copied from .env.example) reads as unset instead of crashing the import.
from database import db  # the shared client; one DB_NAME default (database.py)

router = APIRouter()

VALID_DAYS = list(range(0, 7))   # 0=Mon .. 6=Sun (we accept Sun too in case admin wants it)
# 'personal' blocks are private to a single owner (owner_id) — a leader/admin's
# own work/life blocks. They're never shown to anyone else and only the owner
# gets reminders. All the others are shared office-template audiences.
VALID_AUDIENCES = {"all", "leaders", "trainees", "core_leaders", "personal"}

# The default template is the Owner's Mon–Fri office week (core/schedule_template).
# Auto-seeded for any office that has zero blocks the first time `/api/schedule`
# is hit, so a fresh deploy ships populated. Admins edit it from there.
REMINDER_CHOICES = {0, 5, 10, 15, 30, 60, 120, 1440}


async def _seed_default_schedule(office_id: str) -> int:
    """Seed the office week into the given office. Idempotent: only inserts if
    the office currently has zero blocks. Returns the # inserted."""
    if not office_id:
        return 0
    existing = await db.schedule_blocks.count_documents({"office_id": office_id})
    if existing > 0:
        return 0
    docs = template_docs(office_id)
    if docs:
        await db.schedule_blocks.insert_many(docs)
        await db.offices.update_one({"id": office_id}, {"$set": {
            "schedule_template": TEMPLATE_ID, "schedule_day_labels": VERTEX_DAY_LABELS}})
    return len(docs)


def _clean_date(v) -> Optional[str]:
    """'YYYY-MM-DD' or None."""
    if not v:
        return None
    try:
        return datetime.strptime(str(v).strip()[:10], "%Y-%m-%d").date().isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")


def _clean_reminder(v) -> Optional[int]:
    """Minutes before the start, from REMINDER_CHOICES; None = no reminder."""
    if v is None or v == "":
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n in REMINDER_CHOICES else None


def _hhmm_to_minutes(s: str) -> Optional[int]:
    try:
        hh, mm = s.split(":")
        h = int(hh)
        m = int(mm)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h * 60 + m
    except Exception:
        pass
    return None


async def _scoped_block(admin: dict, block_id: str) -> dict:
    block = await db.schedule_blocks.find_one({"id": block_id})
    if not block:
        raise HTTPException(status_code=404, detail="Block not found")
    if not admin.get("is_super_admin"):
        if not admin.get("office_id") or block.get("office_id") != admin.get("office_id"):
            raise HTTPException(status_code=403, detail="You can only edit your own office's schedule")
    return block


async def _manage_block(user: dict, block_id: str) -> dict:
    """Authorize an edit/delete of a block and return it.

    - Personal blocks: only their owner may manage them (not even admins —
      admins never see other people's personal blocks).
    - Office blocks: admin-only, scoped to the admin's own office (super
      admins may manage any office).
    """
    block = await db.schedule_blocks.find_one({"id": block_id})
    if not block:
        raise HTTPException(status_code=404, detail="Block not found")
    user_id = user.get("id") or user.get("_id") or user.get("user_id")
    if (block.get("audience") or "").lower() == "personal":
        if not user_id or block.get("owner_id") != user_id:
            raise HTTPException(status_code=403, detail="You can only edit your own personal blocks")
        return block
    role = (user.get("role") or "").lower()
    if role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if not user.get("is_super_admin"):
        if not user.get("office_id") or block.get("office_id") != user.get("office_id"):
            raise HTTPException(status_code=403, detail="You can only edit your own office's schedule")
    return block


@router.get("/schedule")
async def list_schedule(request: Request, office: Optional[str] = None):
    """Return all blocks for the requested office, sorted by day then start time.
    Anyone authenticated can read. Auto-seeds the default CG1 template the first
    time an office is hit (zero existing blocks)."""
    user = await get_current_user(request)
    office_id = await resolve_office_id(request, user, office)
    if not office_id:
        return {"office_id": None, "blocks": []}

    # Lazy seed: any office with zero blocks gets the default template installed
    # automatically on first read so a fresh deploy ships preloaded.
    seeded = await _seed_default_schedule(office_id)

    blocks: list = []
    async for b in db.schedule_blocks.find({"office_id": office_id}, {"_id": 0}):
        blocks.append(b)
    blocks.sort(key=lambda b: (
        int(b.get("day_of_week") or 0),
        _hhmm_to_minutes(b.get("start_time") or "00:00") or 0,
    ))

    # Audience-based visibility filter (defense-in-depth — the UI also filters,
    # but we never want a trainee to be able to *fetch* leader-only content).
    role = (user.get("role") or "").lower()
    user_id = user.get("id") or user.get("_id") or user.get("user_id")

    def _visible(b: dict) -> bool:
        aud = (b.get("audience") or "all").lower()
        # Personal blocks are private to their owner — hidden from EVERYONE
        # else, including admins. (A super admin can still see a leader's
        # personal blocks by using "Preview as" that leader, which resolves
        # get_current_user() as them.)
        if aud == "personal":
            return bool(user_id) and b.get("owner_id") == user_id
        if role == "admin":
            return True
        if aud == "all":
            return True
        if aud == "core_leaders":
            ids = b.get("core_leader_ids") or []
            return bool(user_id) and user_id in ids
        if aud == "leaders":
            return role == "leader"
        if aud == "trainees":
            # Leaders can see trainee blocks (coaching visibility).
            return role in ("leader", "trainee")
        return False

    blocks = [b for b in blocks if _visible(b)]

    office_doc = await db.offices.find_one({"id": office_id}, {"_id": 0, "schedule_day_labels": 1}) or {}

    # The viewer's own `ab` days on this week's bells — the app blanks those
    # days and skips their reminders. Only for their own office's schedule.
    absence = {"week_ending": None, "days": [], "dates": []}
    if office_id == user.get("office_id"):
        absence = await current_week_absence(user_id, database=db)

    return {"office_id": office_id, "blocks": blocks, "seeded": seeded,
            "my_group": user_group(role, user.get("owneriq_stage")),
            "group_labels": GROUP_LABELS,
            "day_labels": office_doc.get("schedule_day_labels") or {},
            "absent_days": absence["days"], "absent_dates": absence["dates"],
            "absent_week_ending": absence["week_ending"]}


@router.post("/schedule/seed-defaults")
async def reseed_defaults(request: Request):
    """Admin-only: force-load (or re-load) the default CG1 schedule template
    into this admin's office. Skips if the office already has blocks unless
    `?force=true` is passed (which wipes existing blocks first)."""
    admin = await require_admin(request)
    office_id = admin.get("office_id")
    if not office_id:
        raise HTTPException(status_code=400, detail="Admin has no office_id set")
    force = (request.query_params.get("force") or "").lower() in ("1", "true", "yes")
    if force:
        await db.schedule_blocks.delete_many({"office_id": office_id})
    seeded = await _seed_default_schedule(office_id)
    return {"office_id": office_id, "seeded": seeded, "force": force}


@router.put("/schedule/day-labels")
async def set_day_labels(request: Request):
    """Admin: the short label beside each day name, e.g. Tuesday · Day Trip.
    Body: { "labels": { "1": "Day Trip", ... }, "office_id"?: str }"""
    admin = await require_admin(request)
    body = await request.json()
    office_id = await resolve_office_id(request, admin, body.get("office_id"))
    if not office_id:
        raise HTTPException(status_code=400, detail="office_id is required")
    raw = body.get("labels") or {}
    days = {str(d) for d in VALID_DAYS}
    labels = {str(k): str(v).strip()[:40] for k, v in raw.items()
              if str(k) in days and str(v or "").strip()}
    await db.offices.update_one({"id": office_id}, {"$set": {"schedule_day_labels": labels}})
    return {"office_id": office_id, "day_labels": labels}


@router.post("/schedule")
async def create_block(request: Request):
    """Create a schedule block.

    Shared office blocks (audience all/leaders/trainees/core_leaders) are
    admin-only. Personal blocks (audience 'personal') can be created by anyone
    for themselves: private to the owner, never shown to anyone else, and only
    the owner is reminded.
    """
    user = await get_current_user(request)
    body = await request.json()
    role = (user.get("role") or "").lower()
    user_id = user.get("id") or user.get("_id") or user.get("user_id")

    audience = (body.get("audience") or "all").strip().lower()
    if audience not in VALID_AUDIENCES:
        audience = "all"
    is_personal = audience == "personal"

    if is_personal:
        # Personal blocks always live in the owner's own office and belong to
        # the caller — never trust an office_id/owner_id from the client.
        office_id = user.get("office_id")
        owner_id = str(user_id) if user_id else None
        if not owner_id:
            raise HTTPException(status_code=400, detail="Could not resolve your user id")
    else:
        if role != "admin":
            raise HTTPException(status_code=403, detail="Admin access required")
        office_id = await resolve_office_id(request, user, body.get("office_id"))
        owner_id = None
    if not office_id:
        raise HTTPException(status_code=400, detail="office_id is required")

    day = body.get("day_of_week")
    if day is None or int(day) not in VALID_DAYS:
        raise HTTPException(status_code=400, detail="day_of_week must be 0..6")
    start = (body.get("start_time") or "").strip()
    end = (body.get("end_time") or "").strip()
    sm = _hhmm_to_minutes(start)
    em = _hhmm_to_minutes(end)
    if sm is None or em is None or em <= sm:
        raise HTTPException(status_code=400, detail="start_time / end_time invalid (HH:MM, end > start)")
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    # core_leader_ids: list of user ids permitted to see+notify when audience=core_leaders
    raw_ids = body.get("core_leader_ids") or []
    core_leader_ids: list[str] = []
    if isinstance(raw_ids, list):
        for x in raw_ids:
            if isinstance(x, str) and x.strip():
                core_leader_ids.append(x.strip())
    color = (body.get("color") or "#3a7a56").strip()
    if not color.startswith("#") or len(color) not in (4, 7):
        color = "#3a7a56"

    now = datetime.now(timezone.utc).isoformat()
    block = {
        "id": str(uuid.uuid4()),
        "office_id": office_id,
        "day_of_week": int(day),
        "start_time": start,
        "end_time": end,
        "title": title,
        "audience": audience,
        "color": color,
        "core_leader_ids": core_leader_ids if audience == "core_leaders" else [],
        "owner_id": owner_id,
        "groups": [] if is_personal else clean_groups(body.get("groups")),
        "date": _clean_date(body.get("date")),
        "kind": "task" if is_personal and body.get("kind") == "task" else "event",
        "reminder_minutes": _clean_reminder(body.get("reminder_minutes", 10 if is_personal else 5)),
        "done_dates": [],
        "presenter": (body.get("presenter") or "").strip() or None,
        "topic": (body.get("topic") or "").strip() or None,
        "details": (body.get("details") or "").strip() or None,
        "created_at": now,
        "updated_at": now,
    }
    await db.schedule_blocks.insert_one(block.copy())
    block.pop("_id", None)
    return block


@router.put("/schedule/{block_id}")
async def update_block(block_id: str, request: Request):
    """Update a block. Office blocks are admin-only; personal blocks may be
    edited only by their owner (enforced in _manage_block)."""
    user = await get_current_user(request)
    existing_block = await _manage_block(user, block_id)
    is_personal = (existing_block.get("audience") or "").lower() == "personal"
    body = await request.json()
    updates: dict = {}
    for k in ("title", "audience", "color", "presenter", "topic", "details", "start_time", "end_time"):
        if k in body:
            v = body.get(k)
            if isinstance(v, str):
                v = v.strip()
            updates[k] = v or None if k in ("presenter", "topic", "details") else v
    if "day_of_week" in body:
        d = body.get("day_of_week")
        if d is None or int(d) not in VALID_DAYS:
            raise HTTPException(status_code=400, detail="day_of_week must be 0..6")
        updates["day_of_week"] = int(d)
    if "start_time" in updates or "end_time" in updates:
        s = updates.get("start_time", existing_block.get("start_time"))
        e = updates.get("end_time", existing_block.get("end_time"))
        sm = _hhmm_to_minutes(s)
        em = _hhmm_to_minutes(e)
        if sm is None or em is None or em <= sm:
            raise HTTPException(status_code=400, detail="start_time / end_time invalid")
    if "audience" in updates:
        a = (updates["audience"] or "").lower()
        # A personal block can never be converted into a shared office block
        # (or vice-versa) via update — that would change who can see it.
        if is_personal:
            updates["audience"] = "personal"
        else:
            if a not in VALID_AUDIENCES or a == "personal":
                a = "all"
            updates["audience"] = a
    if "groups" in body and not is_personal:
        updates["groups"] = clean_groups(body.get("groups"))
    if "date" in body:
        updates["date"] = _clean_date(body.get("date"))
    if "kind" in body and is_personal:
        updates["kind"] = "task" if body.get("kind") == "task" else "event"
    if "reminder_minutes" in body:
        updates["reminder_minutes"] = _clean_reminder(body.get("reminder_minutes"))
    if "core_leader_ids" in body:
        raw_ids = body.get("core_leader_ids") or []
        cleaned: list[str] = []
        if isinstance(raw_ids, list):
            for x in raw_ids:
                if isinstance(x, str) and x.strip():
                    cleaned.append(x.strip())
        updates["core_leader_ids"] = cleaned
    if "color" in updates:
        c = updates["color"] or ""
        if not c.startswith("#") or len(c) not in (4, 7):
            updates["color"] = "#3a7a56"
    if "title" in updates and not (updates["title"] or "").strip():
        raise HTTPException(status_code=400, detail="title cannot be empty")

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    res = await db.schedule_blocks.update_one({"id": block_id}, {"$set": updates})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Block not found")
    block = await db.schedule_blocks.find_one({"id": block_id}, {"_id": 0})
    return block


@router.delete("/schedule/{block_id}")
async def delete_block(block_id: str, request: Request):
    """Delete a block. Office blocks are admin-only; personal blocks may be
    deleted only by their owner (enforced in _manage_block)."""
    user = await get_current_user(request)
    await _manage_block(user, block_id)
    res = await db.schedule_blocks.delete_one({"id": block_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Block not found")
    return {"ok": True}


@router.post("/schedule/{block_id}/duplicate")
async def duplicate_block(block_id: str, request: Request):
    """Admin-only: duplicate this block to one or more target days.

    Body: { "days": [0..6, ...] } — list of day_of_week ints (Mon=0..Sun=6).
    Each entry creates a fresh block with a new id but identical content
    (title, time, audience, color, presenter, topic, details, core_leader_ids).
    Duplicates onto the source's own day are silently skipped.
    """
    admin = await require_admin(request)
    body = await request.json()
    raw_days = body.get("days") or []
    if not isinstance(raw_days, list) or not raw_days:
        raise HTTPException(status_code=400, detail="`days` must be a non-empty list of weekday ints (0..6)")

    src = await _scoped_block(admin, block_id)
    src.pop("_id", None)

    targets: list[int] = []
    seen: set[int] = set()
    for d in raw_days:
        try:
            di = int(d)
        except Exception:
            continue
        if di in VALID_DAYS and di != int(src.get("day_of_week", -1)) and di not in seen:
            targets.append(di)
            seen.add(di)

    if not targets:
        raise HTTPException(status_code=400, detail="No valid target days (cannot duplicate onto source's own day)")

    now_iso = datetime.now(timezone.utc).isoformat()
    new_docs = []
    for d in targets:
        new_docs.append({
            "id": str(uuid.uuid4()),
            "office_id": src.get("office_id"),
            "day_of_week": d,
            "start_time": src.get("start_time"),
            "end_time": src.get("end_time"),
            "title": src.get("title"),
            "audience": src.get("audience") or "all",
            "color": src.get("color") or "#3a7a56",
            "core_leader_ids": list(src.get("core_leader_ids") or []),
            "groups": list(src.get("groups") or []),
            "reminder_minutes": src.get("reminder_minutes", 5),
            "kind": src.get("kind") or "event",
            "date": None,
            "presenter": src.get("presenter"),
            "topic": src.get("topic"),
            "details": src.get("details"),
            "created_at": now_iso,
            "updated_at": now_iso,
            "duplicated_from": block_id,
        })
    if new_docs:
        await db.schedule_blocks.insert_many(new_docs)
    # return list without _id
    return {"created": [{k: v for k, v in d.items() if k != "_id"} for d in new_docs]}


@router.post("/schedule/{block_id}/done")
async def set_task_done(block_id: str, request: Request):
    """Tick a personal task off (or back on) for one date. Owner only.
    Body: { "date": "YYYY-MM-DD", "done": true }"""
    user = await get_current_user(request)
    block = await _manage_block(user, block_id)
    if (block.get("audience") or "").lower() != "personal":
        raise HTTPException(status_code=400, detail="Only your own tasks can be ticked off")
    body = await request.json()
    day = _clean_date(body.get("date")) or block.get("date")
    if not day:
        raise HTTPException(status_code=400, detail="date is required")
    op = "$addToSet" if body.get("done", True) else "$pull"
    await db.schedule_blocks.update_one({"id": block_id}, {op: {"done_dates": day}, "$set": {"kind": "task"}})
    return await db.schedule_blocks.find_one({"id": block_id}, {"_id": 0})
