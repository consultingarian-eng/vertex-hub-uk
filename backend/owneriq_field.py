"""Field days: every BA's day in the field, kept small, for the Timeline.

Where the numbers come from
---------------------------
OwnerIQ's Live Operations holds each BA's door log for a day. owneriq_live
already saves those logs in `owneriq_live_cache` (raw, ~100 KB a BA-day): the
nightly re-settle walks yesterday's whole tree, and anyone opening Live
Operations saves the days they look at.

This module does two things with that:

  build_field_days   turns each saved log into ONE small `owneriq_field_days`
                     record (core/field_days.summarise_ba_day): sign-ups and
                     doors per hour, first and last door, time in the field,
                     the sector break. The Timeline reads only these.
  tick               keeps the logs coming: it refreshes today through the
                     working day, and fills in the past (one missing day at a
                     time, newest first, back BACKFILL_DAYS) for the weeks
                     before the nightly re-settle existed.

Read-only towards OwnerIQ. Without an OwnerIQ login (a local run) `tick` only
builds records from whatever logs are already saved.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from core.app_time import APP_TZ
from core.field_days import summarise_ba_day
from database import db

logger = logging.getLogger(__name__)

BACKFILL_DAYS = 56            # how far back the past is filled in
BUILD_BATCH = 150             # logs summarised per run
TODAY_EVERY_MINUTES = 50      # how often today's logs are refreshed
TODAY_HOURS = (10, 22)        # …between these UK hours (the field day)
GIVE_UP_AFTER = 3             # a past day OwnerIQ won't serve is left after this many tries
_STATE_ID = "field_days"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def has_login() -> bool:
    return bool(os.getenv("OWNERIQ_EMAIL") and os.getenv("OWNERIQ_PASSWORD"))


async def _pins_for(date_iso: str, cache: dict) -> dict[str, str]:
    """{OwnerIQ user id: company pin} for a day, from its saved sector details."""
    if date_iso not in cache:
        pins: dict[str, str] = {}
        async for doc in db.owneriq_live_cache.find({"kind": "sector", "date": date_iso}, {"payload.members": 1}):
            for m in ((doc.get("payload") or {}).get("members") or []):
                pin = (m.get("marketing_company") or {}).get("pin")
                if m.get("id") is not None and pin is not None:
                    pins[str(m["id"])] = str(pin)
        cache[date_iso] = pins
    return cache[date_iso]


async def build_field_days(limit: int = BUILD_BATCH) -> int:
    """Summarise saved door logs that have no record yet, or whose log was
    saved again since (today's is, through the day). Returns how many."""
    built = {d["_id"]: d.get("src_fetched_at") async for d in db.owneriq_field_days.find({}, {"src_fetched_at": 1})}
    todo = []
    async for doc in db.owneriq_live_cache.find({"kind": "ba"}, {"date": 1, "ref_id": 1, "fetched_at": 1}).sort("date", -1):
        key = f"{doc.get('ref_id')}:{doc.get('date')}"
        if built.get(key) != doc.get("fetched_at"):
            todo.append(doc["_id"])
            if len(todo) >= limit:
                break
    pins: dict = {}
    done = 0
    for cache_id in todo:
        doc = await db.owneriq_live_cache.find_one({"_id": cache_id})
        if not doc:
            continue
        key = f"{doc.get('ref_id')}:{doc.get('date')}"
        try:
            summary = summarise_ba_day(doc.get("payload") or {}, doc["date"])
        except Exception as ex:      # one odd log must not stop the rest
            logger.warning("field day %s could not be summarised: %s", key, ex)
            summary = None
        if summary is None:
            # Nothing knocked: remember that it was looked at, so it isn't
            # read again every run, and so a removed day's record goes.
            await db.owneriq_field_days.update_one(
                {"_id": key}, {"$set": {"empty": True, "date": doc["date"], "oid": str(doc.get("ref_id")),
                                        "src_fetched_at": doc.get("fetched_at"), "built_at": _now().isoformat()}}, upsert=True)
        else:
            summary["mc_pin"] = (await _pins_for(doc["date"], pins)).get(summary["oid"])
            await db.owneriq_field_days.replace_one(
                {"_id": key}, {**summary, "empty": False, "src_fetched_at": doc.get("fetched_at"), "built_at": _now().isoformat()}, upsert=True)
        done += 1
    return done


async def _harvest(date_iso: str) -> dict:
    """Save a whole day's logs (every sector, every BA) from OwnerIQ."""
    from owneriq_live import resettle_day
    return await resettle_day(date_iso)


async def tick() -> dict:
    """One pass: fetch what's due (today, else one missing past day), then build."""
    out: dict = {"fetched": None, "built": 0}
    if has_login():
        now_uk = datetime.now(APP_TZ)
        today = now_uk.date()
        state = await db.owneriq_sync_state.find_one({"_id": _STATE_ID}) or {}
        try:
            last = state.get("today_at")
            due = (not last or (now_uk - datetime.fromisoformat(last)).total_seconds() >= TODAY_EVERY_MINUTES * 60
                   or state.get("today_date") != today.isoformat())
            if TODAY_HOURS[0] <= now_uk.hour <= TODAY_HOURS[1] and due:
                counts = await _harvest(today.isoformat())
                await db.owneriq_sync_state.update_one({"_id": _STATE_ID}, {"$set": {
                    "today_at": now_uk.isoformat(), "today_date": today.isoformat()}}, upsert=True)
                out["fetched"] = {"date": today.isoformat(), **counts}
            else:
                # The past: the newest day in the window that was never walked.
                done = set(state.get("backfilled") or [])
                fails = dict(state.get("backfill_fails") or {})
                for back in range(1, BACKFILL_DAYS + 1):
                    d = (today - timedelta(days=back)).isoformat()
                    if d in done:
                        continue
                    if await db.owneriq_live_cache.find_one({"_id": f"live:all:{d}", "final": True}, {"_id": 1}) and \
                            await db.owneriq_live_cache.find_one({"kind": "ba", "date": d}, {"_id": 1}):
                        done.add(d)          # the nightly re-settle already has it
                        continue
                    if back == 1:
                        continue             # yesterday belongs to the 03:00 re-settle
                    try:
                        counts = await _harvest(d)
                    except Exception as ex:
                        # One day OwnerIQ won't serve must not hold up the days
                        # behind it: try it a few times, then move on.
                        fails[d] = int(fails.get(d) or 0) + 1
                        if fails[d] >= GIVE_UP_AFTER:
                            done.add(d)
                        logger.warning("field days: %s could not be fetched (try %d): %s", d, fails[d], ex)
                        out["error"] = f"{d}: {str(ex) or type(ex).__name__}"
                        break
                    done.add(d)
                    fails.pop(d, None)
                    out["fetched"] = {"date": d, **counts}
                    break
                oldest = (today - timedelta(days=BACKFILL_DAYS + 7)).isoformat()
                await db.owneriq_sync_state.update_one({"_id": _STATE_ID}, {"$set": {
                    "backfilled": sorted(x for x in done if x >= oldest),
                    "backfill_fails": {k: v for k, v in fails.items() if k >= oldest}}}, upsert=True)
        except Exception as ex:
            logger.error("field days: fetch failed: %s", ex)
            out["error"] = str(ex) or type(ex).__name__
    try:
        out["built"] = await build_field_days()
    except Exception as ex:
        logger.error("field days: build failed: %s", ex)
        out["build_error"] = str(ex) or type(ex).__name__
    if out.get("fetched") or out.get("built"):
        logger.info("field days tick: %s", out)
    return out
