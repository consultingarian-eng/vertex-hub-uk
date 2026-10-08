"""Weekly Bulletin — cross-office leaderboards rendered Monday-morning style.

Returns countrywide, read-only weekly rankings derived from Bells data:
  1. top_sales        — Top 5 brand ambassadors by total sales (no minimum)
  2. top_membership   — Top 5 by memberships / sales %, min 10 sales
  3. top_gold         — Top 5 by over30 / sales % (Gold = $30+), min 10 sales

Tie-breaker (per user spec): higher total sales wins.
Permissions: admins and leaders. These endpoints expose only the intentionally
companywide bulletin aggregates; they do not provide raw office records.
Profile photos: passthrough of `profile_image` (base64 data URL or null).
"""
from typing import Optional
from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request

from auth import get_subtree_ids, require_admin_or_leader
from database import db
from routes.bells import compute_totals

router = APIRouter()

# Minimum total sales required to qualify for the % leaderboards.
MIN_SALES_FOR_PCT = 10
TOP_N = 5


def _safe_int(v) -> int:
    try:
        return int(v or 0)
    except Exception:
        return 0


def _team_member_scope(leader_id: str, subtree_ids: list) -> Optional[tuple[list[str], int]]:
    """Return aggregation IDs and the number of people led by ``leader_id``.

    ``get_subtree_ids`` includes the leader themselves. A leader is therefore
    only an eligible *team* when at least one distinct descendant exists. The
    leader stays in the aggregation IDs so their personal production continues
    to contribute to their eligible team's total, while ``member_count`` means
    people in their subtree excluding the leader.
    """
    leader_id = str(leader_id)
    seen: set[str] = set()
    normalized: list[str] = []
    for raw_id in subtree_ids or []:
        member_id = str(raw_id)
        if member_id and member_id not in seen:
            seen.add(member_id)
            normalized.append(member_id)

    descendants = [member_id for member_id in normalized if member_id != leader_id]
    if not descendants:
        return None
    return [leader_id, *descendants], len(descendants)


def _rank_top_teams(teams: list) -> list:
    """Sort deterministically, cap the public bulletin, and assign ranks."""
    ranked = sorted(
        teams,
        key=lambda team: (-team["total_sales"], team["team_name"].lower()),
    )[:TOP_N]
    for index, team in enumerate(ranked):
        team["rank"] = index + 1
    return ranked


async def _build_top_teams(week_ending: str) -> list:
    """Derive the countrywide top-team board without a stored weekly record."""
    # Leaders, plus admins who run their own crew inside an office. An
    # OFFICE-LEVEL admin is excluded on purpose — their subtree is the whole
    # office and would dwarf every real crew — but a team leader promoted to
    # admin still leads one team, and dropping them erases a real crew from
    # the board (core/admin_scope.py).
    from core.admin_scope import leads_own_crew

    candidates = await db.users.find(
        {
            "role": {"$in": ["leader", "admin"]},
            "team_name": {"$exists": True, "$nin": [None, ""]},
            "is_active": {"$ne": False},
            "deleted": {"$ne": True},
            "is_demo": {"$ne": True},
        },
        {"_id": 1, "name": 1, "team_name": 1, "office_id": 1, "profile_image": 1,
         "role": 1, "reports_to": 1, "is_super_admin": 1},
    ).to_list(500)

    raw_leaders = [
        c for c in candidates
        if (c.get("role") or "").lower() != "admin" or await leads_own_crew(c, db)
    ]

    if not raw_leaders:
        return []

    # Current roster state is authoritative for what constitutes a team. The
    # hierarchy helper intentionally includes inactive (but non-deleted) users
    # for other historical views, so filter its result against one active-user
    # snapshot before deciding eligibility, member_count, or Bells aggregation.
    active_users = await db.users.find(
        {"is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}},
        {"_id": 1},
    ).to_list(5000)
    active_user_ids = {str(user["_id"]) for user in active_users}

    office_names: dict = {}
    async for office in db.offices.find({}, {"_id": 0, "id": 1, "name": 1}):
        office_names[office["id"]] = office.get("name") or "Unknown"

    teams: list = []
    for team_leader in raw_leaders:
        team_name = str(team_leader.get("team_name") or "").strip()
        if not team_name:
            continue
        leader_id = str(team_leader["_id"])
        try:
            subtree_ids = await get_subtree_ids(leader_id)
            active_subtree_ids = [
                member_id
                for member_id in subtree_ids
                if str(member_id) in active_user_ids
            ]
            scope = _team_member_scope(leader_id, active_subtree_ids)
        except Exception:
            scope = None
        if scope is None:
            continue
        aggregation_ids, member_count = scope

        entries = await db.bells_entries.find(
            {"week_ending": week_ending, "user_id": {"$in": aggregation_ids}},
            {"_id": 0, "days": 1},
        ).to_list(500)

        total_sales = 0
        total_memberships = 0
        total_over30 = 0
        in_days = 0
        for entry in entries:
            for day in (entry.get("days") or []):
                if (day or {}).get("status") != "in":
                    continue
                over30 = _safe_int(day.get("over30"))
                under30 = _safe_int(day.get("under30"))
                total_sales += over30 + under30
                total_over30 += over30
                total_memberships += _safe_int(day.get("memberships"))
                in_days += 1

        if total_sales == 0 and total_memberships == 0:
            continue

        teams.append({
            "team_name": team_name,
            "leader_name": team_leader.get("name") or "Unknown",
            "leader_avatar": team_leader.get("profile_image"),
            "office": office_names.get(team_leader.get("office_id") or "", "Unknown"),
            "member_count": member_count,
            "total_sales": total_sales,
            "total_memberships": total_memberships,
            "total_over30": total_over30,
            "piece_average": round(total_sales / in_days, 2) if in_days > 0 else 0.0,
            "pct_membership": round((total_memberships / total_sales) * 100, 1) if total_sales > 0 else 0.0,
            "pct_gold": round((total_over30 / total_sales) * 100, 1) if total_sales > 0 else 0.0,
        })

    return _rank_top_teams(teams)


@router.get("/bulletin/weekly")
async def bulletin_weekly(request: Request, week_ending: Optional[str] = None):
    """Build the read-only countrywide bulletin for a given week.

    Args:
        week_ending: Sunday date string YYYY-MM-DD. Required.
    """
    viewer = await require_admin_or_leader(request)
    _ = viewer
    if not week_ending:
        raise HTTPException(status_code=400, detail="week_ending is required (YYYY-MM-DD)")

    # ── Fetch every bells entry for the target week, regardless of office ──
    # Cross-office is the point of this view; authorized viewers seeing other
    # offices' aggregate rankings is intentional because the bulletin is a
    # companywide publication.
    rows: list = []
    async for e in db.bells_entries.find(
        {"week_ending": week_ending},
        {"_id": 0, "user_id": 1, "user_name": 1, "office_id": 1, "office": 1, "days": 1, "role": 1, "earnings": 1},
    ):
        rows.append(e)

    if not rows:
        return {
            "week_ending": week_ending,
            "min_sales_pct": MIN_SALES_FOR_PCT,
            "top_sales": [],
            "top_membership": [],
            "top_gold": [],
        }

    # ── Build a name → office display map (the bells doc already carries
    # `office` as a label, but we still resolve via offices collection in case
    # the cached name is stale). ─
    office_names: dict = {}
    async for o in db.offices.find({}, {"_id": 0, "id": 1, "name": 1}):
        office_names[o["id"]] = o.get("name") or "Unknown"

    # ── Load fee schedules so earnings can be computed dynamically (not from
    # the stale cached `earnings` field which may be 0 for older entries). ─
    fees_cache: dict = {}
    async for f in db.commission_fees.find({}, {"_id": 0}):
        fees_cache[f.get("office_id", "__default__")] = f
    default_fees = fees_cache.get("__default__") or next(iter(fees_cache.values()), None)

    # ── Aggregate weekly totals per rep ──
    per_rep: dict = {}
    for r in rows:
        uid = r.get("user_id") or r.get("user_name")
        if not uid:
            continue
        days = r.get("days") or []
        sales = 0
        over30 = 0
        memberships = 0
        for d in days:
            if (d or {}).get("status") != "in":
                continue
            o30 = _safe_int(d.get("over30"))
            u30 = _safe_int(d.get("under30"))
            mem = _safe_int(d.get("memberships"))
            sales += o30 + u30
            over30 += o30
            memberships += mem
        if sales == 0 and memberships == 0 and over30 == 0:
            continue  # skip empty/rest-week entries
        # Office display: prefer the entry's cached `office` (latest at write time)
        office_lbl = r.get("office")
        if not office_lbl and r.get("office_id"):
            office_lbl = office_names.get(r["office_id"])
        office_id = r.get("office_id") or ""
        fees = fees_cache.get(office_id) or default_fees
        computed_earnings = compute_totals(r, fees).get("earnings", 0.0) if fees else 0.0
        per_rep[uid] = {
            "user_id": uid if r.get("user_id") else None,
            "user_name": r.get("user_name") or "Unknown",
            "office": office_lbl or "Unknown",
            "sales": sales,
            "over30": over30,
            "memberships": memberships,
            "earnings": computed_earnings,
        }

    if not per_rep:
        return {
            "week_ending": week_ending,
            "min_sales_pct": MIN_SALES_FOR_PCT,
            "top_sales": [],
            "top_membership": [],
            "top_gold": [],
        }

    # ── Resolve profile_image AND live name per rep in one DB sweep.
    # We always trust the *live* users.name over the cached bells_entries.user_name
    # so renames (e.g. "Sam" → "Sam Taylor") propagate to the bulletin
    # immediately without re-writing every bells doc. ─
    user_ids: list = []
    for r in per_rep.values():
        if r["user_id"]:
            try:
                user_ids.append(ObjectId(r["user_id"]))
            except Exception:
                pass
    profile_by_uid: dict = {}
    name_by_uid: dict = {}
    if user_ids:
        async for u in db.users.find(
            {"_id": {"$in": user_ids}},
            {"profile_image": 1, "name": 1},
        ):
            uid_str = str(u["_id"])
            profile_by_uid[uid_str] = u.get("profile_image")
            if u.get("name"):
                name_by_uid[uid_str] = u["name"]
    for uid, r in per_rep.items():
        r["avatar"] = profile_by_uid.get(str(uid))  # base64 data URL or None
        # Override cached user_name with live users.name when present.
        live_name = name_by_uid.get(str(uid))
        if live_name:
            r["user_name"] = live_name

    # ── Build the three leaderboards ──
    # Tie-breaker per user spec: higher total sales wins. For top_sales the
    # primary key IS sales, so we add a secondary stable-name tie-break to keep
    # ordering deterministic week-to-week when two reps land on identical
    # numbers. For % boards we sort primarily by % desc, then sales desc.
    all_reps = list(per_rep.values())

    top_sales = sorted(
        all_reps,
        key=lambda r: (-r["sales"], -r["earnings"], r["user_name"].lower()),
    )[:TOP_N]
    top_sales_out = [{
        "rank": i + 1,
        "user_id": r["user_id"],
        "name": r["user_name"],
        "office": r["office"],
        "avatar": r["avatar"],
        "sales": r["sales"],
        "earnings": round(r.get("earnings", 0), 2),
    } for i, r in enumerate(top_sales)]

    qualified = [r for r in all_reps if r["sales"] >= MIN_SALES_FOR_PCT]

    top_membership = sorted(
        [{**r, "pct": (r["memberships"] / r["sales"]) * 100 if r["sales"] else 0} for r in qualified],
        key=lambda r: (-r["pct"], -r["sales"], r["user_name"].lower()),
    )[:TOP_N]
    top_membership_out = [{
        "rank": i + 1,
        "user_id": r["user_id"],
        "name": r["user_name"],
        "office": r["office"],
        "avatar": r["avatar"],
        "sales": r["sales"],
        "memberships": r["memberships"],
        "pct": round(r["pct"], 1),
    } for i, r in enumerate(top_membership)]

    top_gold = sorted(
        [{**r, "pct": (r["over30"] / r["sales"]) * 100 if r["sales"] else 0} for r in qualified],
        key=lambda r: (-r["pct"], -r["sales"], r["user_name"].lower()),
    )[:TOP_N]
    top_gold_out = [{
        "rank": i + 1,
        "user_id": r["user_id"],
        "name": r["user_name"],
        "office": r["office"],
        "avatar": r["avatar"],
        "sales": r["sales"],
        "over30": r["over30"],
        "pct": round(r["pct"], 1),
    } for i, r in enumerate(top_gold)]

    return {
        "week_ending": week_ending,
        "min_sales_pct": MIN_SALES_FOR_PCT,
        "top_sales": top_sales_out,
        "top_membership": top_membership_out,
        "top_gold": top_gold_out,
    }


@router.get("/bulletin/team-weekly")
async def bulletin_team_weekly(request: Request, week_ending: Optional[str] = None):
    """Weekly Team Bulletin — leader teams ranked by total sales (full subtree).

    Qualifying: a team_name plus at least one active, non-deleted descendant,
    and either role=='leader' or an admin who runs their own crew inside an
    office. Office-level admins (owners) are excluded from the rankings —
    their subtree is the whole office. Each team's sales total covers their
    current active subtree
    (sub-leaders + their BAs), so section-leaders with multiple sub-teams get
    their whole active group counted.
    """
    viewer = await require_admin_or_leader(request)
    _ = viewer
    if not week_ending:
        raise HTTPException(status_code=400, detail="week_ending is required (YYYY-MM-DD)")

    return {"week_ending": week_ending, "teams": await _build_top_teams(week_ending)}
