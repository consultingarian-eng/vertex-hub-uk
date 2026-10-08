"""The Timeline: sign-ups hour by hour, who brings them in, and what the best
weeks have in common.

  GET /api/insights/field?from=YYYY-MM-DD&to=YYYY-MM-DD&teams=58,61&user_id=…

Returns, for the chosen dates and scope:
  • hours      sign-ups, doors and BAs out for each hour of the day
  • bas        each BA's sign-ups, sign-ups per hour in the field, best hour
               and their own hour-by-hour sign-ups
  • averages   an average day: first door, last door, time in the field,
               sector break
  • patterns   the last PATTERN_WEEKS weeks' person-weeks cut into best,
               average and low, with the same day facts for each

Scope (never trusted from the client): Admins and Coach+ see the office and
can narrow it to any teams. A Coach sees their own team (and teams led by
people under them), the same rule as the Performance Hub. `user_id` narrows it
to one person, for the person page: allowed for whoever may open that page in
full.

Everything is read from `owneriq_field_days` (see owneriq_field.py); nothing
here asks OwnerIQ.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request

from auth import get_subtree_ids, require_admin_or_leader, sees_whole_office
from core.app_time import APP_TZ
from core.field_days import patterns, timeline
from database import db
from owneriq_config import office_pin
from owneriq_sync import ID_LINKED

router = APIRouter()

MAX_RANGE_DAYS = 186
PATTERN_WEEKS = 12


def _clean_range(from_date: Optional[str], to_date: Optional[str]) -> tuple[str, str]:
    today = datetime.now(APP_TZ).date()
    try:
        end = date.fromisoformat(str(to_date)[:10]) if to_date else today
    except ValueError:
        end = today
    try:
        start = date.fromisoformat(str(from_date)[:10]) if from_date else end - timedelta(days=end.weekday())
    except ValueError:
        start = end - timedelta(days=end.weekday())
    end = min(end, today)
    if start > end:
        start = end
    if (end - start).days > MAX_RANGE_DAYS:
        start = end - timedelta(days=MAX_RANGE_DAYS)
    return start.isoformat(), end.isoformat()


async def _team_map() -> tuple[dict[str, dict], list[dict], dict]:
    """({OwnerIQ user id: {id, name}}, [teams], the office view) from the
    newest saved Performance Hub office view: who is in which team now."""
    doc = await db.owneriq_hub.find_one({"kind": "mc"}, sort=[("week_start", -1)])
    view = (doc or {}).get("payload") or {}
    by_oid: dict[str, dict] = {}
    teams: dict[str, dict] = {}
    for row in view.get("users") or []:
        oid = (row.get("user") or {}).get("id")
        team = row.get("team") or {}
        if oid is None or team.get("id") is None:
            continue
        entry = {"id": str(team["id"]), "name": (team.get("name") or "").strip()}
        by_oid[str(oid)] = entry
        teams[entry["id"]] = entry
    return by_oid, sorted(teams.values(), key=lambda t: t["name"].lower()), view


async def _person_oids(user_doc: dict) -> set[str]:
    """The OwnerIQ ids a person's door logs are filed under."""
    uid = str(user_doc["_id"])
    oids = {str(user_doc["owneriq_user_id"])} if user_doc.get("owneriq_user_id") else set()
    async for r in db.owneriq_kpis.find({"cg1_user_id": uid, "owneriq_user_id": {"$ne": None}, **ID_LINKED}, {"_id": 0, "owneriq_user_id": 1}).limit(400):
        oids.add(str(r["owneriq_user_id"]))
    return oids


@router.get("/insights/field")
async def field_insights(request: Request, from_date: Optional[str] = None, to_date: Optional[str] = None,
                         teams: Optional[str] = None, user_id: Optional[str] = None):
    viewer = await require_admin_or_leader(request)
    # FastAPI can't name a parameter `from`; the client sends from= / to=.
    q = request.query_params
    start, end = _clean_range(q.get("from") or from_date, q.get("to") or to_date)
    team_of, all_teams, office_view = await _team_map()
    office_wide = sees_whole_office(viewer)

    person = None
    allowed_oids: Optional[set[str]] = None        # None = everyone the office filter lets through
    my_teams = all_teams
    picked: list[str] = []
    if user_id:
        from routes.people import _load_person
        person_doc, limited = await _load_person(viewer, user_id)
        if limited:
            raise HTTPException(status_code=403, detail="Their field numbers are with their own Coach")
        allowed_oids = await _person_oids(person_doc)
        person = {"id": str(person_doc["_id"]), "name": person_doc.get("name") or "", "linked": bool(allowed_oids)}
        my_teams = []
    else:
        if not office_wide:
            # A Coach: their own team, and teams led by people under them.
            from owneriq_hub import app_user_ids, coach_teams
            mine = coach_teams(office_view, await app_user_ids(office_view), str(viewer["id"]),
                               set(await get_subtree_ids(viewer["id"])), viewer.get("name"))
            my_teams = [{"id": str(t["id"]), "name": t["name"]} for t in mine]
        wanted = [t.strip() for t in (teams or "").split(",") if t.strip()]
        ids = {t["id"] for t in my_teams}
        picked = [t for t in wanted if t in ids or (t == "none" and office_wide)]
        if picked or not office_wide:
            use = set(picked) or ids
            allowed_oids = {oid for oid, t in team_of.items() if t["id"] in use}
            if "none" in use:
                # People who are in OwnerIQ but in no team.
                everyone = {str((r.get("user") or {}).get("id")) for r in office_view.get("users") or []}
                allowed_oids |= everyone - set(team_of)
            if not office_wide and not picked:
                # …and always the Coach's own people, whichever team they sit in.
                under = [ObjectId(s) for s in await get_subtree_ids(viewer["id"]) if ObjectId.is_valid(str(s))]
                async for u in db.users.find({"_id": {"$in": under}, "owneriq_user_id": {"$nin": [None, ""]}},
                                             {"owneriq_user_id": 1}):
                    allowed_oids.add(str(u["owneriq_user_id"]))

    # An Admin's office only (the Owner sees every office the login covers).
    pin = None if viewer.get("is_super_admin") else await office_pin(viewer.get("office_id"), db)

    def match(lo: str, hi: str) -> dict:
        m: dict = {"date": {"$gte": lo, "$lte": hi}, "empty": {"$ne": True}}
        if allowed_oids is not None:
            m["oid"] = {"$in": sorted(allowed_oids)}
        if pin:
            m["mc_pin"] = {"$in": [str(pin), None]}
        return m

    proj = {"_id": 0, "laps": 0, "src_fetched_at": 0, "built_at": 0}
    days = await db.owneriq_field_days.find(match(start, end), proj).to_list(20000)
    pattern_from = (date.fromisoformat(end) - timedelta(weeks=PATTERN_WEEKS)).isoformat()
    pattern_days = await db.owneriq_field_days.find(match(pattern_from, end), {**proj, "hours": 0}).to_list(40000)

    out = timeline(days)
    # Each BA's team, and their app account (so a row can open their page).
    from owneriq_hub import app_user_ids
    links = await app_user_ids({"users": [{"user": {"id": b["oid"]}} for b in out["bas"]]})
    for b in out["bas"]:
        b["team"] = (team_of.get(b["oid"]) or {}).get("name")
        b["user_id"] = (links.get(b["oid"]) or {}).get("id")
    coverage = await db.owneriq_field_days.find({"empty": {"$ne": True}}, {"_id": 0, "date": 1}).sort("date", 1).limit(1).to_list(1)
    return {
        "from": start, "to": end,
        "scope": {"person": person, "teams": picked, "office_wide": office_wide},
        "teams": my_teams,
        "can_pick_no_team": office_wide and not user_id,
        **out,
        "patterns": {**patterns(pattern_days), "from": pattern_from, "to": end},
        "data_from": coverage[0]["date"] if coverage else None,
    }
