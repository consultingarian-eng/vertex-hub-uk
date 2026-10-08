"""OwnerIQ Performance Hub sync (read-only towards OwnerIQ).

OwnerIQ's Performance Hub (`/v3/owner/bells_performance/marketing_companies/{id}`,
one call per company per week) carries, for every BA: the weekly sales target
and goal status, each day's attendance status (present / not present / absent
/ not set / na) and sign-up count, and the week's KPIs (sales, piece average,
reliability, scoring). It also lists the company's named teams with leaders.

This module mirrors that into the app every hour (from the OwnerIQ job):
  • owneriq_weekly_stats — one row per (app user, week_ending) for the Home card.
  • Bells weekly goal (WG) ← OwnerIQ weekly target, unless someone set a goal
    in the app (weekly_goal_source tracks who wrote it).
  • users.team_name / owneriq_team_id ← the OwnerIQ team the coach leads.
And fills Bells from the daily KPI rows (`owneriq_kpis`): a day nobody has
entered gets the BA's OwnerIQ sign-ups as £12 sign-ups (OwnerIQ has no
£12/£15+ split), flagged so coaches can correct the split. A day we filled is
refreshed on later runs until someone edits it; an edited day is never touched.

OwnerIQ users are linked to app users by users.owneriq_user_id, then the KPI
link, then roster email/badge (persisted to users.owneriq_user_id).
"""
from __future__ import annotations

import logging
import os
import re
import uuid
from datetime import date, datetime, timedelta, timezone

import httpx
from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from core.app_time import APP_TZ
from database import db
from owneriq_live import _company_ids, _headers
from owneriq_sync import ID_LINKED, OWNERIQ_API_BASE, OwnerIQError, _api_headers, _login, _select_company, company_pins

logger = logging.getLogger(__name__)

BELLS_SOURCE_NOTE = "Filled from OwnerIQ as £12 sign-ups: check the £15+ split"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


# ── Linking OwnerIQ users to app users ───────────────────────────────────────
async def _roster(client: httpx.AsyncClient, token: str) -> list[dict]:
    out: dict[str, dict] = {}
    pins = await company_pins(client, token) or [None]
    for pin in pins:
        if pin:
            await _select_company(client, token, pin)
        hdrs = {**_api_headers(), "authorization": f"Bearer {token}"}
        # The whole roster (every leaver too) is slow and can time out, on
        # OwnerIQ's side (502/503/504) or ours. Give it a short wait, then ask
        # for the active reps only: they are what matter for links and stages.
        r = None
        try:
            r = await client.get(f"{OWNERIQ_API_BASE}/v2/users", params={"limit": 2000}, headers=hdrs, timeout=20.0)
        except httpx.TransportError as ex:
            logger.info("OwnerIQ full roster timed out (%s); using the active roster", type(ex).__name__)
        if r is None or r.status_code in (502, 503, 504):
            r = await client.get(f"{OWNERIQ_API_BASE}/v2/users", params={"limit": 2000, "active": "true"},
                                 headers=hdrs, timeout=60.0)
        if r.status_code != 200:
            raise OwnerIQError(f"GET /v2/users failed: HTTP {r.status_code}")
        for u in r.json().get("data") or []:
            a = u.get("attributes") or {}
            badges = {b.strip().upper() for b in re.split(r"[,;\s]+", str(a.get("badge_number_list") or "")) if b.strip()}
            if a.get("badge_number"):
                badges.add(str(a["badge_number"]).strip().upper())
            out[str(u["id"])] = {"email": _norm(a.get("email")), "badges": badges, "active": bool(a.get("active")),
                                 "stage": a.get("stage")}
    return list({"id": k, **v} for k, v in out.items())


async def link_users(client: httpx.AsyncClient, token: str) -> dict[str, dict]:
    """OwnerIQ user id → app user doc. Persists new links on users.owneriq_user_id."""
    users = await db.users.find({"deleted": {"$ne": True}},
                                {"email": 1, "name": 1, "role": 1, "office_id": 1, "owneriq_user_id": 1,
                                 "amplifi_codes": 1, "is_super_admin": 1, "reports_to": 1,
                                 "owneriq_stage": 1}).to_list(10000)
    by_id = {str(u["_id"]): u for u in users}
    link: dict[str, dict] = {str(u["owneriq_user_id"]): u for u in users if u.get("owneriq_user_id")}
    async for r in db.owneriq_kpis.find({"cg1_user_id": {"$ne": None}, "owneriq_user_id": {"$ne": None}, **ID_LINKED},
                                        {"cg1_user_id": 1, "owneriq_user_id": 1}).sort("date", -1):
        u = by_id.get(str(r["cg1_user_id"]))
        if u and str(r["owneriq_user_id"]) not in link:
            link[str(r["owneriq_user_id"])] = u
    linked_app = {str(u["_id"]) for u in link.values()}
    by_email = {_norm(u.get("email")): u for u in users}
    by_badge = {str(b).strip().upper(): u for u in users for b in (u.get("amplifi_codes") or [])}
    owner_login = _norm(os.getenv("OWNERIQ_EMAIL"))
    super_admin = next((u for u in users if u.get("is_super_admin")), None)
    new_links = []
    # The roster only adds NEW links and refreshes stages. If OwnerIQ can't
    # serve it this run, carry on with the links we already hold: the week's
    # figures must not wait on it.
    try:
        roster = await _roster(client, token)
    except (httpx.TransportError, OwnerIQError) as ex:
        logger.warning("OwnerIQ roster unavailable this run (%s); keeping existing links", type(ex).__name__)
        roster = []
    stage_of = {r["id"]: r.get("stage") for r in roster}
    for r in sorted(roster, key=lambda x: not x["active"]):
        if r["id"] in link:
            continue
        u = by_email.get(r["email"])
        if not u and r["email"] and r["email"] == owner_login:
            u = super_admin
        if not u:
            u = next((by_badge[b] for b in r["badges"] if b in by_badge), None)
        if u and str(u["_id"]) not in linked_app:
            link[r["id"]] = u
            linked_app.add(str(u["_id"]))
            new_links.append((u["_id"], r["id"]))
    for uid, oid in new_links:
        await db.users.update_one({"_id": uid}, {"$set": {"owneriq_user_id": oid}})
    # Everyone's current OwnerIQ stage (stage_3, stage_3_plus, …) for the
    # team map's stage badges and rank counts.
    for oid, u in link.items():
        if oid in stage_of and u.get("owneriq_stage") != stage_of[oid]:
            await db.users.update_one({"_id": u["_id"]}, {"$set": {"owneriq_stage": stage_of[oid]}})
    return link


# ── Bells rows ───────────────────────────────────────────────────────────────
def _empty_day() -> dict:
    return {"over30": None, "under30": None, "memberships": None, "status": "off"}


async def _bells_entry(user: dict, week_ending: str) -> dict | None:
    office_id = user.get("office_id")
    if not office_id:
        return None
    q = {"office_id": office_id, "week_ending": week_ending, "user_id": str(user["_id"])}
    e = await db.bells_entries.find_one(q)
    if e:
        return e
    doc = {
        "id": str(uuid.uuid4()), **q, "user_name": user.get("name", ""), "role": user.get("role"),
        "stage": None, "break_even": None, "weekly_goal": None, "last_week_total": None,
        "last_week_total_source": None, "days": [_empty_day() for _ in range(7)],
        "created_by_id": "owneriq-sync", "created_at": _now(), "updated_at": _now(),
    }
    try:
        await db.bells_entries.insert_one(dict(doc))
        return doc
    except DuplicateKeyError:
        return await db.bells_entries.find_one(q)


def _day_untouched(day: dict) -> bool:
    return (day.get("under30") in (None, 0) and day.get("over30") in (None, 0)
            and day.get("status") in (None, "off", "normal"))


async def fill_bells(iso_from: str, iso_to: str) -> dict:
    """Fill Bells days from OwnerIQ daily KPIs (see module docstring)."""
    users = {str(u["_id"]): u async for u in db.users.find({"deleted": {"$ne": True}},
                                                           {"name": 1, "role": 1, "office_id": 1})}
    per_day: dict[tuple, dict] = {}
    async for r in db.owneriq_kpis.find({"date": {"$gte": iso_from, "$lte": iso_to},
                                        "cg1_user_id": {"$ne": None}, "test_mode": {"$ne": True}, **ID_LINKED}):
        k = (str(r["cg1_user_id"]), r["date"])
        cur = per_day.setdefault(k, {"sales": 0, "doors": 0})
        cur["sales"] += int(r.get("sales") or 0)
        cur["doors"] += int(r.get("doors_knocked") or 0)
    filled = refreshed = skipped = 0
    for (uid, iso), v in sorted(per_day.items()):
        user = users.get(uid)
        if not user or (v["sales"] == 0 and v["doors"] == 0):
            continue
        d = date.fromisoformat(iso)
        week_ending = (d + timedelta(days=6 - d.weekday())).isoformat()
        entry = await _bells_entry(user, week_ending)
        if not entry:
            continue
        idx = d.weekday()
        days = list(entry.get("days") or [])
        while len(days) < 7:
            days.append(_empty_day())
        day = dict(days[idx] or {})
        mine = (entry.get("owneriq_days") or {}).get(str(idx))
        ours_unedited = mine is not None and day.get("under30") == mine and day.get("over30") in (None, 0) \
            and day.get("status") == "in"
        if not (_day_untouched(day) or ours_unedited):
            skipped += 1
            continue
        if ours_unedited and mine == v["sales"]:
            continue
        day.update({"under30": v["sales"], "over30": None, "status": "in"})
        days[idx] = day
        await db.bells_entries.update_one({"id": entry["id"]}, {"$set": {
            "days": days, f"owneriq_days.{idx}": v["sales"],
            "owneriq_note": BELLS_SOURCE_NOTE, "updated_at": _now()}})
        if ours_unedited:
            refreshed += 1
        else:
            filled += 1
    return {"filled": filled, "refreshed": refreshed, "kept_manual": skipped}


# ── Performance Hub ──────────────────────────────────────────────────────────
async def _performance(client: httpx.AsyncClient, token: str, mc_id: str, week_start: str) -> dict:
    r = await client.get(f"{OWNERIQ_API_BASE}/v3/owner/bells_performance/marketing_companies/{mc_id}",
                         params={"week_start_on": week_start}, headers=_headers(token))
    if r.status_code != 200:
        raise OwnerIQError(f"GET bells_performance {mc_id} failed: HTTP {r.status_code} {r.text[:200]}")
    return r.json()


async def _apply_week(payload: dict, link: dict[str, dict], apply_teams: bool) -> dict:
    week_start = payload.get("week_start_on")
    week_ending = (date.fromisoformat(week_start) + timedelta(days=6)).isoformat()
    team_of: dict[str, str] = {}
    teams_set = 0
    for t in payload.get("teams") or []:
        name = str(t.get("name") or "").strip()
        for m in t.get("members") or []:
            team_of[str(m.get("id"))] = name
        leader = link.get(str((t.get("leader") or {}).get("id")))
        if apply_teams and leader and name and leader.get("role") in ("leader", "admin"):
            res = await db.users.update_one(
                {"_id": leader["_id"], "$or": [{"team_name": {"$ne": name}},
                                               {"owneriq_team_id": {"$ne": t.get("id")}}]},
                {"$set": {"team_name": name[:40], "owneriq_team_id": t.get("id"),
                          "team_name_source": "owneriq"}})
            teams_set += res.modified_count
    stats = goals = 0
    for row in payload.get("users") or []:
        oid = str((row.get("user") or {}).get("id"))
        u = link.get(oid)
        if not u:
            continue
        k = row.get("kpis") or {}
        uid = str(u["_id"])
        await db.owneriq_weekly_stats.update_one(
            {"user_id": uid, "week_ending": week_ending},
            {"$set": {
                "user_id": uid, "week_ending": week_ending, "week_start": week_start,
                "office_id": u.get("office_id"), "owneriq_user_id": oid,
                "team_name": team_of.get(oid), "team_leader": bool(row.get("team_leader")),
                "goal_status": row.get("goal_status"),
                "kpis": {key: k.get(key) for key in ("sales", "sales_target", "piece_average", "reliability",
                                                      "scoring", "points", "doors_knocked", "spoken_to",
                                                      "pitches_commenced", "pitches_closed")},
                "days": [{key: d.get(key) for key in ("date", "weekday", "phase", "status", "planned",
                                                       "checked_in", "in_field", "sales_count", "has_sale")}
                         for d in row.get("days") or []],
                "synced_at": _now(),
            }}, upsert=True)
        stats += 1
        target = k.get("sales_target")
        if target is not None:
            entry = await _bells_entry(u, week_ending)
            if entry and (entry.get("weekly_goal") is None or entry.get("weekly_goal_source") == "owneriq") \
                    and entry.get("weekly_goal") != target:
                await db.bells_entries.update_one({"id": entry["id"]}, {"$set": {
                    "weekly_goal": target, "weekly_goal_source": "owneriq", "updated_at": _now()}})
                goals += 1
    return {"week_ending": week_ending, "stats": stats, "goals": goals, "teams": teams_set}


async def sync_performance(weeks: int = 2, bells_weeks: int = 1) -> dict:
    """Pull the last `weeks` Performance Hub weeks and fill Bells for the last
    `bells_weeks` weeks (current week included)."""
    today = datetime.now(APP_TZ).date()
    this_monday = monday_of(today)
    out: dict = {"weeks": []}
    async with httpx.AsyncClient(timeout=60.0) as client:
        token = await _login(client)
        link = await link_users(client, token)
        out["linked_users"] = len(link)
        for mc_id in await _company_ids(client, token):
            for i in range(weeks):
                ws = (this_monday - timedelta(weeks=i)).isoformat()
                payload = await _performance(client, token, mc_id, ws)
                # Keep the whole view for the app's Performance Hub screen.
                try:
                    from owneriq_hub import store as _store_hub
                    await _store_hub("mc", str(mc_id), ws, payload)
                except Exception as ex:
                    logger.warning("OwnerIQ hub copy failed: %s", ex)
                res = await _apply_week(payload, link, apply_teams=(i == 0))
                out["weeks"].append({"mc": mc_id, **res})
    bells_from = (this_monday - timedelta(weeks=bells_weeks - 1)).isoformat()
    out["bells"] = await fill_bells(bells_from, today.isoformat())
    await db.owneriq_sync_state.update_one({"_id": "performance"}, {"$set": {"ok": True, "synced_at": _now(), **{
        "summary": {k: v for k, v in out.items() if k != "weeks"}}}}, upsert=True)
    return out


async def scheduler_tick() -> None:
    if not os.getenv("OWNERIQ_EMAIL") or not os.getenv("OWNERIQ_PASSWORD"):
        return
    try:
        res = await sync_performance()
        logger.info("OwnerIQ performance sync: %s", {k: v for k, v in res.items() if k != "weeks"})
    except Exception as ex:
        # A timeout has an empty message: record its type so the cause shows.
        why = str(ex) or type(ex).__name__
        logger.error("OwnerIQ performance sync failed: %s", why)
        await db.owneriq_sync_state.update_one({"_id": "performance"}, {"$set": {
            "ok": False, "error": why[:300], "synced_at": _now()}}, upsert=True)
