"""Leaders' Weekly Planner — the digital version of the printed
"LEADERS WEEKLY PLANNER" book + the WhatsApp weekly-plan reports leaders
already write (e.g. Stoic Solutions / THRYVE formats).

One doc per user per week (Sunday week_ending, same convention as bells &
the office agenda):
  • review  — the week-plan/report sections (wins, goals, team mgmt, 8-steps…)
  • days    — Mon–Sat diary pages (Networking / Sector / Primetime / Crew Plan
              + Leaders Meeting / Morning Meeting boxes from the paper book)
  • notes   — free extra-notes page

Numbers the app already knows (sales, P/A, scoring %, highrollers, BA goals)
are NOT stored here — GET /weekly-planners/{week}/stats computes them live
from bells_entries so the report always matches the sheet.

Visibility mirrors the Monthly Goal Planner: owner edits; upline
(core leader / admin / super admin) may view read-only.
"""
import os
import re
import uuid
import base64
from datetime import datetime, timezone, date, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from bson import ObjectId
from pymongo.errors import DuplicateKeyError
from dotenv import load_dotenv

from auth import get_current_user, get_subtree_ids
from core.rate_limit import take_ai_quota
from core.app_time import APP_TZ
from core.goal_audit import record_goal_change
from routes.monthly_planners import _resolve_target_user

load_dotenv()

router = APIRouter()
from database import db  # the shared client; one DB_NAME default (database.py)

# Mon=0..Sat=5 — same as the office agenda
DAYS = list(range(0, 6))

# The 8 Steps self-review (star-rated 0–5 each)
EIGHT_STEPS = [
    "Attitude",
    "Time Management",
    "Preparation",
    "100% Effort",
    "Safeguarding Attitude",
    "Working Territory Effectively",
    "Know Your Why",
    "Taking Control",
]

# Per-day diary boxes. "Plan today" boxes come from the paper book's day
# spreads; the notes boxes are what leaders write down every day (Leaders
# Meeting + the Morning Meeting subtopics: News, Topic, Customer Service,
# Bells).
DAY_FIELDS = [
    "primetime", "sector", "networking", "crew_plan",
    "leaders_meeting", "morning_news", "morning_topic", "morning_cs", "morning_bells",
]

# Human labels for search results
DAY_FIELD_LABELS = {
    "primetime": "Primetime",
    "sector": "Sector",
    "networking": "Networking",
    "crew_plan": "Crew Meetings",
    "leaders_meeting": "Leaders Meeting",
    "morning_news": "Morning Meeting · News",
    "morning_topic": "Morning Meeting · Topic",
    "morning_cs": "Morning Meeting · Customer Service",
    "morning_bells": "Morning Meeting · Bells",
}
DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


def _coerce_to_sunday(s: str) -> Optional[str]:
    try:
        d = date.fromisoformat(s)
    except Exception:
        return None
    delta = (6 - d.weekday()) % 7
    return (d + timedelta(days=delta)).isoformat()


def _crew_lock_deadline(week_ending: str) -> datetime:
    """Monday 10:30 AM (app time) of the week ending on the given Sunday."""
    monday = date.fromisoformat(week_ending) - timedelta(days=6)
    return datetime(monday.year, monday.month, monday.day, 10, 30, tzinfo=APP_TZ)


def _empty_day() -> dict:
    return {k: "" for k in DAY_FIELDS}


def _empty_review() -> dict:
    return {
        # 🚀 Wins / Positives
        "wins": [],
        # Manual bits of last week's accountability the app can't compute
        "owners_profit": "",
        "team_quality": {"silver": "", "gold": "", "zero": "", "fails": ""},
        # 📊 Personal KPI extras (sales/scoring auto-computed via /stats)
        "personal": {"loas": "", "scoring_focus": "",
                     "silver": "", "gold": "", "zero": "", "fails": ""},
        # 🎯 This week's goals
        "next_goals": {"sales": "", "leaders": "", "piece_avg": "", "scoring": ""},
        # 💡 Theme + concentration
        "theme": "",
        "concentration": "",
        # 👥 Headcount / COD breakdown (free text — formats vary per leader)
        "headcount": "",
        # 🧑‍💼 Recruitment
        "recruitment": {"booked_in": "", "attended": "", "newstarts": "", "focus": ""},
        # 🧩 8 Steps review
        "eight_steps": {"scores": {s: 0 for s in EIGHT_STEPS}, "focus": ""},
        # 🧠 What did I learn
        "learnings": [],
        # 💪 Personal development
        "personal_development": {"cod": "", "goal": ""},
        # 🤝 Team management
        "team_management": {"meetings": "", "team_call": "", "one_on_one": "",
                            "education": "", "social": ""},
        # 🌱 Who am I developing — [{id, who, what}]
        "developing": [],
        # 🎯 Goals — this week's focuses + mid/long-term
        "focus_next_week": [],
        "focus_mid": "",
        "focus_long": "",
        # Sign-off motto / hashtags (legacy — no longer shown in the UI)
        "motto": "",
    }


def _seed(user_id: str, office_id: str, week_ending: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "office_id": office_id,
        "week_ending": week_ending,
        "review": _empty_review(),
        "days": {str(d): _empty_day() for d in DAYS},
        "notes": "",
        "created_at": now,
        "updated_at": now,
    }


# ── Normalizers — clamp incoming payloads to the expected shape ────────────
def _s(v, cap: int = 4000) -> str:
    return (str(v) if v is not None else "").strip()[:cap]


def _str_list(v, cap: int = 12) -> list:
    out = []
    if isinstance(v, list):
        for x in v:
            s = _s(x, 500)
            if s:
                out.append(s)
    return out[:cap]


def _sub(raw, keys: dict) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    return {k: _s(raw.get(k), cap) for k, cap in keys.items()}


def _normalize_review(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    out = _empty_review()
    out["wins"] = _str_list(raw.get("wins"))
    out["owners_profit"] = _s(raw.get("owners_profit"), 60)
    out["team_quality"] = _sub(raw.get("team_quality"), {"silver": 20, "gold": 20, "zero": 20, "fails": 20})
    out["personal"] = _sub(raw.get("personal"), {"loas": 20, "scoring_focus": 300,
                                                 "silver": 20, "gold": 20, "zero": 20, "fails": 20})
    out["next_goals"] = _sub(raw.get("next_goals"), {"sales": 20, "leaders": 20, "piece_avg": 20, "scoring": 20})
    out["theme"] = _s(raw.get("theme"), 300)
    out["concentration"] = _s(raw.get("concentration"), 300)
    out["headcount"] = _s(raw.get("headcount"), 1500)
    out["recruitment"] = _sub(raw.get("recruitment"), {"booked_in": 20, "attended": 20, "newstarts": 20, "focus": 300})
    steps_raw = (raw.get("eight_steps") or {}) if isinstance(raw.get("eight_steps"), dict) else {}
    scores_raw = steps_raw.get("scores") if isinstance(steps_raw.get("scores"), dict) else {}
    scores = {}
    for s in EIGHT_STEPS:
        try:
            scores[s] = max(0, min(5, int(scores_raw.get(s) or 0)))
        except Exception:
            scores[s] = 0
    out["eight_steps"] = {"scores": scores, "focus": _s(steps_raw.get("focus"), 300)}
    out["learnings"] = _str_list(raw.get("learnings"))
    out["personal_development"] = _sub(raw.get("personal_development"), {"cod": 60, "goal": 300})
    out["team_management"] = _sub(raw.get("team_management"), {"meetings": 800, "team_call": 300,
                                                               "one_on_one": 300, "education": 300, "social": 800})
    dev = []
    if isinstance(raw.get("developing"), list):
        for r in raw["developing"]:
            if not isinstance(r, dict):
                continue
            who = _s(r.get("who"), 80)
            what = _s(r.get("what"), 300)
            if who or what:
                dev.append({"id": r.get("id") or str(uuid.uuid4()), "who": who, "what": what})
    out["developing"] = dev[:12]
    out["focus_next_week"] = _str_list(raw.get("focus_next_week"))
    out["focus_mid"] = _s(raw.get("focus_mid"), 800)
    out["focus_long"] = _s(raw.get("focus_long"), 800)
    out["motto"] = _s(raw.get("motto"), 500)
    return out


def _normalize_days(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for d in DAYS:
        day_raw = raw.get(str(d)) if isinstance(raw.get(str(d)), dict) else {}
        out[str(d)] = {k: _s(day_raw.get(k)) for k in DAY_FIELDS}
    return out


def _scrub(doc: dict) -> dict:
    if doc and "_id" in doc:
        doc.pop("_id", None)
    return doc


# How complete a leader's week plan is. A doc merely EXISTING means nothing —
# autosave creates one the moment a leader types (or a goal syncs), so the
# tick has to measure substance: wins, sales goals, team management, the
# 8-steps review, and focus. Shared by the Team Planners roster and the
# office weekly-review summary so "submitted" means the same thing in both.
PLAN_STEPS_TOTAL = 5
PLAN_FILLED_AT = 4  # "most parts" — 4 of the 5 core sections


def _plan_steps_done(doc: Optional[dict], goal_row: Optional[dict]) -> int:
    r = _normalize_review((doc or {}).get("review"))
    g = goal_row or {}
    tm = r["team_management"]
    n = 0
    if r["wins"]:
        n += 1
    if g.get("weekly_goal") is not None or g.get("team_weekly_goal") is not None:
        n += 1
    if any((tm.get(k) or "").strip() for k in ("meetings", "team_call", "one_on_one", "education", "social")):
        n += 1
    if any(v > 0 for v in r["eight_steps"]["scores"].values()):
        n += 1
    if r["focus_next_week"] or r["focus_mid"] or r["focus_long"]:
        n += 1
    return n


def _require_planner_role(user: dict):
    """Leader/admin-only surfaces: the week REVIEW, crew scheduling, goals,
    and the review-week performance stats — none of which exist for a
    trainee (no crew, no week-in-review to write)."""
    if user.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")


def _require_planner_access(user: dict):
    """Own-day-page surfaces: trainees get the Mon–Sat daily plan + notes +
    search + photo-scan, exactly like leaders/admins, just without the week
    review or crew tools (gated separately by _require_planner_role)."""
    if user.get("role") not in ("trainee", "leader", "admin"):
        raise HTTPException(status_code=403, detail="Planner access required")


# ── ENDPOINTS ──────────────────────────────────────────────────────────────

@router.get("/weekly-planners")
async def list_weekly_planners(request: Request, user_id: Optional[str] = None):
    """List planner weeks for me (or a report I'm allowed to view)."""
    me, target = await _resolve_target_user(request, user_id)
    _require_planner_access(me)
    cursor = db.weekly_planners.find(
        {"user_id": target["id"]},
        {"_id": 0, "id": 1, "week_ending": 1, "updated_at": 1},
    ).sort("week_ending", -1)
    items = await cursor.to_list(120)
    return {
        "user": {"id": target["id"], "name": target.get("name") or target.get("email"),
                 "role": target.get("role"), "team_name": target.get("team_name") or ""},
        "items": items,
    }


# NOTE: /search, /scan-notes, /team/* and /office/* are declared BEFORE
# "/weekly-planners/{week}" so those paths aren't captured as a week date.
@router.get("/weekly-planners/team/roster")
async def weekly_team_roster(request: Request, week: Optional[str] = None):
    """Who has (and hasn't) written a weekly plan for the given week.
    Admins see every leader in their office; leaders see the leaders in
    their own reports tree. Powers the Team Planners weekly view and the
    admin Home completion card."""
    me = await get_current_user(request)
    role = me.get("role")
    if role not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")
    week_ending = _coerce_to_sunday(week) if week else None
    if not week_ending:
        # Default: the week currently being planned (Mon–Sat = this week's
        # upcoming Sunday; on Sunday itself, next week's).
        today = date.today()
        offset = (6 - today.weekday()) % 7
        week_ending = (today + timedelta(days=offset if offset else 7)).isoformat()

    base_filter = {"role": {"$in": ["leader", "admin"]}, "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}}
    if role == "admin":
        users = await db.users.find(
            {**base_filter, "office_id": me.get("office_id") or ""},
            {"_id": 1, "name": 1, "email": 1, "role": 1},
        ).to_list(500)
    else:
        subtree = await get_subtree_ids(me["id"])
        oids = []
        for sid in subtree:
            if sid == me["id"]:
                continue
            try:
                oids.append(ObjectId(sid))
            except Exception:
                pass
        users = await db.users.find(
            {**base_filter, "_id": {"$in": oids}},
            {"_id": 1, "name": 1, "email": 1, "role": 1},
        ).to_list(500)

    ids = [str(u["_id"]) for u in users]
    docs = await db.weekly_planners.find(
        {"user_id": {"$in": ids}, "week_ending": week_ending},
        {"_id": 0, "user_id": 1, "updated_at": 1, "review": 1},
    ).to_list(500)
    by_user = {d["user_id"]: d for d in docs}

    # Sales goals live on the leader's bells row, not the planner doc.
    goal_rows = await db.bells_entries.find(
        {"user_id": {"$in": ids}, "week_ending": week_ending},
        {"_id": 0, "user_id": 1, "weekly_goal": 1, "team_weekly_goal": 1},
    ).to_list(500)
    goals_by_user = {r["user_id"]: r for r in goal_rows}

    items = []
    for u in users:
        uid = str(u["_id"])
        d = by_user.get(uid)
        done = _plan_steps_done(d, goals_by_user.get(uid))
        items.append({
            "id": uid,
            "name": u.get("name") or u.get("email"),
            "role": u.get("role"),
            # The tick: most of the plan is genuinely filled in.
            "has_planner": done >= PLAN_FILLED_AT,
            # Started = wrote/set ANYTHING (partial-progress display).
            "started": bool(d) or done > 0,
            "steps_done": done,
            "steps_total": PLAN_STEPS_TOTAL,
            "updated_at": (d or {}).get("updated_at"),
        })
    # Leaders first, least-complete before complete within role, then name —
    # so the admin sees who still owes a plan at the top.
    items.sort(key=lambda x: (0 if x["role"] == "leader" else 1, x["steps_done"], (x["name"] or "").lower()))
    return {"week_ending": week_ending, "items": items}


@router.get("/weekly-planners/team/daily-roster")
async def weekly_team_daily_roster(request: Request):
    """Who has written TODAY's daily-plan box — trainees, leaders and admins
    alike, since the Mon–Sat day page is the same mechanism for everyone.
    Unlike the weekly roster, this ONLY returns people who have written
    something today: the admin Home card wants a feed of who's planned,
    not a checklist of who hasn't (there's no day box at all on Sunday)."""
    me = await get_current_user(request)
    role = me.get("role")
    if role not in ("leader", "admin"):
        raise HTTPException(status_code=403, detail="Coach or admin access required")

    today_local = datetime.now(APP_TZ).date()
    wd = today_local.weekday()  # Mon=0 .. Sun=6
    if wd == 6:
        return {"date": today_local.isoformat(), "is_plannable_day": False,
                "day_index": None, "week_ending": None, "total_eligible": 0, "items": []}
    day_idx = wd
    week_ending = (today_local + timedelta(days=(6 - wd))).isoformat()

    base_filter = {"role": {"$in": ["trainee", "leader", "admin"]}, "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}}
    if role == "admin":
        users = await db.users.find(
            {**base_filter, "office_id": me.get("office_id") or ""},
            {"_id": 1, "name": 1, "email": 1, "role": 1},
        ).to_list(1000)
    else:
        subtree = await get_subtree_ids(me["id"])
        oids = []
        for sid in subtree:
            if sid == me["id"]:
                continue
            try:
                oids.append(ObjectId(sid))
            except Exception:
                pass
        users = await db.users.find(
            {**base_filter, "_id": {"$in": oids}},
            {"_id": 1, "name": 1, "email": 1, "role": 1},
        ).to_list(1000)

    ids = [str(u["_id"]) for u in users]
    name_by_id = {str(u["_id"]): (u.get("name") or u.get("email") or "?") for u in users}
    role_by_id = {str(u["_id"]): u.get("role") for u in users}
    docs = await db.weekly_planners.find(
        {"user_id": {"$in": ids}, "week_ending": week_ending},
        {"_id": 0, "user_id": 1, "days": 1, "updated_at": 1},
    ).to_list(1000)

    items = []
    for doc in docs:
        uid = doc.get("user_id")
        day = (doc.get("days") or {}).get(str(day_idx)) or {}
        if any((day.get(k) or "").strip() for k in DAY_FIELDS):
            items.append({
                "id": uid,
                "name": name_by_id.get(uid, "?"),
                "role": role_by_id.get(uid),
                "updated_at": doc.get("updated_at"),
            })
    # Most recently written first — reads like a live feed.
    items.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return {
        "date": today_local.isoformat(),
        "is_plannable_day": True,
        "day_index": day_idx,
        "week_ending": week_ending,
        "total_eligible": len(ids),
        "items": items,
    }


@router.get("/weekly-planners/office/weekly-review")
async def office_weekly_review(request: Request, week: Optional[str] = None, office: Optional[str] = None):
    """The Monday 9:00 meeting on one page, for a whole office.

    Closes LAST week and opens THIS one. `week` is the week being planned
    (Sunday week_ending, defaulting the same way the Team Planners roster
    does); everything retrospective — office totals, highrollers, each
    leader's crew result — is computed for the week before it, matching the
    planner's own review-week convention (see /weekly-planners/{week}/stats).

    Money is the rep's own commission for the week (bells_entries.earnings,
    recomputed here from the office's live commission_fees so it always
    matches the Bells screen), not billed revenue.

    Office-scoped: an admin sees their own office; a super admin may pass
    ?office=. Deliberately read-only — nothing here writes.
    """
    from routes.bells import compute_totals, _is_in_day
    from core.office_helpers import resolve_office_id

    me = await get_current_user(request)
    if me.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    office_id = await resolve_office_id(request, me, office)

    if week:
        week_ending = _coerce_to_sunday(week)
        if not week_ending:
            raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")
    else:
        # Default: the week currently being planned — on Monday morning that
        # is this week, so the review below lands on the week just finished.
        today = date.today()
        offset = (6 - today.weekday()) % 7
        week_ending = (today + timedelta(days=offset if offset else 7)).isoformat()
    review_week = (date.fromisoformat(week_ending) - timedelta(days=7)).isoformat()

    office_doc = await db.offices.find_one({"id": office_id}, {"_id": 0, "name": 1}) or {}

    # ── One pass over the office roster; the reporting tree is walked in
    # memory afterwards so we don't fire get_subtree_ids() per leader.
    users = await db.users.find(
        {"office_id": office_id, "role": {"$in": ["trainee", "leader", "admin"]},
         "is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}},
        {"_id": 1, "name": 1, "email": 1, "role": 1, "reports_to": 1},
    ).to_list(1000)
    name_by_id = {str(u["_id"]): (u.get("name") or u.get("email") or "?") for u in users}
    role_by_id = {str(u["_id"]): (u.get("role") or "") for u in users}
    upline_by_id = {str(u["_id"]): str(u.get("reports_to") or "") for u in users}
    children: dict = {}
    for u in users:
        rt = str(u.get("reports_to") or "")
        if rt:
            children.setdefault(rt, []).append(str(u["_id"]))

    def _subtree(root: str) -> list:
        """Root + every descendant, cycle-safe (legacy rows can loop)."""
        seen = {root}
        ordered = [root]
        frontier = [root]
        while frontier:
            nxt = []
            for parent in frontier:
                for child in children.get(parent, []):
                    if child in seen:
                        continue
                    seen.add(child)
                    ordered.append(child)
                    nxt.append(child)
            frontier = nxt
        return ordered

    fees = await db.commission_fees.find_one({"office_id": office_id}, {"_id": 0})
    if not fees:
        fees = await db.commission_fees.find_one({}, {"_id": 0})

    last_rows = await db.bells_entries.find(
        {"office_id": office_id, "week_ending": review_week}, {"_id": 0},
    ).to_list(1000)
    plan_rows = await db.bells_entries.find(
        {"office_id": office_id, "week_ending": week_ending},
        {"_id": 0, "user_id": 1, "weekly_goal": 1, "team_weekly_goal": 1},
    ).to_list(1000)
    goals_by_user = {r.get("user_id"): r for r in plan_rows if r.get("user_id")}
    # Crew goals as they stood for the week under review — what each leader
    # actually committed to back then, for the retrospective blocks.
    review_team_goals = {
        r.get("user_id"): r.get("team_weekly_goal")
        for r in last_rows if r.get("user_id")
    }

    # Per-person result for the week under review. Totals are recomputed
    # rather than read off the row so a mid-week fees change can't leave the
    # summary disagreeing with Bells.
    perf: dict = {}
    for r in last_rows:
        uid = r.get("user_id")
        if not uid:
            continue
        t = compute_totals(r, fees)
        days = r.get("days") or []
        in_days = [d for d in days if isinstance(d, dict) and _is_in_day(d)]
        perf[uid] = {
            "name": name_by_id.get(uid) or r.get("user_name") or "?",
            "role": role_by_id.get(uid) or r.get("role") or "",
            "sales": int(t.get("total_sales") or 0),
            "over30": int(t.get("total_over30") or 0),
            "under30": int(t.get("total_under30") or 0),
            "memberships": int(t.get("total_memberships") or 0),
            "earnings": float(t.get("earnings") or 0.0),
            "days_worked": int(t.get("days_worked") or 0),
            "piece_avg": t.get("piece_average"),
            "scoring_pct": t.get("scoring_pct"),
            "avg_per_day": t.get("average_earnings_per_day"),
            "goal": r.get("weekly_goal"),
            "in_days": len(in_days),
            "scored_days": sum(
                1 for d in in_days
                if (float(d.get("over30") or 0) + float(d.get("under30") or 0)) > 0
            ),
        }

    def _roll(uids) -> dict:
        """Aggregate a set of people's review-week results."""
        sales = over30 = memberships = 0
        earnings = 0.0
        in_days = scored_days = 0
        goal = 0
        has_goal = False
        worked = zero = 0
        for uid in uids:
            p = perf.get(uid)
            if not p:
                continue
            sales += p["sales"]
            over30 += p["over30"]
            memberships += p["memberships"]
            earnings += p["earnings"]
            in_days += p["in_days"]
            scored_days += p["scored_days"]
            if p["goal"] is not None:
                goal += int(p["goal"] or 0)
                has_goal = True
            if p["days_worked"] > 0:
                worked += 1
                if p["sales"] == 0:
                    zero += 1
        return {
            "sales": sales, "over30": over30, "memberships": memberships,
            "earnings": round(earnings, 2),
            "ba_days": in_days,
            "piece_avg": round(sales / in_days, 2) if in_days else None,
            "scoring_pct": round(100 * scored_days / in_days) if in_days else None,
            "goal": goal if has_goal else None,
            "goal_pct": round(100 * sales / goal) if has_goal and goal else None,
            "gold_pct": round(100 * over30 / sales) if sales else None,
            "reps_worked": worked,
            "reps_zero": zero,
        }

    # Office headline — every bells row in the office, including anyone since
    # deactivated. They still made the money; leaving them out would make the
    # office total disagree with the Bells sheet for that week.
    totals = _roll(list(perf.keys()))
    totals["reps"] = len(perf)

    # Two different goals, and they are not the same question:
    #   `goal`   — bottom-up, the sum of every individual weekly_goal. Nobody
    #              sets it; it just falls out. Anyone without a goal of their
    #              own contributes 0 to it while still contributing sales.
    #   `target` — top-down, what the office actually committed to. Either an
    #              explicit office target or the crew goal(s) sitting at the top
    #              of the tree (rows whose upline is outside this office).
    # The meeting wants the target as the headline and the sum beside it, so
    # a gap between the two is visible rather than silently averaged away.
    target = None
    target_source = None
    explicit = office_doc.get("weekly_goal")
    try:
        if explicit not in (None, "") and int(explicit) > 0:
            target, target_source = int(explicit), "office"
    except (TypeError, ValueError):
        target = None
    if target is None:
        root_goals = []
        for uid in name_by_id:
            if (upline_by_id.get(uid) or "") in name_by_id:
                continue  # reports to someone inside the office — not a root
            tg = review_team_goals.get(uid)
            if tg is not None:
                try:
                    root_goals.append(int(tg))
                except (TypeError, ValueError):
                    pass
        if root_goals:
            target, target_source = sum(root_goals), "crew"
    totals["target"] = target
    totals["target_pct"] = round(100 * totals["sales"] / target) if target else None
    totals["target_source"] = target_source

    # ── Top 5 highrollers by money made ───────────────────────────────────
    ranked = sorted(
        (dict(p, user_id=uid) for uid, p in perf.items() if p["earnings"] > 0),
        key=lambda p: (-p["earnings"], -p["sales"], (p["name"] or "").lower()),
    )
    highrollers = []
    for i, p in enumerate(ranked[:5]):
        up = upline_by_id.get(p["user_id"]) or ""
        highrollers.append({
            "rank": i + 1,
            "user_id": p["user_id"],
            "name": p["name"],
            "role": p["role"],
            "leader_name": name_by_id.get(up) or "",
            "earnings": round(p["earnings"], 2),
            "sales": p["sales"],
            "over30": p["over30"],
            "memberships": p["memberships"],
            "days_worked": p["days_worked"],
            "piece_avg": p["piece_avg"],
            "avg_per_day": p["avg_per_day"],
            "goal": p["goal"],
        })

    # ── Per-leader cards: this week's plan + last week's crew result ──────
    leader_ids = [str(u["_id"]) for u in users if (u.get("role") or "") in ("leader", "admin")]
    planners = await db.weekly_planners.find(
        {"user_id": {"$in": leader_ids}, "week_ending": week_ending}, {"_id": 0},
    ).to_list(500)
    planner_by_user = {d.get("user_id"): d for d in planners}

    def _int_or_none(v):
        m = re.search(r"-?\d+", str(v or ""))
        return int(m.group()) if m else None

    leaders = []
    wins: list = []
    learnings: list = []
    focuses: list = []
    developing: list = []
    themes: list = []
    step_totals = {s: [0, 0] for s in EIGHT_STEPS}  # step → [sum, raters]
    recruit_roll = {"booked_in": 0, "attended": 0, "newstarts": 0}

    for uid in leader_ids:
        doc = planner_by_user.get(uid)
        goal_row = goals_by_user.get(uid) or {}
        steps_done = _plan_steps_done(doc, goal_row)
        r = _normalize_review((doc or {}).get("review"))
        who = name_by_id.get(uid, "?")

        crew = _subtree(uid)
        crew_result = _roll(crew)
        crew_perf = sorted(
            (dict(perf[c], user_id=c) for c in crew if c in perf and perf[c]["earnings"] > 0),
            key=lambda p: -p["earnings"],
        )

        scores = r["eight_steps"]["scores"]
        rated = {s: v for s, v in scores.items() if v > 0}
        for s, v in rated.items():
            step_totals[s][0] += v
            step_totals[s][1] += 1
        lowest = [
            {"step": s, "score": v}
            for s, v in sorted(rated.items(), key=lambda kv: (kv[1], kv[0]))[:2]
        ]

        for k in recruit_roll:
            n = _int_or_none(r["recruitment"].get(k))
            if n is not None:
                recruit_roll[k] += n

        # Pooled meeting lists — attributed so you know whose win it is.
        for w in r["wins"]:
            wins.append({"user_id": uid, "name": who, "text": w})
        for l in r["learnings"]:
            learnings.append({"user_id": uid, "name": who, "text": l})
        for f in r["focus_next_week"]:
            focuses.append({"user_id": uid, "name": who, "text": f})
        for d in r["developing"]:
            if d.get("who") or d.get("what"):
                developing.append({"user_id": uid, "name": who, "who": d.get("who", ""), "what": d.get("what", "")})
        if r["theme"] or r["concentration"]:
            themes.append({"user_id": uid, "name": who, "theme": r["theme"], "concentration": r["concentration"]})

        leaders.append({
            "user_id": uid,
            "name": who,
            "role": role_by_id.get(uid, ""),
            "crew_size": max(0, len(crew) - 1),
            "plan": {
                "submitted": steps_done >= PLAN_FILLED_AT,
                "started": bool(doc) or steps_done > 0,
                "steps_done": steps_done,
                "steps_total": PLAN_STEPS_TOTAL,
                "updated_at": (doc or {}).get("updated_at"),
                "theme": r["theme"],
                "concentration": r["concentration"],
                "goals": {
                    "personal": goal_row.get("weekly_goal"),
                    "team": goal_row.get("team_weekly_goal"),
                },
                "next_goals": r["next_goals"],
                "wins": r["wins"],
                "learnings": r["learnings"],
                "focus_next_week": r["focus_next_week"],
                "focus_mid": r["focus_mid"],
                "focus_long": r["focus_long"],
                "team_management": r["team_management"],
                "eight_steps": {"scores": scores, "focus": r["eight_steps"]["focus"], "lowest": lowest},
                "developing": r["developing"],
                "recruitment": r["recruitment"],
                "headcount": r["headcount"],
                "owners_profit": r["owners_profit"],
                "personal_development": r["personal_development"],
            },
            "last_week": {
                **crew_result,
                "own": ({k: perf[uid][k] for k in ("sales", "earnings", "piece_avg", "scoring_pct", "days_worked", "goal")}
                        if uid in perf else None),
                "team_goal": review_team_goals.get(uid),
                "top": [
                    {"user_id": p["user_id"], "name": p["name"],
                     "earnings": round(p["earnings"], 2), "sales": p["sales"]}
                    for p in crew_perf[:3]
                ],
            },
        })

    # Leaders first, then the biggest crew result — the meeting works down
    # from the teams that carried the week.
    leaders.sort(key=lambda x: (
        0 if x["role"] == "leader" else 1,
        -(x["last_week"]["earnings"] or 0),
        (x["name"] or "").lower(),
    ))

    eight_steps_office = sorted(
        [
            {"step": s, "avg": round(tot / n, 1), "raters": n}
            for s, (tot, n) in step_totals.items() if n
        ],
        key=lambda x: x["avg"],
    )

    submitted = sum(1 for l in leaders if l["plan"]["submitted"])
    return {
        "week_ending": week_ending,
        "review_week_ending": review_week,
        "office": {"id": office_id, "name": office_doc.get("name") or ""},
        "totals": totals,
        "highrollers": highrollers,
        "leaders": leaders,
        "wins": wins[:60],
        "learnings": learnings[:60],
        "focuses": focuses[:60],
        "developing": developing[:60],
        "themes": themes,
        "eight_steps_office": eight_steps_office,
        "recruitment": recruit_roll,
        "plans_submitted": submitted,
        "plans_total": len(leaders),
        "missing_plans": [
            {"user_id": l["user_id"], "name": l["name"],
             "steps_done": l["plan"]["steps_done"], "steps_total": PLAN_STEPS_TOTAL}
            for l in leaders if not l["plan"]["submitted"]
        ],
    }


@router.get("/weekly-planners/office/goal-audit")
async def office_goal_audit(
    request: Request,
    user_id: Optional[str] = None,
    week: Optional[str] = None,
    limit: int = 100,
):
    """Who changed a sales goal, when, from what to what, and via which
    screen. Exists because `updated_at` on a bells row cannot answer that —
    a sheet save bumps it whether or not a goal moved. Admin-only, scoped to
    the caller's office. Newest first."""
    me = await get_current_user(request)
    if me.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    q: dict = {}
    if user_id:
        q["user_id"] = str(user_id)
    if week:
        wk = _coerce_to_sunday(week)
        if not wk:
            raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")
        q["week_ending"] = wk
    if not me.get("is_super_admin"):
        # Office-scope by whose goal it was, since the trail itself is global.
        oids = []
        for u in await db.users.find(
            {"office_id": me.get("office_id") or ""}, {"_id": 1},
        ).to_list(1000):
            oids.append(str(u["_id"]))
        q["user_id"] = {"$in": oids} if "user_id" not in q else q["user_id"]

    rows = await db.goal_audit.find(q, {"_id": 0}).sort("at", -1).to_list(max(1, min(limit, 500)))
    names = {}
    for r in rows:
        names[r.get("user_id")] = None
    oid_list = []
    for uid in list(names):
        try:
            oid_list.append(ObjectId(uid))
        except Exception:
            pass
    for u in await db.users.find({"_id": {"$in": oid_list}}, {"name": 1, "email": 1}).to_list(500):
        names[str(u["_id"])] = u.get("name") or u.get("email")
    for r in rows:
        r["user_name"] = names.get(r.get("user_id")) or "?"
    return {"count": len(rows), "items": rows}


@router.get("/weekly-planners/search")
async def search_weekly_planners(request: Request, q: str = "", user_id: Optional[str] = None):
    """iCloud-Notes-style search across every week of a user's planner —
    day boxes, extra notes, and the written review fields. Returns matches
    newest-week first with a snippet + where to jump to."""
    me, target = await _resolve_target_user(request, user_id)
    _require_planner_access(me)
    term = (q or "").strip()
    if len(term) < 2:
        return {"query": term, "results": []}
    rx = re.compile(re.escape(term), re.IGNORECASE)

    def _snippet(text: str) -> str:
        m = rx.search(text)
        if not m:
            return text[:90]
        start = max(0, m.start() - 40)
        end = min(len(text), m.end() + 50)
        return ("…" if start > 0 else "") + text[start:end].replace("\n", " ") + ("…" if end < len(text) else "")

    results = []
    cursor = db.weekly_planners.find({"user_id": target["id"]}, {"_id": 0}).sort("week_ending", -1)
    async for doc in cursor:
        week_ending = doc.get("week_ending") or ""
        # Day boxes
        for d in DAYS:
            day = (doc.get("days") or {}).get(str(d)) or {}
            for k in DAY_FIELDS:
                text = (day.get(k) or "")
                if text and rx.search(text):
                    results.append({
                        "week_ending": week_ending, "where": "day", "day": d,
                        "label": f"{DAY_NAMES[d]} · {DAY_FIELD_LABELS.get(k, k)}",
                        "snippet": _snippet(text),
                    })
        # Extra notes
        notes = doc.get("notes") or ""
        if notes and rx.search(notes):
            results.append({"week_ending": week_ending, "where": "notes", "day": None,
                            "label": "Extra Notes", "snippet": _snippet(notes)})
        # Review free-text (wins, learnings, focus, theme…)
        review = doc.get("review") or {}

        def _walk(v, path: str):
            if isinstance(v, str):
                if v and rx.search(v):
                    results.append({"week_ending": week_ending, "where": "week", "day": None,
                                    "label": "Week plan", "snippet": _snippet(v)})
            elif isinstance(v, list):
                for x in v:
                    _walk(x, path)
            elif isinstance(v, dict):
                for x in v.values():
                    _walk(x, path)

        _walk(review, "review")
        if len(results) >= 60:
            break
    return {"query": term, "results": results[:60]}


@router.post("/weekly-planners/scan-notes")
async def scan_notes_image(request: Request, file: UploadFile = File(...)):
    """OCR a photo of handwritten notes into plain text (Gemini Vision —
    same key/path as the agenda scan). The image itself is NEVER stored;
    only the transcribed text goes into the planner, so DB space stays flat."""
    me = await get_current_user(request)
    _require_planner_access(me)
    take_ai_quota(me)  # per-person hourly AI cap (core/rate_limit.py)
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 12MB)")

    # Downscale + recompress (same rationale as /agenda/scan: keep well
    # under the ~60s deployed ingress timeout).
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(raw))
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        max_side = 1200
        w, h = img.size
        scale = min(1.0, max_side / max(w, h))
        if scale < 1.0:
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=75, optimize=True)
        raw = buf.getvalue()
    except Exception as ex:
        print(f"[weekly-planner/scan-notes] image preprocess skipped: {ex}")

    b64 = base64.b64encode(raw).decode("ascii")
    from core.llm_keys import anthropic_api_key
    api_key = anthropic_api_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="LLM key not configured")

    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"LLM library missing: {ex}")

    import asyncio
    import time as _time

    def _make_chat():
        return LlmChat(
            api_key=api_key,
            session_id=f"wp-scan-{uuid.uuid4().hex[:10]}",
            system_message=(
                "You are an expert OCR transcriber. Transcribe ALL handwritten and "
                "printed text in the photo into clean plain text. Preserve bullet "
                "points and line breaks. Return ONLY the transcription — no "
                "commentary, no code fences."
            ),
        ).with_model("vision")

    msg = UserMessage(text="Transcribe this photo of notes.", file_contents=[ImageContent(image_base64=b64)])
    # The Gemini preview endpoint throws occasional transient errors (429/5xx,
    # dropped connections) that succeed on an immediate retry — absorb ONE of
    # those quietly instead of surfacing "Scan failed" to the user. Only fast
    # failures are retried: a slow first attempt + retry would blow past the
    # ~60s deployed ingress timeout, so those still surface immediately.
    start = _time.monotonic()
    response = None
    last_err: Exception | None = None
    for attempt in range(2):
        try:
            response = await asyncio.wait_for(_make_chat().send_message(msg), timeout=45)
            break
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="Vision model timed out. Try a smaller/clearer photo.")
        except Exception as ex:
            last_err = ex
            if attempt == 0 and (_time.monotonic() - start) < 12:
                print(f"[weekly-planner/scan-notes] transient LLM error, retrying: {ex}")
                await asyncio.sleep(1.2)
                continue
            break
    if response is None:
        raise HTTPException(status_code=502, detail=f"Vision model call failed: {last_err}")

    text = (response if isinstance(response, str) else str(response)).strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-z]*\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    return {"text": text[:8000]}


@router.put("/weekly-planners/crew/{member_id}")
async def set_crew_member_plan(member_id: str, request: Request):
    """Leader sets a crew member's week: Mon–Sat schedule statuses and/or
    weekly goal. Written straight onto the member's bells row so Bells and
    the planner stay one source of truth. Day NUMBERS are never touched —
    only `status` per day and `weekly_goal`."""
    me = await get_current_user(request)
    _require_planner_role(me)
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    week_ending = _coerce_to_sunday((body.get("week_ending") or "").strip())
    if not week_ending:
        raise HTTPException(status_code=400, detail="week_ending must be a valid YYYY-MM-DD date")

    try:
        target = await db.users.find_one({"_id": ObjectId(member_id)})
    except Exception:
        target = None
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    target_id = str(target["_id"])

    allowed = bool(me.get("is_super_admin"))
    if not allowed and me.get("role") == "admin":
        allowed = (target.get("office_id") or "") == (me.get("office_id") or "")
    if not allowed:
        subtree = await get_subtree_ids(me["id"])
        allowed = target_id in subtree
    if not allowed:
        raise HTTPException(status_code=403, detail="You can only plan for people on your own team")

    # ── Roles & lock ─────────────────────────────────────────────────────
    # Admins/super-admins write directly (the office IS the approver).
    # Leaders: Ab days become an absence REQUEST (owner approves — see
    # routes/absences.py) and can be submitted at any time, even mid-week.
    # Everything a leader writes DIRECTLY (goal, clearing an approved Ab)
    # stays locked after MONDAY 10:30 AM (app time) of the planning week.
    is_admin = bool(me.get("is_super_admin") or me.get("role") == "admin")
    locked = (not is_admin) and datetime.now(APP_TZ) > _crew_lock_deadline(week_ending)

    from routes.bells import _normalize_days
    now_iso = datetime.now(timezone.utc).isoformat()

    # Look up by the full bells row key (office included) — the same key the
    # uniq_office_week_user index enforces — so this writer can never target
    # or create a row a different writer wouldn't find.
    crew_office_id = target.get("office_id") or me.get("office_id") or ""
    if not crew_office_id:
        raise HTTPException(status_code=400, detail="Office unknown for this member")
    existing = await db.bells_entries.find_one(
        {"office_id": crew_office_id, "user_id": target_id, "week_ending": week_ending}
    )
    days = _normalize_days((existing or {}).get("days"))
    # The planner may ONLY toggle absences. It never writes 'in' — a day
    # pre-marked In with no sales counts as a 0-scoring worked day and
    # poisons piece-average/scoring reporting. 'In' happens the way bells
    # already does it: automatically, when sales values are entered.
    #   • incoming 'ab'                → admin: mark absent · leader: request
    #   • incoming 'off' on an 'ab' day → clear the absence back to off
    #   • anything else                 → leave the bells cell untouched
    #     (protects in/rt/nc/pc statuses set on the Bells screen)
    statuses_in = body.get("day_statuses")
    requested_ab: list = []
    if isinstance(statuses_in, list):
        for i, s in enumerate(statuses_in[:6]):
            s = str(s or "").strip().lower()
            cur = days[i].get("status")
            if s == "ab":
                if is_admin:
                    days[i]["status"] = "ab"
                elif cur != "ab":
                    requested_ab.append(i)
            elif s == "off" and cur == "ab":
                if locked:
                    raise HTTPException(
                        status_code=403,
                        detail="Schedule locked (Mon 10:30) — ask your office admin to clear an approved absence.",
                    )
                days[i]["status"] = "off"

    update: dict = {"days": days, "updated_at": now_iso}
    if "weekly_goal" in body:
        g_raw = body.get("weekly_goal")
        try:
            new_goal = float(g_raw) if g_raw not in (None, "") else None
        except Exception:
            new_goal = None
        if locked:
            # After the lock a leader may still REQUEST absences, but the
            # goal is frozen — only reject if they actually tried to change it.
            if new_goal != (existing or {}).get("weekly_goal"):
                raise HTTPException(
                    status_code=403,
                    detail="Goals locked (Mon 10:30) — ask your office admin for adjustments.",
                )
        else:
            update["weekly_goal"] = new_goal

    if existing:
        await db.bells_entries.update_one({"id": existing["id"]}, {"$set": update})
        goal_out = update.get("weekly_goal", existing.get("weekly_goal"))
        if "weekly_goal" in update:
            await record_goal_change(
                db, user_id=target_id, week_ending=week_ending, field="weekly_goal",
                old=existing.get("weekly_goal"), new=update["weekly_goal"], actor=me,
                source="PUT /weekly-planners/crew/{member_id}",
            )
    else:
        goal_out = update.get("weekly_goal")
        try:
            await db.bells_entries.insert_one({
                "id": str(uuid.uuid4()),
                "office_id": crew_office_id,
                "user_id": target_id,
                "user_name": target.get("name") or target.get("email") or "",
                "role": target.get("role"),
                "stage": None,
                "break_even": None,
                "weekly_goal": goal_out,
                "last_week_total": None,
                "week_ending": week_ending,
                "days": days,
                "earnings": 0.0,
                "created_by_id": me["id"],
                "created_at": now_iso,
                "updated_at": now_iso,
            })
        except DuplicateKeyError:
            # Lost the create race (uniq_office_week_user) — replay this save
            # onto the winner's row. Rebuild days from the winner so a racing
            # writer's sales are never clobbered by our empty defaults; only
            # the absence toggles the first pass validated are re-applied
            # (lock/permission raises already happened above).
            existing = await db.bells_entries.find_one(
                {"office_id": crew_office_id, "user_id": target_id, "week_ending": week_ending}
            )
            if existing:
                days = _normalize_days(existing.get("days"))
                if isinstance(statuses_in, list):
                    for i, s in enumerate(statuses_in[:6]):
                        s = str(s or "").strip().lower()
                        if s == "ab" and is_admin:
                            days[i]["status"] = "ab"
                        elif s == "off" and days[i].get("status") == "ab" and not locked:
                            days[i]["status"] = "off"
                update["days"] = days
                await db.bells_entries.update_one({"id": existing["id"]}, {"$set": update})
                goal_out = update.get("weekly_goal", existing.get("weekly_goal"))
                if "weekly_goal" in update:
                    await record_goal_change(
                        db, user_id=target_id, week_ending=week_ending, field="weekly_goal",
                        old=existing.get("weekly_goal"), new=update["weekly_goal"], actor=me,
                        source="PUT /weekly-planners/crew/{member_id}",
                    )

    # ── Absence request bookkeeping ──────────────────────────────────────
    from routes.absences import submit_absence_request
    pending_request = None
    if not is_admin and isinstance(statuses_in, list):
        # requested_ab is the FULL desired pending set for this member+week:
        # deselecting a pending day drops it, empty set cancels the request.
        pending_request = await submit_absence_request(
            me, target, week_ending, requested_ab, body.get("absence_reason") or "")
    elif is_admin:
        # An admin marking Ab directly settles any pending request those
        # days were waiting on — no ghost approvals left behind.
        pending = await db.absence_requests.find_one(
            {"target_user_id": target_id, "week_ending": week_ending, "status": "pending"})
        if pending and all(days[i].get("status") == "ab" for i in (pending.get("day_indices") or []) if 0 <= i <= 5):
            await db.absence_requests.update_one({"id": pending["id"]}, {"$set": {
                "status": "approved",
                "decided_by_id": me["id"],
                "decided_by_name": me.get("name") or me.get("email") or "",
                "decided_at": now_iso,
                "decision_note": "Set directly on the sheet",
                "updated_at": now_iso,
            }})

    return {"ok": True, "user_id": target_id, "week_ending": week_ending,
            "weekly_goal": goal_out, "day_statuses": [d.get("status") for d in days[:6]],
            "pending_request": pending_request}


@router.put("/weekly-planners/my-goals")
async def set_my_planner_goals(request: Request):
    """Leader sets their own PERSONAL sales goal and/or TEAM sales goal for
    a week. Both live on the leader's own bells row (weekly_goal +
    team_weekly_goal) so Bells and the planner stay in sync — days are
    never touched."""
    me = await get_current_user(request)
    _require_planner_role(me)
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    week_ending = _coerce_to_sunday((body.get("week_ending") or "").strip())
    if not week_ending:
        raise HTTPException(status_code=400, detail="week_ending must be a valid YYYY-MM-DD date")

    def _num(v):
        try:
            return float(v) if v not in (None, "") else None
        except Exception:
            return None

    now_iso = datetime.now(timezone.utc).isoformat()
    update: dict = {"updated_at": now_iso}
    if "personal_goal" in body:
        update["weekly_goal"] = _num(body.get("personal_goal"))
    if "team_goal" in body:
        update["team_weekly_goal"] = _num(body.get("team_goal"))
    if len(update) == 1:
        raise HTTPException(status_code=400, detail="Nothing to update")

    # Full bells row key (office included) — matches uniq_office_week_user so
    # this writer always finds the same row every other writer does. This was
    # the endpoint that duplicated a rep's week: the planner autosaves the
    # personal and team goals as two near-simultaneous PUTs, and both passed
    # the find-then-insert check before either row landed.
    my_office_id = me.get("office_id") or ""
    if not my_office_id:
        raise HTTPException(status_code=400, detail="Office unknown")
    existing = await db.bells_entries.find_one(
        {"office_id": my_office_id, "user_id": me["id"], "week_ending": week_ending}
    )
    if existing:
        await db.bells_entries.update_one({"id": existing["id"]}, {"$set": update})
    else:
        from routes.bells import _normalize_days
        try:
            await db.bells_entries.insert_one({
                "id": str(uuid.uuid4()),
                "office_id": my_office_id,
                "user_id": me["id"],
                "user_name": me.get("name") or me.get("email") or "",
                "role": me.get("role"),
                "stage": None,
                "break_even": None,
                "weekly_goal": update.get("weekly_goal"),
                "team_weekly_goal": update.get("team_weekly_goal"),
                "last_week_total": None,
                "week_ending": week_ending,
                "days": _normalize_days([]),
                "earnings": 0.0,
                "created_by_id": me["id"],
                "created_at": now_iso,
                "updated_at": now_iso,
            })
        except DuplicateKeyError:
            # Lost the create race — set the goal(s) on the winner's row.
            # $set only touches the goal fields, never days.
            existing = await db.bells_entries.find_one(
                {"office_id": my_office_id, "user_id": me["id"], "week_ending": week_ending}
            )
            if existing:
                await db.bells_entries.update_one({"id": existing["id"]}, {"$set": update})
    for _f in ("weekly_goal", "team_weekly_goal"):
        if _f in update:
            await record_goal_change(
                db, user_id=me["id"], week_ending=week_ending, field=_f,
                old=(existing or {}).get(_f), new=update[_f], actor=me,
                source="PUT /weekly-planners/my-goals",
            )

    # An admin's crew IS the office, so the one number they type here is both
    # their crew goal and the office goal. Mirror it onto the office doc, which
    # is what the daily breakdown's progress line and the week-in-review's
    # top-down `target` read — otherwise the admin sets a goal on the planner
    # and those surfaces keep reporting against nothing, with no other screen
    # anywhere that writes it.
    office_goal_out = None
    office_id = me.get("office_id") or ""
    # …but only for an OFFICE-LEVEL admin. An admin who runs their own crew
    # inside the office (core/admin_scope.py) is setting one team's target
    # here, and it must stay on their own bells row.
    _is_office_admin = False
    if me.get("role") == "admin":
        from core.admin_scope import is_office_level_admin
        _is_office_admin = await is_office_level_admin(me)
    if "team_weekly_goal" in update and _is_office_admin and office_id:
        # The office field is a plain non-negative int; a cleared crew goal
        # means "no office goal", which both readers treat 0 as.
        raw = update["team_weekly_goal"]
        try:
            office_goal_out = max(0, int(raw)) if raw is not None else 0
        except (TypeError, ValueError):
            office_goal_out = 0
        office_doc = await db.offices.find_one({"id": office_id}, {"_id": 0, "weekly_goal": 1})
        await db.offices.update_one(
            {"id": office_id},
            {"$set": {"weekly_goal": office_goal_out, "weekly_goal_updated_at": now_iso}},
        )
        await record_goal_change(
            db, user_id=me["id"], week_ending=week_ending, field="office_weekly_goal",
            old=(office_doc or {}).get("weekly_goal"), new=office_goal_out, actor=me,
            source="PUT /weekly-planners/my-goals",
        )
        # …and onto the Weekly Plan's Sales Goal + any co-admin's crew row,
        # so every goal surface shows the same number (owner request, Sep 2026).
        from core.goal_sync import sync_office_weekly_goal
        await sync_office_weekly_goal(
            office_id, week_ending, update["team_weekly_goal"], me,
            "PUT /weekly-planners/my-goals",
            skip_office=True, skip_bells_user_id=me["id"],
        )

    saved = await db.bells_entries.find_one({"user_id": me["id"], "week_ending": week_ending}, {"_id": 0, "weekly_goal": 1, "team_weekly_goal": 1})
    return {"ok": True, "week_ending": week_ending,
            "personal_goal": (saved or {}).get("weekly_goal"),
            "team_goal": (saved or {}).get("team_weekly_goal"),
            "office_goal": office_goal_out}


@router.get("/weekly-planners/{week}")
async def get_weekly_planner(week: str, request: Request, user_id: Optional[str] = None):
    """Planner doc for a week (coerced to its Sunday). Owner gets a seed if
    none exists yet; other viewers get exists:false with no doc."""
    week_ending = _coerce_to_sunday(week)
    if not week_ending:
        raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")
    me, target = await _resolve_target_user(request, user_id)
    _require_planner_access(me)

    doc = await db.weekly_planners.find_one({"user_id": target["id"], "week_ending": week_ending}, {"_id": 0})
    is_owner = target["id"] == me["id"]
    # role rides along so the UI can word the plan for its OWNER (an admin's
    # goals box is "Office sales" — it drives the office goal — even when the
    # plan was opened through a ?user_id= link).
    if not doc:
        if not is_owner:
            return {"exists": False, "can_edit": False, "viewer_is_owner": False,
                    "target": {"id": target["id"], "name": target.get("name") or "", "team_name": target.get("team_name") or "",
                               "role": target.get("role") or ""},
                    "week_ending": week_ending, "planner": None}
        seed = _seed(me["id"], me.get("office_id") or "", week_ending)
        return {"exists": False, "can_edit": True, "viewer_is_owner": True,
                "target": {"id": me["id"], "name": me.get("name") or "", "team_name": me.get("team_name") or "",
                           "role": me.get("role") or ""},
                "week_ending": week_ending, "planner": seed}

    # Backfill shape for older docs
    doc["review"] = _normalize_review(doc.get("review"))
    doc["days"] = _normalize_days(doc.get("days"))
    doc["notes"] = _s(doc.get("notes"), 8000)
    return {"exists": True, "can_edit": is_owner, "viewer_is_owner": is_owner,
            "target": {"id": target["id"], "name": target.get("name") or "", "team_name": target.get("team_name") or "",
                       "role": target.get("role") or ""},
            "week_ending": week_ending, "planner": doc}


@router.put("/weekly-planners/{week}")
async def upsert_weekly_planner(week: str, request: Request):
    """Owner-only upsert (autosave). Weeks never lock — a leader can tidy up
    last week's report on Sunday night without restriction."""
    week_ending = _coerce_to_sunday(week)
    if not week_ending:
        raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")
    me = await get_current_user(request)
    _require_planner_access(me)

    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    days = _normalize_days(body.get("days"))
    notes = _s(body.get("notes"), 8000)
    # Trainees get the daily plan only — no week review, no crew (they don't
    # have one yet). Enforced server-side regardless of what a client sends,
    # so this can never be bypassed by a modified app. The moment someone is
    # promoted to leader, both simply become writable — no data migration,
    # since the doc shape never changed, only what a trainee was allowed to
    # fill in.
    if me.get("role") == "trainee":
        review = _empty_review()
        for d in DAYS:
            days[str(d)]["crew_plan"] = ""
    else:
        review = _normalize_review(body.get("review"))

    now = datetime.now(timezone.utc).isoformat()
    existing = await db.weekly_planners.find_one({"user_id": me["id"], "week_ending": week_ending}, {"_id": 0})
    if existing:
        update = {"review": review, "days": days, "notes": notes, "updated_at": now}
        await db.weekly_planners.update_one({"id": existing["id"]}, {"$set": update})
        existing.update(update)
        return _scrub(existing)

    doc = _seed(me["id"], me.get("office_id") or "", week_ending)
    doc.update({"review": review, "days": days, "notes": notes})
    await db.weekly_planners.insert_one(doc.copy())
    return _scrub(doc)


# ── Live stats from bells — auto-fills the report's numbers ────────────────
def _day_units(d: dict) -> float:
    return float(d.get("over30") or 0) + float(d.get("under30") or 0)


def _row_stats(row: dict) -> dict:
    days = row.get("days") or []
    worked = [d for d in days if isinstance(d, dict) and d.get("status") == "in"]
    total = sum(_day_units(d) for d in days if isinstance(d, dict))
    scored = sum(1 for d in worked if _day_units(d) > 0)
    n_worked = len(worked)
    return {
        "total": round(total, 1),
        "goal": row.get("weekly_goal"),
        "days_worked": n_worked,
        "days_scored": scored,
        "scoring_pct": round(100 * scored / n_worked) if n_worked else None,
        "piece_avg": round(total / n_worked, 2) if n_worked else None,
    }


@router.get("/weekly-planners/{week}/stats")
async def weekly_planner_stats(week: str, request: Request, user_id: Optional[str] = None):
    """Auto numbers for the planner's REVIEW section. The review looks back
    at the week just gone — so for a planner covering the week ending the
    19th, every stat here (bells totals, goals, piece average, scoring %,
    highrollers, quality) is computed for the week ending
    the 12th."""
    week_ending = _coerce_to_sunday(week)
    if not week_ending:
        raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")
    review_week = (date.fromisoformat(week_ending) - timedelta(days=7)).isoformat()
    me, target = await _resolve_target_user(request, user_id)
    _require_planner_role(me)

    subtree = await get_subtree_ids(target["id"])
    rows = await db.bells_entries.find(
        {"week_ending": review_week, "user_id": {"$in": subtree}},
        {"_id": 0, "user_id": 1, "days": 1, "weekly_goal": 1, "team_weekly_goal": 1},
    ).to_list(500)
    by_user = {r.get("user_id"): r for r in rows}

    # Names for everyone in the subtree (full roster, not just bells rows)
    oids = []
    for uid in subtree:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            pass
    users = await db.users.find(
        {"_id": {"$in": oids}, "deleted": {"$ne": True}}, {"name": 1, "email": 1, "role": 1, "new_hire_id": 1}
    ).to_list(500)
    names = {str(u["_id"]): (u.get("name") or u.get("email") or "?") for u in users}
    role_by_id = {str(u["_id"]): (u.get("role") or "") for u in users}
    hire_by_id = {str(u["_id"]): u.get("new_hire_id") for u in users}

    personal = _row_stats(by_user.get(target["id"]) or {})

    members = []
    team_total = 0.0
    team_worked = 0
    team_scored = 0
    for uid in subtree:
        row = by_user.get(uid)
        if not row:
            continue
        st = _row_stats(row)
        team_total += st["total"]
        team_worked += st["days_worked"]
        team_scored += st["days_scored"]
        members.append({"user_id": uid, "name": names.get(uid, "?"), **st})
    members.sort(key=lambda m: -m["total"])

    # Quality KPIs from the Bells sheet — team (whole subtree) and personal
    quality = await _quality_kpis(review_week, list(by_user.values()))
    own_review_row = by_user.get(target["id"])
    personal_quality = await _quality_kpis(
        review_week,
        [own_review_row] if own_review_row else [],
    )

    # Headcount / COD breakdown (excludes the leader themself):
    #   COD1 = trainee still inside their first 8 days
    #   COD2 = trainee with all 8 day-assessments completed
    #   COD3 = leader · COD3+ = leader with a leader on their team
    cod1 = cod2 = cod3 = cod3p = 0
    for uid in subtree:
        if uid == target["id"] or uid not in role_by_id:
            continue
        role = role_by_id[uid]
        if role == "trainee":
            done = 0
            hid = hire_by_id.get(uid)
            if hid:
                done = await db.daily_assessments.count_documents(
                    {"new_hire_id": hid, "day_number": {"$lte": 8}, "completed": True}
                )
            if done >= 8:
                cod2 += 1
            else:
                cod1 += 1
        elif role in ("leader", "admin"):
            sub = await get_subtree_ids(uid)
            if any(sid != uid and role_by_id.get(sid) == "leader" for sid in sub):
                cod3p += 1
            else:
                cod3 += 1
    headcount = {"total": cod1 + cod2 + cod3 + cod3p, "cod1": cod1, "cod2": cod2, "cod3": cod3, "cod3p": cod3p}

    # Crew roster for the PLANNING week — every subtree user, stitched with
    # last week's result and this week's goal + Mon–Sat schedule statuses
    # (from their bells row). This powers the tappable crew list where the
    # leader sets each person's schedule and goal.
    plan_rows = await db.bells_entries.find(
        {"week_ending": week_ending, "user_id": {"$in": subtree}},
        {"_id": 0, "user_id": 1, "days": 1, "weekly_goal": 1, "team_weekly_goal": 1},
    ).to_list(500)
    plan_by_user = {r.get("user_id"): r for r in plan_rows}

    # Absence requests for the planning week — pending ones drive the
    # "requested · awaiting approval" state; the latest decided one lets the
    # leader see a fresh approval/denial without leaving the planner.
    ab_reqs = await db.absence_requests.find(
        {"week_ending": week_ending, "target_user_id": {"$in": subtree}},
        {"_id": 0},
    ).sort("updated_at", -1).to_list(300)
    pending_req_by_user: dict = {}
    decided_req_by_user: dict = {}
    for rq in ab_reqs:
        uid_r = rq.get("target_user_id")
        if rq.get("status") == "pending" and uid_r not in pending_req_by_user:
            pending_req_by_user[uid_r] = rq
        elif rq.get("status") in ("approved", "denied") and uid_r not in decided_req_by_user:
            decided_req_by_user[uid_r] = rq

    crew = []
    for uid in subtree:
        if uid not in names:
            continue
        last_row = by_user.get(uid)
        prow = plan_by_user.get(uid)
        pdays = (prow or {}).get("days") or []
        statuses = []
        for i in range(6):
            d = pdays[i] if i < len(pdays) and isinstance(pdays[i], dict) else {}
            s = str(d.get("status") or "off").lower()
            statuses.append(s if s in ("in", "off", "rt", "nc", "ab", "pc") else "off")
        preq = pending_req_by_user.get(uid)
        dreq = decided_req_by_user.get(uid)
        crew.append({
            "user_id": uid,
            "name": names[uid],
            "last": ({"goal": last_row.get("weekly_goal"), "total": _row_stats(last_row)["total"]} if last_row else None),
            "goal": (prow or {}).get("weekly_goal"),
            "day_statuses": statuses,
            "pending_request": ({"id": preq["id"], "day_indices": preq.get("day_indices") or [],
                                 "reason": preq.get("reason") or "", "created_at": preq.get("created_at")}
                                if preq else None),
            "last_decision": ({"status": dreq.get("status"), "day_indices": dreq.get("day_indices") or [],
                               "decided_at": dreq.get("decided_at"), "decision_note": dreq.get("decision_note") or "",
                               "decided_by_name": dreq.get("decided_by_name") or ""}
                              if dreq else None),
        })

    # This week's sales goals — sourced from the leader's own bells row
    own_plan_row = plan_by_user.get(target["id"]) or {}

    # Crew-section lock state (Monday 10:30 AM app time of the planning week)
    lock_deadline = _crew_lock_deadline(week_ending)
    crew_locked = datetime.now(APP_TZ) > lock_deadline

    return {
        "week_ending": week_ending,
        "review_week_ending": review_week,
        "crew_locked": crew_locked,
        "crew_lock_deadline": lock_deadline.isoformat(),
        "personal": personal,
        "team": {
            "total": round(team_total, 1),
            "ba_days": team_worked,
            "piece_avg": round(team_total / team_worked, 2) if team_worked else None,
            "scoring_pct": round(100 * team_scored / team_worked) if team_worked else None,
            # The crew goal being reviewed is the one the leader COMMITTED to
            # for that week (team_weekly_goal on their own bells row), not the
            # accumulation of everyone's personal goals — a crew can sum to 8
            # while the leader's actual call was 30, and the review has to
            # grade the call. Unset means unset; no fallback to the sum.
            "goal": (by_user.get(target["id"]) or {}).get("team_weekly_goal"),
            "members": members,
            "highrollers": [{"name": m["name"], "total": m["total"]} for m in members[:3] if m["total"] > 0],
        },
        "crew": crew,
        "quality": quality,
        "personal_quality": personal_quality,
        "headcount": headcount,
        "goals": {"personal": own_plan_row.get("weekly_goal"), "team": own_plan_row.get("team_weekly_goal")},
    }


# ── Team quality KPIs ──────────────────────────────────────────────────────
# Gold rate + membership rate for the week just gone, from the Bells sheet
# (over-30 units = gold, memberships column). Fails and 2nd/4th-delivery
# retention needed a client delivery feed, which this build doesn't have —
# they stay None so the planner shows them as "—".
def _pct(n: float, d: float):
    return round(100 * n / d) if d else None


async def _quality_kpis(week_ending: str, bells_rows: list) -> dict:
    out: dict = {
        "source": None, "gold_pct": None, "mem_pct": None, "fails_pct": None,
        "second_delivery": None, "fourth_delivery": None,
    }
    over = under = mems = 0.0
    for row in bells_rows:
        for d in (row.get("days") or []):
            if not isinstance(d, dict):
                continue
            over += float(d.get("over30") or 0)
            under += float(d.get("under30") or 0)
            mems += float(d.get("memberships") or 0)
    units = over + under
    if units:
        out["source"] = "bells"
        out["gold_pct"] = _pct(over, units)
        out["mem_pct"] = _pct(mems, units)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Morning "Bells read-out" — admins only, scoped to the admin's own office.
#
# Every morning meeting opens by reading out yesterday's performers:
#   • trainees with 2+ sales, leaders/admins with 3+ — read ascending
#     (the 2s first, then 3s, then 4s…).
#   • Monday reads Saturday (no Sunday bells) — but ANY Sunday sale, even one,
#     is read out on Monday too.
#   • Thursday adds the halfway-week review: the office's top-5 high rollers
#     from Mon–Wed of the current week.
#
# Computed live from bells_entries on every call — an edit to bells shows up
# on the next planner load, nothing is snapshotted.
# ─────────────────────────────────────────────────────────────────────────────

def _readout_day_sales(day) -> int:
    """Sales for one bells day: over30 + under30. NEVER memberships.

    A membership is an add-on to a sale, not a sale — the same rule the
    sales-path engine states at core/sales_path.py ("Sales = over30 + under30
    only; memberships are add-ons, never sales") and the same arithmetic
    _day_sales does 300 lines above in this very file.

    This function added memberships from the day the read-out shipped
    (e526c92f, 2026-08-25) until 2026-09-14. It inflated every rep by their
    membership count, and because the qualifying threshold is applied to THIS
    number it also changed who appeared: on one Saturday an office's
    read-out named four people when only one had cleared the bar, and three
    reps sitting on 2 real sales were read out as having hit 3 or 4.
    """
    if not isinstance(day, dict):
        return 0
    return int(day.get("over30") or 0) + int(day.get("under30") or 0)


def _readout_threshold(role: str) -> int:
    return 2 if (role or "").lower() == "trainee" else 3


async def _bells_rows(office_id: str, week_ending: str) -> list:
    return await db.bells_entries.find(
        {"office_id": office_id, "week_ending": week_ending},
        {"_id": 0, "user_name": 1, "role": 1, "days": 1},
    ).to_list(500)


# Two-segment path on purpose: GET /weekly-planners/{week} is registered
# above and would swallow a literal single-segment sibling.
@router.get("/weekly-planners/bells-readout/{week}")
async def bells_readout(request: Request, week: str, day: int):
    """The auto-generated morning read-out for planner day `day` (0=Mon…5=Sat)
    of the week ending `week` (a Sunday)."""
    user = await get_current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    office_id = user.get("office_id")
    if not office_id:
        raise HTTPException(status_code=403, detail="Your account is not assigned to an office")
    week_ending = _coerce_to_sunday(week)
    if not week_ending:
        raise HTTPException(status_code=400, detail="week must be a valid YYYY-MM-DD date")
    if not 0 <= int(day) <= 5:
        raise HTTPException(status_code=400, detail="day must be 0 (Mon) … 5 (Sat)")
    day = int(day)
    sunday = date.fromisoformat(week_ending)

    # Which bells day (and which week's sheet) this morning reads from.
    if day == 0:
        src_week = (sunday - timedelta(days=7)).isoformat()
        src_idx = 5                                   # Saturday of last week
        src_date = (sunday - timedelta(days=8)).isoformat()
    else:
        src_week = week_ending
        src_idx = day - 1
        src_date = (sunday - timedelta(days=7 - day)).isoformat()

    rows = await _bells_rows(office_id, src_week)

    readout = []
    for r in rows:
        days = r.get("days") or []
        sales = _readout_day_sales(days[src_idx]) if len(days) > src_idx else 0
        if sales >= _readout_threshold(r.get("role")):
            readout.append({"name": r.get("user_name") or "?", "role": r.get("role"), "sales": sales})
    readout.sort(key=lambda x: (x["sales"], x["name"]))  # 2s first, then 3s, 4s…

    out = {"day": day, "source_date": src_date, "readout": readout}

    # Monday: any Sunday sale (even one) rides along.
    if day == 0:
        sunday_hits = []
        for r in rows:
            days = r.get("days") or []
            sales = _readout_day_sales(days[6]) if len(days) > 6 else 0
            if sales >= 1:
                sunday_hits.append({"name": r.get("user_name") or "?", "role": r.get("role"), "sales": sales})
        sunday_hits.sort(key=lambda x: (x["sales"], x["name"]))
        out["sunday"] = sunday_hits
        out["sunday_date"] = (sunday - timedelta(days=7)).isoformat()

    # Thursday: halfway-week review — top 5 high rollers Mon–Wed of THIS week.
    if day == 3:
        week_rows = rows if src_week == week_ending else await _bells_rows(office_id, week_ending)
        totals = []
        for r in week_rows:
            days = r.get("days") or []
            t = sum(_readout_day_sales(days[i]) for i in range(min(3, len(days))))
            if t > 0:
                totals.append({"name": r.get("user_name") or "?", "role": r.get("role"), "sales": t})
        totals.sort(key=lambda x: (-x["sales"], x["name"]))
        out["top5"] = totals[:5]

    return out
