"""Leader "Today" — the grading queue + weekly-focus data for the Home screen.

One cheap endpoint (Mongo only, no external calls) that answers the
questions a leader opens the app with:

    • Who is waiting on me for a grade right now?  (grading queue)
    • Have I started my Monthly Goal Planner?      (planner status)
    • How is today going?                          (counts)

GET /api/leader/today →
    {
      "grading": [
        { hire_id, trainee_user_id, name, current_day, current_status,
          assessment_id, day_number, days_pending }
      ],
      "new_starts": [
        { hire_id, trainee_user_id, name, current_day, days_done,
          next_assessment_id, next_day, cod1: {done, total}, cod2: {done, total} }
      ],
      "planner": { month, exists, locked },
      "counts": { active, awaiting, graded_today }
    }

Scoping mirrors /dashboard/stats: leaders see their subtree, admins their
office, super-admins everything. `grading` lists active hires that have at
least one incomplete assessment at or before their current day, with the
EARLIEST pending day surfaced (that's the one to grade next) and
`days_pending` so the UI can flag people falling behind.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request

from auth import require_admin, require_admin_or_leader, require_super_admin, get_subtree_ids
from core.assessment_reminders import MIN_GAP_HOURS
from core.push import send_push_to_user
from database import db
from core.app_time import APP_TZ
from core.trainee_records import coach_hire_filter

router = APIRouter()

# A genuine accountless hire is a brand-new starter who hasn't registered yet
# (Day 1-2). One still ungraded and account-less this long after starting never
# registered / has left — treat as a stale ghost, not a person to grade.
ACCOUNTLESS_MAX_AGE_DAYS = 21


def _parse_date(val) -> "date | None":
    try:
        return datetime.strptime(str(val)[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


async def _exclude_inactive_hires(user: dict, hires: list[dict]) -> list[dict]:
    """Drop hires whose linked user is no longer a live trainee.

    A "live trainee" is one whose account is not deleted, not deactivated
    (is_active != False — the codebase's "no longer works here" marker), and
    still has role 'trainee'. Three ways a stale hire leaks into the grading
    queue:
      • Deleted user (users.deleted=True) whose new_hire stayed active.
      • Deactivated user (users.is_active=False) — someone who left; their
        new_hire is often left active.
      • Promoted user (role changed to leader/admin) — grading is a trainee
        concern, so they no longer belong here.

    Account-linked hires are checked precisely by their linked _id. Legacy
    rows with NO linked account fall back to a name / new_hire_id match
    against gone users (office-scoped), mirroring /new-hires."""
    if not hires:
        return hires

    # (a) Account-linked hires: ALLOWLIST — keep only if the linked account is
    #     a currently-live trainee. This drops deleted, deactivated, and
    #     promoted users, AND orphans whose user record was removed entirely
    #     (a dangling trainee_user_id no longer resolves to anyone live).
    linked_ids = [h["trainee_user_id"] for h in hires if h.get("trainee_user_id")]
    live_trainee_uids: set[str] = set()
    if linked_ids:
        oids = []
        for lid in linked_ids:
            try:
                oids.append(ObjectId(lid))
            except Exception:
                pass
        if oids:
            async for u in db.users.find(
                {"_id": {"$in": oids}, "role": "trainee",
                 "deleted": {"$ne": True}, "is_active": {"$ne": False}},
                {"_id": 1},
            ):
                live_trainee_uids.add(str(u["_id"]))

    # (b) Accountless legacy rows (no trainee_user_id): keep unless the name /
    #     new_hire_id matches a "gone" user (deleted or deactivated) in this
    #     admin's office. Genuine pre-account trainees (Day 1-2 before they
    #     make an account) have no match and are kept.
    gone_q: dict = {"$or": [{"deleted": True}, {"is_active": False}]}
    if not user.get("is_super_admin") and user.get("office_id"):
        gone_q = {"$and": [gone_q, {"office_id": user["office_id"]}]}
    gone_raw = await db.users.find(
        gone_q, {"name": 1, "new_hire_id": 1}
    ).to_list(2000)
    gone_names = {u["name"] for u in gone_raw if u.get("name")}
    gone_hire_ids = {u["new_hire_id"] for u in gone_raw if u.get("new_hire_id")}

    today = datetime.now(timezone.utc).date()
    kept = []
    for h in hires:
        tuid = h.get("trainee_user_id")
        if tuid:
            # Must be backed by a live trainee; otherwise it's stale/orphaned.
            if str(tuid) not in live_trainee_uids:
                continue
        else:
            # Accountless legacy row.
            if h.get("name") in gone_names or h.get("id") in gone_hire_ids:
                continue
            started = _parse_date(h.get("start_date"))
            if started and (today - started).days > ACCOUNTLESS_MAX_AGE_DAYS:
                continue  # stale accountless ghost (never registered / left)
        kept.append(h)
    return kept


def _office_filter(user: dict, office: str | None) -> str | None:
    """Which office_id to scope to. Super admins may pass an explicit office
    (Home passes their home office, the Team/Bells toggle passes the picked
    one, None = all offices). Everyone else is pinned to their own office."""
    if user.get("is_super_admin"):
        return office or None
    return user.get("office_id") or None


async def _hire_scope_match(user: dict, subtree_ids: list[str] | None, office_id: str | None) -> dict:
    """Active-hire filter for this viewer — same rules as /dashboard/stats."""
    match: dict = {"active": True}
    if user["role"] == "leader" and subtree_ids is not None:
        trainee_users = await db.users.find(
            {"_id": {"$in": [ObjectId(sid) for sid in subtree_ids]},
             "role": "trainee", "is_active": {"$ne": False}},
            {"new_hire_id": 1},
        ).to_list(500)
        hire_ids = [u["new_hire_id"] for u in trainee_users if u.get("new_hire_id")]
        leader_names = [user.get("name", "")]
        for sid in subtree_ids:
            u = await db.users.find_one({"_id": ObjectId(sid)}, {"name": 1, "role": 1})
            if u and u.get("role") in ("leader", "admin"):
                leader_names.append(u.get("name", ""))
        match["$or"] = coach_hire_filter(hire_ids, list(subtree_ids) + [user.get("id")], leader_names)
    if office_id:
        match["office_id"] = office_id
    return match


async def _leader_user_id_for(trainee_user_id: str | None, leader_name: str) -> str | None:
    """Leader user id for a grading row: the trainee's reports_to first, the
    hire's leader name second — the same resolution order the reminder tick
    uses (core/assessment_reminders._resolve_leader_id), but on THIS module's
    db handle so unit tests patching leader_today.db cover it too."""
    tu = None
    if trainee_user_id:
        try:
            tu = await db.users.find_one({"_id": ObjectId(trainee_user_id)}, {"reports_to": 1})
        except Exception:
            tu = None
    if tu and tu.get("reports_to"):
        return str(tu["reports_to"])
    if leader_name and leader_name != "Unassigned":
        lu = await db.users.find_one(
            {"name": leader_name, "role": {"$in": ["leader", "admin"]}}, {"_id": 1}
        )
        if lu:
            return str(lu["_id"])
    return None


async def _sales_today(user: dict, subtree_ids: list[str] | None, office_id: str | None) -> dict:
    """Today's sales (app time) in the viewer's scope: units sold, reps in field,
    and bells — a bell being one rep hitting 3+ sales in the day."""
    today_local = datetime.now(APP_TZ).date()
    week_ending = (today_local + timedelta(days=(6 - today_local.weekday()))).isoformat()
    idx = today_local.weekday()

    bells_match: dict = {"week_ending": week_ending}
    if user["role"] == "leader" and subtree_ids is not None:
        bells_match["user_id"] = {"$in": subtree_ids}
    elif office_id:
        bells_match["office_id"] = office_id

    units = 0
    reps_in = 0
    bells = 0        # a bell = one rep hitting 3+ sales in a day
    week_units = 0   # Monday → today
    week_bells = 0   # bell-days so far this week
    week_over30 = 0  # gold pieces so far this week
    week_mems = 0    # memberships so far this week
    async for e in db.bells_entries.find(bells_match, {"_id": 0, "days": 1}):
        days = e.get("days") or []
        for di in range(min(idx + 1, len(days))):
            d = days[di] or {}
            worked = d.get("status") == "in" or any((d.get(k) or 0) for k in ("over30", "under30", "memberships"))
            if not worked:
                continue
            rep_units = (d.get("over30") or 0) + (d.get("under30") or 0)
            week_units += rep_units
            week_over30 += (d.get("over30") or 0)
            week_mems += (d.get("memberships") or 0)
            if rep_units >= 3:
                week_bells += 1
            if di == idx:
                reps_in += 1
                units += rep_units
                if rep_units >= 3:
                    bells += 1
    # Weekly sales goal — an ADMIN's Office pulse compares against the
    # office's published weekly plan (agenda); a LEADER's Team pulse
    # compares against their own personal goal instead (set on their own
    # bells_entries row, same field the Bells screen edits) — the office
    # goal isn't theirs to be measured against.
    week_goal = None
    week_goal_raw = None
    week_goal_source = None  # 'crew' | 'personal' — what the number means
    if user["role"] == "leader":
        # The pulse's sales number is the whole subtree's, so compare against
        # the CREW goal (team_weekly_goal — same field the Weekly Planner's
        # team-goal box and the Bells team header edit). Fall back to the
        # personal goal for leaders who haven't set a crew goal yet.
        own_row = await db.bells_entries.find_one(
            {"week_ending": week_ending, "user_id": user["id"]},
            {"_id": 0, "weekly_goal": 1, "team_weekly_goal": 1},
        )
        tg = (own_row or {}).get("team_weekly_goal")
        wg = (own_row or {}).get("weekly_goal")
        if tg is not None:
            week_goal = int(tg)
            week_goal_raw = str(tg)
            week_goal_source = "crew"
        elif wg is not None:
            week_goal = int(wg)
            week_goal_raw = str(wg)
            week_goal_source = "personal"
    elif office_id:
        plan = await db.weekly_agendas.find_one(
            {"office_id": office_id, "week_ending": week_ending},
            {"_id": 0, "stats": 1, "themes": 1},
        )
        if plan:
            stats = plan.get("stats") or {}
            themes = plan.get("themes") or {}
            for v in (stats.get("weekly_goal"), stats.get("goal"), stats.get("sales_goal"), themes.get("sales_goal")):
                s = str(v or "").strip()
                if s:
                    week_goal_raw = s
                    break
            if week_goal_raw:
                m = re.search(r"\d+", week_goal_raw.replace(",", ""))
                if m:
                    week_goal = int(m.group())

    return {
        "date": today_local.isoformat(),
        "units": units, "reps_in": reps_in, "bells": bells,
        "week_units": week_units, "week_bells": week_bells,
        "week_goal": week_goal, "week_goal_raw": week_goal_raw,
        "week_goal_source": week_goal_source,
        "week_ending": week_ending,
        # Live quality rates for the CURRENT week (units-based, from bells)
        "week_gold_pct": round(100 * week_over30 / week_units) if week_units else None,
        "week_mem_pct": round(100 * week_mems / week_units) if week_units else None,
    }


@router.get("/leader/today")
async def leader_today(request: Request, office: str | None = None):
    user = await require_admin_or_leader(request)

    office_id = _office_filter(user, office)
    subtree_ids = await get_subtree_ids(user["id"]) if user["role"] == "leader" else None
    match = await _hire_scope_match(user, subtree_ids, office_id)
    hires = await db.new_hires.find(
        match,
        {"_id": 0, "id": 1, "name": 1, "current_day": 1, "current_status": 1,
         "trainee_user_id": 1, "leader": 1, "start_date": 1, "office_id": 1},
    ).to_list(500)
    # Exclude stale records: deleted, deactivated, or promoted users.
    hires = await _exclude_inactive_hires(user, hires)

    hire_ids = [h["id"] for h in hires]
    assessments: list = []
    if hire_ids:
        assessments = await db.daily_assessments.find(
            {"new_hire_id": {"$in": hire_ids}},
            {"_id": 0, "id": 1, "new_hire_id": 1, "day_number": 1,
             "completed": 1, "assessment_date": 1,
             "acknowledged": 1, "passed_off": 1},
        ).to_list(8000)

    by_hire: dict[str, list] = {}
    for a in assessments:
        by_hire.setdefault(a["new_hire_id"], []).append(a)

    today_utc = datetime.now(timezone.utc).date().isoformat()
    graded_today = sum(
        1 for a in assessments
        if a.get("completed") and str(a.get("assessment_date") or "").startswith(today_utc)
    )

    grading = []
    for h in hires:
        current_day = int(h.get("current_day") or 1)
        pending = sorted(
            (a for a in by_hire.get(h["id"], [])
             if not a.get("completed") and int(a.get("day_number") or 99) <= current_day),
            key=lambda a: int(a.get("day_number") or 99),
        )
        if not pending:
            continue
        nxt = pending[0]
        # Did the trainee acknowledge their most recent graded day? Uses the
        # rows already fetched above — no extra query. None = nothing graded
        # yet, so the chip simply doesn't apply.
        graded = [a for a in by_hire.get(h["id"], []) if a.get("completed")]
        latest = max(graded, key=lambda a: int(a.get("day_number") or 0), default=None)
        acknowledged_yesterday = (
            bool(latest.get("acknowledged") or latest.get("passed_off"))
            if latest else None
        )
        grading.append({
            "hire_id": h["id"],
            "trainee_user_id": h.get("trainee_user_id"),
            "name": h.get("name", ""),
            "current_day": current_day,
            "current_status": h.get("current_status", "Pending"),
            "assessment_id": nxt["id"],
            "day_number": int(nxt.get("day_number") or 1),
            "days_pending": len(pending),
            "acknowledged_yesterday": acknowledged_yesterday,
            "leader_user_id": None,
        })
    # Most behind first, then earliest pending day.
    grading.sort(key=lambda g: (-g["days_pending"], g["day_number"], g["name"]))
    grading = grading[:20]

    # Admin viewers get each row's responsible leader resolved so Home can
    # offer the one-tap "Remind" nudge (remind_leader below). Leaders viewing
    # their own queue don't need it — the button is admin-only.
    if user["role"] == "admin":
        leader_names = {h["id"]: (h.get("leader") or "") for h in hires}
        for g in grading:
            g["leader_user_id"] = await _leader_user_id_for(
                g.get("trainee_user_id"), leader_names.get(g["hire_id"], "")
            )

    # Vertex New Starts: a Coach sees EVERY new start in the office, to follow
    # their development, not only their own. Grading stays with the new
    # start's own Coach: `mine` marks the rows this viewer can grade and open
    # in full, and only those keep a "next day to grade".
    mine_ids = {h["id"] for h in hires}
    starts_hires, starts_by_hire = hires, by_hire
    if user["role"] == "leader" and user.get("office_id"):
        starts_hires = await _exclude_inactive_hires(user, await db.new_hires.find(
            {"active": True, "office_id": user["office_id"]},
            {"_id": 0, "id": 1, "name": 1, "current_day": 1, "current_status": 1,
             "trainee_user_id": 1, "leader": 1, "start_date": 1, "office_id": 1},
        ).to_list(500))
        extra = [h["id"] for h in starts_hires if h["id"] not in mine_ids]
        starts_by_hire = dict(by_hire)
        if extra:
            for a in await db.daily_assessments.find(
                {"new_hire_id": {"$in": extra}},
                {"_id": 0, "id": 1, "new_hire_id": 1, "day_number": 1, "completed": 1},
            ).to_list(8000):
                starts_by_hire.setdefault(a["new_hire_id"], []).append(a)
    new_starts = await _new_starts(starts_hires, starts_by_hire)
    for row in new_starts:
        row["mine"] = row["hire_id"] in mine_ids
        if not row["mine"]:
            row["next_assessment_id"] = None
            row["next_day"] = None

    month = datetime.now(timezone.utc).strftime("%Y-%m")
    planner_doc = await db.monthly_planners.find_one(
        {"user_id": user["id"], "month": month}, {"_id": 0, "locked": 1}
    )

    return {
        "grading": grading,
        "new_starts": new_starts,
        "planner": {
            "month": month,
            "exists": planner_doc is not None,
            "locked": bool(planner_doc.get("locked")) if planner_doc else False,
        },
        "counts": {
            "active": len(hires),
            "awaiting": len(grading),
            "graded_today": graded_today,
        },
        "sales_today": await _sales_today(user, subtree_ids, office_id),
        "team_health": await _team_health(user, hires, office_id) if user["role"] == "admin" else None,
    }


async def _cod_totals(office_id: str | None) -> dict[int, int]:
    """How many live COD 1 / COD 2 modules an office has (its own set, else
    the shared default set, the same fallback GET /modules uses)."""
    out: dict[int, int] = {}
    for stage in (1, 2):
        n = await db.training_modules.count_documents(
            {"stage": stage, "office_id": office_id, "retired": {"$ne": True}})
        if not n:
            n = await db.training_modules.count_documents(
                {"stage": stage, "office_id": None, "retired": {"$ne": True}})
        out[stage] = n
    return out


async def _new_starts(hires: list[dict], by_hire: dict[str, list]) -> list[dict]:
    """Every live new starter in scope: where they are in Days 1-8 and how
    much of COD 1 and COD 2 has been marked off (passed off by a Coach)."""
    uids = [h["trainee_user_id"] for h in hires if h.get("trainee_user_id")]
    marked: dict[tuple[str, int], set] = {}
    if uids:
        async for r in db.module_progress.find(
            {"stage": {"$in": [1, 2]}, "passed_off": True,
             "$or": [{"target_user_id": {"$in": uids}},
                     {"target_user_id": {"$exists": False}, "user_id": {"$in": uids}}]},
            {"_id": 0, "stage": 1, "module_id": 1, "target_user_id": 1, "user_id": 1},
        ):
            who = r.get("target_user_id") or r.get("user_id")
            marked.setdefault((who, int(r.get("stage") or 0)), set()).add(r.get("module_id"))
    totals: dict[str | None, dict[int, int]] = {}
    out = []
    for h in hires:
        oid = h.get("office_id")
        if oid not in totals:
            totals[oid] = await _cod_totals(oid)
        rows = by_hire.get(h["id"], [])
        current_day = int(h.get("current_day") or 1)
        pending = sorted((a for a in rows if not a.get("completed") and int(a.get("day_number") or 99) <= current_day),
                         key=lambda a: int(a.get("day_number") or 99))
        uid = h.get("trainee_user_id")
        cod = {}
        for stage in (1, 2):
            total = totals[oid][stage]
            cod[stage] = {"done": min(total, len(marked.get((uid, stage), ()))) if uid else 0, "total": total}
        out.append({
            "hire_id": h["id"],
            "trainee_user_id": uid,
            "name": h.get("name", ""),
            "coach": h.get("leader") or None,
            "current_day": current_day,
            "days_done": sum(1 for a in rows if a.get("completed")),
            "next_assessment_id": pending[0]["id"] if pending else None,
            "next_day": int(pending[0].get("day_number") or 1) if pending else None,
            "cod1": cod[1],
            "cod2": cod[2],
        })
    # Newest starters first (lowest day), then by name.
    out.sort(key=lambda r: (r["current_day"], r["name"].lower()))
    return out


async def _team_health(user: dict, hires: list[dict], office_id: str | None) -> dict:
    """Org-chart issues worth an admin's attention. Only ever *adds* rows to
    the Home pulse card when something is actually wrong — silent otherwise."""
    today = datetime.now(timezone.utc).date()

    # Trainees stuck without a leader for 2+ days
    unassigned_aging = []
    for h in hires:
        if (h.get("leader") or "Unassigned") not in ("", "Unassigned", None):
            continue
        try:
            started = datetime.strptime(str(h.get("start_date"))[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue
        days = (today - started).days
        if days >= 2:
            unassigned_aging.append({"name": h.get("name", ""), "days": days})
    unassigned_aging.sort(key=lambda x: -x["days"])

    # Leaders with no active trainees reporting to them
    leader_q: dict = {"role": "leader", "is_active": {"$ne": False}, "deleted": {"$ne": True}}
    if office_id:
        leader_q["office_id"] = office_id
    leaders = await db.users.find(leader_q, {"name": 1}).to_list(200)
    busy = set(
        str(rt) for rt in await db.users.distinct(
            "reports_to", {"role": "trainee", "is_active": {"$ne": False}, "deleted": {"$ne": True}}
        ) if rt
    )
    idle_leaders = [l.get("name", "") for l in leaders if str(l["_id"]) not in busy]

    return {
        "unassigned_aging": unassigned_aging[:5],
        "idle_leaders": sorted(idle_leaders)[:5],
    }


@router.post("/leader/today/remind/{leader_user_id}")
async def remind_leader(leader_user_id: str, request: Request):
    """One-tap admin nudge: ONE "assessments waiting" push to a leader who's
    fallen behind on grading (the Home queue's Remind button).

    Throttled to one admin nudge per leader per MIN_GAP_HOURS via a SIBLING
    key (`admin_nudge_at`) on the same assessment_reminder_state doc the
    automatic bell-triggered tick writes (`last_sent_at`) — an admin tap is
    rate-limited independently of the cron nudges, but all throttle state
    for a leader lives in one place."""
    admin = await require_admin(request)

    try:
        target = await db.users.find_one(
            {"_id": ObjectId(leader_user_id)}, {"name": 1, "role": 1, "deleted": 1, "office_id": 1}
        )
    except Exception:
        target = None
    if not target or target.get("deleted") or target.get("role") not in ("leader", "admin"):
        raise HTTPException(status_code=404, detail="Coach not found")
    if not admin.get("is_super_admin") and (
        not admin.get("office_id") or target.get("office_id") != admin.get("office_id")
    ):
        # Office admins nudge their own office's coaches only.
        raise HTTPException(status_code=404, detail="Coach not found")

    now_utc = datetime.now(timezone.utc)
    state = await db.assessment_reminder_state.find_one({"_id": leader_user_id})
    last = (state or {}).get("admin_nudge_at")
    if last:
        try:
            last_dt = datetime.fromisoformat(last)
        except ValueError:
            last_dt = None
        if last_dt and now_utc - last_dt < timedelta(hours=MIN_GAP_HOURS):
            retry_at = (last_dt + timedelta(hours=MIN_GAP_HOURS)).astimezone(APP_TZ).strftime("%H:%M")
            first = (target.get("name") or "They").split(" ")[0]
            raise HTTPException(
                status_code=429,
                detail=f"{first} was already nudged in the last {MIN_GAP_HOURS}h — try again after {retry_at}.",
            )

    admin_first = (admin.get("name") or "").split(" ")[0] or "Your admin"
    await send_push_to_user(
        leader_user_id,
        title=f"📋 {admin_first} nudged you — assessments waiting",
        body="New-BA days are waiting on your grade. Tap to open your queue.",
        data={"type": "grading_reminder", "url": "/"},
    )
    await db.assessment_reminder_state.update_one(
        {"_id": leader_user_id},
        {"$set": {"admin_nudge_at": now_utc.isoformat(), "admin_nudge_by": admin["id"]}},
        upsert=True,
    )
    return {"ok": True, "nudged": leader_user_id}


@router.post("/admin/assessment-reminders/run")
async def run_assessment_reminders(request: Request, dry_run: bool = True):
    """Admin test hook for the bell-triggered grading reminders.

    dry_run=true (default) reports who WOULD be pushed without sending.
    dry_run=false sends for real (still honours the per-leader 3h throttle,
    but ignores quiet hours since an admin is explicitly asking)."""
    await require_super_admin(request)
    from core.assessment_reminders import assessment_reminder_tick
    return await assessment_reminder_tick(dry_run=dry_run, force=True)
