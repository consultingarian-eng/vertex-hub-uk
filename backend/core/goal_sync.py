"""One office sales goal, three mirrors — kept in lock-step.

The same number lives in three places, each read by different surfaces:

  • the office admins' bells rows' `team_weekly_goal` (per week) — the Bells
    "crew goal", the public sheet, the Home Team pulse;
  • `weekly_agendas.stats.weekly_goal` (per week) — the Schedule tab's
    Weekly Plan editor and the Weekly Snapshot's "SALES THIS WEEK / goal";
  • `offices.weekly_goal` (single int) — the daily breakdown progress line
    and the week-in-review's top-down target.

An OFFICE-LEVEL admin's crew IS the office, so whichever surface the owner
types the goal into, the other two must follow (owner request, Sep 2026).
Every write path calls sync_office_weekly_goal(); the flags let the caller
skip the store it already wrote itself.

"Office-level" is load-bearing: an admin who reports to another admin runs
their own crew inside the office (core/admin_scope.py), so their crew goal
is theirs alone. Mirroring it would publish one team's target as the whole
office's, and mirroring the office goal back would wipe it out.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from database import db
from core.app_time import APP_TZ
from core.goal_audit import record_goal_change

logger = logging.getLogger(__name__)

# Bells refuses rows more than this far into the future (see
# routes/bells._validate_week_ending_write) — the mirror honors the same rule.
_MAX_FUTURE_DAYS = 7


def _as_int(v) -> Optional[int]:
    """Goal as a positive int, or None when unset.

    The agenda's Sales Goal is free text ("220", "220 sales", "hit 220!") and
    the plan editor itself reads the number out of the text — so does this,
    with the same first-number rule. Text WITHOUT a number is None, which
    callers must treat as "no goal stated", never as an intentional clear.
    """
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        n = int(v)
        return n if n > 0 else None
    m = re.search(r"\d[\d,]*", str(v))
    if not m:
        return None
    try:
        n = int(m.group(0).replace(",", ""))
        return n if n > 0 else None
    except ValueError:
        return None


def _current_local_sunday() -> str:
    today = datetime.now(APP_TZ).date()
    return (today + timedelta(days=(6 - today.weekday()))).isoformat()


async def goal_for_week(office_id: str, week_ending: str) -> Optional[int]:
    """The office goal already on record for a week — the max crew goal on
    any office-level admin's bells row. Used to seed a fresh Weekly Plan
    (and to protect an already-set goal from copy-from-last-week).

    A crew-leading admin's row is skipped: their number is one team's
    target, and reading it here would seed the office plan from it."""
    try:
        from core.admin_scope import office_level_admin_ids
        admin_ids = [
            str(a["_id"]) for a in await office_level_admin_ids(office_id, database=db)
        ]
        if not admin_ids:
            return None
        goals = []
        async for r in db.bells_entries.find(
            {"office_id": office_id, "week_ending": week_ending, "user_id": {"$in": admin_ids}},
            {"_id": 0, "team_weekly_goal": 1},
        ):
            g = _as_int(r.get("team_weekly_goal"))
            if g is not None:
                goals.append(g)
        return max(goals) if goals else None
    except Exception as e:
        logger.warning(f"goal sync: goal_for_week failed for {office_id}/{week_ending}: {e}")
        return None


async def sync_office_weekly_goal(
    office_id: str,
    week_ending: str,
    goal,
    actor: dict,
    source: str,
    *,
    skip_agenda: bool = False,
    skip_office: bool = False,
    skip_bells_user_id: Optional[str] = None,
) -> None:
    """Mirror an office sales goal across all three stores. Best-effort —
    a failed mirror must never fail the write that triggered it."""
    goal_int = _as_int(goal)
    now_iso = datetime.now(timezone.utc).isoformat()

    # The bells mirror honors bells' own future clamp — a far-future plan
    # week must not conjure bells rows bells itself would refuse.
    try:
        week_ok_for_bells = week_ending <= (
            datetime.now(APP_TZ).date() + timedelta(days=_MAX_FUTURE_DAYS)
        ).isoformat()
    except Exception:
        week_ok_for_bells = True

    # ── offices.weekly_goal (single int; 0 = cleared) ────────────────────
    # This store is WEEK-LESS — the daily breakdown and week-in-review read
    # it as "the running week's target". Only the CURRENT week may write it;
    # planning next week or fixing a past week must never clobber the live
    # number mid-week.
    if not skip_office and week_ending != _current_local_sunday():
        skip_office = True
    if not skip_office:
        try:
            office_doc = await db.offices.find_one({"id": office_id}, {"_id": 0, "weekly_goal": 1})
            new_val = goal_int or 0
            if office_doc is not None and (office_doc.get("weekly_goal") or 0) != new_val:
                await db.offices.update_one(
                    {"id": office_id},
                    {"$set": {"weekly_goal": new_val, "weekly_goal_updated_at": now_iso}},
                )
                await record_goal_change(
                    db, user_id=str(actor.get("id") or ""), week_ending=week_ending,
                    field="office_weekly_goal", old=office_doc.get("weekly_goal"),
                    new=new_val, actor=actor, source=source,
                )
        except Exception as e:
            logger.warning(f"goal sync: office doc mirror failed for {office_id}: {e}")

    # ── weekly_agendas.stats.weekly_goal (only when a plan exists) ───────
    # Never conjure an agenda doc from a bells edit — an empty draft would
    # hijack the editor's seed-row flow. No plan yet → nothing to mirror.
    if not skip_agenda:
        try:
            doc = await db.weekly_agendas.find_one(
                {"office_id": office_id, "week_ending": week_ending},
                {"_id": 0, "id": 1, "stats": 1},
            )
            if doc:
                new_str = str(goal_int) if goal_int is not None else ""
                stats = doc.get("stats") or {}
                if (stats.get("weekly_goal") or "") != new_str:
                    await db.weekly_agendas.update_one(
                        {"id": doc["id"]},
                        {"$set": {"stats.weekly_goal": new_str, "updated_at": now_iso}},
                    )
        except Exception as e:
            logger.warning(f"goal sync: agenda mirror failed for {office_id}/{week_ending}: {e}")

    # ── every office-level admin's bells row for the week ────────────────
    # A crew-leading admin is deliberately NOT here: their crew goal row is
    # their own team's target, and this mirror would overwrite it every time
    # the office goal moved.
    if not week_ok_for_bells:
        return
    try:
        from core.admin_scope import office_level_admin_ids
        admins = await office_level_admin_ids(office_id, {"name": 1}, database=db)
        for a in admins:
            uid = str(a["_id"])
            if skip_bells_user_id and uid == str(skip_bells_user_id):
                continue
            row = await db.bells_entries.find_one(
                {"office_id": office_id, "week_ending": week_ending, "user_id": uid},
                {"_id": 0, "id": 1, "team_weekly_goal": 1},
            )
            new_goal = float(goal_int) if goal_int is not None else None
            if row:
                if row.get("team_weekly_goal") != new_goal:
                    await db.bells_entries.update_one(
                        {"id": row["id"]},
                        {"$set": {"team_weekly_goal": new_goal, "updated_at": now_iso}},
                    )
                    await record_goal_change(
                        db, user_id=uid, week_ending=week_ending, field="team_weekly_goal",
                        old=row.get("team_weekly_goal"), new=new_goal, actor=actor, source=source,
                    )
            elif new_goal is not None:
                from routes.bells import _normalize_days
                await db.bells_entries.insert_one({
                    "id": str(uuid.uuid4()),
                    "office_id": office_id,
                    "user_id": uid,
                    "user_name": a.get("name") or "",
                    "role": "admin",
                    "stage": None, "break_even": None, "weekly_goal": None,
                    "team_weekly_goal": new_goal,
                    "last_week_total": None, "last_week_total_source": None,
                    "week_ending": week_ending,
                    "days": _normalize_days([]),
                    "created_by_id": str(actor.get("id") or ""),
                    "created_at": now_iso, "updated_at": now_iso,
                })
                await record_goal_change(
                    db, user_id=uid, week_ending=week_ending, field="team_weekly_goal",
                    old=None, new=new_goal, actor=actor, source=source,
                )
    except Exception as e:
        logger.warning(f"goal sync: bells rows mirror failed for {office_id}/{week_ending}: {e}")
