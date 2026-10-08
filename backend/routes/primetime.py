"""Office Primetime plan — one shared coaching grid per office, per week.

Every day at Primetime someone is Learning, Teaching or Watching. Until now
that lived as a free-text box on each leader's own Weekly Planner
(`weekly_planners.days[d].primetime`), which meant nobody could see anyone
else's plan. This module is the office-wide version of the same idea.

Shape of the thing:
  • ONE row per (office, week, day, person) — a person does one Primetime a
    day, matching the single PRIMETIME block on the office schedule.
  • A row is {mode, topic, who-with}. `mode` is learning | teaching | watching.
  • Rows that share a `session_id` are the same session: the teacher's row is
    the host, everyone who joined points at it. That is what makes "I can see
    another team is running a topic and add my person to it" a single write —
    you create/update YOUR person's row, never theirs.

Two deliberate departures from the rest of the codebase, both load-bearing:

1. The roster is NEVER materialised into storage. We store only rows somebody
   actually filled in, and compute the list of names live from the tree on
   every read. That is what makes departures correct for free: a person who
   leaves simply stops being returned for future days, while every row they
   already have survives untouched.

2. `_office_roster` does NOT use the app-wide "still works here" predicate
   (`is_active != False AND deleted != True`). That predicate is all-or-
   nothing, and Primetime needs per-day truth: someone who left on Wednesday
   must still appear on Mon/Tue/Wed and must not appear on Thu/Fri/Sat. So we
   read `left_on` (see `_left_on`) and compare it against each day's date.

Ghost records: every row snapshots `subject_name` at write time. A person can
be deleted from `db.users` entirely and their past Primetime rows still render
with the right name, with no lookup and no join.
"""
import uuid
from datetime import datetime, timezone, date, timedelta, time as dtime
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request
from pymongo.errors import DuplicateKeyError
from pydantic import BaseModel

from auth import get_current_user, get_subtree_ids, require_admin_or_leader
from core.office_helpers import resolve_office_id
from core.app_time import APP_TZ, uk_date
from core.push import send_push_to_user
from database import db

router = APIRouter()

# Mon=0 .. Sat=5 — same convention as the weekly planner and the office agenda.
DAYS = list(range(0, 6))
DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

MODES = ("learning", "teaching", "watching")

MAX_TOPIC = 200
MAX_WITH_TEXT = 200
MAX_WITH_IDS = 25
# An office roster is dozens of people, not thousands. The cap is a runaway
# guard, not a real limit.
MAX_ROSTER = 2000

# "Still works here" — the app-wide predicate, used here only for the fast
# path (who is definitely on the grid). Per-day truth comes from `_left_on`.
_ACTIVE_USER = {"is_active": {"$ne": False}, "deleted": {"$ne": True}, "is_demo": {"$ne": True}}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_local() -> date:
    return datetime.now(APP_TZ).date()


# The hour (app time) after which the working day is over and everyone is looking at
# tomorrow's plan rather than today's.
ROLLOVER_HOUR = 18


def _planning_day(now: Optional[datetime] = None) -> date:
    """The day Primetime is being planned for, right now, in office time.

    Before 6pm (app time) that's today. After it, the day is done and the useful
    question is what's happening tomorrow — so Home and the planner both roll
    forward. Sunday has no Primetime, so it is skipped in either direction.
    """
    now = now or datetime.now(APP_TZ)
    target = now.date()
    if now.hour >= ROLLOVER_HOUR:
        target += timedelta(days=1)
    if target.weekday() == 6:  # Sunday
        target += timedelta(days=1)
    return target


def _s(v, cap: int) -> str:
    """Coerce to a trimmed, length-capped string."""
    if v is None:
        return ""
    return str(v).strip()[:cap]


def _is_iso_date(v) -> bool:
    if not isinstance(v, str):
        return False
    try:
        date.fromisoformat(v)
        return True
    except Exception:
        return False


def _coerce_to_sunday(s: str) -> Optional[str]:
    """Roll any date forward to the Sunday that ends its week."""
    try:
        d = date.fromisoformat(s)
    except Exception:
        return None
    return (d + timedelta(days=(6 - d.weekday()) % 7)).isoformat()


def _planning_sunday() -> str:
    """The week being PLANNED — matching the Weekly Planner's convention.

    Mon–Sat that's the week we're in. On a Sunday it rolls to NEXT week:
    Sunday is wrap-up and planning day, and there is no Primetime on it.
    """
    today = _today_local()
    if today.weekday() == 6:  # Sunday
        return (today + timedelta(days=7)).isoformat()
    return _coerce_to_sunday(today.isoformat()) or today.isoformat()


def _day_date(week_ending: str, day_index: int) -> str:
    """The real calendar date of a day slot. week_ending is the Sunday."""
    return (date.fromisoformat(week_ending) + timedelta(days=day_index - 6)).isoformat()


def _week_monday(week_ending: str) -> str:
    return _day_date(week_ending, 0)


def _scrub(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


def _left_on(u: dict) -> Optional[str]:
    """The person's last day, as YYYY-MM-DD — or None if they still work here.

    Three sources, most explicit first:
      1. `left_on` — set when an admin bins someone (see admin_routes.delete_user).
         Back-datable, so "her last day was Tuesday" is expressible.
      2. `deleted_at` — legacy soft-deletes that predate `left_on`. The deletion
         day is the best available guess at the last day.
      3. Flagged gone with no date at all (notably `is_active: False`, which
         nothing in this codebase writes — it arrives by hand or from an
         external process). Treated as long gone, so they never appear on a
         future day. Rows they already have still render, because those are
         unioned in from the entries themselves.
    """
    v = u.get("left_on")
    if _is_iso_date(v):
        return v
    gone = bool(u.get("deleted")) or u.get("is_active") is False
    if not gone:
        return None
    da = u.get("deleted_at")
    if isinstance(da, str) and len(da) >= 10 and _is_iso_date(da[:10]):
        return da[:10]
    return "1970-01-01"


def _on_grid(left: Optional[str], day_date: str) -> bool:
    """Does this person still belong on the plan for this day?

    Inclusive of the last day itself: someone whose last day is Wednesday is
    at Primetime on Wednesday. They drop off Thursday onward.
    """
    return left is None or day_date <= left


def _person(u: dict, left: Optional[str]) -> dict:
    return {
        "user_id": str(u["_id"]),
        "name": u.get("name") or "",
        "role": (u.get("role") or "").lower(),
        "team_name": u.get("team_name") or "",
        "leader_id": u.get("reports_to") or "",
        "left_on": left,
    }


async def _office_roster(office_id: str, week_ending: str) -> list:
    """Everyone who can appear anywhere on this week's grid.

    Deliberately wider than the app-wide active filter — see the module
    docstring. Returns people with a `left_on` so the caller can decide
    per day; it does NOT pre-filter by day.
    """
    monday = _week_monday(week_ending)
    rows = await db.users.find(
        {
            "office_id": office_id,
            "role": {"$in": ["trainee", "leader", "admin"]},
            # Top-level so the left_on $or branch can't re-admit a demo user.
            "is_demo": {"$ne": True},
            "$or": [
                # Currently here.
                _ACTIVE_USER,
                # Gone, but not before this week started — they still occupy
                # the days they worked.
                {"left_on": {"$gte": monday}},
            ],
        },
        {"_id": 1, "name": 1, "role": 1, "team_name": 1, "reports_to": 1,
         "left_on": 1, "deleted": 1, "deleted_at": 1, "is_active": 1},
    ).to_list(MAX_ROSTER)
    return [_person(u, _left_on(u)) for u in rows]


async def _day_statuses(office_id: str, week_ending: str, user_ids: list) -> dict:
    """user_id -> ['in','ab','off',...] for Mon..Sat, from the Bells sheet.

    Primetime is planned for whoever is actually in that day, so a rep already
    marked absent shouldn't be sitting in the list waiting to be given a topic.
    Bells is the one place attendance is recorded (the planner's crew sheet and
    the absence-approval flow both write `ab` onto these same cells), so it is
    the only honest source for "who's in on Wednesday".

    Missing rows are normal — plenty of weeks are planned before Bells is
    filled in — so an absent entry is only ever an explicit `ab`, never an
    assumption drawn from silence.
    """
    if not user_ids:
        return {}
    rows = await db.bells_entries.find(
        {"office_id": office_id, "week_ending": week_ending, "user_id": {"$in": list(user_ids)}},
        {"_id": 0, "user_id": 1, "days": 1},
    ).to_list(MAX_ROSTER)
    out = {}
    for r in rows:
        days = r.get("days") or []
        out[r.get("user_id")] = [
            (days[i].get("status") if i < len(days) and isinstance(days[i], dict) else None) or ""
            for i in DAYS
        ]
    return out


async def _resolve_week(week: Optional[str]) -> str:
    wk = _coerce_to_sunday(week) if week else None
    return wk or _planning_sunday()


async def _editable_ids(me: dict, office_id: str) -> Optional[set]:
    """Which people this viewer may write rows for. None means 'anyone in the office'.

    Decision: a leader plans for their own tree only (themselves included);
    everyone can read the whole office. Adding your person to another team's
    session is still allowed, because that writes YOUR person's row.
    """
    if me.get("is_super_admin"):
        return None
    if (me.get("role") or "").lower() == "admin" and (me.get("office_id") or "") == office_id:
        return None

    subtree = set(await get_subtree_ids(me["id"]))
    # `get_subtree_ids` drops departed people at the query level, but the read
    # path deliberately keeps them on the days they actually worked. Without
    # this, a rep who left on Wednesday renders on Mon–Wed and every write for
    # those days 403s — the grid and the save disagreeing about who is on the
    # plan. Add back departed direct reports so the two paths use one answer;
    # `_on_grid` in `_guard_write` still stops anyone planning them past their
    # last day.
    departed = await db.users.find(
        {
            "office_id": office_id,
            "reports_to": {"$in": list(subtree)},
            "$or": [{"deleted": True}, {"is_active": False}],
        },
        {"_id": 1},
    ).to_list(MAX_ROSTER)
    subtree.update(str(d["_id"]) for d in departed)
    return subtree


def _entry_out(e: dict) -> dict:
    return {
        "id": e.get("id"),
        "day_index": e.get("day_index"),
        "day_date": e.get("day_date"),
        "subject_user_id": e.get("subject_user_id"),
        "subject_name": e.get("subject_name") or "",
        "mode": e.get("mode"),
        "topic": e.get("topic") or "",
        "session_id": e.get("session_id") or "",
        "with_ids": list(e.get("with_ids") or []),
        "with_names": list(e.get("with_names") or []),
        "with_text": e.get("with_text") or "",
        "updated_at": e.get("updated_at"),
        "updated_by_name": e.get("updated_by_name") or "",
    }


def _dedupe_entries(entries: list) -> list:
    """One row per person per day — keep the newest by updated_at.

    Duplicates written before the unique index existed (find-then-insert race
    with _mirror_counterparts) rendered the same person twice on the Home card
    and the planner. The index now prevents new ones; this keeps reads clean
    even if an old duplicate survives."""
    best: dict = {}
    for e in entries:
        k = (e.get("day_index"), e.get("subject_user_id"))
        cur = best.get(k)
        if cur is None or (e.get("updated_at") or "") > (cur.get("updated_at") or ""):
            best[k] = e
    return list(best.values())


def _build_sessions(entries: list) -> list:
    """Group rows into sessions so the UI can show "who is running what".

    A session is anchored by its teaching row. Learning/watching rows that
    point at the same session_id are its attendees. Rows with no session_id
    (a solo "learning: reading the manual") never become sessions.
    """
    hosts: dict = {}
    for e in entries:
        if e.get("mode") == "teaching" and e.get("session_id"):
            hosts[e["session_id"]] = e
    out = []
    for sid, host in hosts.items():
        attendees = [
            {
                "user_id": e["subject_user_id"],
                "name": e.get("subject_name") or "",
                "mode": e.get("mode"),
            }
            for e in entries
            if e.get("session_id") == sid and e["subject_user_id"] != host["subject_user_id"]
        ]
        attendees.sort(key=lambda a: a["name"].lower())
        out.append({
            "session_id": sid,
            "day_index": host.get("day_index"),
            "day_date": host.get("day_date"),
            "topic": host.get("topic") or "",
            "host_user_id": host["subject_user_id"],
            "host_name": host.get("subject_name") or "",
            "attendees": attendees,
        })
    out.sort(key=lambda s: (s["day_index"] or 0, s["topic"].lower()))
    return out


async def _snapshot_names(user_ids: list, office_id: str, limit: int = MAX_WITH_IDS) -> dict:
    """user_id -> name, for people in this office. Unknown ids are dropped."""
    oids = []
    for uid in user_ids:
        try:
            oids.append(ObjectId(uid))
        except Exception:
            continue
    if not oids:
        return {}
    rows = await db.users.find(
        {"_id": {"$in": oids}, "office_id": office_id},
        {"_id": 1, "name": 1},
    ).to_list(limit)
    return {str(r["_id"]): (r.get("name") or "") for r in rows}


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

@router.get("/primetime/week")
async def get_primetime_week(request: Request, week: Optional[str] = None, office: Optional[str] = None):
    """The whole office's Primetime plan for one week.

    Readable by every leader/admin in the office — cross-team visibility is
    the entire point of the feature. Write permission is reported per person
    via `can_edit` so the UI can render other teams read-only.
    """
    me = await require_admin_or_leader(request)
    office_id = await resolve_office_id(request, me, office)
    week_ending = await _resolve_week(week)

    roster = await _office_roster(office_id, week_ending)
    entries = await db.primetime_entries.find(
        {"office_id": office_id, "week_ending": week_ending},
    ).to_list(MAX_ROSTER * len(DAYS))
    entries = _dedupe_entries([_scrub(e) for e in entries])

    editable = await _editable_ids(me, office_id)
    known_ids = {p["user_id"] for p in roster}

    # Ghosts: someone with a row this week who is no longer in the roster
    # query at all (deleted long ago, or moved office). Rendered straight from
    # the row's own name snapshot — no lookup, no join.
    for e in entries:
        uid = e.get("subject_user_id")
        if uid and uid not in known_ids:
            known_ids.add(uid)
            roster.append({
                "user_id": uid,
                "name": e.get("subject_name") or "",
                "role": "",
                "team_name": "",
                "leader_id": "",
                "left_on": _day_date(week_ending, 0),
                "is_ghost": True,
            })

    # Every leader in the office needs a name for the team headings — this is
    # roster-sized, not counterpart-sized, so it uses the roster cap.
    leader_names = {}
    leader_ids = list({p["leader_id"] for p in roster if p.get("leader_id")})
    if leader_ids:
        leader_names = await _snapshot_names(leader_ids, office_id, limit=MAX_ROSTER)

    statuses = await _day_statuses(office_id, week_ending, [p["user_id"] for p in roster])

    people = []
    for p in roster:
        can_edit = editable is None or p["user_id"] in editable
        # A day the person is not on the grid for (left before it, or joined
        # after) is reported so the UI can grey the cell rather than offer an
        # editable box that will be rejected.
        days_on = [d for d in DAYS if _on_grid(p.get("left_on"), _day_date(week_ending, d))]
        day_st = statuses.get(p["user_id"]) or ["" for _ in DAYS]
        people.append({
            **p,
            "leader_name": leader_names.get(p.get("leader_id") or "", ""),
            "can_edit": bool(can_edit),
            "in_my_tree": editable is None or p["user_id"] in editable,
            "days_on_grid": days_on,
            "day_statuses": day_st,
            # Only an explicit `ab` counts. A blank Bells cell means nobody has
            # filled the sheet in yet, not that the person is away.
            "absent_days": [d for d in DAYS if day_st[d] == "ab"],
        })
    people.sort(key=lambda p: ((p.get("name") or "").lower()))

    out_entries = [_entry_out(e) for e in entries]
    return {
        "week_ending": week_ending,
        "office_id": office_id,
        "days": [
            {"day_index": d, "date": _day_date(week_ending, d), "name": DAY_NAMES[d], "short": DAY_SHORT[d]}
            for d in DAYS
        ],
        "today_index": next(
            (d for d in DAYS if _day_date(week_ending, d) == _today_local().isoformat()), None
        ),
        "people": people,
        "entries": out_entries,
        "sessions": _build_sessions(out_entries),
        "can_edit_any": bool(editable is None or editable),
    }


@router.get("/primetime/home")
async def get_primetime_home(request: Request, office: Optional[str] = None):
    """Home card payload: who's got what going on, for the next plannable day.

    Sunday has no Primetime, so on a Sunday this looks ahead to Monday and
    says so.

    Deliberately returns no "x of y planned" tally. A leader reading one told
    them nothing useful: the denominator was the whole office (27 people)
    while their own crew is four, so it always looked like nothing was
    planned. The useful thing is simply the list of who is doing what.

    Office scoping is absolute here — `resolve_office_id` pins a leader and an
    admin to their own office, and this endpoint takes an `office` param only
    so a super admin can be pointed at one deliberately. Two offices
    never appear in the same payload.
    """
    me = await require_admin_or_leader(request)
    office_id = await resolve_office_id(request, me, office)

    target = _planning_day()
    week_ending = _coerce_to_sunday(target.isoformat())
    day_index = target.weekday()  # Mon=0 .. Sat=5
    today = _today_local()

    entries = await db.primetime_entries.find(
        {"office_id": office_id, "week_ending": week_ending, "day_index": day_index},
    ).to_list(MAX_ROSTER)
    entries = _dedupe_entries([_entry_out(_scrub(e)) for e in entries])

    day_date = _day_date(week_ending, day_index)

    roster = await _office_roster(office_id, week_ending)

    # Somebody marked absent isn't there to be coached: a plan left over from
    # before they went off shouldn't be advertised, and they shouldn't be
    # chased for one either. Statuses are read for the roster AND for anyone
    # holding an entry, so an unplanned absentee is caught too.
    statuses = await _day_statuses(
        office_id, week_ending,
        list({p["user_id"] for p in roster} | {e["subject_user_id"] for e in entries}),
    )
    absent_ids = {uid for uid, st in statuses.items() if st[day_index] == "ab"}

    # Who on MY OWN team still has nothing set. Deliberately my team and not
    # the office: the office-wide list above is for seeing what's on offer,
    # but the only people I can do anything about are mine.
    editable = await _editable_ids(me, office_id)
    planned_ids = {e["subject_user_id"] for e in entries if e.get("mode")}
    on_grid = {
        p["user_id"]: p for p in roster
        if _on_grid(p.get("left_on"), day_date)
        and (editable is None or p["user_id"] in editable)
    }
    # Awareness covers the WHOLE team, notifications don't. A leader should be
    # able to see that someone three levels down has nothing planned; they just
    # shouldn't get pushed about it, because the leader directly above that
    # person is the one who can actually do something (see `_unchased`).
    # `is_direct` marks the ones they're personally accountable for.
    mine_unplanned = [
        {
            "user_id": uid,
            "name": p["name"],
            # Rendered as "You" — same reason as the push nudge.
            "is_self": uid == me["id"],
            "is_direct": p.get("leader_id") == me["id"] or uid == me["id"],
        }
        for uid, p in on_grid.items()
        if uid not in planned_ids and uid not in absent_ids
    ]
    # You first, then your own first generation, then the rest of the tree.
    mine_unplanned.sort(
        key=lambda p: (not p["is_self"], not p["is_direct"], (p["name"] or "").lower())
    )

    live = [e for e in entries if e.get("mode") and e["subject_user_id"] not in absent_ids]
    plans = [
        {
            "user_id": e["subject_user_id"],
            "name": e["subject_name"],
            "mode": e["mode"],
            "topic": e["topic"],
            # Lets the card fold both sides of one arrangement into a single
            # group instead of printing the teacher and the learner as two
            # separate lines that look like duplicates.
            "session_id": e["session_id"],
            # Whoever they're doing it with: real names when the row joined a
            # session, else whatever the leader typed.
            "with_label": ", ".join(e["with_names"]) or e["with_text"],
        }
        for e in live
    ]
    plans.sort(key=lambda p: ((p["name"] or "").lower()))

    return {
        "week_ending": week_ending,
        "day_index": day_index,
        "date": day_date,
        "day_name": DAY_NAMES[day_index],
        "is_tomorrow": target != today,
        "office_id": office_id,
        "plans": plans,
        "sessions": _build_sessions(live),
        "my_unplanned": mine_unplanned[:20],
        "my_unplanned_total": len(mine_unplanned),
    }


# ---------------------------------------------------------------------------
# Nudges
# ---------------------------------------------------------------------------

# Nobody gets pushed between 11pm and 8:30am. The scheduled slots all sit
# outside this window by construction, but the guard is enforced in the tick
# itself so a later slot added at a careless hour can't wake the office up.
QUIET_START = dtime(23, 0)
QUIET_END = dtime(8, 30)


def _unchased(on_grid: dict, leader_id: str, planned: set, absent: set) -> list:
    """Who this leader is personally accountable for, still without a plan.

    Their DIRECT reports plus themselves — not the whole downline. If a leader
    were chased for their sub-leaders' crews too, the same trainee would
    generate a push to three people and everyone would learn to ignore them.
    One person, one owner: whoever they report to.

    Admins are never called with this — the office belongs to them, but the
    planning belongs to the leaders under them.
    """
    return [
        uid
        for uid, p in on_grid.items()
        if (p.get("leader_id") == leader_id or uid == leader_id)
        and uid not in planned
        and uid not in absent
    ]


def _in_quiet_hours(now: datetime) -> bool:
    """True between 23:00 and 08:30 app time. 08:30 sharp is already fair game."""
    t = now.timetz().replace(tzinfo=None)
    return t >= QUIET_START or t < QUIET_END


async def primetime_nudge_tick(now: Optional[datetime] = None) -> int:
    """Chase leaders whose OWN team still has nobody planned for Primetime.

    Scoped to their own crew on purpose — the office-wide view is for finding
    a session to join, but the only people a leader can act on are theirs.

    Which day is chased follows the same 6pm rule as everything else, so the
    evening slot asks about tomorrow and the morning slots ask about today.

    Returns the number of leaders pushed (handy in tests and logs).
    """
    now = now or datetime.now(APP_TZ)
    if _in_quiet_hours(now):
        return 0

    target = _planning_day(now)
    week_ending = _coerce_to_sunday(target.isoformat())
    day_index = target.weekday()
    day_date = target.isoformat()
    is_tomorrow = target != now.date()

    leaders = await db.users.find(
        {
            "role": "leader",
            "deleted": {"$ne": True},
            "is_active": {"$ne": False},
            "expo_push_token": {"$exists": True, "$nin": [None, ""]},
        },
        {"_id": 1, "office_id": 1},
    ).to_list(MAX_ROSTER)
    if not leaders:
        return 0

    # Everything below is per-office rather than per-leader, so twenty leaders
    # in one office cost one roster read, not twenty.
    sent = 0
    by_office: dict = {}
    for u in leaders:
        by_office.setdefault(u.get("office_id") or "", []).append(str(u["_id"]))

    for office_id, leader_ids in by_office.items():
        if not office_id:
            continue
        roster = await _office_roster(office_id, week_ending)
        on_grid = {p["user_id"]: p for p in roster if _on_grid(p.get("left_on"), day_date)}
        entries = await db.primetime_entries.find(
            {"office_id": office_id, "week_ending": week_ending, "day_index": day_index},
            {"_id": 0, "subject_user_id": 1, "mode": 1},
        ).to_list(MAX_ROSTER)
        planned = {e["subject_user_id"] for e in entries if e.get("mode")}
        statuses = await _day_statuses(office_id, week_ending, list(on_grid))
        absent = {uid for uid, st in statuses.items() if st[day_index] == "ab"}

        for leader_id in leader_ids:
            # A leader who is off themselves doesn't need chasing.
            if leader_id in absent:
                continue
            missing = _unchased(on_grid, leader_id, planned, absent)
            if not missing:
                continue
            # Their own row counts — a leader is encouraged to set their own
            # Primetime as well as their crew's — but reads as "You", because a
            # push saying "Dana has no Primetime" sent to Dana is nonsense.
            names = ["You" if uid == leader_id else on_grid[uid]["name"] for uid in missing]
            names.sort(key=lambda n: (n != "You", n.lower()))
            shown = ", ".join(names[:3]) + (f" and {len(names) - 3} more" if len(names) > 3 else "")
            when = "tomorrow" if is_tomorrow else "today"
            await send_push_to_user(
                leader_id,
                "Primetime isn't set 🎯",
                # "You" takes have, not has, even on its own.
                f"{shown} {'has' if len(names) == 1 and names[0] != 'You' else 'have'} "
                f"no Primetime for {when}. "
                f"Two minutes now saves the morning.",
                {
                    "type": "primetime_nudge",
                    "url": f"/weekly-planner?week={week_ending}&day={day_index}",
                },
            )
            sent += 1

    return sent


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------

class EntryBody(BaseModel):
    week_ending: str
    day_index: int
    subject_user_id: str
    mode: Optional[str] = None
    topic: Optional[str] = ""
    with_ids: Optional[list] = None
    with_text: Optional[str] = ""
    session_id: Optional[str] = None
    office: Optional[str] = None


async def _guard_write(request: Request, office_param: Optional[str], subject_user_id: str,
                       week_ending: str, day_index: int):
    """Shared front door for every write: auth, office, scope, day validity."""
    me = await require_admin_or_leader(request)
    office_id = await resolve_office_id(request, me, office_param)

    wk = _coerce_to_sunday(week_ending) if week_ending else None
    if not wk or wk != week_ending:
        raise HTTPException(status_code=400, detail="week_ending must be the Sunday that ends the week")
    if day_index not in DAYS:
        raise HTTPException(status_code=400, detail="day_index must be 0 (Mon) through 5 (Sat)")

    editable = await _editable_ids(me, office_id)
    if editable is not None and subject_user_id not in editable:
        raise HTTPException(
            status_code=403,
            detail="You can only plan Primetime for people on your own team",
        )

    subject = await db.users.find_one(
        {"_id": _oid_or_404(subject_user_id)},
        {"_id": 1, "name": 1, "office_id": 1, "left_on": 1, "deleted": 1, "deleted_at": 1, "is_active": 1},
    )
    if not subject:
        raise HTTPException(status_code=404, detail="That person no longer exists")
    if (subject.get("office_id") or "") != office_id:
        raise HTTPException(status_code=403, detail="That person is not in this office")

    day_date = _day_date(week_ending, day_index)
    if not _on_grid(_left_on(subject), day_date):
        raise HTTPException(
            status_code=400,
            detail=f"{subject.get('name') or 'That person'} has left and is not on the plan for {uk_date(day_date)}",
        )
    return me, office_id, subject, day_date


def _oid_or_404(user_id: str) -> ObjectId:
    try:
        return ObjectId(user_id)
    except Exception:
        raise HTTPException(status_code=404, detail="That person no longer exists")


def _session_id(week_ending: str, day_index: int, host_user_id: str) -> str:
    """The id of the session that person hosts on that day.

    Derived, not random, so ONE HOST HAS EXACTLY ONE SESSION PER DAY and two
    people running the same topic can never end up in the same block.

    This replaced random uuids after three teachers, all running
    Pitch Practice, ended up sharing a single session. A newly
    mirrored teacher inherited the session id off the learner who named them,
    so switching a trainee from one Pitch Practice to another dragged the new
    teacher into the old teacher's session. With the id derived from the host
    there is nothing to inherit.
    """
    return f"{week_ending}:{day_index}:{host_user_id}"


async def _row(office_id: str, week_ending: str, day_index: int, uid: str) -> Optional[dict]:
    return await db.primetime_entries.find_one({
        "office_id": office_id, "week_ending": week_ending,
        "day_index": day_index, "subject_user_id": uid,
    })


async def _write_row(doc: dict):
    # Atomic upsert on the natural key — the old find-then-insert raced with
    # _mirror_counterparts (both sides saw "no row", both inserted) and left
    # the same person with two rows for one day. A unique index (server.py)
    # now backstops this; the retry covers the one race upserts still allow:
    # two concurrent upserts can both miss, one inserts, the other throws
    # DuplicateKeyError — on retry it matches the fresh row and updates it.
    key = {"office_id": doc["office_id"], "week_ending": doc["week_ending"],
           "day_index": doc["day_index"], "subject_user_id": doc["subject_user_id"]}
    update = {"$set": doc,
              "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": doc.get("updated_at")}}
    try:
        await db.primetime_entries.update_one(key, update, upsert=True)
    except DuplicateKeyError:
        await db.primetime_entries.update_one(key, {"$set": doc})


async def _mirror_counterparts(office_id: str, week_ending: str, day_index: int,
                               day_date: str, me: dict, row: dict) -> str:
    """Make the other side of the arrangement true too.

    "Ana is learning Closing from Malik" and "Malik is teaching Closing to Ana"
    are one fact, and nobody should have to type it twice. Saving either side
    fills in the other, and an impact holds as many people as it needs — each
    new learner is added to the teacher's list rather than replacing whoever
    was already there.

    This writes ANOTHER person's row, which the normal permission rule forbids
    — you only edit your own tree. That's deliberate and narrowly bounded: it
    is derived from a fact the caller is entitled to state about their own
    person, it stays inside the one office, and it will never overwrite a plan
    somebody already made. If the counterpart has a conflicting row of their
    own, theirs wins and nothing is touched; the caller's own row still records
    the name, so the intent isn't lost.

    Returns the session id the caller's row should end up on.
    """
    session_id = row.get("session_id") or ""
    partner_ids = [uid for uid in (row.get("with_ids") or []) if uid != row["subject_user_id"]]
    if not partner_ids:
        return session_id

    now = _now_iso()
    names = await _snapshot_names(partner_ids + [row["subject_user_id"]], office_id, limit=MAX_WITH_IDS)

    def base(uid: str, mode: str, topic: str, sid: str, with_ids: list) -> dict:
        return {
            "office_id": office_id, "week_ending": week_ending, "day_index": day_index,
            "day_date": day_date, "subject_user_id": uid, "subject_name": names.get(uid, ""),
            "mode": mode, "topic": topic, "session_id": sid,
            "with_ids": with_ids, "with_names": [names.get(x, "") for x in with_ids],
            "with_text": "", "updated_at": now,
            "updated_by_id": me["id"], "updated_by_name": me.get("name") or "",
            # Marks a row the system filled in from the other side, so it's
            # obvious in the data why it appeared.
            "mirrored_from": row["subject_user_id"],
        }

    if row["mode"] in ("learning", "watching"):
        # I'm learning from them → they're teaching me. The session is always
        # THEIRS: derived from them, never inherited from me.
        for teacher_id in partner_ids:
            sid = _session_id(week_ending, day_index, teacher_id)
            theirs = await _row(office_id, week_ending, day_index, teacher_id)
            if theirs is None:
                session_id = sid
                await _write_row(base(teacher_id, "teaching", row.get("topic") or "",
                                      sid, [row["subject_user_id"]]))
            elif theirs.get("mode") == "teaching":
                session_id = sid
                attendees = list(dict.fromkeys([*(theirs.get("with_ids") or []), row["subject_user_id"]]))
                # Names for the WHOLE list, not just the person being added —
                # the ones already there aren't in `names`, and looking them up
                # from it would blank them out.
                attendee_names = await _snapshot_names(attendees, office_id, limit=MAX_WITH_IDS)
                await db.primetime_entries.update_one(
                    {"id": theirs["id"]},
                    {"$set": {
                        "session_id": session_id,
                        "with_ids": attendees,
                        "with_names": [attendee_names.get(x, "") for x in attendees],
                        # Only fill a blank topic — never rewrite theirs.
                        "topic": theirs.get("topic") or row.get("topic") or "",
                        "updated_at": now,
                    }},
                )
            # else: they already have a different plan of their own. Leave it.
        return session_id

    if row["mode"] == "teaching":
        # I'm teaching them → they're learning from me. My session is mine.
        session_id = _session_id(week_ending, day_index, row["subject_user_id"])
        for learner_id in partner_ids:
            theirs = await _row(office_id, week_ending, day_index, learner_id)
            if theirs is None:
                await _write_row(base(learner_id, "learning", row.get("topic") or "",
                                      session_id, [row["subject_user_id"]]))
            elif theirs.get("session_id") == session_id:
                await db.primetime_entries.update_one(
                    {"id": theirs["id"]},
                    {"$set": {"topic": row.get("topic") or theirs.get("topic") or "",
                              "updated_at": now}},
                )
            # else: they already have a plan of their own. Leave it.
    return session_id


@router.put("/primetime/entry")
async def upsert_primetime_entry(body: EntryBody, request: Request):
    """Create or update one person's row for one day.

    Clearing the mode clears the row entirely — an empty toggle is how you
    say "nothing planned", and leaving a topic behind with no mode would be
    a ghost of a different kind.
    """
    me, office_id, subject, day_date = await _guard_write(
        request, body.office, body.subject_user_id, body.week_ending, body.day_index
    )

    mode = (body.mode or "").strip().lower() or None
    if mode is not None and mode not in MODES:
        raise HTTPException(status_code=400, detail=f"mode must be one of {', '.join(MODES)}")

    key = {
        "office_id": office_id,
        "week_ending": body.week_ending,
        "day_index": body.day_index,
        "subject_user_id": body.subject_user_id,
    }

    if mode is None:
        await db.primetime_entries.delete_many(key)
        return {"ok": True, "cleared": True}

    with_ids = [str(x) for x in (body.with_ids or [])][:MAX_WITH_IDS]
    name_by_id = await _snapshot_names(with_ids, office_id) if with_ids else {}
    # Silently drop ids that don't resolve in this office rather than 400 —
    # a counterpart who left mid-edit shouldn't block saving the row.
    with_ids = [uid for uid in with_ids if uid in name_by_id]

    existing = await db.primetime_entries.find_one(key)

    # A teaching row anchors its OWN session, derived from who is running it,
    # so it can never end up inside somebody else's block.
    if mode == "teaching":
        session_id = _session_id(body.week_ending, body.day_index, body.subject_user_id)
    else:
        # Learning/watching: an explicit join wins; otherwise, if a teacher is
        # named, leave it blank for the mirror to fill from THEM. Keeping the
        # old value here is what used to strand someone in a session they had
        # been moved out of.
        session_id = _s(body.session_id, 64)
        if not session_id and not with_ids:
            session_id = (existing or {}).get("session_id") or ""

    now = _now_iso()
    doc = {
        **key,
        "day_date": day_date,
        # Snapshot — this is the ghost record. Kept current on every write so
        # a rename propagates, but never re-derived on read.
        "subject_name": subject.get("name") or "",
        "mode": mode,
        "topic": _s(body.topic, MAX_TOPIC),
        "session_id": session_id,
        "with_ids": with_ids,
        "with_names": [name_by_id[uid] for uid in with_ids],
        "with_text": _s(body.with_text, MAX_WITH_TEXT),
        "updated_at": now,
        "updated_by_id": me["id"],
        "updated_by_name": me.get("name") or "",
    }
    # Naming a counterpart states a fact about both people, so fill in their
    # side too — and take back whichever session that lands us all on.
    doc["session_id"] = await _mirror_counterparts(
        office_id, body.week_ending, body.day_index, day_date, me, doc
    ) or session_id

    if existing:
        await db.primetime_entries.update_one({"id": existing["id"]}, {"$set": doc})
        doc["id"] = existing["id"]
        doc["created_at"] = existing.get("created_at") or now
    else:
        doc["id"] = str(uuid.uuid4())
        doc["created_at"] = now
        doc["created_by_id"] = me["id"]
        await db.primetime_entries.insert_one(dict(doc))

    return {"ok": True, "entry": _entry_out(doc)}


class JoinBody(BaseModel):
    session_id: str
    subject_user_id: str
    mode: Optional[str] = "learning"
    office: Optional[str] = None


@router.post("/primetime/session/join")
async def join_primetime_session(body: JoinBody, request: Request):
    """Add one of my people to a session someone else is running.

    This writes MY person's row — never the host's — so cross-team joining
    needs no write access to the other leader's team.
    """
    session_id = _s(body.session_id, 64)
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")

    mode = (body.mode or "learning").strip().lower()
    if mode not in ("learning", "watching"):
        raise HTTPException(status_code=400, detail="You can join a session as learning or watching")

    # The host row is looked up first because it, not the caller, decides which
    # week and day this join lands on.
    viewer = await require_admin_or_leader(request)
    office_id = await resolve_office_id(request, viewer, body.office)
    host = await db.primetime_entries.find_one(
        {"office_id": office_id, "session_id": session_id, "mode": "teaching"}
    )
    if not host:
        raise HTTPException(status_code=404, detail="That session no longer exists")

    me, office_id, subject, day_date = await _guard_write(
        request, body.office, body.subject_user_id, host["week_ending"], host["day_index"]
    )

    if host["subject_user_id"] == body.subject_user_id:
        raise HTTPException(status_code=400, detail="They are already running that session")

    host_name = host.get("subject_name") or ""
    now = _now_iso()
    key = {
        "office_id": office_id,
        "week_ending": host["week_ending"],
        "day_index": host["day_index"],
        "subject_user_id": body.subject_user_id,
    }
    existing = await db.primetime_entries.find_one(key)
    doc = {
        **key,
        "day_date": day_date,
        "subject_name": subject.get("name") or "",
        "mode": mode,
        "topic": host.get("topic") or "",
        "session_id": session_id,
        "with_ids": [host["subject_user_id"]],
        "with_names": [host_name],
        "with_text": "",
        "updated_at": now,
        "updated_by_id": me["id"],
        "updated_by_name": me.get("name") or "",
    }
    if existing:
        await db.primetime_entries.update_one({"id": existing["id"]}, {"$set": doc})
        doc["id"] = existing["id"]
    else:
        doc["id"] = str(uuid.uuid4())
        doc["created_at"] = now
        doc["created_by_id"] = me["id"]
        await db.primetime_entries.insert_one(dict(doc))

    return {"ok": True, "entry": _entry_out(doc)}


@router.delete("/primetime/entry")
async def clear_primetime_entry(request: Request, week_ending: str, day_index: int,
                                subject_user_id: str, office: Optional[str] = None):
    """Clear one person's row for one day."""
    _me, office_id, _subject, _day = await _guard_write(
        request, office, subject_user_id, week_ending, day_index
    )
    res = await db.primetime_entries.delete_many({
        "office_id": office_id,
        "week_ending": week_ending,
        "day_index": day_index,
        "subject_user_id": subject_user_id,
    })
    return {"ok": True, "deleted": res.deleted_count}
