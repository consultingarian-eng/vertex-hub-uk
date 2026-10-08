"""Sales Development Path engine — 30-day ramp + Sales Proficiency Ladder.

Two ladders, one person: the COD business-development stages (leadership can
move fast) and this sales proficiency ladder (sales mastery compounds over
time), with a 30-day ramp-up runway at the front that gets a new starter
to their first Green Week (8+ sign-ups — the owner's "What Good Looks Like"
Green, core/week_bands.py). Principle: skill = demonstrated capability, not
tenure or title.

Everything here is a pure derivation over bells_entries + module_progress —
this module never becomes a second sales record. Full design + the reasoning
behind every rule: docs/sales-development-path.md.

Levels (names verbatim from the slide):
    1 Beginner      default at provisioning
    2 Competency    first Green Week (8+) after training, + Stage-1
                    Commercial Craft at Deliver
    3 Proficiency   3+ Green Weeks, scoring ≥70% and piece average ≥3.0 over
                    the trailing 20 field days, + Stage-2 Commercial Craft
                    at Deliver
    4 Advanced      scoring ≥80% and piece average ≥3.0 over the trailing 20
                    field days (2+ sales on 8 of your last 10)
    5 Expert        scoring ≥90% and piece average ≥3.0 over two consecutive
                    non-overlapping 30-field-day windows — DATA-ELIGIBLE
                    only; the level itself is coach-signed
    6 Mastery       Expert signed 84+ days ago, Expert data re-met at check
                    time, plus a contribution — coach + admin signed

Levels are high-water marks: recompute never lowers a stored level (admin
data-correction revoke is the only way down). Auto-award stops at Advanced —
bells numbers are hand-typed by leaders, so the top two levels get the same
treatment COD gives Deliver+: a human signs them.

Windows use trailing FIELD DAYS (bells "in" days), matching "8 out of 10
days in any territory" — not calendar luck. A trailing-N-day criterion is
NOT met unless N such days exist inside the recency bound: never evaluate
over a smaller denominator ("window unsatisfied" means false, not vacuously
true).
"""
from __future__ import annotations

import logging
import math
import os
import uuid
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from database import db
from core.app_time import APP_TZ
from core.week_bands import GREEN_WEEK_SALES, RED_EXIT_WEEK_SALES, SUPER_GREEN_WEEK_SALES, AMBER_WEEK_SALES

logger = logging.getLogger(__name__)

# ── Feature flag ────────────────────────────────────────────────────────────
# Ships dark, CI-style (routes registered, 403 until enabled), plus an office
# allowlist the CI precedent lacks so one office can go first:
#   SALES_PATH_ENABLED=true             master switch
#   SALES_PATH_OFFICES=<id>,<id>        optional allowlist; empty = all offices


def sales_path_enabled() -> bool:
    return (os.environ.get("SALES_PATH_ENABLED") or "").strip().lower() in {"1", "true", "yes", "on"}


def sales_path_office_enabled(office_id: str | None) -> bool:
    if not sales_path_enabled():
        return False
    allow = [x.strip() for x in (os.environ.get("SALES_PATH_OFFICES") or "").split(",") if x.strip()]
    return True if not allow else (office_id in allow)


# ── Constants ───────────────────────────────────────────────────────────────

# The company-wide "Green" weekly threshold (GREEN_WEEK_SALES, imported
# above) is the owner's What Good Looks Like Green: 8+ sign-ups in a week.
# Bells' green %, the Green Week badge and this ramp all read the one
# constant in core/week_bands.py.

# A field day only SCORES when it produces 2+ sales — the industry minimum
# (owner, 2026-09-11: "not sure why doing 1 is part of reward"). One sale on
# a day is a day worked, never a day scored. Copy says "2+ sales on N of
# your last M days" — the word "close" is banned in this feature (it reads
# as jargon; the org says Sale/Sales).
MIN_SCORED_DAY_SALES = 2

LEVELS = {
    2: {"key": "competency", "name": "Competency"},
    3: {"key": "proficiency", "name": "Proficiency"},
    4: {"key": "advanced", "name": "Advanced"},
    5: {"key": "expert", "name": "Expert"},
    6: {"key": "mastery", "name": "Mastery"},
}
LEVEL_NAMES = {1: "Beginner", **{n: v["name"] for n, v in LEVELS.items()}}
LEVEL_BADGE_KEYS = {n: f"sales_{v['key']}" for n, v in LEVELS.items()}

# Typical week ranges, verbatim from the "Two ladders. One person." slide.
# Expectation-setting copy ONLY — never gates. They overlap deliberately, and
# their job in the UI is long-term framing: decent comes in weeks, great is
# built over months, so a new hire stops judging themselves on week one.
# Halved on the owner's call (2026-09-14): the old bands were too pessimistic and
# read as "this will take you a year" on the map. Rounded to whole weeks.
# Was {1: "1–6", 2: "3–20", 3: "8–50", 4: "20–50", 5: "25–75", 6: "50–200"}.
TYPICAL_WEEKS = {1: "1–3", 2: "2–10", 3: "4–25", 4: "10–25", 5: "13–38", 6: "25–100"}

PROFICIENCY_GREEN_WEEKS = 3
# Green (8+/week) is the MINIMUM standard (the ramp graduates through it),
# so the ladder above Competency runs at 3.0 sign-ups per day worked — the
# owner's daily minimum of 3 sign-ups a day from Day 4 (seed_data.DAY_TARGETS).
# What separates the top levels is consistency (the scoring bar), not pace.
THRESHOLDS = {
    3: {"scoring_pct": 70, "piece_avg": 3.0, "window": 20},
    4: {"scoring_pct": 80, "piece_avg": 3.0, "window": 20},
    5: {"scoring_pct": 90, "piece_avg": 3.0, "window": 30},
}
# Recency bounds, ANCHORED AT TODAY: the window's oldest field day must fall
# inside this many calendar days of today (app time), so a long-absent rep isn't
# graded (or shown "current form") on months-old data. 20-day windows → 16
# weeks; 30-day → 24 weeks. Expert's second, non-overlapping window gets 2×
# its bound (it sits behind the first).
WINDOW_RECENCY_DAYS = {20: 16 * 7, 30: 24 * 7}

# Training-cutoff fallbacks for hires whose day-8 assessment has no usable
# date (pass-off and promotion auto-complete historically didn't stamp one)
# or was never graded at all. Both must be FIXED dates — a fallback that
# moves with "today" makes the Green Week cutoff unsatisfiable forever.
TRAINING_ALLOWANCE_DAYS = 13   # start_date + ~2 weeks ≈ the 8 training days
TRAINING_STALE_DAYS = 45       # same horizon data_hygiene uses for ghost hires

MASTERY_HOLD_DAYS = 84  # Expert signed 12+ weeks ago before Mastery eligibility

# Skill anchors — existing Commercial Craft modules at Deliver (rung 3, the
# highest rung recordable on Stage 1–2 modules; Deliver is coach-signed,
# which keeps a human in the loop from Competency up). Topic strings must
# match core/module_seed.py exactly — (stage, topic) is module identity.
STAGE1_CC_TOPICS = [
    "5-Step Sign-Up Process", "SEE Principle", "Clear Close",
    "Question Handling", "Impulses", "Accurate Body Positioning",
]
STAGE2_CC_TOPICS = [
    "Improved Question Handling", "Close Variations",
    "Territory Awareness & Adaptability", "Rehash & Consolidation",
]

# Veterans predate COD grading — requiring Deliver sign-offs from people who
# joined before the ladder existed would backfill everyone to Beginner (the
# insulting outcome the backfill exists to avoid). Anchors are waived for
# reps whose join date is before this cutoff; data criteria always apply.
ANCHOR_WAIVER_BEFORE = (os.environ.get("SALES_PATH_ANCHOR_WAIVER_BEFORE") or "2026-09-15")

# Ramp — graded from the START WEEK: week 1 is the week they start (BA
# Academy + first field days — sign-ups count from day one, at least Amber
# expected), week 2's 7 (out of the red zone, per the owner's playbook) is
# the WORST CASE not the aim, week 3's 8 is the expected minimum (Green),
# week 4's 10 is Super Green. Admin-tunable per office; the Green Week
# finish line itself always keys on GREEN_WEEK_SALES.
DEFAULT_RAMP_TARGETS = [AMBER_WEEK_SALES, RED_EXIT_WEEK_SALES, GREEN_WEEK_SALES, SUPER_GREEN_WEEK_SALES]

# ── Admin-editable content ──────────────────────────────────────────────────
# The long-game framing copy + ramp targets, editable in-app exactly like the
# onboarding screen: per-office doc over global doc over these code defaults
# (sales_path_settings collection, office_id None = global). Data criteria
# and level thresholds are NOT here on purpose — they're company-wide policy
# (design doc §4); only expectation-setting copy and ramp pacing are tunable.
# Plain sales-floor English only (owner, 2026-09-12: no "AI coder" talk).
# Numbers read the way a coach says them — "8 out of your last 10 days",
# "sales a day" — never percentages, windows, or words like "trajectory".
DEFAULT_CONTENT = {
    "ramp_targets": list(DEFAULT_RAMP_TARGETS),
    "arc_line": (
        "Getting good takes a few weeks. Getting great takes months — and pays "
        "a lot more. Don't judge yourself on one bad week."
    ),
    "level_arc": {
        "1": "Everyone starts here. You're learning the role — what you earn this week says nothing about what you'll earn next month.",
        "2": f"Your first Green Week — {GREEN_WEEK_SALES} sign-ups in one week. Real earnings start here, and most people get here quickly.",
        "3": "3 sign-ups a day is your normal now — Super Green weeks, well past the Green minimum. Steady, strong earnings.",
        "4": "2+ sign-ups on 8 out of 10 days at a 3-a-day pace. You're one of the top earners now.",
        "5": "2+ sign-ups on 9 out of 10 days, month after month. The biggest earnings in the field.",
        "6": "The best of the best — the people everyone else learns from, and earning like it.",
    },
    "long_game_title": "Good takes weeks. Great takes months.",
    "long_game_body": (
        "Nobody is good at this in week one — that's why you get a 30-day "
        "ramp-up. Stay consistent and you'll be earning steady money. Keep "
        "developing after that and it "
        "goes a lot higher — the top earners built their skills over months, "
        "not days. One bad day or week means nothing. Keep going."
    ),
    "journey_ramp_body": (
        "Your ramp starts the week you do — BA Academy, your first field "
        "days, and your first sign-ups all count from day one. Week 1: at "
        f"least {AMBER_WEEK_SALES} sign-ups. Week 2: {RED_EXIT_WEEK_SALES} — out of the red zone — is the "
        f"worst case, not the aim. Week 3: {GREEN_WEEK_SALES} — the expected minimum (that's a "
        f"Green Week, meeting the standard). Week 4: {SUPER_GREEN_WEEK_SALES} — Super Green, beating "
        "the standard. Your coach is with you the whole way, plenty of people "
        f"run ahead of this curve, and {GREEN_WEEK_SALES}+ every week is steady earnings. "
        "One bad day means nothing. Keep going."
    ),
    "updated_at": None,
}


def _merge_content(*docs) -> dict:
    """Layer docs over DEFAULT_CONTENT; later docs win, empty values don't.
    level_arc merges per level so an office can override one line without
    re-authoring all six."""
    out = dict(DEFAULT_CONTENT)
    out["level_arc"] = dict(DEFAULT_CONTENT["level_arc"])
    for doc in docs:
        if not doc:
            continue
        for key in DEFAULT_CONTENT:
            val = doc.get(key)
            if val is None:
                continue
            if isinstance(val, str) and not val.strip():
                continue
            if key == "level_arc" and isinstance(val, dict):
                for n, line in val.items():
                    if isinstance(line, str) and line.strip():
                        out["level_arc"][str(n)] = line
                continue
            if isinstance(val, list) and not val:
                continue
            out[key] = val
    return out


async def get_sales_path_content(office_id: str | None) -> dict:
    """Merged editable content for an office (office over global over
    defaults) — the single source every surface renders from."""
    global_doc = await db.sales_path_settings.find_one({"office_id": None}, {"_id": 0})
    office_doc = None
    if office_id is not None:
        office_doc = await db.sales_path_settings.find_one({"office_id": office_id}, {"_id": 0})
    return _merge_content(global_doc, office_doc)
# Ramp is for hires after launch; earlier people get ladder levels only.
RAMP_SINCE = (os.environ.get("SALES_PATH_RAMP_SINCE") or "2026-09-15")


# ── Small helpers ───────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_local():
    return datetime.now(APP_TZ).date()


def _today_local_iso() -> str:
    return _today_local().isoformat()


def _parse_date(s):
    try:
        return datetime.strptime(str(s)[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def _forward_sunday(d) -> str:
    """Sunday on-or-after `d` — the bells week containing that date. Same
    semantics as bells_parser._week_ending_for; NEVER _coerce_to_sunday here
    (that snaps backward and would land every mapping one week early)."""
    return (d + timedelta(days=(6 - d.weekday()) % 7)).isoformat()


def _current_sunday_iso() -> str:
    """The Sunday ending the current (still-open) bells week, in app time."""
    return _forward_sunday(_today_local())


def _num(v, default=0.0):
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default


def _day_sales(day: dict) -> float:
    """Sales = over30 + under30 only; memberships are add-ons, never sales."""
    return max(0.0, _num((day or {}).get("over30")) + _num((day or {}).get("under30")))


AUTH_OFF = {"ab", "rt", "pc"}  # same excused set as bells reliability_pct


async def _resolve_user(user_id: str) -> dict | None:
    try:
        return await db.users.find_one({"_id": ObjectId(user_id)})
    except Exception:
        return None


def _user_eligible(u: dict | None) -> bool:
    """Evaluator-side skip: never mint docs/badges for binned, deactivated or
    walk-around demo accounts (listing filters alone don't cover backfill)."""
    if not u:
        return False
    if u.get("deleted") or u.get("is_active") is False or u.get("is_demo"):
        return False
    return True


async def _join_date(user_id: str, user: dict | None = None):
    """The person's day-0 anchor: new_hires.start_date, falling back to
    users.created_at — the exact _join_key rule bells uses. Re-read on every
    recompute (admins edit start dates)."""
    hire = await db.new_hires.find_one(
        {"trainee_user_id": user_id}, {"_id": 0, "id": 1, "start_date": 1}, sort=[("created_at", -1)]
    )
    if hire and hire.get("start_date"):
        d = _parse_date(hire["start_date"])
        if d:
            return d, hire
    u = user or await _resolve_user(user_id)
    created = (u or {}).get("created_at")
    if isinstance(created, datetime):
        return created.date(), hire
    d = _parse_date(created)
    return d, hire


# ── Bells history ───────────────────────────────────────────────────────────


async def _load_history(user_id: str) -> dict:
    """Read the person's whole bells history and derive the two series every
    criterion runs on.

    Returns {
        weeks:      {week_ending: {sales, in_days, all_auth_off, earnings}}
                    — merged across offices by summing (an office transfer
                    can legitimately leave two rows for one week under the
                    per-office unique index; person-bound history counts all
                    of it),
        field_days: [(date_iso, sales)] for status=="in" days strictly
                    before today (app time), newest first, deduped per date.
    }
    Legacy user_id:None rows are invisible to a user_id query by definition —
    the pre-launch resolution script (scripts/resolve_bells_names.py) stamps
    user_id onto unambiguous name-only rows so veterans' history counts.
    """
    weeks: dict[str, dict] = {}
    day_map: dict[str, dict] = {}  # date_iso -> {sales, in}
    today = _today_local()
    async for e in db.bells_entries.find(
        {"user_id": user_id},
        {"_id": 0, "week_ending": 1, "days": 1, "earnings": 1},
    ):
        we = e.get("week_ending")
        wd = _parse_date(we)
        if not wd:
            continue
        wk = weeks.setdefault(we, {"sales": 0.0, "in_days": 0, "statuses": [], "earnings": 0.0})
        wk["earnings"] += _num(e.get("earnings"))
        days = e.get("days") or []
        for idx in range(min(7, len(days))):
            d = days[idx] or {}
            day_date = wd - timedelta(days=(6 - idx))
            status = d.get("status")
            sales = _day_sales(d)
            wk["statuses"].append((idx, status))
            if status == "in":
                wk["in_days"] += 1
                wk["sales"] += sales
                if day_date < today:  # a live day is an 0-sale in-day all day
                    slot = day_map.setdefault(day_date.isoformat(), {"sales": 0.0})
                    slot["sales"] += sales

    for wk in weeks.values():
        # An excused week: no in-days AND every Mon–Sat status is authorized
        # absence — excluded from weekly denominators (mirrors reliability),
        # and it pauses the ramp clock instead of counting against it.
        mon_sat = [s for (i, s) in wk.pop("statuses") if i < 6]
        wk["all_auth_off"] = wk["in_days"] == 0 and bool(mon_sat) and all(
            (s or "off") in AUTH_OFF for s in mon_sat
        )

    field_days = sorted(day_map.items(), key=lambda kv: kv[0], reverse=True)
    return {"weeks": weeks, "field_days": [(d, v["sales"]) for d, v in field_days]}


def _window_metrics(field_days: list, n: int, skip: int = 0) -> dict | None:
    """scoring_pct + piece average over the N most recent field days after
    skipping `skip` (skip=30 gives Expert's second, non-overlapping window).
    Returns None when the window is unsatisfied: fewer than N days, or the
    window's oldest day falls outside the recency bound measured from
    TODAY (app time) (not the window's own span — a rep absent since March would
    otherwise pass on months-dead form). The second Expert window sits
    behind the first, so its bound doubles."""
    chunk = field_days[skip:skip + n]
    if len(chunk) < n:
        return None
    bound = WINDOW_RECENCY_DAYS.get(n)
    oldest = _parse_date(chunk[-1][0])
    if bound and oldest and (_today_local() - oldest).days > bound * (2 if skip else 1):
        return None
    days_scored = sum(1 for _d, s in chunk if s >= MIN_SCORED_DAY_SALES)
    total = sum(s for _d, s in chunk)
    return {
        "days": n,
        "from": chunk[-1][0],
        "to": chunk[0][0],
        # The day COUNT behind scoring_pct, carried so the progress rows can
        # say "11 of 14 days that count" from the gate's own chunk instead of
        # re-deriving it from a rounded percentage.
        "days_scored": days_scored,
        "scoring_pct": round(days_scored / n * 100),
        "piece_avg": round(total / n, 2),
        # The raw total, so the NEXT UP row can say "45 of 60 sales" instead of
        # "2.3 of 3.0" and leave the reader to work out what to aim at.
        "total_sales": total,
    }


def _recent_field_days(field_days: list, n: int, skip: int = 0) -> list:
    """The days a window would grade, minus any that fall outside its
    recency bound — the partial view of _window_metrics, for showing progress
    BEFORE a window is full. Same slice, same bound, same order; it just
    stops at the first day too old to count instead of returning None."""
    bound = WINDOW_RECENCY_DAYS.get(n)
    out = []
    for d_iso, sales in field_days[skip:skip + n]:
        dd = _parse_date(d_iso)
        if dd is None:
            break
        if bound and (_today_local() - dd).days > bound * (2 if skip else 1):
            break  # sorted newest-first — everything after is older still
        out.append((d_iso, sales))
    return out


def _partial_metrics(field_days: list, n: int, skip: int = 0) -> dict:
    """How a window reads with the days there are so far. Progress ONLY —
    _window_metrics stays the single oracle for whether a level is earned, so
    this returns counts and never a verdict."""
    chunk = _recent_field_days(field_days, n, skip)
    days_scored = sum(1 for _d, s in chunk if s >= MIN_SCORED_DAY_SALES)
    total = sum(s for _d, s in chunk)
    return {
        "days_out": len(chunk),
        "days_scored": days_scored,
        "piece_avg": round(total / len(chunk), 2) if chunk else None,
        "total_sales": total,
    }


# ── Skill anchors ───────────────────────────────────────────────────────────


async def _anchor_counts(user_id: str, office_id: str | None, stage: int,
                         topics: list[str]) -> dict:
    """Which of the named Commercial Craft modules are signed off at Deliver
    (or completed) for this person — the counts BEHIND _anchors_met, from the
    same query, so a "2 of 4 skills signed" row can never disagree with the
    gate it describes.

    Module set resolves per office with the global (office_id: None)
    fallback — the award_module_stage_completion resolution, not a
    reimplementation hazard. An office with none of these modules can't block
    a level (vacuously met → total 0, met True).

    Returns {done, total, met, items:[{topic, done}]}, items in the canonical
    topic order. `items` is internal — it is what `done` is counted from, and
    it is deliberately NOT put on the progress row: the checklist has never
    drawn per-topic ticks, so shipping the list to every client was payload
    nothing read.
    """
    proj = {"_id": 0, "id": 1, "topic": 1}

    async def _modules(oid):
        return [
            {"id": m["id"], "topic": m.get("topic")}
            async for m in db.training_modules.find(
                {"stage": stage, "topic": {"$in": topics}, "office_id": oid, "retired": {"$ne": True}},
                proj,
            )
        ]

    modules = await _modules(office_id)
    if not modules and office_id is not None:
        modules = await _modules(None)
    module_ids = [m["id"] for m in modules]
    if not module_ids:
        return {"done": 0, "total": 0, "met": True, "items": []}
    # Two-branch $or, never a bare user_id match — on coach-graded rows
    # user_id is the ASSESSOR; target_user_id is the person.
    done: set[str] = set()
    async for p in db.module_progress.find(
        {
            "module_id": {"$in": module_ids},
            "$or": [
                {"target_user_id": user_id},
                {"target_user_id": {"$exists": False}, "user_id": user_id},
            ],
        },
        {"_id": 0, "module_id": 1, "completed": 1, "ladder": 1},
    ):
        if p.get("completed") or int(p.get("ladder") or 0) >= 3:
            done.add(p["module_id"])
    order = {t: i for i, t in enumerate(topics)}
    modules.sort(key=lambda m: order.get(m["topic"], len(order)))
    items = [{"topic": m["topic"], "done": m["id"] in done} for m in modules]
    return {
        "done": sum(1 for i in items if i["done"]),
        "total": len(module_ids),
        "met": set(module_ids).issubset(done),
        "items": items,
    }


async def _anchors_met(user_id: str, office_id: str | None, stage: int, topics: list[str]) -> bool:
    """True when every named Commercial Craft module is at Deliver (or
    completed) for this person — the bool the level gates read. Thin wrapper
    over _anchor_counts (same query, same resolution, same vacuous-met rule);
    kept as-is so every existing caller keeps its exact behaviour."""
    return (await _anchor_counts(user_id, office_id, stage, topics))["met"]


# ── Ramp ────────────────────────────────────────────────────────────────────


async def _ramp_targets(office_id: str | None) -> list[int]:
    raw = (await get_sales_path_content(office_id)).get("ramp_targets")
    if isinstance(raw, list) and 2 <= len(raw) <= 6:
        try:
            return [max(1, int(x)) for x in raw]
        except (TypeError, ValueError):
            pass
    return list(DEFAULT_RAMP_TARGETS)


def _parse_stamp_date_local(s):
    """A timestamp's calendar date IN APP TIME. Grading stamps are UTC ISO
    datetimes — taking their [:10] date shifts a Sunday-evening grading to
    Monday and moves the Green Week cutoff. Date-only strings parse as-is."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(APP_TZ).date()
    except ValueError:
        return _parse_date(s)


async def _training_done_date(hire: dict | None):
    """The date training day 8 was completed — the Green Week cutoff (the
    ramp no longer uses it: weeks anchor on the start week itself).

    Returns None ONLY while the hire is genuinely still in training (recent
    hire, day 8 pending). Every other path returns a FIXED historical date:
    pass-off and promotion auto-complete historically left assessment_date
    unstamped, and a fallback that moves with today makes `week > cutoff`
    unsatisfiable forever — permanently capping the person at Beginner (the
    launch-review blocker)."""
    if not hire or not hire.get("id"):
        return None
    start_d = _parse_date(hire.get("start_date")) or _parse_date(hire.get("created_at"))
    row = await db.daily_assessments.find_one(
        {"new_hire_id": hire["id"], "day_number": 8, "completed": True},
        {"_id": 0, "assessment_date": 1, "passed_off_at": 1},
    )
    if not row:
        # Day 8 never graded. A recent hire is genuinely training; an old
        # hire is paper-trained or abandoned grading — freezing them at
        # Beginner forever over a missing grade is the insulting outcome the
        # backfill exists to avoid, so their history counts from a fixed
        # post-training estimate.
        if start_d and (_today_local() - start_d).days > TRAINING_STALE_DAYS:
            return start_d + timedelta(days=TRAINING_ALLOWANCE_DAYS)
        return None
    for key in ("assessment_date", "passed_off_at"):
        d = _parse_stamp_date_local(row.get(key))
        if d:
            return d
    if start_d:
        return start_d + timedelta(days=TRAINING_ALLOWANCE_DAYS)
    # No dates anywhere on the hire — count everything rather than freeze.
    return None


async def _evaluate_ramp(user_id: str, office_id: str | None, join_d, hire: dict | None,
                         history: dict, existing_weekly: list | None) -> dict | None:
    """The 30-day runway, graded from the START WEEK (owner, 2026-09-13):
    week 1 is the calendar week they start — orientation plus first field
    days, sales counting from day one — then targets week by week. No
    grace week: the expectation curve IS the grace. A missed week still
    never locks anything; it creates a leader check-in obligation. The
    ramp completes on the first Green Week whenever it lands."""
    if not hire or not join_d:
        return None
    start_iso = str(hire.get("start_date") or "")[:10]
    if not start_iso or start_iso < RAMP_SINCE:
        return None  # ramp is for hires after launch (levels still backfill)

    today = _today_local()
    targets = await _ramp_targets(office_id)
    base: dict = {
        "start_date": start_iso,
        "targets": targets,  # always present — day 1 shows the whole runway
        "phase": "weeks", "week": None, "status": None,
        "weekly": [], "completed_at": None,
    }
    if join_d > today:
        base.update({"status": "not_started"})
        return base

    weeks = history["weeks"]
    current = _current_sunday_iso()
    prior_checkins = {w.get("week_ending"): w.get("checkin") for w in (existing_weekly or []) if w.get("checkin")}

    weekly: list[dict] = []
    green_at: str | None = None
    slot = 0  # 0..len(targets)-1 — ramp week number
    d = _parse_date(_forward_sunday(join_d))  # week 1 = the START week
    while slot < len(targets) and d.isoformat() <= current:
        we = d.isoformat()
        wk = weeks.get(we) or {"sales": 0.0, "in_days": 0, "all_auth_off": False}
        completed = we < current
        paused = bool(wk.get("all_auth_off")) or (completed and wk.get("in_days") == 0)
        row = {
            "week_ending": we,
            # Paused (excused) weeks carry NO week number — they extend the
            # runway, so the number belongs to the retry week. Two rows
            # sharing a number made the My Progress node pin to the excused
            # row forever (launch-review finding).
            "week": None if paused else slot + 1,
            "target": targets[slot],
            "sales": int(wk.get("sales") or 0),
            "completed": completed,
            "paused": paused,
            "met": completed and not paused and (wk.get("sales") or 0) >= targets[slot],
        }
        if prior_checkins.get(we):
            row["checkin"] = prior_checkins[we]
        weekly.append(row)
        if (wk.get("sales") or 0) >= GREEN_WEEK_SALES and not green_at:
            green_at = we
        if not completed:
            break
        if not paused:  # an excused week extends the runway, not the grade
            slot += 1
        d += timedelta(days=7)

    # A Green Week anywhere from the start week completes the ramp —
    # including one that lands late (overdue → complete).
    if not green_at:
        d = _parse_date(_forward_sunday(join_d))
        while d.isoformat() <= current:
            wk = weeks.get(d.isoformat())
            if wk and (wk.get("sales") or 0) >= GREEN_WEEK_SALES:
                green_at = d.isoformat()
                break
            d += timedelta(days=7)

    graded_done = [w for w in weekly if w["completed"] and not w["paused"]]
    if green_at:
        status = "complete"
        current_week = None
    elif len(graded_done) >= len(targets):
        status = "overdue"
        current_week = len(targets)
    else:
        # "behind" only once a graded week has actually completed and missed;
        # the in-progress week always reads on_track (grace, not gates).
        status = "behind" if (graded_done and not graded_done[-1]["met"]) else "on_track"
        current_week = min(len(graded_done) + 1, len(targets))

    # Pre/post-30 average weekly earnings — the exec's measurement ask; a
    # byproduct of the ramp clock (bells rows persist a forecast `earnings`).
    # Completed weeks only (a mid-week row would understate the average), and
    # clipped at the join week so a rehire's previous stint can't pollute the
    # "first 30 days" bucket.
    cutoff_sunday = _forward_sunday(join_d + timedelta(days=30))
    join_week = _forward_sunday(join_d)
    pre, post = [], []
    for we, wk in weeks.items():
        if wk.get("in_days") and we < current and we >= join_week:
            (pre if we <= cutoff_sunday else post).append(_num(wk.get("earnings")))
    base.update({
        "week": current_week,
        "status": status,
        "weekly": weekly,
        "completed_at": green_at,
        "pre30_avg_earnings": round(sum(pre) / len(pre), 2) if pre else None,
        "post30_avg_earnings": round(sum(post) / len(post), 2) if post else None,
    })
    return base


# ── Next-level progress ─────────────────────────────────────────────────────
# "This proficiency target is confusing — a live counter is needed to see
# where I am, how far I am, with ticks for the accomplishments" (owner,
# 2026-09-14). The NEXT UP card used to state a price; these rows turn it
# into a scoreboard — every requirement the gate actually checks, the rep's
# own number against it, and whether it's ticked.
#
# The rules this block lives by:
#   • Every number comes from the SAME value the award reads — the same
#     window dict, the same Green Week list, the same module query. A
#     counter that disagrees with the gate is worse than no counter.
#   • `current` is the GATE's own number, and it is null whenever nothing is
#     being graded against the target yet: a stretch of days out that isn't
#     long enough to grade (`window_ready: false`), or a requirement this rep
#     is waived from (`waived: true`). `so_far` still carries their real live
#     number in those cases — so the row can count up without ever printing
#     "15 of 14" next to an empty tick box. When `window_ready` is false the
#     line to show is `note`, with `days_out` of `of_days` filling up.
#   • `target` is the BAR, not a measurement: it is known before anyone has
#     worked a day, so it stays set on a row that is still filling up. It is
#     null only where no target exists at all — a signature, or a skills row
#     this rep is waived from. So the test for "is this graded yet" is
#     `current != null`; `target != null` means "there is a bar to draw".
#   • `met is false` guarantees `current < target` whenever both are set (the
#     gate's own comparison; test_next_up_never_prints_its_own_target). The
#     client leans on that to guarantee the printed number can never read as
#     the target on a row that hasn't ticked.
#   • `ready` on the block is the engine's own verdict for that level
#     (auto_level / expert_data_eligible / mastery_data_eligible). The rows
#     are the breakdown; `ready` is the authority.
#   • It describes CURRENT FORM against the NEXT level only. It says nothing
#     about the level already held — those are high-water and can't be lost,
#     and nothing here may imply otherwise.
#   • Confidence-first: rows count UP ("current": 2, "target": 3,
#     "remaining": 1). Never a deficit, never a shortfall, no red.
#   • Plain English in `label`/`detail`, served from here so copy and
#     criteria can't drift apart (the _meta() precedent). No "piece
#     average", no "scoring percentage", no "window", no "anchors" — and
#     "close" is a funnel stage, never a sale.
#
# Requirement kinds, so the UI knows how to draw a row:
#   count     — a tally against a whole number (Green Weeks, skills signed,
#               days at Expert). `unit` says what is being counted, and the
#               checklist prints it beside the score wherever the label alone
#               would leave the number ambiguous (days vs weeks).
#   ratio     — N of your last M days out (`of_days`, `days_out`,
#               `window_ready`). Not gradeable until M days exist.
#   average   — sales per day against a pace (`decimals` = how to print it).
#   signature — a human signs it. No number exists, so none is invented:
#               `current`/`target` are null and `signed_off_by` says who.


def _ceil_tenth(x: float) -> float:
    return math.ceil(round(x, 4) * 10) / 10


def _scoring_days_target(n: int, pct: int) -> int:
    """The fewest 2+-sale days inside an N-day stretch that clear the bar —
    inverted from _window_metrics' own rounding rather than re-derived, so
    "14 of your last 20 days out" is exactly the day the gate flips."""
    for d in range(n + 1):
        if round(d / n * 100) >= pct:
            return d
    return n


def _req(key: str, label: str, detail: str, kind: str, current, target, met: bool,
         *, unit: str | None = None, **extra) -> dict:
    """One requirement row. `met` is always passed in from the gate's own
    comparison — this helper never decides whether something is earned."""
    row = {
        "key": key,
        "label": label,
        "detail": detail,
        "kind": kind,
        "unit": unit,
        "current": current,
        "target": target,
        "met": bool(met),
        "remaining": None,
    }
    if row["met"]:
        row["remaining"] = 0 if kind != "signature" else None
    elif current is not None and target is not None:
        gap = max(0.0, float(target) - float(current))
        # Averages round the gap UP to a tenth: "0.1 to go" when 0.04 is
        # missing is honest-conservative, and it can never print "0.0 to go"
        # on a row that hasn't ticked.
        row["remaining"] = _ceil_tenth(gap) if kind == "average" else int(math.ceil(gap))
    row.update(extra)
    return row


def _green_weeks_req(count: int, target: int) -> dict:
    # Say what the tally ACTUALLY counts. The gate starts counting the week
    # after the first 8 days finish (those weeks' totals are coach-carried,
    # so they were never the BA's own). "weeks with 8+ sign-ups" alone would
    # invite anyone with an early big week to read the counter as broken.
    return _req(
        "green_weeks", "Green Weeks",
        f"weeks of {GREEN_WEEK_SALES}+ sign-ups after your first 8 days",
        "count", int(count), int(target), count >= target, unit="weeks",
    )


# ── "What do I actually do?" ─────────────────────────────────────────────────
#
# Every row on the NEXT UP card was a scoreboard: a number, a target and a
# gap. A rep could read "24 of 27 · 3 to go" and still have no idea what to do
# on Monday (owner, 2026-09-16: "it needs to be dumb simplified so someone
# goes: ah I just need xyz over the next x days to get that box ticked").
#
# The awkward part is that not every row CAN be acted on. The Expert card's
# two "before that" rows grade days 31-60, which are already written down.
# Measured on a real leader: six one-sale days from July hold that row at 24
# of 27, and it ticks after 44 more days out whether he does 3 a day or 6 —
# because those days leave by ageing out, not by being outworked. Telling him
# "3 to go" implies he can go and get 3. He cannot, not today.
#
# So a row forecasts itself at the level's own pace and again at double it. If
# both land on the same day the row is time-bound and says so; otherwise it
# names the rate and the number of days out that would tick it.

def _days_out_per_week(field_days: list) -> float | None:
    """How many days a week this person is actually out, over the last 8
    weeks. Used only to turn days out into weeks for the copy, never a gate."""
    if not field_days:
        return None
    newest = _parse_date(field_days[0][0])
    if newest is None:
        return None
    recent = 0
    for d, _s in field_days:
        pd = _parse_date(d)
        if pd and (newest - pd).days <= 56:
            recent += 1
    return (recent / 8.0) if recent else None


#: How far ahead a forecast will look before giving up, in days out.
FORECAST_HORIZON = 200


def _forecast_days_out(sales: list, n: int, skip: int, metric: str,
                       target: float, rate: float) -> int | None:
    """Days out at `rate` a day before this window hits `target`, 0 if already.

    `sales` is newest-first, the same order field_days uses. Each simulated
    day pushes the oldest out of the window, which is exactly why a row can be
    unreachable by effort alone.
    """
    days = list(sales)
    for i in range(FORECAST_HORIZON + 1):
        w = days[skip:skip + n]
        if len(w) == n:
            v = (sum(1 for x in w if x >= MIN_SCORED_DAY_SALES)
                 if metric == "days" else sum(w))
            if v >= target:
                return i
        days.insert(0, float(rate))
    return None


def _weeks_phrase(days_out: int, per_week: float | None) -> str:
    """" — about 8 weeks" alongside a count of days out, when the cadence is
    known. Days out is the honest unit because it is what the window counts,
    but nobody plans in days out, so the calendar estimate rides along."""
    if not per_week or per_week <= 0:
        return ""
    weeks = days_out / per_week
    if weeks < 1.5:
        return ""
    return f" — about {round(weeks)} weeks"


def _action_line(sales: list, n: int, skip: int, metric: str, target: float,
                 rate: float, met: bool, per_week: float | None) -> str | None:
    """One plain sentence: what to do, and for how long.

    The split that matters is `skip`. A row with skip=0 grades the days a rep
    is about to work, so effort moves it and the line names a rate. A row with
    skip>0 grades the stretch BEHIND that one — nothing done today reaches it
    for `skip` days out — so promising "3 to go" there would be a lie about
    what today's work can do.

    Note the rate is NOT doubled to test this. For a day-counting row that
    would prove nothing: a day scores at 2+, so 4 a day and 8 a day tick the
    same box, and the row would look time-bound when it is simply binary.
    """
    if met:
        return None
    soon = _forecast_days_out(sales, n, skip, metric, target, rate)
    if soon is None:
        return "Keep the run going — this one needs a longer stretch than the months ahead."
    if soon == 0:
        return None  # the forecast disagrees with the gate; the gate wins
    span = f"{soon} more days out{_weeks_phrase(soon, per_week)}"
    if skip:
        return (f"Already recorded — nothing you do today reaches this window. "
                f"It clears in {span}.")
    if metric == "days":
        return f"Get {MIN_SCORED_DAY_SALES}+ every day you're out and this ticks in {span}."
    return f"{_trim_num(rate)} a day for the next {soon} days out ticks this{_weeks_phrase(soon, per_week)}."


def _days_out_phrase(n: int, skip: int) -> str:
    return f"the {n} before those" if skip else f"your last {n} days out"


_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _short_date(iso: str, with_year: bool = False) -> str:
    d = _parse_date(iso)
    if d is None:
        return ""
    return f"{d.day} {_MONTHS[d.month - 1]}" + (f" {d.year}" if with_year else "")


def _window_dates(window: dict | None) -> str:
    """"13 Aug – 15 Sep" for the stretch a row actually graded.

    The Expert card asks about THREE overlapping stretches at once — the last
    30 days out, the 30 before those, and the last 20 — and said only "your
    last 30 days out" on each. With no dates a reader cannot tell which
    period a number came from, or that two of them share most of their days
    (owner, 2026-09-16). The engine already knows the range; it just never
    said it.
    """
    if not window:
        return ""
    a, b = window.get("from"), window.get("to")
    if not a or not b:
        return ""
    da, dbb = _parse_date(a), _parse_date(b)
    cross = bool(da and dbb and da.year != dbb.year)
    return f"{_short_date(a, cross)} – {_short_date(b, cross)}"


def _dated_detail(lead: str, n: int, skip: int, window: dict | None) -> str:
    """Dates FIRST, because that is what tells three near-identical rows
    apart at a glance; the stretch's description second."""
    dates = _window_dates(window)
    phrase = f"{lead} {_days_out_phrase(n, skip)}".strip()
    return f"{dates} · {phrase}" if dates else phrase


def _filling_note(n: int, skip: int, days_out: int) -> str:
    """The line a row shows while its stretch of days out is still filling up.

    Two things it has to get right, both of which the one generic sentence
    got wrong:
      • WHICH stretch. The Expert/Mastery card asks about two of them, and
        the second is the block of days BEFORE the recent one — telling
        someone "you're at 4" against their most recent days when the row is
        counting the days behind those is just a wrong number.
      • That only RECENT days count. The tally stops at the first day too old
        to count, so a rep coming back from a long break has fewer days here
        than they have actually worked. Unsaid, that reads as lost work.
    """
    bound = WINDOW_RECENCY_DAYS.get(n)
    weeks = (bound * (2 if skip else 1)) // 7 if bound else None
    if skip:
        span = f", inside the last {weeks} weeks" if weeks else ""
        return (f"This row counts the {n} days out before those{span} — "
                f"you're at {days_out} of them so far.")
    span = f" in the last {weeks} weeks" if weeks else ""
    return f"Counts once you have {n} days out{span} — you're at {days_out}."


def _good_days_req(key: str, label: str | None, window: dict | None, field_days: list,
                   n: int, pct: int, skip: int = 0,
                   per_week: float | None = None) -> dict:
    """2+ sales on X of your last N days out. Met comes from the gate's own
    comparison; the count comes from the gate's own chunk when the window is
    full, and from the days-so-far when it isn't."""
    if window:
        so_far, days_out, ready = window["days_scored"], n, True
    else:
        part = _partial_metrics(field_days, n, skip)
        so_far, days_out, ready = part["days_scored"], part["days_out"], False
    row = _req(
        key, label or f"Days that count ({MIN_SCORED_DAY_SALES}+ sign-ups)",
        _dated_detail("of", n, skip, window), "ratio",
        so_far if ready else None, _scoring_days_target(n, pct),
        bool(window) and window["scoring_pct"] >= pct,
        unit="days", so_far=so_far, of_days=n, days_out=days_out,
        window_ready=ready,
    )
    if not ready:
        # Nothing is graded on a short stretch (never a smaller
        # denominator), so no gate number exists yet — without that rule the
        # row could read "15 of 14" beside an empty tick box. What IS filling
        # up is days out, so that's what the line counts.
        row["note"] = _filling_note(n, skip, days_out)
    else:
        row["action"] = _action_line(
            [x for _d, x in field_days], n, skip, "days",
            _scoring_days_target(n, pct), float(MIN_SCORED_DAY_SALES),
            row["met"], per_week,
        )
    return row


def _trim_num(x: float) -> str:
    """3.0 -> "3", 2.5 -> "2.5". A pace in copy should not carry a dead .0."""
    return f"{x:g}"


def _pace_req(key: str, label: str | None, window: dict | None, field_days: list,
              n: int, target: float, skip: int = 0,
              per_week: float | None = None) -> dict:
    """Sales across the window, against the total the level's pace implies.

    Counts SALES, not a rate. It used to print the piece average — "2.3 of
    3.0" — which had three problems at once (owner, 2026-09-15). It sits
    directly under "Days that count (2+ sales), 13 of 14", so the reader
    carries that denominator down, but this one is averaged over EVERY day
    out including the blanks. "Of 3.0" reads like a score out of three rather
    than a target rate. And alone on the card it gave a rep no whole number
    to aim at: working out that 2.25 over 20 days means 15 more sales is not
    a thing to make somebody do in their head.

    So the row now reads "45 of 60" with "3 a day" under it, and the shared
    "N to go" line does the arithmetic. `met` still comes from the gate's own
    piece-average comparison — the number on screen changed, the bar did not.
    """
    total_target = float(target) * n
    if window:
        so_far, days_out, ready = window["total_sales"], n, True
    else:
        part = _partial_metrics(field_days, n, skip)
        so_far, days_out, ready = part["total_sales"], part["days_out"], False
    row = _req(
        key, label or "Total sign-ups", _dated_detail("across", n, skip, window),
        "count", so_far if ready else None, total_target,
        # The GATE, untouched: the level is still earned on the piece average.
        bool(window) and window["piece_avg"] >= target,
        unit="sales", so_far=so_far, of_days=n, days_out=days_out,
        window_ready=ready,
        # The pace the total stands for, kept so the row still teaches it.
        value_sub=f"{_trim_num(float(target))} a day",
        piece_avg=(window or {}).get("piece_avg"),
    )
    if not ready:
        row["note"] = _filling_note(n, skip, days_out)
    else:
        row["action"] = _action_line(
            [x for _d, x in field_days], n, skip, "sales",
            total_target, float(target), row["met"], per_week,
        )
    return row


def _skills_req(stage: int, counts: dict | None, waived: bool) -> dict:
    """Stage 1/2 sales skills signed off at Deliver — the same module read
    the level gate uses, so the ticks in `items` are the gate's own answer.

    A rep the waiver covers (or an office with none of these modules set up)
    is asked for nothing here: the tick is real, and `current`/`target` stay
    null rather than inventing a score out of a requirement that isn't
    theirs. `so_far` still shows what they have actually signed."""
    done = (counts or {}).get("done") or 0
    total = (counts or {}).get("total") or 0
    # Waived (joined before sign-offs were part of the ladder) or an office
    # with none of these modules set up: the gate genuinely doesn't ask this
    # rep for anything, so there's no target to count against — the tick is
    # real, and `so_far` still carries what they have actually signed.
    gates = bool(counts) and total > 0 and not waived
    row = _req(
        f"skills_stage{stage}", f"Stage {stage} sales skills signed",
        "signed off by your coach", "count",
        done if gates else None, total if gates else None,
        bool(waived or (counts and counts.get("met"))), unit="skills",
        so_far=done, waived=bool(waived),
    )
    if waived:
        row["note"] = "Already yours — you started before sign-offs joined the ladder."
    elif not gates:
        row["note"] = "Nothing to sign off for your office yet."
    return row


def _sign_req(key: str, label: str, detail: str, by: str, requested: bool,
              can_request: bool) -> dict:
    """A signature isn't a number, so this row doesn't fake one."""
    return _req(
        key, label, detail, "signature", None, None, False,
        signed_off_by=by, requested=bool(requested), can_request=bool(can_request),
    )


def _next_up(level: int, *, auto_level: int, green_weeks: int, field_days: list,
             w20: dict | None, w30a: dict | None, w30b: dict | None,
             anchors_waived: bool, anchor_counts: dict,
             expert_data_eligible: bool, mastery_data_eligible: bool,
             expert_days_held: int | None, expert_hold_met: bool,
             expert_requested: bool, mastery_requested: bool) -> dict | None:
    """Live progress toward the NEXT level — one row per requirement the
    engine checks for it, with the rep's own number against the target.

    None at Mastery: there is no next level, and inventing one would be a
    lie. Everything below reads as a scoreboard, never a wall.
    """
    if level >= 6:
        return None
    n = level + 1
    rows: list[dict] = []
    # How often this person is actually out, so "44 more days out" can also
    # say "about 8 weeks". Copy only — never a gate.
    per_week = _days_out_per_week(field_days)

    if n == 2:
        rows.append(_green_weeks_req(green_weeks, 1))
        rows.append(_skills_req(1, anchor_counts.get(1), anchors_waived))
        ready = auto_level >= 2
    elif n == 3:
        t = THRESHOLDS[3]
        rows.append(_green_weeks_req(green_weeks, PROFICIENCY_GREEN_WEEKS))
        rows.append(_good_days_req("good_days", None, w20, field_days, t["window"], t["scoring_pct"],
                                   per_week=per_week))
        rows.append(_pace_req("sales_per_day", None, w20, field_days, t["window"], t["piece_avg"],
                               per_week=per_week))
        rows.append(_skills_req(2, anchor_counts.get(2), anchors_waived))
        ready = auto_level >= 3
    elif n == 4:
        t = THRESHOLDS[4]
        rows.append(_good_days_req("good_days", None, w20, field_days, t["window"], t["scoring_pct"],
                                   per_week=per_week))
        rows.append(_pace_req("sales_per_day", None, w20, field_days, t["window"], t["piece_avg"],
                               per_week=per_week))
        ready = auto_level >= 4
    else:  # Expert and Mastery sit on the same two 30-day stretches
        t5, t4 = THRESHOLDS[5], THRESHOLDS[4]
        w = t5["window"]
        if n == 6:
            # The gate counts DAYS since the Expert signature, so the row
            # prints days — and says so, in the detail and beside the number
            # (unit="days", which the checklist puts under the score). The
            # old line said "12 weeks at Expert" over a bare "100", which
            # read as 100 weeks.
            rows.append(_req(
                "expert_hold", "Time at Expert",
                f"{MASTERY_HOLD_DAYS} days at Expert "
                f"— about {MASTERY_HOLD_DAYS // 7} weeks", "count",
                expert_days_held, MASTERY_HOLD_DAYS, expert_hold_met, unit="days",
            ))
        rows.append(_good_days_req("good_days", None, w30a, field_days, w, t5["scoring_pct"],
                                   per_week=per_week))
        rows.append(_pace_req("sales_per_day", None, w30a, field_days, w, t5["piece_avg"],
                               per_week=per_week))
        rows.append(_good_days_req(
            "good_days_before", f"Days that count ({MIN_SCORED_DAY_SALES}+ sign-ups) before that",
            w30b, field_days, w, t5["scoring_pct"], skip=w, per_week=per_week))
        rows.append(_pace_req(
            "sales_per_day_before", "Total sign-ups before that",
            w30b, field_days, w, t5["piece_avg"], skip=w, per_week=per_week))
        # The engine also asks that the Advanced pace still holds right now
        # (Expert is built on top of Advanced, and the gate re-reads it). The
        # good-days half of that bar comes free with the 30-day one — 27 of
        # 30 leaves at most 3 quiet days, so the last 20 can't drop under 16
        # — but the pace half doesn't, so it gets its own row rather than
        # sitting as a silent veto behind a full set of ticks.
        rows.append(_pace_req(
            "sales_per_day_recent", "Total sign-ups right now",
            w20, field_days, t4["window"], t4["piece_avg"], per_week=per_week))
        if n == 5:
            rows.append(_sign_req(
                "expert_sign_off", "Your coach signs it off",
                "Ask for it once the numbers are in — a coach signs Expert.",
                "coach", expert_requested, expert_data_eligible))
            ready = expert_data_eligible
        else:
            rows.append(_sign_req(
                "mastery_sign_off", "An admin signs it off",
                "The numbers, plus helping someone else get their first Green Week.",
                "admin", mastery_requested, mastery_data_eligible))
            ready = mastery_data_eligible

    return {
        "level": n,
        "level_name": LEVEL_NAMES.get(n, ""),
        "requirements": rows,
        "met_count": sum(1 for r in rows if r["met"]),
        "total": len(rows),
        # The engine's own verdict for this level — the authority the rows
        # only describe. Never "you lost something": it's this week's form.
        "ready": bool(ready),
        "needs_signature": n in (5, 6),
        "signed_off_by": {5: "coach", 6: "admin"}.get(n),
        "requested": bool(expert_requested if n == 5 else mastery_requested if n == 6 else False),
    }


# ── Ladder evaluation ───────────────────────────────────────────────────────


async def evaluate_user(user_id: str, user: dict | None = None,
                        existing: dict | None = None) -> dict | None:
    """Compute the person's full sales-path state. Pure read; returns the doc
    shape (without persistence concerns) or None for ineligible users."""
    u = user or await _resolve_user(user_id)
    if not _user_eligible(u):
        return None
    office_id = u.get("office_id")
    join_d, hire = await _join_date(user_id, u)
    history = await _load_history(user_id)
    weeks, field_days = history["weeks"], history["field_days"]

    # Green Weeks only count after training day 8 (training-week totals can be
    # leader-carried); people with no hire record are veterans — all count.
    # "Still training" is a bounded state, never a permanent freeze: only a
    # RECENT hire with day 8 pending gets an empty list.
    done_d = await _training_done_date(hire) if hire else None
    hire_start = _parse_date((hire or {}).get("start_date")) or _parse_date((hire or {}).get("created_at"))
    still_training = (
        bool(hire) and done_d is None and hire_start is not None
        and (_today_local() - hire_start).days <= TRAINING_STALE_DAYS
    )
    if still_training:
        green_weeks: list[str] = []
    else:
        cutoff = _forward_sunday(done_d) if done_d else None
        current = _current_sunday_iso()
        green_weeks = sorted(
            we for we, wk in weeks.items()
            if (wk.get("sales") or 0) >= GREEN_WEEK_SALES
            and (cutoff is None or we > cutoff)
            and we <= current  # live week may count — crossing 12 early only helps
        )

    anchors_waived = bool(join_d and join_d.isoformat() < ANCHOR_WAIVER_BEFORE)
    w20 = _window_metrics(field_days, 20)
    w30a = _window_metrics(field_days, 30)
    w30b = _window_metrics(field_days, 30, skip=30)

    # Module sign-offs are read once per stage and reused by both the level
    # gate and the progress rows below — one query, one answer, so the tick
    # list can never disagree with the gate it describes.
    anchor_counts: dict[int, dict] = {}

    async def _anchors(stage: int, topics: list[str]) -> dict:
        if stage not in anchor_counts:
            anchor_counts[stage] = await _anchor_counts(user_id, office_id, stage, topics)
        return anchor_counts[stage]

    auto_level = 1
    if green_weeks and (anchors_waived or (await _anchors(1, STAGE1_CC_TOPICS))["met"]):
        auto_level = 2
    t3 = THRESHOLDS[3]
    if (auto_level >= 2 and len(green_weeks) >= PROFICIENCY_GREEN_WEEKS and w20
            and w20["scoring_pct"] >= t3["scoring_pct"] and w20["piece_avg"] >= t3["piece_avg"]
            and (anchors_waived or (await _anchors(2, STAGE2_CC_TOPICS))["met"])):
        auto_level = 3
    t4 = THRESHOLDS[4]
    if (auto_level >= 3 and w20
            and w20["scoring_pct"] >= t4["scoring_pct"] and w20["piece_avg"] >= t4["piece_avg"]):
        auto_level = 4

    t5 = THRESHOLDS[5]
    expert_windows = [w for w in (w30a, w30b) if w]
    expert_data_eligible = (
        auto_level >= 4 and w30a is not None and w30b is not None
        and all(w["scoring_pct"] >= t5["scoring_pct"] and w["piece_avg"] >= t5["piece_avg"]
                for w in (w30a, w30b))
    )

    ex = existing or {}
    level = max(auto_level, int(ex.get("level") or 1))  # high-water: never down
    if ex.get("expert_signed_at") and level < 5:
        level = 5
    if ex.get("mastery_signed_at") and level < 6:
        level = 6

    expert_signed_iso = ex.get("expert_signed_at")
    # Days since the Expert signature, hoisted so the Mastery progress row
    # counts the very days the hold gate counts.
    signed_d = _parse_date(expert_signed_iso) if expert_signed_iso else None
    expert_days_held = (_today_local() - signed_d).days if signed_d else None
    expert_hold_met = bool(expert_days_held is not None and expert_days_held >= MASTERY_HOLD_DAYS)
    # "Held" = re-evaluated as currently met at check time — no history
    # table; the recency bound keeps a long-absent rep's stale form out.
    mastery_data_eligible = bool(expert_hold_met and expert_data_eligible)

    # Level dates: stamp newly-reached auto levels (app time). Signed levels stamp
    # at sign-off; existing stamps are never rewritten.
    level_dates = dict(ex.get("level_dates") or {})
    for n in range(2, min(auto_level, 4) + 1):
        level_dates.setdefault(LEVELS[n]["key"], _today_local_iso())

    # Current form — coach truth without demotion. Bounded windows; below the
    # floor the UI says "insufficient recent data" instead of a stale number.
    # The 4-week average zero-fills missing rows (a saved-nothing week is a
    # real zero) but never reaches before the person joined, and skips
    # excused all-authorized-absence weeks entirely.
    join_week = _forward_sunday(join_d) if join_d else None
    form_weeks: list[float] = []
    d = _parse_date(_current_sunday_iso()) - timedelta(days=7)
    while len(form_weeks) < 4 and d and (join_week is None or d.isoformat() >= join_week):
        wk = weeks.get(d.isoformat())
        if not (wk and wk.get("all_auth_off")):
            form_weeks.append(_num((wk or {}).get("sales")))
        d -= timedelta(days=7)
    # days_in_window counts only RECENT field days (inside the 20-day
    # window's recency bound) — a rep back from months away reads
    # "0/20 days — not enough data", never a stale number as current form.
    recent_days = len(_recent_field_days(field_days, 20))
    form = {
        "scoring_pct_20d": w20["scoring_pct"] if w20 else None,
        "piece_avg_20d": w20["piece_avg"] if w20 else None,
        "days_in_window": recent_days,
        "avg_sales_4w": round(sum(form_weeks) / len(form_weeks), 1) if form_weeks else None,
        "updated_at": _now_iso(),
    }

    # NEXT UP — the live scoreboard for the level above, from the same values
    # the gate just read. The stage the next level asks about is loaded now
    # if the gate above short-circuited past it (a waived rep, or one with no
    # Green Week yet, never triggers the anchor read).
    next_level = level + 1 if level < 6 else None
    if next_level == 2:
        await _anchors(1, STAGE1_CC_TOPICS)
    elif next_level == 3:
        await _anchors(2, STAGE2_CC_TOPICS)
    next_up = _next_up(
        level,
        auto_level=auto_level,
        green_weeks=len(green_weeks),
        field_days=field_days,
        w20=w20, w30a=w30a, w30b=w30b,
        anchors_waived=anchors_waived,
        anchor_counts=anchor_counts,
        expert_data_eligible=expert_data_eligible,
        mastery_data_eligible=mastery_data_eligible,
        expert_days_held=expert_days_held,
        expert_hold_met=expert_hold_met,
        expert_requested=bool(ex.get("expert_ready_for_check")),
        mastery_requested=bool(ex.get("mastery_ready_for_check")),
    )

    ramp = await _evaluate_ramp(user_id, office_id, join_d, hire,
                                history, (ex.get("ramp") or {}).get("weekly"))

    return {
        "user_id": user_id,
        "office_id": office_id,  # refreshed every recompute — transfers go stale otherwise
        "level": level,
        "level_name": LEVEL_NAMES.get(level, "Beginner"),
        "auto_level": auto_level,
        "level_dates": level_dates,
        "green_weeks": len(green_weeks),
        "first_green_week": green_weeks[0] if green_weeks else None,
        "windows": {"w20": w20, "w30a": w30a, "w30b": w30b},
        "expert_data_eligible": expert_data_eligible,
        "expert_windows": expert_windows if expert_data_eligible else [],
        "mastery_data_eligible": mastery_data_eligible,
        "expert_ready_for_check": bool(ex.get("expert_ready_for_check")) and level < 5,
        "mastery_ready_for_check": bool(ex.get("mastery_ready_for_check")) and level < 6,
        "expert_ready_at": ex.get("expert_ready_at"),
        "mastery_ready_at": ex.get("mastery_ready_at"),
        "expert_signed_at": ex.get("expert_signed_at"),
        "expert_signed_by_id": ex.get("expert_signed_by_id"),
        "mastery_signed_at": ex.get("mastery_signed_at"),
        "mastery_signed_by_id": ex.get("mastery_signed_by_id"),
        "form": form,
        # Per-requirement progress toward the NEXT level (None at Mastery).
        "next_up": next_up,
        "ramp": ramp,
        "revoked": ex.get("revoked") or [],
        "updated_at": _now_iso(),
    }


async def recompute_sales_path(user_id: str, notify: bool = True) -> dict | None:
    """Evaluate + persist + celebrate. The write-path hook (bells saves,
    module grading, sign-offs). Level-up badges push only when the flag is on
    for the office AND a doc already existed — a missing doc means first
    touch (backfill hasn't stamped this person yet), so award silently to
    avoid launch-day push storms."""
    if not user_id:
        return None
    u = await _resolve_user(user_id)
    if not _user_eligible(u):
        return None
    if not sales_path_office_enabled(u.get("office_id")):
        # Dark offices stay completely untouched — no docs, no badge rows a
        # rep could spot before their office launches. The boot backfill
        # stamps everyone silently the day the office turns on.
        return None
    existing = await db.sales_path.find_one({"user_id": user_id}, {"_id": 0})
    doc = await evaluate_user(user_id, u, existing)
    if doc is None:
        return None
    if not existing:
        doc["id"] = str(uuid.uuid4())
        doc["created_at"] = _now_iso()
    else:
        doc["id"] = existing.get("id") or str(uuid.uuid4())
        doc["created_at"] = existing.get("created_at") or _now_iso()
    await db.sales_path.update_one({"user_id": user_id}, {"$set": doc}, upsert=True)

    prev_level = int((existing or {}).get("level") or 1)
    if doc["level"] > prev_level:
        from core.achievements import award
        live = bool(existing) and notify and sales_path_office_enabled(doc.get("office_id"))
        for n in range(max(2, prev_level + 1), doc["level"] + 1):
            key = LEVEL_BADGE_KEYS.get(n)
            if key:
                await award(user_id, key, notify=live, seen=not live)
    return doc


async def get_or_compute(user_id: str) -> dict | None:
    """Read path: stored doc, computed fresh when absent (never spams — a
    fresh doc means first touch, which awards silently)."""
    doc = await db.sales_path.find_one({"user_id": user_id}, {"_id": 0})
    if doc:
        return doc
    return await recompute_sales_path(user_id, notify=False)


# ── Backfill ────────────────────────────────────────────────────────────────


async def backfill_sales_path() -> dict:
    """Boot-time silent backfill (startup_seed, sequenced AFTER the bells
    dedupe + uniq_office_week_user index build so pre-2026-09-02 duplicate
    rows can't double-count). Idempotent; awards are notify=False/seen=True
    via the missing-doc rule in recompute_sales_path. Only runs once the
    feature flag is on — no point minting docs for a dark feature."""
    if not sales_path_enabled():
        return {"skipped": "SALES_PATH_ENABLED is off"}
    counts = {"evaluated": 0, "skipped": 0}
    seen: set[str] = set()
    # Everyone with bells history first (they can hold levels), then any
    # remaining active field roles (they get a Beginner doc + ramp state).
    for uid in await db.bells_entries.distinct("user_id", {"user_id": {"$type": "string"}}):
        seen.add(uid)
    async for u in db.users.find(
        {"role": {"$in": ["trainee", "leader", "admin"]},
         "deleted": {"$ne": True}, "is_active": {"$ne": False}, "is_demo": {"$ne": True}},
        {"_id": 1},
    ):
        seen.add(str(u["_id"]))
    for uid in seen:
        try:
            doc = await recompute_sales_path(uid, notify=False)
            counts["evaluated" if doc else "skipped"] += 1
        except Exception:
            counts["skipped"] += 1
            logger.exception(f"sales_path backfill: user {uid} failed (continuing)")
    logger.info(f"backfill_sales_path done — {counts}")
    return counts
