"""OwnerIQ Performance Hub, served to the app's own Performance Hub screen.

Read-only towards OwnerIQ. Three views, exactly as OwnerIQ's hub loads them:

    company   /v3/owner/bells_performance/marketing_companies/{mc}
    team      /v3/owner/bells_performance/teams/{team_id}
    no team   /v3/owner/bells_performance/marketing_companies/{mc}/no_team

each for one week (`week_start_on`, a Monday). A view carries the eight KPI
tiles with their day-by-day values, the door activity totals and averages, the
teams (company view) and every BA's week: KPIs plus a tile per day.

Every view is kept in `owneriq_hub` (one doc per view per week). A copy newer
than FRESH_SECONDS is served as-is; otherwise OwnerIQ is asked again. When
OwnerIQ can't be reached (or no login is configured, as on a local run) the
last copy is served and flagged `stale`.
"""
from __future__ import annotations

import logging
import os
from datetime import date, datetime, timedelta, timezone

import httpx

from core.app_time import APP_TZ
from database import db
from owneriq_live import _company_ids, _headers
from owneriq_sync import ID_LINKED, OWNERIQ_API_BASE, OwnerIQError, _login, is_oid

logger = logging.getLogger(__name__)

FRESH_SECONDS = 180          # the live week
SETTLED_SECONDS = 6 * 3600   # weeks that ended more than two days ago


def _now() -> datetime:
    return datetime.now(timezone.utc)


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def clean_week(week_start: str | None) -> str:
    """A Monday, 'YYYY-MM-DD'. Anything else snaps to its week's Monday; no
    value means this week (UK time)."""
    try:
        d = date.fromisoformat(str(week_start)[:10]) if week_start else datetime.now(APP_TZ).date()
    except ValueError:
        d = datetime.now(APP_TZ).date()
    return monday_of(d).isoformat()


def has_login() -> bool:
    return bool(os.getenv("OWNERIQ_EMAIL") and os.getenv("OWNERIQ_PASSWORD"))


def _path(kind: str, ref: str) -> str:
    if kind == "team":
        return f"/v3/owner/bells_performance/teams/{ref}"
    if kind == "no_team":
        return f"/v3/owner/bells_performance/marketing_companies/{ref}/no_team"
    return f"/v3/owner/bells_performance/marketing_companies/{ref}"


def _fresh(doc: dict, week_start: str) -> bool:
    at = doc.get("fetched_at")
    if not isinstance(at, datetime):
        return False
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    week_end = date.fromisoformat(week_start) + timedelta(days=6)
    settled = datetime.now(APP_TZ).date() > week_end + timedelta(days=2)
    return (_now() - at).total_seconds() < (SETTLED_SECONDS if settled else FRESH_SECONDS)


async def _fetch(kind: str, ref: str, week_start: str) -> dict:
    async with httpx.AsyncClient(timeout=45.0) as client:
        token = await _login(client)
        r = await client.get(f"{OWNERIQ_API_BASE}{_path(kind, ref)}",
                             params={"week_start_on": week_start}, headers=_headers(token))
        if r.status_code != 200:
            raise OwnerIQError(f"GET {_path(kind, ref)} failed: HTTP {r.status_code} {r.text[:160]}")
        return r.json()


async def store(kind: str, ref: str, week_start: str, payload: dict) -> None:
    await db.owneriq_hub.update_one(
        {"_id": f"{kind}:{ref}:{week_start}"},
        {"$set": {"kind": kind, "ref": str(ref), "week_start": week_start,
                  "payload": payload, "fetched_at": _now()}},
        upsert=True)


async def get_view(kind: str, ref: str, week_start: str, force: bool = False) -> dict | None:
    """The view's payload plus `fetched_at` and `stale`, or None when there is
    no copy and OwnerIQ can't be asked."""
    key = f"{kind}:{ref}:{week_start}"
    doc = await db.owneriq_hub.find_one({"_id": key})
    if doc and not force and _fresh(doc, week_start):
        return {**doc["payload"], "fetched_at": doc["fetched_at"].isoformat(), "stale": False}
    if has_login():
        try:
            payload = await _fetch(kind, ref, week_start)
            await store(kind, ref, week_start, payload)
            return {**payload, "fetched_at": _now().isoformat(), "stale": False}
        except Exception as ex:   # OwnerIQ down or slow: fall back to the copy
            logger.warning("OwnerIQ hub %s failed: %s", key, ex)
    if doc:
        at = doc.get("fetched_at")
        return {**doc["payload"], "fetched_at": at.isoformat() if isinstance(at, datetime) else None, "stale": True}
    return None


async def company_id() -> str | None:
    """The OwnerIQ company this login owns: remembered, else asked for."""
    state = await db.owneriq_sync_state.find_one({"_id": "hub"})
    if state and state.get("mc_id"):
        return str(state["mc_id"])
    mc = None
    if has_login():
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                ids = await _company_ids(client, await _login(client))
                mc = ids[0] if ids else None
        except Exception as ex:
            logger.warning("OwnerIQ hub: company lookup failed: %s", ex)
    if not mc:   # a local run with seeded copies
        doc = await db.owneriq_hub.find_one({"kind": "mc"}, sort=[("week_start", -1)])
        mc = doc.get("ref") if doc else None
    if mc:
        await db.owneriq_sync_state.update_one({"_id": "hub"}, {"$set": {"mc_id": str(mc)}}, upsert=True)
    return str(mc) if mc else None


def _name_key(name) -> str:
    return " ".join(str(name or "").lower().split())


def coach_teams(office_view: dict, app_users: dict, coach_id: str, downline: set, coach_name: str | None = None) -> list[dict]:
    """The teams a Coach may open in the Performance Hub, as [{id, name}]:
    the OwnerIQ team they are in (first), then every team led by someone under
    them in the app's tree. `app_users` is app_user_ids() of the office view.
    Only the OwnerIQ id link counts: a Coach who isn't linked by id gets no
    teams (link them in Admin or via their badge). Display names never
    authorise, because anyone can change their own. `coach_name` is accepted
    for older callers and ignored."""
    mine, led = None, []
    for row in office_view.get("users") or []:
        team = row.get("team") or {}
        if team.get("id") is None:
            continue
        person = row.get("user") or {}
        app_id = (app_users.get(str(person.get("id"))) or {}).get("id")
        entry = {"id": team["id"], "name": (team.get("name") or "").strip()}
        is_me = app_id is not None and app_id == coach_id
        if is_me:
            mine = entry
        elif row.get("team_leader") and app_id and app_id in downline:
            led.append(entry)
    out, seen = [], set()
    for t in ([mine] if mine else []) + sorted(led, key=lambda t: t["name"].lower()):
        if t["id"] not in seen:
            seen.add(t["id"])
            out.append(t)
    return out


def week_options(n: int = 12) -> list[dict]:
    """This week and the n-1 before it, newest first."""
    this_monday = monday_of(datetime.now(APP_TZ).date())
    out = []
    for i in range(n):
        ws = this_monday - timedelta(weeks=i)
        we = ws + timedelta(days=6)
        out.append({"week_start": ws.isoformat(), "week_end": we.isoformat(),
                    "label": "This week" if i == 0 else "Last week" if i == 1 else None})
    return out


async def app_user_ids(payload: dict) -> dict[str, dict]:
    """{OwnerIQ user id: {id, role}} for the BAs in a view who have an app
    account, so a row can open that person in the app. Links are read the way
    the Performance sync reads them: users.owneriq_user_id first, then the
    daily KPI rows (which carry both ids)."""
    from bson import ObjectId
    oids = [str((r.get("user") or {}).get("id")) for r in payload.get("users") or []]
    out: dict[str, dict] = {}
    if not oids:
        return out
    live = {"deleted": {"$ne": True}, "is_active": {"$ne": False}}
    async for u in db.users.find({"owneriq_user_id": {"$in": oids}, **live}, {"owneriq_user_id": 1, "role": 1}):
        out[str(u["owneriq_user_id"])] = {"id": str(u["_id"]), "role": u.get("role")}
    missing = [o for o in oids if o not in out]
    if missing:
        # owneriq_kpis stores the OwnerIQ id as it arrived (text or number).
        keys = missing + [int(o) for o in missing if is_oid(o)]
        pairs: dict[str, str] = {}
        async for r in db.owneriq_kpis.find(
            {"owneriq_user_id": {"$in": keys}, "cg1_user_id": {"$ne": None}, **ID_LINKED},
            {"_id": 0, "owneriq_user_id": 1, "cg1_user_id": 1},
        ).sort("date", -1):
            pairs.setdefault(str(r["owneriq_user_id"]), str(r["cg1_user_id"]))
        ids = [ObjectId(v) for v in pairs.values() if ObjectId.is_valid(v)]
        roles = {str(u["_id"]): u.get("role") async for u in db.users.find({"_id": {"$in": ids}, **live}, {"role": 1})}
        for oid, uid in pairs.items():
            if uid in roles:
                out[oid] = {"id": uid, "role": roles[uid]}
    return out
