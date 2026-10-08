"""Bell-triggered grading reminders.

Bells are entered by an admin at the end of a working day. A bell entry with
today (or yesterday) marked "in" is hard evidence the trainee worked — so if
their daily assessment for a day at-or-before their current day is still
incomplete, the leader gets a push nudge.

Behaviour:
    • Runs on the APScheduler interval tick (every 30 min).
    • Sends only between 08:30 and 23:00 app time, UK time by default (quiet hours
      outside that window, per product owner).
    • At most one push per leader every MIN_GAP_HOURS (state kept in the
      `assessment_reminder_state` collection), repeating until the pending
      assessments are completed — then it naturally goes silent.
    • One push per leader summarises all their pending trainees.
    • dry_run=True computes who WOULD be notified without sending or
      touching state — used by the admin test endpoint.

Everything fails silently (like core.push) — reminders are best-effort and
must never take the API down.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone, date

from bson import ObjectId

from database import db
from core.app_time import APP_TZ
from core.push import send_push_to_user

logger = logging.getLogger(__name__)

MIN_GAP_HOURS = 3
# Look back this many calendar days for bells evidence (today + yesterday —
# bells land late in the evening, so the morning nag references yesterday).
LOOKBACK_DAYS = 2


def _in_send_window(now_local: datetime) -> bool:
    """True between 08:30 and 22:59 app time."""
    return (now_local.hour, now_local.minute) >= (8, 30) and now_local.hour < 23


def _week_ending(d: date) -> str:
    """Sunday (inclusive) of the week containing d — bells' week key."""
    return (d + timedelta(days=(6 - d.weekday()))).isoformat()


def _day_worked(day: dict | None) -> bool:
    d = day or {}
    if d.get("status") == "in":
        return True
    return any((d.get(k) or 0) for k in ("over30", "under30", "memberships"))


def _day_label(day_number: int) -> str:
    return f"Orientation day {day_number}" if day_number <= 2 else f"Field day {day_number - 2}"


async def _bells_worked_map(dates: list[date]) -> dict[str, str]:
    """trainee user_id → most recent ISO date (from `dates`) they were 'in'."""
    worked: dict[str, str] = {}
    for d in dates:  # ordered most-recent first so first hit wins
        idx = d.weekday()
        cur = db.bells_entries.find(
            {"week_ending": _week_ending(d), "user_id": {"$nin": [None, ""]}},
            {"user_id": 1, "days": 1},
        )
        async for e in cur:
            uid = e.get("user_id")
            if not uid or uid in worked:
                continue
            days = e.get("days") or []
            if idx < len(days) and _day_worked(days[idx]):
                worked[uid] = d.isoformat()
    return worked


async def _resolve_leader_id(trainee_user_id: str, leader_name: str) -> str | None:
    """Leader user id for a trainee: reports_to first, hire.leader name second."""
    try:
        tu = await db.users.find_one({"_id": ObjectId(trainee_user_id)}, {"reports_to": 1})
    except Exception:
        tu = None
    if tu and tu.get("reports_to"):
        return str(tu["reports_to"])
    if leader_name and leader_name != "Unassigned":
        lu = await db.users.find_one(
            {"name": leader_name, "role": {"$in": ["leader", "admin"]}}, {"_id": 1}
        )
        if lu:
            return str(lu["_id"])
    return None


async def assessment_reminder_tick(dry_run: bool = False, force: bool = False) -> dict:
    """One reminder pass. `force` skips the quiet-hours check (admin testing);
    `dry_run` reports without sending or updating throttle state."""
    now_local = datetime.now(APP_TZ)
    if not force and not _in_send_window(now_local):
        return {"skipped": "quiet_hours", "now_local": now_local.isoformat()}

    dates = [now_local.date() - timedelta(days=i) for i in range(LOOKBACK_DAYS)]
    worked = await _bells_worked_map(dates)
    if not worked:
        return {"sent": 0, "candidates": 0, "reason": "no bells for window"}

    # Only remind for people who are STILL trainees. A rep promoted to leader
    # keeps ringing bells (leaders sell too) and their old new_hire record can
    # linger active with unfinished Stage-1 days — but they must not trigger
    # grading nags. Drop any worked user_id whose account is no longer a
    # trainee (or has been deleted).
    oids = []
    for uid in worked:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass
    trainee_ids = set()
    if oids:
        async for u in db.users.find(
            {"_id": {"$in": oids}, "role": "trainee",
             "deleted": {"$ne": True}, "is_active": {"$ne": False}},
            {"_id": 1},
        ):
            trainee_ids.add(str(u["_id"]))
    worked = {uid: d for uid, d in worked.items() if uid in trainee_ids}
    if not worked:
        return {"sent": 0, "candidates": 0, "reason": "no new BAs worked"}

    hires = await db.new_hires.find(
        {"active": True, "trainee_user_id": {"$in": list(worked.keys())}},
        {"_id": 0, "id": 1, "name": 1, "leader": 1, "current_day": 1, "trainee_user_id": 1},
    ).to_list(500)
    if not hires:
        return {"sent": 0, "candidates": 0, "reason": "no active new starters with bells"}

    hire_ids = [h["id"] for h in hires]
    pending_by_hire: dict[str, list[int]] = {}
    cur = db.daily_assessments.find(
        {"new_hire_id": {"$in": hire_ids}, "completed": {"$ne": True}},
        {"_id": 0, "new_hire_id": 1, "day_number": 1},
    )
    async for a in cur:
        pending_by_hire.setdefault(a["new_hire_id"], []).append(int(a.get("day_number") or 99))

    # leader_id → [{name, day_number, worked_on}]
    by_leader: dict[str, list[dict]] = {}
    unassigned: list[str] = []
    for h in hires:
        # Guard: hires are fetched by trainee-filtered worked ids, so every
        # hire should be in `worked` — but skip defensively if not.
        worked_on = worked.get(h.get("trainee_user_id"))
        if worked_on is None:
            continue
        current_day = int(h.get("current_day") or 1)
        pend = sorted(n for n in pending_by_hire.get(h["id"], []) if n <= current_day)
        if not pend:
            continue
        leader_id = await _resolve_leader_id(h["trainee_user_id"], h.get("leader") or "")
        item = {"name": h.get("name", ""), "day_number": pend[0], "worked_on": worked_on}
        if leader_id:
            by_leader.setdefault(leader_id, []).append(item)
        else:
            unassigned.append(item["name"])

    sent = 0
    skipped_gap = 0
    now_utc = datetime.now(timezone.utc)
    details = []
    for leader_id, items in by_leader.items():
        state = await db.assessment_reminder_state.find_one({"_id": leader_id})
        last = state.get("last_sent_at") if state else None
        if last:
            try:
                last_dt = datetime.fromisoformat(last)
                if now_utc - last_dt < timedelta(hours=MIN_GAP_HOURS):
                    skipped_gap += 1
                    details.append({"leader_id": leader_id, "trainees": items, "status": "throttled"})
                    continue
            except ValueError:
                pass

        if len(items) == 1:
            it = items[0]
            body = f"{it['name']} was in for the day but {_day_label(it['day_number'])} isn't graded yet. Tap to grade."
        else:
            names = ", ".join(f"{it['name']} ({_day_label(it['day_number'])})" for it in items[:3])
            more = f" +{len(items) - 3} more" if len(items) > 3 else ""
            body = f"{len(items)} new BAs worked but aren't graded yet: {names}{more}."

        details.append({"leader_id": leader_id, "trainees": items, "status": "dry_run" if dry_run else "sent"})
        if dry_run:
            continue

        await send_push_to_user(
            leader_id,
            title="📋 Assessments waiting",
            body=body,
            data={"type": "grading_reminder", "url": "/"},
        )
        await db.assessment_reminder_state.update_one(
            {"_id": leader_id},
            {"$set": {"last_sent_at": now_utc.isoformat(), "pending_count": len(items)}},
            upsert=True,
        )
        sent += 1

    result = {
        "sent": sent,
        "candidates": len(by_leader),
        "throttled": skipped_gap,
        "unassigned_pending": unassigned,
        "dry_run": dry_run,
        "details": details,
    }
    if sent or dry_run:
        logger.info(f"assessment_reminder_tick: {sent} sent / {len(by_leader)} candidates / {skipped_gap} throttled")
    return result
