"""OwnerIQ (Field IQ) → CG1 **Live Operations** passthrough.

The KPI sync (owneriq_sync.py) stores historical door_interaction_kpis. This
module is different: it mirrors OwnerIQ's *Live Operations* dashboard — the
teams (sectors) that are out in the field on a given day, with their live
running totals and per-BA breakdowns. Today changes minute-to-minute, so we
proxy it live (reusing the owner login from owneriq_sync) — but a PAST day is
immutable once it's over, so we cache completed days permanently and only pay
the OwnerIQ round-trip once. See the caching layer below.

Three OwnerIQ endpoints back the three screens:

  1. GET /v3/owner/live_operations?date=YYYY-MM-DD
        → {kpis, sectors[{id,name,leader,members,total_sales,live,first_knock_at}]}
        This returns only the owner's DEFAULT company unless every company is
        named: &marketing_company_id[]=<id>&…. See fetch_live_top — every
        caller of this endpoint must go through it.
  2. GET /v3/owner/live_operations/sectors/{id}?date=…
        → {sector, hero{doors,spoken,pitches,closed,sales,points}, members[…per-BA…]}
  3. GET /v3/owner/live_operations/bas/{id}?date=…
        → {ba, sector, hero, laps[{number, interactions_by_address[…door log…]}]}

The date is the field day (app time). Everything is read-only.
"""
import os
import logging
from datetime import datetime, timedelta, timezone

import httpx

from database import db
from owneriq_sync import OWNERIQ_API_BASE, _UA, _login, OwnerIQError

logger = logging.getLogger(__name__)

# Today's data is served from cache for at most this long before we re-pull
# (keeps the app snappy without going stale on live figures). Past days are
# cached forever — they don't change once the field day is over.
OWNERIQ_LIVE_TTL = int((os.getenv("OWNERIQ_LIVE_TTL") or "60"))

from core.app_time import APP_TZ


def today_iso() -> str:
    return datetime.now(APP_TZ).date().isoformat()


def _headers(token: str) -> dict:
    return {
        "accept": "application/json",
        "x-requested-with": "XMLHttpRequest",
        "origin": "https://owner-iq.ai",
        "referer": "https://owner-iq.ai/",
        "user-agent": _UA,
        "authorization": f"Bearer {token}",
    }


async def _get(client: httpx.AsyncClient, token: str, path: str, iso_date: str, extra_params=None) -> dict:
    r = await client.get(
        f"{OWNERIQ_API_BASE}{path}",
        params=[("date", iso_date), *(extra_params or [])],
        headers=_headers(token),
    )
    if r.status_code != 200:
        raise OwnerIQError(f"GET {path} failed: HTTP {r.status_code} {r.text[:200]}")
    return r.json()


async def _company_ids(client: httpx.AsyncClient, token: str) -> list[str]:
    """OwnerIQ ids of every marketing company this owner login can see."""
    r = await client.get(
        f"{OWNERIQ_API_BASE}/v3/owner/marketing_companies/light_index",
        headers=_headers(token),
    )
    if r.status_code != 200:
        raise OwnerIQError(f"GET light_index failed: HTTP {r.status_code} {r.text[:200]}")
    return [str(c["id"]) for c in (r.json().get("data") or []) if c.get("id") is not None]


async def fetch_live_top(client: httpx.AsyncClient, token: str, iso_date: str) -> dict:
    """The top-level Live Operations payload across EVERY office.

    Left unnamed, OwnerIQ answers with the default company only, silently
    dropping every other office from Sectors. The KPI block comes back summed
    across the named companies (discovered from the login, never hard-coded)."""
    ids = await _company_ids(client, token)
    if not ids:
        raise OwnerIQError("light_index returned no marketing companies")
    return await _get(client, token, "/v3/owner/live_operations", iso_date,
                      [("marketing_company_id[]", i) for i in ids])


async def fetch_live_operations(iso_date: str) -> dict:
    """Top-level Live Operations for a day: KPIs + every sector out in the field."""
    async with httpx.AsyncClient(timeout=45.0) as client:
        token = await _login(client)
        return await fetch_live_top(client, token, iso_date)


async def fetch_sector(sector_id, iso_date: str) -> dict:
    """One team's live detail: hero totals + per-BA rows for the day."""
    async with httpx.AsyncClient(timeout=45.0) as client:
        token = await _login(client)
        return await _get(client, token, f"/v3/owner/live_operations/sectors/{sector_id}", iso_date)


async def fetch_ba(ba_id, iso_date: str) -> dict:
    """One BA's live detail: hero totals + door-by-door laps for the day."""
    async with httpx.AsyncClient(timeout=45.0) as client:
        token = await _login(client)
        return await _get(client, token, f"/v3/owner/live_operations/bas/{ba_id}", iso_date)


HERO_METRICS = ["doors_knocked", "spoken_to", "pitches_commenced", "pitches_closed", "sales", "points"]


### ── Caching layer ──────────────────────────────────────────────────────────
# Store the RAW vendor payload per (kind, id, date) in `owneriq_live_cache`.
# A day is "final" once it's strictly before today (app time) → cached forever; today
# is re-pulled after OWNERIQ_LIVE_TTL. We cache the unscoped payload only —
# role scoping / CG1 linking runs fresh at read time in the route, so a cache
# entry can safely serve every caller.

def _is_final(iso_date: str) -> bool:
    """A day is settled once it is two or more days old. Today can still move,
    and so can yesterday: OwnerIQ goes on tidying a day's figures for a while
    after midnight (a copy saved at 00:05 showed a Piece Average of 0.83 where
    OwnerIQ later said 1.0), so yesterday keeps the short TTL too."""
    yesterday = (datetime.now(APP_TZ).date() - timedelta(days=1)).isoformat()
    return iso_date < yesterday


def _age_seconds(fetched_at: str | None) -> float | None:
    try:
        t = datetime.fromisoformat(fetched_at)
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - t).total_seconds()
    except Exception:
        return None


def _fresh_enough(doc: dict) -> bool:
    # Trust the date, not only the flag: a copy flagged final while its day
    # was still "yesterday" has to earn that again.
    if doc.get("final") and _is_final(str(doc.get("date") or "9999")):
        return True
    age = _age_seconds(doc.get("fetched_at"))
    return age is not None and age < OWNERIQ_LIVE_TTL


async def _cache_read(key: str) -> dict | None:
    return await db.owneriq_live_cache.find_one({"_id": key})


async def _cache_write(key: str, kind: str, ref_id, iso_date: str, payload: dict) -> None:
    await db.owneriq_live_cache.update_one(
        {"_id": key},
        {"$set": {
            "kind": kind, "ref_id": str(ref_id), "date": iso_date,
            "payload": payload, "final": _is_final(iso_date),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )


async def _cached(kind: str, ref_id, iso_date: str, fetcher, force: bool = False) -> dict:
    key = f"{kind}:{ref_id}:{iso_date}"
    if not force:
        doc = await _cache_read(key)
        if doc and _fresh_enough(doc):
            return doc["payload"]
    payload = await fetcher()
    await _cache_write(key, kind, ref_id, iso_date, payload)
    return payload


async def get_live_operations(iso_date: str, force: bool = False) -> dict:
    return await _cached("live", "all", iso_date, lambda: fetch_live_operations(iso_date), force)


async def get_sector(sector_id, iso_date: str, force: bool = False) -> dict:
    return await _cached("sector", sector_id, iso_date, lambda: fetch_sector(sector_id, iso_date), force)


async def get_ba(ba_id, iso_date: str, force: bool = False) -> dict:
    return await _cached("ba", ba_id, iso_date, lambda: fetch_ba(ba_id, iso_date), force)


async def compile_funnel(sector_ids: list, iso_date: str, force: bool = False) -> dict:
    """Sum the hero funnel (doors→sales→points) across several sectors.

    Uses the per-sector cache: past days are pure cache hits; for today, any
    stale/missing sectors are fetched under ONE login and cached (so the hub's
    combined funnel and the per-team screens share the same cached details)."""
    totals = {m: 0 for m in HERO_METRICS}
    if not sector_ids:
        return totals
    details: dict = {}
    missing: list = []
    for sid in sector_ids:
        doc = None if force else await _cache_read(f"sector:{sid}:{iso_date}")
        if doc and _fresh_enough(doc):
            details[sid] = doc["payload"]
        else:
            missing.append(sid)
    if missing:
        async with httpx.AsyncClient(timeout=60.0) as client:
            token = await _login(client)
            for sid in missing:
                try:
                    d = await _get(client, token, f"/v3/owner/live_operations/sectors/{sid}", iso_date)
                except OwnerIQError as ex:
                    logger.warning("compile_funnel: sector %s failed: %s", sid, ex)
                    continue
                details[sid] = d
                await _cache_write(f"sector:{sid}:{iso_date}", "sector", sid, iso_date, d)
    for sid in sector_ids:
        hero = (details.get(sid) or {}).get("hero") or {}
        for m in HERO_METRICS:
            totals[m] += (hero.get(m) or 0)
    return totals


async def resettle_day(iso_date: str) -> dict:
    """Re-pull a completed day's WHOLE tree once and overwrite the cache.

    'Final' days are otherwise never re-fetched, so a correction made after the
    last live refresh would be missed. This runs nightly for the day that just
    ended: it walks the top-level → every sector → every BA (discovering even
    entries nobody opened during the day) under one login and rewrites each as
    the settled copy. Idempotent."""
    counts = {"sectors": 0, "bas": 0}
    async with httpx.AsyncClient(timeout=90.0) as client:
        token = await _login(client)
        top = await fetch_live_top(client, token, iso_date)
        await _cache_write(f"live:all:{iso_date}", "live", "all", iso_date, top)
        for sector in (top.get("sectors") or []):
            sid = sector.get("id")
            if sid is None:
                continue
            try:
                sd = await _get(client, token, f"/v3/owner/live_operations/sectors/{sid}", iso_date)
            except OwnerIQError as ex:
                logger.warning("resettle %s: sector %s failed: %s", iso_date, sid, ex)
                continue
            await _cache_write(f"sector:{sid}:{iso_date}", "sector", sid, iso_date, sd)
            counts["sectors"] += 1
            for m in (sd.get("members") or []):
                bid = m.get("id")
                if bid is None:
                    continue
                try:
                    bd = await _get(client, token, f"/v3/owner/live_operations/bas/{bid}", iso_date)
                except OwnerIQError as ex:
                    logger.warning("resettle %s: ba %s failed: %s", iso_date, bid, ex)
                    continue
                await _cache_write(f"ba:{bid}:{iso_date}", "ba", bid, iso_date, bd)
                counts["bas"] += 1
    logger.info("OwnerIQ resettle %s: %d sectors, %d BAs re-cached", iso_date, counts["sectors"], counts["bas"])
    return counts


async def resettle_yesterday_tick() -> None:
    """Nightly scheduler entrypoint — re-settle the day that just ended."""
    if not os.getenv("OWNERIQ_EMAIL") or not os.getenv("OWNERIQ_PASSWORD"):
        logger.info("OwnerIQ resettle skipped: creds not set")
        return
    yday = (datetime.now(APP_TZ).date() - timedelta(days=1)).isoformat()
    try:
        await resettle_day(yday)
    except Exception as ex:  # keep the scheduler alive
        logger.error("OwnerIQ resettle tick failed: %s", ex)


def sector_pin(sector: dict) -> str | None:
    """The marketing-company pin a sector belongs to (from its leader)."""
    mc = ((sector.get("leader") or {}).get("marketing_company") or {})
    p = mc.get("pin")
    return str(p) if p is not None else None


def sector_office_name(sector: dict) -> str | None:
    return ((sector.get("leader") or {}).get("marketing_company") or {}).get("name")
