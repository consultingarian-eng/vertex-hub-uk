"""Server-side schedule-block reminders for the installed PWA (web push).

Why this exists
---------------
On native (Expo Go / native builds) the "Starting in 5 min: …" reminders are
*local* notifications scheduled on-device by the app (see the frontend's
utils/scheduleNotifications.ts). Browsers can't schedule local notifications,
so on the web PWA that scheduler no-ops — which means web users historically
got NO schedule reminders at all.

This module fills that gap: an APScheduler tick (every minute) scans the
recurring `schedule_blocks` and, at each block's reminder time (its
`reminder_minutes` before the start; 5 for older blocks, none when null), fires a
WEB PUSH to every user in that office whose audience matches — but ONLY over
web push (send_web_push_to_user), never the combined channel. Native users
keep their on-device local reminder; a user who has *both* the native app and
the installed PWA will get both (product decision — one per channel).

Times in `schedule_blocks` are wall-clock times in the app timezone (UK time). `day_of_week` is
0=Mon … 6=Sun, matching the schedule model. A block with a `date` happens once,
on that date; without one it repeats every week. Office blocks with `groups`
reach only the people in those timetable lanes (core/schedule_template).

Dedup: one send per (block_id, app-time date), tracked in
`schedule_reminder_sends` so overlapping/retried ticks never double-fire.
Everything fails silently — reminders are best-effort and must never take the
API down.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from database import db
from core.app_time import APP_TZ
from core.bells_absence import absent_today_user_ids
from core.push import is_category_enabled_for_user_id
from core.schedule_template import block_groups, user_group
from core.webpush import send_web_push_to_user

logger = logging.getLogger(__name__)

REMINDER_MINUTES = 5  # blocks saved before per-block reminders existed
# How wide a window (in minutes) counts as "due" for a given fire time. The tick
# runs every minute; a 2-minute window means a delayed/skipped tick still catches
# the reminder on the next minute, while per-(block,date) dedup prevents a repeat.
DUE_WINDOW_MIN = 2

_ttl_index_ready = False


def _hhmm_to_minutes(s: str) -> int | None:
    try:
        hh, mm = str(s).split(":")
        h, m = int(hh), int(mm)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h * 60 + m
    except Exception:
        pass
    return None


def _reminders_opted_out(user_doc: dict) -> bool:
    """Profile-tab "Schedule Reminders" toggle (PUT /me/schedule-reminders).
    Off is always explicit — missing/None/anything-else means enabled, matching
    the frontend's default-on and the backend's opt-out convention."""
    return user_doc.get("schedule_reminders_enabled") is False


def _audience_match(audience: str, role: str, user_id: str, core_leader_ids: list[str], owner_id: str | None = None) -> bool:
    """Mirror the frontend isAudienceMatch() so web reminders reach exactly the
    same people the native local reminders do."""
    aud = (audience or "all").lower()
    role = (role or "").lower()
    # Personal blocks are private — only the owner is ever reminded.
    if aud == "personal":
        return bool(owner_id) and user_id == owner_id
    if aud == "all":
        return True
    if aud == "leaders":
        return role in ("leader", "admin")
    if aud == "trainees":
        return role == "trainee"
    if aud == "core_leaders":
        return role == "admin" or user_id in (core_leader_ids or [])
    return False


def _reminder_minutes(block: dict) -> int | None:
    """Minutes before the start to remind; None = no reminder."""
    if "reminder_minutes" not in block:
        return REMINDER_MINUTES
    v = block.get("reminder_minutes")
    return int(v) if isinstance(v, (int, float)) and v >= 0 else None


def _block_match(block: dict, role: str, user_id: str, stage) -> bool:
    """Is this person reminded of this block? Lane-based for office blocks that
    carry `groups`; otherwise the audience rules shared with the app."""
    aud = (block.get("audience") or "all").lower()
    if aud != "personal" and block.get("groups"):
        return user_group(role, stage) in block_groups(block)
    return _audience_match(aud, role, user_id, block.get("core_leader_ids") or [], block.get("owner_id"))


def _when(minutes: int) -> str:
    if minutes <= 0:
        return "Starting now"
    if minutes >= 1440 and minutes % 1440 == 0:
        days = minutes // 1440
        return "Tomorrow" if days == 1 else f"In {days} days"
    if minutes >= 60 and minutes % 60 == 0:
        return f"Starting in {minutes // 60} hr"
    return f"Starting in {minutes} min"


def _build_message(block: dict) -> tuple[str, str]:
    minutes = _reminder_minutes(block)
    minutes = REMINDER_MINUTES if minutes is None else minutes
    label = "Task" if block.get("kind") == "task" else None
    title = f"{_when(minutes)}: {block.get('title') or label or 'Meeting'}"
    presenter = (block.get("presenter") or "").strip()
    topic = (block.get("topic") or "").strip()
    parts = [f"with {presenter}" if presenter else None, topic or None]
    body = " · ".join(p for p in parts if p) or "Tap to view details"
    return title, body


async def _ensure_ttl_index() -> None:
    """Expire dedup markers after 7 days so the collection stays tiny."""
    global _ttl_index_ready
    if _ttl_index_ready:
        return
    try:
        await db.schedule_reminder_sends.create_index("created_at", expireAfterSeconds=7 * 86400)
    except Exception:
        pass
    _ttl_index_ready = True


async def _claim_send(block_id: str, local_date: str) -> bool:
    """Atomically mark (block, date) as sent. Returns True if we won the claim
    (i.e. this is the first tick to reach it), False if already sent."""
    key = f"{block_id}:{local_date}"
    try:
        res = await db.schedule_reminder_sends.update_one(
            {"_id": key},
            {"$setOnInsert": {"created_at": datetime.now(timezone.utc)}},
            upsert=True,
        )
        return res.upserted_id is not None
    except Exception:
        # Duplicate-key race (single-process, but be safe) → someone else has it.
        return False


async def schedule_reminder_tick(dry_run: bool = False) -> dict:
    """One reminder pass. Sends web push for any block whose reminder time
    (start − 5 min) falls in the current due window. `dry_run` reports the
    would-send set without sending or claiming dedup markers."""
    await _ensure_ttl_index()

    now_local = datetime.now(APP_TZ)
    dow = now_local.weekday()  # 0=Mon .. 6=Sun — matches schedule_blocks.day_of_week
    now_min = now_local.hour * 60 + now_local.minute
    local_date = now_local.date().isoformat()

    # Which blocks are "due" right now? fire = start − the block's reminder
    # minutes, looked up on the block's own day (a reminder a day or more
    # ahead fires on the day before, and so on).
    blocks: list[dict] = []
    from datetime import timedelta
    for ahead in (0, 1):
        day = now_local.date() + timedelta(days=ahead)
        q = {"$or": [{"date": day.isoformat()},
                     {"day_of_week": day.weekday(), "date": {"$in": [None, ""]}}]}
        async for b in db.schedule_blocks.find(q, {"_id": 0}):
            start_min = _hhmm_to_minutes(b.get("start_time") or "")
            minutes = _reminder_minutes(b)
            if start_min is None or minutes is None:
                continue
            if b.get("kind") == "task" and day.isoformat() in (b.get("done_dates") or []):
                continue
            fire_min = start_min + ahead * 1440 - minutes
            if 0 <= (now_min - fire_min) < DUE_WINDOW_MIN:
                blocks.append(b)

    if not blocks:
        return {"sent": 0, "blocks_due": 0, "reason": "nothing due"}

    # Only bother with users who actually have a web-push subscription.
    try:
        sub_ids = set(await db.web_push_subscriptions.distinct("user_id"))
    except Exception as e:
        logger.error(f"schedule_reminder_tick: load subs failed: {e}")
        return {"sent": 0, "blocks_due": len(blocks), "reason": "subs load failed"}
    if not sub_ids:
        return {"sent": 0, "blocks_due": len(blocks), "reason": "no web subscribers"}

    # Anyone marked absent (`ab`) on today's bells isn't in — no reminders.
    absent_ids = await absent_today_user_ids(now_local, database=db)

    # Group due blocks by office so we fetch each office's roster once.
    by_office: dict[str, list[dict]] = {}
    for b in blocks:
        by_office.setdefault(b.get("office_id") or "", []).append(b)

    sent = 0
    details: list[dict] = []
    for office_id, office_blocks in by_office.items():
        if not office_id:
            continue
        roster: list[tuple[str, str, object]] = []  # (str_id, role, stage)
        try:
            cur = db.users.find(
                {"office_id": office_id, "deleted": {"$ne": True}, "is_active": {"$ne": False}},
                {"_id": 1, "role": 1, "owneriq_stage": 1, "schedule_reminders_enabled": 1},
            )
            async for u in cur:
                uid = str(u["_id"])
                # Distinct from the Inbox 'schedule' category checked at send
                # time, which also gates absence pushes.
                if _reminders_opted_out(u):
                    continue
                if uid in absent_ids:
                    continue
                if uid in sub_ids:  # skip users without a web subscription
                    roster.append((uid, (u.get("role") or "").lower(), u.get("owneriq_stage")))
        except Exception as e:
            logger.error(f"schedule_reminder_tick: roster load failed for {office_id}: {e}")
            continue
        if not roster:
            continue

        for b in office_blocks:
            targets = [uid for (uid, role, stage) in roster if _block_match(b, role, uid, stage)]
            if not targets:
                continue

            if dry_run:
                details.append({"block_id": b.get("id"), "title": b.get("title"), "targets": len(targets)})
                continue

            # One claim per (block, date) — covers the whole audience in this pass.
            if not await _claim_send(b.get("id"), local_date):
                continue

            title, body = _build_message(b)
            data = {
                "type": "schedule",
                "kind": "schedule",
                "blockId": b.get("id"),
                "url": "/schedule",
                "tag": f"schedule-{b.get('id')}",
            }
            for uid in targets:
                try:
                    # Same preference gate as send_push_to_user — this path
                    # goes straight to web push, so it checks explicitly.
                    if not await is_category_enabled_for_user_id(uid, data):
                        continue
                    await send_web_push_to_user(uid, title, body, data)
                    sent += 1
                except Exception as e:
                    logger.error(f"schedule_reminder_tick: send failed for {uid}: {e}")
            details.append({"block_id": b.get("id"), "title": b.get("title"), "targets": len(targets)})

    result = {"sent": sent, "blocks_due": len(blocks), "dry_run": dry_run, "details": details}
    if sent or dry_run:
        logger.info(f"schedule_reminder_tick: sent {sent} web push across {len(blocks)} due block(s)")
    return result
