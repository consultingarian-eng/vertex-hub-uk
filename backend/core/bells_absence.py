"""Who is marked absent (`ab`) on the bells this week.

A person marked `ab` for a day isn't in, so their schedule blanks that day and
no schedule reminder reaches them for it. Only `ab` counts — rt/pc/off/nc and
unlinked rows (no user_id) never blank anything. Scope is the CURRENT bells
week (Mon–Sun, keyed by its Sunday `week_ending`), in app time (core.app_time).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

from database import db
from core.app_time import APP_TZ

logger = logging.getLogger(__name__)

ABSENT = "ab"


def _week_ending(d: date) -> str:
    return (d + timedelta(days=6 - d.weekday())).isoformat()


def _absent_indexes(days: list) -> list[int]:
    return [i for i, d in enumerate(days or []) if (d or {}).get("status") == ABSENT]


async def current_week_absence(user_id: str | None, now: datetime | None = None, database=None) -> dict:
    """{"week_ending", "days": [0=Mon…], "dates": [ISO]} for this user's `ab` days
    this week. Empty on any failure — the schedule must still load. Pass
    `database=` when the caller holds its own handle (routes/schedule.py)."""
    today = (now or datetime.now(APP_TZ)).date()
    week_ending = _week_ending(today)
    out = {"week_ending": week_ending, "days": [], "dates": []}
    if not user_id:
        return out
    try:
        idx: set[int] = set()
        async for e in (database if database is not None else db).bells_entries.find(
            {"week_ending": week_ending, "user_id": user_id}, {"_id": 0, "days": 1}
        ):
            idx.update(_absent_indexes(e.get("days")))
        monday = today - timedelta(days=today.weekday())
        out["days"] = sorted(idx)
        out["dates"] = [(monday + timedelta(days=i)).isoformat() for i in out["days"]]
    except Exception as ex:
        logger.warning("current_week_absence failed for %s: %s", user_id, ex)
    return out


async def absent_today_user_ids(now: datetime | None = None, database=None) -> set[str]:
    """Every user marked `ab` on the bells for today (app time)."""
    today = (now or datetime.now(APP_TZ)).date()
    idx = today.weekday()
    out: set[str] = set()
    try:
        async for e in (database if database is not None else db).bells_entries.find(
            {"week_ending": _week_ending(today), f"days.{idx}.status": ABSENT,
             "user_id": {"$nin": [None, ""]}},
            {"_id": 0, "user_id": 1},
        ):
            out.add(str(e["user_id"]))
    except Exception as ex:
        logger.warning("absent_today_user_ids failed: %s", ex)
    return out
