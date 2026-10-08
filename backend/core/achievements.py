"""Achievement engine — real badges earned for real milestones.

Distinct from `routes/badges.py` (the admin-managed physical rep-ID-badge
catalog with QR codes). These are account-bound achievement unlocks stored
in `user_badges`, awarded idempotently from wherever the triggering event
already happens server-side (bells entry, hierarchy changes, promotions,
assessment grading, exam submit, streak activity).

Performance-first catalog (per the owner, 2026-07-12):
    day-sales ladder   sign-up(1) → bell(3) → gong(5) → superstar(10)
    personal weeks     Green Week (8+, the owner's What Good Looks Like
                       Green — core/week_bands.py) / 20 / 30 personal
                       sign-ups in one bells week
    leadership         Team Builder (someone reports to you),
                       Core Coach (someone on your team advances to Stage 3)
    team weeks         40 / 60 / 100 team sign-ups in a single week
    training           first Green day, all-Green Stage 1, first/perfect
                       module quiz, and Stage 2 / Stage 3 completion

    learning days      cumulative count of days with any Product Knowledge
                       activity — 1 / 5 / 10 / 25 / 50 / 100. Deliberately NOT a
                       streak: no consecutive-day requirement anywhere
                       (owner call, 2026-07-12 — rewarding unbroken daily
                       activity pressures people to never take a day off).

    award(user_id, key)  →  True if newly awarded, False if already earned
                             (or user_id/key missing) — safe to call on
                             every relevant write with no pre-check.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from database import db
from core.push import send_push_to_user
from core.week_bands import GREEN_WEEK_SALES

logger = logging.getLogger(__name__)

# Day-sales ladder — units in a single calendar day on the bells board.
# Vocabulary (owner-confirmed): bell = 3 sales/day, gong = 5, superstar = 10.
DAY_SALES_TIERS = [
    (1, "first_sale"),
    (3, "first_bell"),
    (5, "first_gong"),
    (10, "superstar_10"),
]

# Personal-week ladder. The first rung is the owner's Green Week (8+
# sign-ups — "What Good Looks Like"); 20 and 30 are stretch goals above it.
# The stored key stays "personal_12" (existing user_badges rows use it).
PERSONAL_WEEK_TIERS = [
    (GREEN_WEEK_SALES, "personal_12"),
    (20, "personal_20"),
    (30, "personal_30"),
]

# Team-week ladder — you + everyone under you, one bells week (Sunday ending).
TEAM_WEEK_TIERS = [
    (40, "team_40"),
    (60, "team_60"),
    (100, "team_100"),
]

# Learning-days ladder — lifetime count of days with any learning activity.
# A count, not a streak: days never need to be consecutive.
LEARNING_DAY_MILESTONES = [
    (1, "learn_1"),
    (5, "learn_5"),
    (10, "learn_10"),
    (25, "learn_25"),
    (50, "learn_50"),
    (100, "learn_100"),
]

MODULE_STAGE_KEYS = {
    2: "stage2_complete",
    3: "stage3_complete",
}

ACHIEVEMENTS = [
    # ── Day-sales ladder ──────────────────────────────────────────────────
    {"key": "first_sale", "title": "First Sign-up", "subtitle": "You got your first sign-up.", "emoji": "🎉",
     "how": "Get your first sign-up. It counts as soon as the day's sign-ups are logged on the Bells board."},
    {"key": "first_bell", "title": "First Bell", "subtitle": "3 sign-ups in one day.", "emoji": "🔔",
     "how": "Ring the bell — 3 sign-ups in a single day."},
    {"key": "first_gong", "title": "First Gong", "subtitle": "5 sign-ups in one day.", "emoji": "🥁",
     "how": "Bang the gong — 5 sign-ups in a single day."},
    {"key": "superstar_10", "title": "Superstar", "subtitle": "10 sign-ups in one day.", "emoji": "🌟",
     "how": "10 sign-ups in a single day. Rare air — the whole office hears about this one."},
    # ── Personal weeks ──────────────────────────────────────────────────
    {"key": "personal_12", "title": "Green Week", "subtitle": f"{GREEN_WEEK_SALES} sign-ups in one week.", "emoji": "🟢",
     "how": f"Log {GREEN_WEEK_SALES} or more personal sign-ups in a single Bells week — Green, meeting the standard."},
    {"key": "personal_20", "title": "High Roller", "subtitle": "20 sign-ups in one week.", "emoji": "🎯",
     "how": "Log 20 personal sign-ups in a single Bells week."},
    {"key": "personal_30", "title": "Thirty Club", "subtitle": "30 sign-ups in one week.", "emoji": "💎",
     "how": "Log 30 personal sign-ups in a single Bells week."},
    # ── Leadership ────────────────────────────────────────────────────────
    {"key": "team_builder", "title": "Team Builder", "subtitle": "Someone joined your team.", "emoji": "🤝",
     "how": "Become someone's coach — have your first new BA assigned to you."},
    {"key": "core_leader", "title": "Core Coach", "subtitle": "Someone you coach reached Stage 3.", "emoji": "👑",
     "how": "Have someone on your team advance to Stage 3. Developing leaders is the real game."},
    # ── Team weeks ────────────────────────────────────────────────────────
    {"key": "team_40", "title": "Team 40", "subtitle": "40 team sign-ups in a week.", "emoji": "🚀",
     "how": "You and everyone in your team combine for 40+ sign-ups in a single week."},
    {"key": "team_60", "title": "Team 60", "subtitle": "60 team sign-ups in a week.", "emoji": "⚡",
     "how": "You and everyone in your team combine for 60+ sign-ups in a single week."},
    {"key": "team_100", "title": "Team 100", "subtitle": "100 team sign-ups in a week.", "emoji": "🏆",
     "how": "You and everyone in your team combine for 100+ sign-ups in a single week. Office legend status."},
    # ── Coaching & learning ───────────────────────────────────────────────
    {"key": "green_day", "title": "Green Day", "subtitle": "Earned a Green assessment.", "emoji": "✅",
     "how": "Complete any Stage 1 day assessment with an overall score of 9 or higher."},
    {"key": "stage1_complete", "title": "Stage 1 Graduate", "subtitle": "Completed your first 8 days.", "emoji": "🏁",
     "how": "Complete all of your first 8 days — 2 BA Academy days plus 6 field days. Your scores don't need to be perfect, just finished."},
    {"key": "stage1_green", "title": "Eight Days Green", "subtitle": "Finished all 8 days Green.", "emoji": "🟩",
     "how": "Complete all 8 Stage 1 days with an overall score of 9 or higher on every day."},
    {"key": "quiz_pass", "title": "Knowledge Check", "subtitle": "Passed your first module quiz.", "emoji": "✏️",
     "how": "Pass any Stage 2 or Stage 3 module quiz."},
    {"key": "quiz_perfect", "title": "Perfect Recall", "subtitle": "Perfect score on a module quiz.", "emoji": "💯",
     "how": "Answer every question correctly on a Stage 2 or Stage 3 module quiz."},
    {"key": "stage2_complete", "title": "Independent", "subtitle": "Completed every Stage 2 module.", "emoji": "🧭",
     "how": "Complete every Independence-stage development module assigned to your office."},
    {"key": "stage3_complete", "title": "Leadership Graduate", "subtitle": "Completed every Stage 3 module.", "emoji": "🏛️",
     "how": "Complete every Leadership-stage development module assigned to your office."},
    {"key": "exam_90", "title": "Campaign Pro", "subtitle": "Scored 90%+ on the Campaign Knowledge exam.", "emoji": "🧠",
     "how": "Score 90% or higher on the Campaign Knowledge exam."},
    {"key": "learn_1", "title": "First Learning Day", "subtitle": "Learnt in the app for the first time.", "emoji": "🌱",
     "how": "Complete a Campaign Knowledge lesson, quiz, or exam activity. This is a lifetime total, not a daily streak."},
    {"key": "learn_5", "title": "Learning Momentum", "subtitle": "5 learning days.", "emoji": "📘",
     "how": "Learn in the app on 5 different days. The days never need to be consecutive."},
    {"key": "learn_10", "title": "Bookworm", "subtitle": "10 learning days.", "emoji": "📖",
     "how": "Learn in the app on 10 different days — a lesson, a quiz, or the exam. They don't need to be in a row."},
    {"key": "learn_25", "title": "Scholar", "subtitle": "25 learning days.", "emoji": "📚",
     "how": "Learn in the app on 25 different days, whenever suits you — no streaks required."},
    {"key": "learn_50", "title": "Brainiac", "subtitle": "50 learning days.", "emoji": "💡",
     "how": "Learn in the app on 50 different days, at your own pace."},
    {"key": "learn_100", "title": "Professor", "subtitle": "100 learning days.", "emoji": "🎓",
     "how": "Learn in the app on 100 different days. Take weekends off — the count never resets."},
    # ── Sales Proficiency Ladder (core/sales_path.py) ─────────────────────
    # MUST live in this catalog: _cleanup() below deletes any user_badges row
    # whose key it doesn't know, on every boot. Levels 2–4 auto-award from
    # bells data; Expert is coach-signed and Mastery admin-signed. These keys
    # are deliberately NOT in PERSONAL_SALES_KEYS — corrections go through
    # the admin revoke endpoint (a data-correction with a reason), never a
    # silent reconcile.
    {"key": "sales_competency", "title": "Competency", "subtitle": "Your first Green Week.", "emoji": "🥉",
     "how": f"Get your first Green Week ({GREEN_WEEK_SALES}+ sign-ups) after your first 8 days, with your Stage 1 sales skills signed off by your coach."},
    {"key": "sales_proficiency", "title": "Proficiency", "subtitle": "Green Weeks are your normal.", "emoji": "🥈",
     "how": "Three Green Weeks, 2+ sign-ups on 7 out of your last 10 days, and your Stage 2 sales skills signed off."},
    {"key": "sales_advanced", "title": "Advanced", "subtitle": "2+ sign-ups on 8 out of your last 10 days.", "emoji": "🥇",
     "how": "2+ sign-ups on 8 out of your last 10 days, averaging 3 sign-ups a day over your last 20 days out."},
    {"key": "sales_expert", "title": "Expert", "subtitle": "9 of 10, held and signed.", "emoji": "🏅",
     "how": "2+ sign-ups on 9 out of 10 days for two months straight — then a coach signs it."},
    {"key": "sales_mastery", "title": "Mastery", "subtitle": "The standard others learn from.", "emoji": "🐐",
     "how": "Hold Expert level for 12+ weeks and pass it on — coach someone to their first Green Week. Signed by an admin."},
]

ACHIEVEMENTS_BY_KEY = {a["key"]: a for a in ACHIEVEMENTS}


async def award(user_id: str, key: str, notify: bool = True, seen: bool = False) -> bool:
    """Atomically insert a user_badges row if not already earned.

    Returns True if this call newly awarded the badge (so the caller can
    decide whether to push), False if already earned or the key/user_id
    is invalid. Safe to call unconditionally on every relevant event.
    Backfills pass notify=False, seen=True: retroactive recognition should
    appear quietly on the profile, not spam pushes or replay celebrations.
    """
    if not user_id:
        return False
    meta = ACHIEVEMENTS_BY_KEY.get(key)
    if not meta:
        return False
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        **meta,
        "earned_at": datetime.now(timezone.utc).isoformat(),
        "seen": seen,
    }
    try:
        result = await db.user_badges.update_one(
            {"user_id": user_id, "key": key},
            {"$setOnInsert": doc},
            upsert=True,
        )
    except DuplicateKeyError:
        # A concurrent request won the unique (user_id, key) insert race.
        return False
    if result.upserted_id is None:
        return False
    if notify:
        try:
            await send_push_to_user(
                user_id,
                f"{meta['emoji']} {meta['title']}",
                meta["subtitle"],
                {"type": "badge_earned", "key": key},
            )
        except Exception:
            pass  # push is best-effort; the badge itself is already saved
    return True


def _number(value, default=0):
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def _day_units(day: dict) -> float:
    """Count real sales on a worked day; memberships are add-ons, not sales."""
    if (day or {}).get("status") != "in":
        return 0
    return max(0, _number(day.get("over30")) + _number(day.get("under30")))


def _sales_badge_keys(days: list[dict]) -> list[str]:
    """Return all daily and personal-week keys reached by a stored week."""
    daily_sales = [_day_units(day) for day in (days or [])]
    best_day = max(daily_sales, default=0)
    week_total = sum(daily_sales)
    keys = [key for threshold, key in DAY_SALES_TIERS if best_day >= threshold]
    keys.extend(key for threshold, key in PERSONAL_WEEK_TIERS if week_total >= threshold)
    return keys


async def award_day_sales(user_id: str, day_units: int, notify: bool = True, seen: bool = False) -> None:
    """Award every day-sales tier the given single-day unit count reaches."""
    if not user_id or day_units <= 0:
        return
    for threshold, key in DAY_SALES_TIERS:
        if day_units >= threshold:
            await award(user_id, key, notify=notify, seen=seen)


async def award_sales_milestones(
    user_id: str,
    days: list[dict],
    notify: bool = True,
    seen: bool = False,
) -> dict[str, bool]:
    """Award daily + personal-week sales tiers from the post-write week."""
    results: dict[str, bool] = {}
    for key in _sales_badge_keys(days):
        results[key] = await award(user_id, key, notify=notify, seen=seen)
    return results


async def award_learning_days(user_id: str, total: int, notify: bool = True, seen: bool = False) -> None:
    """Award every learning-days milestone the lifetime total has reached."""
    if not user_id or total <= 0:
        return
    for threshold, key in LEARNING_DAY_MILESTONES:
        if total >= threshold:
            await award(user_id, key, notify=notify, seen=seen)


def _stage1_badge_keys(assessments: list[dict]) -> list[str]:
    """Derive Stage 1 completion/mastery keys from completed day records."""
    best_score_by_day: dict[int, float | None] = {}
    for assessment in assessments or []:
        if not assessment.get("completed"):
            continue
        try:
            day = int(assessment.get("day_number"))
        except (TypeError, ValueError):
            continue
        if day not in range(1, 9):
            continue
        score = _number(assessment.get("overall_score"), None)
        previous = best_score_by_day.get(day)
        if day not in best_score_by_day or (score is not None and (previous is None or score > previous)):
            best_score_by_day[day] = score

    keys: list[str] = []
    if any(score is not None and score >= 9 for score in best_score_by_day.values()):
        keys.append("green_day")
    if all(day in best_score_by_day for day in range(1, 9)):
        keys.append("stage1_complete")
        if all(best_score_by_day[day] is not None and best_score_by_day[day] >= 9 for day in range(1, 9)):
            keys.append("stage1_green")
    return keys


async def award_stage1_milestones(
    new_hire_id: str,
    user_id: str,
    notify: bool = True,
    seen: bool = False,
) -> dict[str, bool]:
    """Award every Stage 1 milestone supported by the hire's assessments."""
    if not new_hire_id or not user_id:
        return {}
    assessments = await db.daily_assessments.find(
        {"new_hire_id": new_hire_id, "day_number": {"$gte": 1, "$lte": 8}, "completed": True},
        {"_id": 0, "day_number": 1, "completed": 1, "overall_score": 1},
    ).to_list(20)
    results: dict[str, bool] = {}
    for key in _stage1_badge_keys(assessments):
        results[key] = await award(user_id, key, notify=notify, seen=seen)
    return results


def _quiz_badge_keys(score: int, total: int, passed: bool) -> list[str]:
    keys: list[str] = []
    perfect = total > 0 and score == total
    if passed or perfect:
        keys.append("quiz_pass")
    if perfect:
        keys.append("quiz_perfect")
    return keys


async def award_quiz_badges(
    user_id: str,
    score: int,
    total: int,
    passed: bool,
    stage: int,
    notify: bool = True,
    seen: bool = False,
) -> dict[str, bool]:
    """Award first-pass/perfect-quiz milestones from server-graded results."""
    if stage not in MODULE_STAGE_KEYS:
        return {}
    results: dict[str, bool] = {}
    for key in _quiz_badge_keys(score, total, passed):
        results[key] = await award(user_id, key, notify=notify, seen=seen)
    return results


async def award_module_stage_completion(
    user_id: str,
    stage: int,
    notify: bool = True,
    seen: bool = False,
) -> bool:
    """Award Stage 2/3 completion once every current office module is done."""
    key = MODULE_STAGE_KEYS.get(stage)
    if not user_id or not key:
        return False
    try:
        user = await db.users.find_one({"_id": ObjectId(user_id)}, {"office_id": 1})
    except Exception:
        user = await db.users.find_one({"id": user_id}, {"office_id": 1})
    if not user:
        return False

    office_id = user.get("office_id")
    required_ids = {
        module_id
        for module_id in await db.training_modules.distinct("id", {"stage": stage, "office_id": office_id})
        if module_id
    }
    if not required_ids and office_id is not None:
        required_ids = {
            module_id
            for module_id in await db.training_modules.distinct("id", {"stage": stage, "office_id": None})
            if module_id
        }
    if not required_ids:
        return False

    completed_ids = set(await db.module_progress.distinct(
        "module_id",
        {
            "module_id": {"$in": list(required_ids)},
            "completed": True,
            "$or": [
                {"target_user_id": user_id},
                {"target_user_id": {"$exists": False}, "user_id": user_id},
            ],
        },
    ))
    if not required_ids.issubset(completed_ids):
        return False
    return await award(user_id, key, notify=notify, seen=seen)


async def award_upline_core_leader(leader_user_id: str, notify: bool = True, seen: bool = False) -> None:
    """Someone just became (or turned out to be) a leader — everyone above
    them in the reports_to chain now 'has a leader on their team'."""
    visited: set = set()
    current = leader_user_id
    for _ in range(20):  # hard cap; hierarchy is shallow
        try:
            doc = await db.users.find_one({"_id": ObjectId(current)}, {"reports_to": 1})
        except Exception:
            return
        parent = (doc or {}).get("reports_to")
        if not parent or parent in visited:
            return
        visited.add(parent)
        await award(parent, "core_leader", notify=notify, seen=seen)
        current = parent


async def award_team_week_badges(week_ending: str | None = None, notify: bool = True, seen: bool = False) -> None:
    """Award team-week tiers to every user with a team (>=1 direct report)
    whose subtree total for a week reaches a threshold.

    week_ending=None scans ALL weeks (backfill); a specific Sunday scans just
    that week (the hourly scheduler job). Team = the leader + their whole
    subtree, same rollup as the bells Team view.
    """
    from auth import get_subtree_ids

    q: dict = {"week_ending": week_ending} if week_ending else {}
    # (week, user_id) → units
    totals: dict = {}
    async for e in db.bells_entries.find(q, {"_id": 0, "user_id": 1, "week_ending": 1, "days": 1}):
        uid, we = e.get("user_id"), e.get("week_ending")
        if not uid or not we:
            continue
        units = sum(_day_units(d) for d in (e.get("days") or []))
        if units:
            totals[(we, uid)] = totals.get((we, uid), 0) + units
    if not totals:
        return

    weeks = {we for (we, _uid) in totals}
    team_leads = [
        parent_id
        for parent_id in await db.users.distinct(
            "reports_to",
            {"deleted": {"$ne": True}, "is_active": {"$ne": False}},
        )
        if parent_id
    ]
    for lead_id in team_leads:
        subtree = set(await get_subtree_ids(lead_id))
        for we in weeks:
            team_total = sum(units for (w, uid), units in totals.items() if w == we and uid in subtree)
            for threshold, key in TEAM_WEEK_TIERS:
                if team_total >= threshold:
                    await award(lead_id, key, notify=notify, seen=seen)


# ── Revocation ──────────────────────────────────────────────────────────────
# The engine is award-only, so a badge earned from a mis-keyed entry survives
# the correction (a leader fat-fingers a 5-sale day → First Gong fires → the day
# is fixed to 2 → the badge just stays). These reconcile passes recompute the
# affected badges straight from the current bells_entries and silently drop any
# whose threshold the data no longer supports. Only the sales/team badges — pure
# functions of the bells board — are revocable this way; learning, leadership,
# and training badges are historical facts and are never touched here.
PERSONAL_SALES_KEYS = frozenset(key for _t, key in (*DAY_SALES_TIERS, *PERSONAL_WEEK_TIERS))
TEAM_SALES_KEYS = frozenset(key for _t, key in TEAM_WEEK_TIERS)


async def _self_and_upline(user_id: str) -> list[str]:
    """The user plus every leader above them in the reports_to chain.

    A correction to this rep's sales changes their own personal badges and the
    team-week total of every ancestor, so all of them need reconciling.
    """
    chain = [user_id]
    visited = {user_id}
    current = user_id
    for _ in range(20):  # hard cap; hierarchy is shallow
        try:
            doc = await db.users.find_one({"_id": ObjectId(current)}, {"reports_to": 1})
        except Exception:
            break
        parent = (doc or {}).get("reports_to")
        if not parent or parent in visited:
            break
        visited.add(parent)
        chain.append(parent)
        current = parent
    return chain


async def reconcile_sales_badges(user_id: str) -> list[str]:
    """Silently revoke any personal sales badge the rep no longer qualifies for.

    Recomputes their best-ever single day and best-ever bells week across every
    bells_entries row, then deletes any day-sales / personal-week badge whose
    threshold that best no longer reaches. Purely derived from the source of
    truth, so it can't over-delete: a badge only goes when the data genuinely
    stopped supporting it. No push — a correction shouldn't fire a demoralizing
    "badge removed" notification. Returns the revoked keys (empty if unchanged).
    """
    if not user_id:
        return []
    # Cheap guard: skip the full recompute unless the rep actually holds a
    # revocable sales badge.
    held = set(await db.user_badges.distinct(
        "key", {"user_id": user_id, "key": {"$in": list(PERSONAL_SALES_KEYS)}}
    ))
    if not held:
        return []

    best_day = 0.0
    weekly_totals: dict[str, float] = {}
    async for e in db.bells_entries.find(
        {"user_id": user_id}, {"_id": 0, "week_ending": 1, "days": 1}
    ):
        week_total = 0.0
        for d in (e.get("days") or []):
            u = _day_units(d)
            week_total += u
            if u > best_day:
                best_day = u
        week = e.get("week_ending")
        if week:
            weekly_totals[week] = weekly_totals.get(week, 0.0) + week_total
    best_week = max(weekly_totals.values(), default=0.0)

    qualified = {key for threshold, key in DAY_SALES_TIERS if best_day >= threshold}
    qualified |= {key for threshold, key in PERSONAL_WEEK_TIERS if best_week >= threshold}
    stale = sorted(held - qualified)
    if not stale:
        return []
    await db.user_badges.delete_many({"user_id": user_id, "key": {"$in": stale}})
    logger.info(f"reconcile_sales_badges: revoked {stale} for user {user_id}")
    return stale


async def reconcile_team_badges(leader_id: str) -> list[str]:
    """Silently revoke any team-week badge this leader no longer qualifies for.

    Recomputes the leader's best-ever single-week subtree total (self + every
    report, same rollup as the bells Team view) and drops any team tier that
    best no longer reaches. Returns the revoked keys (empty if unchanged).
    """
    if not leader_id:
        return []
    held = set(await db.user_badges.distinct(
        "key", {"user_id": leader_id, "key": {"$in": list(TEAM_SALES_KEYS)}}
    ))
    if not held:
        return []  # not a team-badge holder — skip the expensive subtree scan

    from auth import get_subtree_ids
    subtree = list(set(await get_subtree_ids(leader_id)))
    weekly_totals: dict[str, float] = {}
    async for e in db.bells_entries.find(
        {"user_id": {"$in": subtree}}, {"_id": 0, "week_ending": 1, "days": 1}
    ):
        week = e.get("week_ending")
        if not week:
            continue
        weekly_totals[week] = weekly_totals.get(week, 0.0) + sum(
            _day_units(d) for d in (e.get("days") or [])
        )
    best_week = max(weekly_totals.values(), default=0.0)

    qualified = {key for threshold, key in TEAM_WEEK_TIERS if best_week >= threshold}
    stale = sorted(held - qualified)
    if not stale:
        return []
    await db.user_badges.delete_many({"user_id": leader_id, "key": {"$in": stale}})
    logger.info(f"reconcile_team_badges: revoked {stale} for leader {leader_id}")
    return stale


async def reconcile_sales_and_team_badges(user_id: str) -> dict[str, list[str]]:
    """Full post-correction reconcile: the rep's own personal sales badges plus
    the team-week badges of the rep and every leader above them.

    Call after any bells write. Cheap when nothing is stale (each user is a
    single indexed lookup that bails before the recompute). Returns
    {user_id: [revoked keys]} for whatever actually changed.
    """
    if not user_id:
        return {}
    revoked: dict[str, list[str]] = {}
    personal = await reconcile_sales_badges(user_id)
    if personal:
        revoked[user_id] = list(personal)
    for lead_id in await _self_and_upline(user_id):
        team = await reconcile_team_badges(lead_id)
        if team:
            revoked.setdefault(lead_id, []).extend(team)
    return revoked


async def backfill_achievements() -> dict:
    """Retroactively award achievements from historical data.

    Idempotent — runs on every boot from startup_seed, so an Emergent
    redeploy heals prod without shell access (same pattern as
    cleanup_promoted_hires / backfill_row_offices). Awards are silent
    (no push, seen=True): people who sold weeks ago shouldn't get a
    "you just earned this!" moment; the badge simply appears on their
    profile. Everything earned from now on celebrates live as usual.
    """
    counts: dict = {}

    def _bump(key: str, newly: bool):
        if newly:
            counts[key] = counts.get(key, 0) + 1

    # Each section is isolated: a bug or bad row in one (e.g. a malformed
    # bells_entries doc) must not silently prevent every OTHER section from
    # awarding — that was the previous failure mode (one exception aborted
    # the whole function, and startup_seed's outer try/except swallowed it
    # with no indication of how far backfill actually got).
    async def _section(name: str, coro):
        try:
            await coro
        except Exception:
            logger.exception(f"backfill_achievements: '{name}' section failed (continuing)")

    # Retired catalog keys (e.g. the old streak badges) shouldn't linger as
    # invisible rows.
    async def _cleanup():
        res = await db.user_badges.delete_many({"key": {"$nin": list(ACHIEVEMENTS_BY_KEY.keys())}})
        if res.deleted_count:
            logger.info(f"backfill_achievements: removed {res.deleted_count} retired badge row(s)")
        await db.user_badges.delete_many({
            "$or": [
                {"user_id": {"$exists": False}},
                {"user_id": {"$in": [None, ""]}},
            ],
        })
        duplicate_groups = db.user_badges.aggregate([
            {"$sort": {"earned_at": 1, "_id": 1}},
            {"$group": {
                "_id": {"user_id": "$user_id", "key": "$key"},
                "ids": {"$push": "$_id"},
                "count": {"$sum": 1},
            }},
            {"$match": {"count": {"$gt": 1}}},
        ])
        async for group in duplicate_groups:
            await db.user_badges.delete_many({"_id": {"$in": group["ids"][1:]}})
        # Badge rows snapshot the catalog meta at award time ($setOnInsert),
        # so wording edits never reach already-earned badges. Re-sync the
        # display fields from the current catalog — earned_at/seen untouched.
        for meta in ACHIEVEMENTS:
            await db.user_badges.update_many(
                {"key": meta["key"]},
                {"$set": {k: meta[k] for k in ("title", "subtitle", "emoji", "how")}},
            )
        await db.user_badges.create_index(
            [("user_id", 1), ("key", 1)],
            unique=True,
            name="unique_user_achievement",
        )
    await _section("cleanup_retired_keys", _cleanup())

    # ── Personal sales — best day + every historical bells week ───────
    async def _sales_milestones():
        best_day: dict = {}
        weekly_totals: dict = {}
        async for e in db.bells_entries.find(
            {}, {"_id": 0, "user_id": 1, "week_ending": 1, "days": 1}
        ):
            uid = e.get("user_id")
            if not uid:
                continue
            week_total = 0
            for d in (e.get("days") or []):
                u = _day_units(d)
                week_total += u
                if u > best_day.get(uid, 0):
                    best_day[uid] = u
            week = e.get("week_ending")
            if week and week_total:
                weekly_totals[(uid, week)] = weekly_totals.get((uid, week), 0) + week_total
        for uid, units in best_day.items():
            for threshold, key in DAY_SALES_TIERS:
                if units >= threshold:
                    _bump(key, await award(uid, key, notify=False, seen=True))
        for (uid, _week), units in weekly_totals.items():
            for threshold, key in PERSONAL_WEEK_TIERS:
                if units >= threshold:
                    _bump(key, await award(uid, key, notify=False, seen=True))
    await _section("sales_milestones", _sales_milestones())

    # ── Team Builder — anyone who has ever had a direct report ───────────
    async def _team_builder():
        for parent_id in await db.users.distinct("reports_to"):
            if parent_id:
                _bump("team_builder", await award(parent_id, "team_builder", notify=False, seen=True))
    await _section("team_builder", _team_builder())

    # ── Core Leader — every ancestor of every current leader/admin ───────
    async def _core_leader():
        async for u in db.users.find(
            {"role": {"$in": ["leader", "admin"]}, "reports_to": {"$nin": [None, ""]}, "deleted": {"$ne": True}},
            {"_id": 1},
        ):
            await award_upline_core_leader(str(u["_id"]), notify=False, seen=True)
        counts["core_leader"] = await db.user_badges.count_documents({"key": "core_leader"})
    await _section("core_leader", _core_leader())

    # ── Team weeks — every historical bells week ──────────────────────────
    await _section("team_weeks", award_team_week_badges(None, notify=False, seen=True))

    # ── Stage 1 — Green day, completion, and all-Green mastery ───────
    async def _stage1_milestones():
        async for hire in db.new_hires.find(
            {"trainee_user_id": {"$nin": [None, ""]}}, {"_id": 0, "id": 1, "trainee_user_id": 1}
        ):
            results = await award_stage1_milestones(
                hire["id"], hire["trainee_user_id"], notify=False, seen=True
            )
            for key, newly in results.items():
                _bump(key, newly)
    await _section("stage1_milestones", _stage1_milestones())

    # ── Module quizzes — persisted pass/perfect results ──────────────────
    async def _module_quizzes():
        async for progress in db.module_progress.find(
            {
                "stage": {"$in": list(MODULE_STAGE_KEYS)},
                "$or": [{"quiz_passed": True}, {"quiz_total": {"$gt": 0}}],
            },
            {
                "_id": 0, "target_user_id": 1, "user_id": 1, "stage": 1,
                "quiz_score": 1, "quiz_total": 1, "quiz_passed": 1,
            },
        ):
            uid = progress.get("target_user_id") or progress.get("user_id")
            if not uid:
                continue
            results = await award_quiz_badges(
                uid,
                int(progress.get("quiz_score") or 0),
                int(progress.get("quiz_total") or 0),
                bool(progress.get("quiz_passed")),
                int(progress["stage"]),
                notify=False,
                seen=True,
            )
            for key, newly in results.items():
                _bump(key, newly)
    await _section("module_quizzes", _module_quizzes())

    # ── Module stages — all current office modules completed ─────────────
    async def _module_stages():
        candidates: set[str] = set()
        async for progress in db.module_progress.find(
            {"completed": True}, {"_id": 0, "target_user_id": 1, "user_id": 1}
        ):
            uid = progress.get("target_user_id") or progress.get("user_id")
            if uid:
                candidates.add(uid)
        for uid in candidates:
            for stage, key in MODULE_STAGE_KEYS.items():
                newly = await award_module_stage_completion(uid, stage, notify=False, seen=True)
                _bump(key, newly)
    await _section("module_stages", _module_stages())

    # ── exam_90 — any submitted attempt at 90%+ ──────────────────────────
    async def _exam_90():
        for uid in await db.product_exam_attempts.distinct("user_id", {"score_pct": {"$gte": 90}}):
            if uid:
                _bump("exam_90", await award(uid, "exam_90", notify=False, seen=True))
    await _section("exam_90", _exam_90())

    # ── learning days — seed totals from legacy streak data + award ──────
    # Best-ever consecutive streak is a lower bound on true learning days
    # (per-day history was never kept); learning_days.total wins once set.
    async def _learning_days():
        async for u in db.users.find(
            {"$or": [{"learning_days.total": {"$gt": 0}}, {"learning_streak": {"$exists": True}}], "deleted": {"$ne": True}},
            {"learning_days": 1, "learning_streak": 1},
        ):
            ld = u.get("learning_days") or {}
            legacy = u.get("learning_streak") or {}
            total = max(int(ld.get("total") or 0), int(legacy.get("best") or 0), int(legacy.get("count") or 0))
            if total <= 0:
                continue
            if total > int(ld.get("total") or 0):
                await db.users.update_one(
                    {"_id": u["_id"]},
                    {"$set": {"learning_days": {"total": total, "last_date": ld.get("last_date") or legacy.get("last_date") or None}}},
                )
            await award_learning_days(str(u["_id"]), total, notify=False, seen=True)
    await _section("learning_days", _learning_days())

    # ── Revoke stale sales/team badges ───────────────────────────────────
    # Runs last, after every award section has re-granted what the data still
    # supports, so this only removes badges left behind by a downward
    # correction (the mis-keyed-First-Gong case). Self-heals prod on boot with
    # no shell access, same as the award backfill above.
    async def _revoke_stale():
        for uid in await db.user_badges.distinct("user_id", {"key": {"$in": list(PERSONAL_SALES_KEYS)}}):
            for key in await reconcile_sales_badges(uid):
                counts[f"-{key}"] = counts.get(f"-{key}", 0) + 1
        for uid in await db.user_badges.distinct("user_id", {"key": {"$in": list(TEAM_SALES_KEYS)}}):
            for key in await reconcile_team_badges(uid):
                counts[f"-{key}"] = counts.get(f"-{key}", 0) + 1
    await _section("revoke_stale_sales", _revoke_stale())

    logger.info(f"backfill_achievements done — awarded: {counts or 'nothing new'}")
    return counts
