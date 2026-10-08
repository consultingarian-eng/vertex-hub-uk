"""Orientation mass-grading nudges + the shared cohort query.

Why this exists
---------------
99/100 new hires are simply "Excellent and Learnt" on orientation Days 1–2,
yet each one used to cost the admin ~5 minutes of per-person grading. The
bulk-grade flow (routes/orientation.py) marks the whole Monday class at once;
this module is the push that reminds admins it's waiting:

    • Day 1 nudge — Monday 18:00 UK time (the day the class is created).
    • Day 2 nudge — Tuesday 18:00 UK time.

For each office whose Day-N orientation cohort is non-empty, every active
admin of that office gets ONE push, deep-linked to /orientation-grading?day=N.
Empty cohort → no push at all. Dedupe is one send per (office, day, app-time date),
tracked in `orientation_nudge_sends` with a 7-day TTL — the same pattern as
`schedule_reminder_sends` — so a retried/overlapping tick never double-fires.

The cohort definition lives here (cohort_for_office) so the GET
/api/orientation/cohort endpoint and this tick can never drift apart:
    active new_hires of the office, start_date within the last 8 days (app time),
    whose Day-N daily_assessment exists and is NOT completed.

data["type"] is "orientation_grading", which maps to the "grading"
notification-prefs category in core/push.py — admins who switched grading
nudges off stay silent (send_push_to_user enforces it).

Everything fails silently — nudges are best-effort and must never take the
API down.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone

from database import db
from core.app_time import APP_TZ
from core.push import send_push_to_user

logger = logging.getLogger(__name__)


# "Within the last 8 days": start_date is today or up to 7 days ago (app time).
# Wide enough that a Tuesday Day-2 nudge (and a missed-notification catch-up
# later in the week) still sees Monday's class; narrow enough that stale
# never-graded records from previous cohorts don't haunt the list forever.
ORIENTATION_WINDOW_DAYS = 8

ORIENTATION_DAYS = (1, 2)

_ttl_index_ready = False


def _start_date_in_window(start_date, today_local: date) -> bool:
    """True when start_date (ISO string, date part) is within the last
    ORIENTATION_WINDOW_DAYS days (app time) — today included, future starts excluded.
    Unparseable/missing dates are excluded (can't prove they belong)."""
    try:
        d = date.fromisoformat(str(start_date)[:10])
    except (ValueError, TypeError):
        return False
    delta = (today_local - d).days
    return 0 <= delta < ORIENTATION_WINDOW_DAYS


async def cohort_for_office(office_id: str, day: int) -> list[dict]:
    """The Day-N orientation grading cohort for one office.

    Active new hires of the office whose start_date falls in the 8-day
    window (app time) and whose Day-N daily_assessment exists and is not completed.
    An empty list is normal (everyone graded / no recent class)."""
    today_local = datetime.now(APP_TZ).date()
    hires = await db.new_hires.find(
        {"active": True, "office_id": office_id},
        {"_id": 0, "id": 1, "name": 1, "start_date": 1, "leader": 1},
    ).to_list(500)
    windowed = [h for h in hires if _start_date_in_window(h.get("start_date"), today_local)]
    if not windowed:
        return []
    pending_by_hire: dict[str, str] = {}  # hire_id -> assessment_id
    cur = db.daily_assessments.find(
        {"new_hire_id": {"$in": [h["id"] for h in windowed]}, "day_number": day},
        {"_id": 0, "id": 1, "new_hire_id": 1, "completed": 1},
    )
    async for a in cur:
        if not a.get("completed"):
            pending_by_hire[a["new_hire_id"]] = a["id"]
    items = [
        {
            "hire_id": h["id"],
            "assessment_id": pending_by_hire[h["id"]],
            "name": h.get("name", ""),
            "start_date": h.get("start_date"),
            "has_leader": bool((h.get("leader") or "").strip()),
        }
        for h in windowed
        if h["id"] in pending_by_hire
    ]
    items.sort(key=lambda i: i["name"].lower())
    return items


async def _ensure_ttl_index() -> None:
    """Expire dedupe markers after 7 days so the collection stays tiny."""
    global _ttl_index_ready
    if _ttl_index_ready:
        return
    try:
        await db.orientation_nudge_sends.create_index(
            "created_at", expireAfterSeconds=7 * 86400
        )
    except Exception:
        pass
    _ttl_index_ready = True


async def _claim_send(office_id: str, day: int, local_date: str) -> bool:
    """Atomically mark (office, day, date) as nudged. True = we won the claim."""
    key = f"{office_id}:{day}:{local_date}"
    try:
        res = await db.orientation_nudge_sends.update_one(
            {"_id": key},
            {"$setOnInsert": {"created_at": datetime.now(timezone.utc)}},
            upsert=True,
        )
        return res.upserted_id is not None
    except Exception:
        # Duplicate-key race → someone else already has it.
        return False


async def orientation_nudge_tick(day: int, dry_run: bool = False) -> dict:
    """One nudge pass for orientation Day `day` (1 or 2). For each office with
    a non-empty ungraded cohort, push every active admin of that office —
    once per office per app-time date. `dry_run` reports without sending/claiming."""
    if day not in ORIENTATION_DAYS:
        return {"sent": 0, "offices": 0, "reason": f"invalid day {day}"}
    await _ensure_ttl_index()
    local_date = datetime.now(APP_TZ).date().isoformat()

    sent = 0
    offices_nudged = 0
    details: list[dict] = []
    try:
        offices = await db.offices.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(100)
    except Exception as e:
        logger.error(f"orientation_nudge_tick: office load failed: {e}")
        return {"sent": 0, "offices": 0, "reason": "office load failed"}

    for office in offices:
        office_id = office.get("id")
        if not office_id:
            continue
        try:
            cohort = await cohort_for_office(office_id, day)
        except Exception as e:
            logger.error(f"orientation_nudge_tick: cohort failed for {office_id}: {e}")
            continue
        # Day-2 evening must not ignore a Day 1 that was never graded — the
        # push covers the earliest day waiting, so leftovers can't hide
        # behind the weekday.
        leftover_day1: list = []
        if day == 2:
            try:
                leftover_day1 = await cohort_for_office(office_id, 1)
            except Exception:
                leftover_day1 = []
        if not cohort and not leftover_day1:
            continue  # nothing ungraded → no push at all

        if dry_run:
            details.append({"office_id": office_id, "cohort": len(cohort), "status": "dry_run"})
            continue

        # One claim covers every admin of the office for this app-time date.
        if not await _claim_send(office_id, day, local_date):
            details.append({"office_id": office_id, "cohort": len(cohort), "status": "deduped"})
            continue

        n = len(cohort)
        if leftover_day1 and n:
            title = f"🎓 Orientation waiting — Day 1: {len(leftover_day1)} · Day 2: {n}"
            target_day = 1
        elif leftover_day1:
            title = f"🎓 {len(leftover_day1)} orientation Day 1 assessments still ungraded"
            target_day = 1
        else:
            title = f"🎓 {n} orientation Day {day} assessments ready"
            target_day = day
        body = "Tap to mark the Monday class — all of them at once"
        data = {"type": "orientation_grading", "url": f"/orientation-grading?day={target_day}"}
        office_sent = 0
        try:
            cur = db.users.find(
                {
                    "office_id": office_id,
                    "role": "admin",
                    "deleted": {"$ne": True},
                    "is_active": {"$ne": False},
                },
                {"_id": 1},
            )
            async for u in cur:
                try:
                    # send_push_to_user applies the "grading" prefs gate itself.
                    await send_push_to_user(str(u["_id"]), title, body, data)
                    office_sent += 1
                except Exception as e:
                    logger.error(f"orientation_nudge_tick: push failed for {u.get('_id')}: {e}")
        except Exception as e:
            logger.error(f"orientation_nudge_tick: admin load failed for {office_id}: {e}")
        sent += office_sent
        offices_nudged += 1
        details.append({"office_id": office_id, "cohort": n, "admins_pushed": office_sent, "status": "sent"})

    result = {"sent": sent, "offices": offices_nudged, "day": day, "dry_run": dry_run, "details": details}
    if sent or dry_run:
        logger.info(
            f"orientation_nudge_tick(day={day}): pushed {sent} admin(s) across {offices_nudged} office(s)"
        )
    return result
