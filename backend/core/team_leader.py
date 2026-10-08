"""Earned leadership titles — measured, not typed in.

The ladder (the owner's Business Advancement Criteria). Each rung is a team
SHAPE plus a team RESULT, and both have to be true:

    Stage 4 · Crew Leadership       2 first-gen leaders  + team sign-ups week
    Stage 5 · Assistant Ownership   4 first-gen leaders  + team sign-ups week
    Stage 6 · Owner                 above the ladder — granted, never computed

    The 2 / 4 first-gen shape is the owner's own. The weekly team sign-up
    thresholds (STAGE_4_TEAM_WEEK_SIGN_UPS / STAGE_5_TEAM_WEEK_SIGN_UPS) are
    NOT in his content — they are placeholders for the owner to set.

Stored vs shown: `users.title` (and the `title` key in TITLE_TIERS) keeps the
historical stored values "Team Leader" / "Assistant Owner" / "Owner" so
existing data keeps matching; TITLE_DISPLAY maps each one to the owner's
stage name for anything people read (the frontend's roleTitle.ts does the
same mapping on screen).

    "In a week" means one Bells week (Monday to Sunday, keyed by its Sunday
    `week_ending`). It is a peak, not an average: reaching it once is the
    qualification.

Where each half comes from
--------------------------
* The team is the `reports_to` subtree. "First generation" means DIRECT
  reports, and only those whose role is `leader` count toward the shape.
* The sales come from Bells (`bells_entries`): the same per-day sales the
  weekly sales board, sales badges and team-week badges count — sales on
  days marked "in" (see core.achievements._day_units).

WHY THIS DOES NOT ASSIGN TITLES
-------------------------------
It reports. It never writes `users.title`, on purpose: an incomplete org
chart (`reports_to`) or a missing Bells week would silently strip a title
someone was deliberately granted. So: measure, show the working, and leave
`title` a deliberate act.
"""
from __future__ import annotations

import collections

from core.achievements import _day_units
from database import db

#: Team sign-ups (Bells, one Monday-Sunday week) each rung needs on top of
#: its first-gen shape. His criteria say only "Hit team sales criteria"
#: without a number — THE OWNER SHOULD SET THESE; 50 / 100 are placeholders
#: carried over until he does.
STAGE_4_TEAM_WEEK_SIGN_UPS = 50
STAGE_5_TEAM_WEEK_SIGN_UPS = 100

#: Stored title value → the owner's stage name, for anything people read.
TITLE_DISPLAY = {
    "Team Leader": "Stage 4 · Crew Leadership",
    "Assistant Owner": "Stage 5 · Assistant Ownership",
    "Owner": "Stage 6 · Owner",
}


def display_title(title: str | None) -> str | None:
    """Stored title → on-screen stage name; unknown titles pass through."""
    if not title:
        return title
    return TITLE_DISPLAY.get(title, title)


#: The earned ladder, hardest first — the first tier a person meets is theirs.
#: `title` is the STORED value (see display_title for the words people see);
#: `leaders` = direct reports with role 'leader' (first-gen); `sales` = Bells
#: sign-ups inside one Monday-Sunday week.
TITLE_TIERS = [
    {"title": "Assistant Owner", "display": TITLE_DISPLAY["Assistant Owner"],
     "leaders": 4, "sales": STAGE_5_TEAM_WEEK_SIGN_UPS},
    {"title": "Team Leader", "display": TITLE_DISPLAY["Team Leader"],
     "leaders": 2, "sales": STAGE_4_TEAM_WEEK_SIGN_UPS},
]

#: Granted, never computed — it sits above the measured ladder.
UNEARNED_TITLES = ("Owner",)

#: The easiest rung, for "does this person register at all".
FIRST_GEN_LEADERS = min(t["leaders"] for t in TITLE_TIERS)
TEAM_WEEK_SALES = min(t["sales"] for t in TITLE_TIERS)


def earned_title(first_gen_leaders: int, best_week_sales: int) -> str | None:
    """The highest tier this shape and result earn (its STORED title), or None."""
    for tier in TITLE_TIERS:
        if first_gen_leaders >= tier["leaders"] and best_week_sales >= tier["sales"]:
            return tier["title"]
    return None


async def _people() -> tuple[dict, dict]:
    """(users by id, direct reports by parent id)."""
    rows = await db.users.find(
        {"deleted": {"$ne": True}, "is_demo": {"$ne": True}}
    ).to_list(5000)
    by_id = {str(u["_id"]): u for u in rows}
    children: dict[str, list] = collections.defaultdict(list)
    for u in rows:
        parent = u.get("reports_to")
        if parent:
            children[str(parent)].append(u)
    return by_id, children


def _subtree(root: str, children: dict) -> list[str]:
    """Every id under `root`, root included, cycle-safe."""
    seen, out, frontier = {root}, [root], [root]
    while frontier:
        nxt = []
        for node in frontier:
            for child in children.get(node, []):
                cid = str(child["_id"])
                if cid not in seen:
                    seen.add(cid)
                    out.append(cid)
                    nxt.append(cid)
        frontier = nxt
    return out


async def _sales_by_person_week() -> collections.Counter:
    """(user_id, week_ending) -> Bells sales on worked ("in") days."""
    counts: collections.Counter = collections.Counter()
    cursor = db.bells_entries.find(
        {"user_id": {"$type": "string"}},
        {"_id": 0, "user_id": 1, "week_ending": 1, "days": 1},
    )
    async for row in cursor:
        uid, week = row.get("user_id"), row.get("week_ending")
        if not uid or not week:
            continue
        units = sum(_day_units(d) for d in (row.get("days") or []) if isinstance(d, dict))
        if units:
            counts[(uid, week)] += int(units)
    return counts


async def team_leader_report() -> dict:
    """Every leader measured against the rule, with the working shown.

    Read-only. Returns the qualifying weeks so a human can check the number
    rather than trust it.
    """
    by_id, children = await _people()
    per = await _sales_by_person_week()

    rows = []
    for uid, user in by_id.items():
        direct = children.get(uid, [])
        gen1 = [c for c in direct if c.get("role") == "leader"]
        if not direct:
            continue
        team = _subtree(uid, children)
        weeks: collections.Counter = collections.Counter()
        for member in team:
            for (owner, week), n in per.items():
                if owner == member:
                    weeks[week] += n
        best_week, best_n = weeks.most_common(1)[0] if weeks else (None, 0)
        earned = earned_title(len(gen1), best_n)
        current = user.get("title")
        rows.append({
            "user_id": uid,
            "name": user.get("name"),
            "role": user.get("role"),
            "current_title": current,
            "current_title_display": display_title(current),
            "earned_title": earned,
            "earned_title_display": display_title(earned),
            # A granted title (Owner) sits above the ladder, so "not earned"
            # is never a discrepancy for one.
            "matches": (current == earned) or (current in UNEARNED_TITLES),
            "first_gen_leaders": len(gen1),
            "first_gen_leader_names": [c.get("name") for c in gen1],
            "team_size": len(team) - 1,
            "best_week": best_week,
            "best_week_sales": best_n,
            # Per-tier working, so a near miss is visible rather than a bare no.
            "tiers": [
                {
                    "title": t["title"],
                    "display": t["display"],
                    "needs_leaders": t["leaders"],
                    "needs_sales": t["sales"],
                    "has_leaders": len(gen1) >= t["leaders"],
                    "has_sales": best_n >= t["sales"],
                    "short_by_leaders": max(0, t["leaders"] - len(gen1)),
                    "short_by_sales": max(0, t["sales"] - best_n),
                    "weeks_met": sorted(
                        [w for w, n in weeks.items() if n >= t["sales"]], reverse=True
                    ),
                }
                for t in TITLE_TIERS
            ],
        })
    rows.sort(key=lambda r: (-r["best_week_sales"], r["name"] or ""))

    return {
        "rule": {
            "tiers": TITLE_TIERS,
            "granted_only": list(UNEARNED_TITLES),
            "title_display": dict(TITLE_DISPLAY),
            "sales_source": "Bells weekly sign-up board (sign-ups on days marked in)",
            "week": "Monday-Sunday Bells week (week_ending = Sunday); a peak, not an average",
        },
        "rows": rows,
    }
