"""Two zero days in a row → "needs a retrain", to the Owner and the team.

A zero is a day someone was IN the field (Bells status `in`) and brought back
no sign-ups. When a person's two most recent days in are both zeros, their
upline is told once: every office-level Admin (the Owner), and every Coach
above them in the tree (their own Coach, their team's leader, and so on up).

When it is checked: a day's count is only final once the field day is over,
so today is judged from ALERT_HOUR (UK time) and, before that, the check looks
back to yesterday. Days off in between don't break a run (a zero on Friday and
a zero on the next day in, Monday, are two in a row); a run only alerts while
it is fresh (its second zero within FRESH_DAYS). Each run alerts once: the
`zero_alerts` collection remembers (person, date of the second zero).

Bells is the source because it is the office's own record: it is filled from
OwnerIQ through the day and can be corrected by hand, and a correction made
before the check runs is honoured.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

from bson import ObjectId

from core.app_time import APP_TZ, uk_date

logger = logging.getLogger(__name__)

ALERT_HOUR = 21      # UK time: the field day (ends 20:30) is over
FRESH_DAYS = 2       # the second zero must be this recent to alert


def judged_through(now_uk: datetime) -> date:
    """The latest day whose sign-up count is final at `now_uk`."""
    return now_uk.date() if now_uk.hour >= ALERT_HOUR else now_uk.date() - timedelta(days=1)


def _day_total(d: dict) -> int:
    return int((d.get("over30") or 0) + (d.get("under30") or 0))


def zero_run(entries: list[dict], through: date) -> tuple[str, str] | None:
    """(first zero, second zero) as ISO dates when the two most recent days
    in, up to `through`, were both zeros and the second is fresh. `entries`
    are one person's bells rows (any weeks, any order)."""
    days_in: list[tuple[date, int]] = []
    for e in entries:
        try:
            week_end = date.fromisoformat(str(e.get("week_ending"))[:10])
        except ValueError:
            continue
        for i, d in enumerate((e.get("days") or [])[:7]):
            day = week_end - timedelta(days=6 - i)
            if day <= through and (d or {}).get("status") == "in":
                days_in.append((day, _day_total(d)))
    days_in.sort()
    if len(days_in) < 2:
        return None
    (d1, t1), (d2, t2) = days_in[-2], days_in[-1]
    if t1 != 0 or t2 != 0 or (through - d2).days > FRESH_DAYS:
        return None
    return d1.isoformat(), d2.isoformat()


async def upline_coach_ids(database, user_doc: dict) -> list[str]:
    """Every Coach or Admin above a person in the tree, nearest first."""
    out: list[str] = []
    seen = {str(user_doc["_id"])}
    parent = user_doc.get("reports_to")
    while parent and str(parent) not in seen and len(out) < 12:
        seen.add(str(parent))
        try:
            p = await database.users.find_one({"_id": ObjectId(str(parent))},
                                              {"role": 1, "reports_to": 1, "deleted": 1, "is_active": 1})
        except Exception:
            p = None
        if not p:
            break
        if p.get("role") in ("leader", "admin") and not p.get("deleted") and p.get("is_active") is not False:
            out.append(str(p["_id"]))
        parent = p.get("reports_to")
    return out


async def run(database, now_uk: datetime | None = None, send=None) -> list[dict]:
    """Check everyone; alert for each new two-zero run. Returns what was sent.
    `send(user_id, title, body, data)` defaults to the app's push + inbox."""
    if send is None:
        from core.push import send_push_to_user as send
    from core.admin_scope import office_level_admin_ids

    now_uk = now_uk or datetime.now(APP_TZ)
    through = judged_through(now_uk)
    # A run's two days can straddle a week (and a weekend off), so read three.
    this_week = through + timedelta(days=6 - through.weekday())
    weeks = [(this_week - timedelta(days=7 * k)).isoformat() for k in range(3)]
    by_user: dict[str, list[dict]] = {}
    async for e in database.bells_entries.find(
            {"week_ending": {"$in": weeks}, "user_id": {"$nin": [None, ""]}},
            {"_id": 0, "user_id": 1, "week_ending": 1, "days": 1, "office_id": 1}):
        by_user.setdefault(str(e["user_id"]), []).append(e)

    sent: list[dict] = []
    admins_by_office: dict = {}
    for uid, entries in by_user.items():
        run_ = zero_run(entries, through)
        if not run_:
            continue
        first, second = run_
        try:
            person = await database.users.find_one({"_id": ObjectId(uid)})
        except Exception:
            person = None
        if not person or person.get("deleted") or person.get("is_active") is False or person.get("is_demo") \
                or person.get("role") == "admin":
            continue
        # Claim the alert first, so two overlapping checks can't both send it.
        claim = await database.zero_alerts.update_one(
            {"_id": f"{uid}:{second}"},
            {"$setOnInsert": {"user_id": uid, "first": first, "second": second,
                              "created_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True)
        if not getattr(claim, "upserted_id", None):
            continue
        office_id = person.get("office_id")
        if office_id not in admins_by_office:
            admins_by_office[office_id] = [str(a["_id"]) for a in await office_level_admin_ids(office_id, database=database)] if office_id else []
        to = list(dict.fromkeys(admins_by_office[office_id] + await upline_coach_ids(database, person)))
        to = [t for t in to if t != uid]
        name = person.get("name") or "Someone"
        title = f"Retrain needed: {name}"
        body = (f"{name} has had 2 zero days in a row ({uk_date(first, year=False)} and {uk_date(second, year=False)}). "
                f"They need a retrain.")
        data = {"type": "zero_days", "url": f"/person/{uid}", "person_id": uid, "dates": [first, second]}
        for target in to:
            try:
                await send(target, title, body, data)
            except Exception as ex:
                logger.warning("zero alert to %s failed: %s", target, ex)
        await database.zero_alerts.update_one({"_id": f"{uid}:{second}"}, {"$set": {"sent_to": to, "name": name}})
        sent.append({"user_id": uid, "name": name, "first": first, "second": second, "to": to})
    if sent:
        logger.info("zero alerts: %d sent (%s)", len(sent), ", ".join(s["name"] for s in sent))
    return sent
