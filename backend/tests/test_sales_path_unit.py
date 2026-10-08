"""Sales Development Path evaluator — window rules, levels, ramp lifecycle,
and the launch-review regressions (stale-form windows, date-less day-8 rows,
paused-week numbering).

Pure in-memory: mongomock_motor, no network, no real Mongo.
"""

import asyncio
import sys
from datetime import date, timedelta
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from core import achievements
from core import sales_path as sp


def _run(coro):
    return asyncio.run(coro)


TODAY = sp._today_local()
CUR_SUNDAY = sp._parse_date(sp._current_sunday_iso())


def _week(n_back: int) -> str:
    """Sunday ISO of the completed week n_back weeks before the current one."""
    return (CUR_SUNDAY - timedelta(days=7 * n_back)).isoformat()


def _days(sales_mon_to_sun, statuses=None):
    out = []
    for i in range(7):
        s = sales_mon_to_sun[i] if i < len(sales_mon_to_sun) else 0
        st = statuses[i] if statuses and i < len(statuses) else ("in" if s or i < 5 else "off")
        out.append({"over30": s or None, "under30": None, "memberships": None, "status": st})
    return out


def _patch(monkeypatch):
    """Fresh mock db + feature flag on + fixed policy cutoffs for the tests:
    anchors waived for pre-2026 joiners, ramp for post-2020 starts."""
    db = AsyncMongoMockClient()["test"]
    monkeypatch.setattr(sp, "db", db)
    monkeypatch.setattr(achievements, "db", db)
    monkeypatch.setenv("SALES_PATH_ENABLED", "true")
    monkeypatch.delenv("SALES_PATH_OFFICES", raising=False)
    monkeypatch.setattr(sp, "ANCHOR_WAIVER_BEFORE", "2026-01-01")
    monkeypatch.setattr(sp, "RAMP_SINCE", "2020-01-01")
    return db


def _user(db, role="leader", office="boston", created="2025-01-06", **extra):
    oid = ObjectId()
    _run(db.users.insert_one({
        "_id": oid, "name": "Rep", "role": role, "office_id": office,
        "created_at": created, **extra,
    }))
    return str(oid)


def _bells_week(db, uid, week_ending, days, office="boston", earnings=700.0):
    _run(db.bells_entries.insert_one({
        "id": f"{uid}:{week_ending}", "office_id": office, "user_id": uid,
        "user_name": "Rep", "week_ending": week_ending, "days": days,
        "earnings": earnings,
    }))


GREEN_5DAY = [3, 3, 3, 3, 3, 0, 0]  # 15 sign-ups over 5 in-days — a Green Week (8+)
# 6 sign-ups over 3 in-days — Amber (6-7), every day still scores (2+).
AMBER_3DAY = ([2, 2, 2, 0, 0, 0, 0], ["in", "in", "in", "off", "off", "off", "off"])


# ── Window rules ────────────────────────────────────────────────────────────


def test_window_metrics_denominator_and_today_anchored_recency():
    d = TODAY - timedelta(days=1)
    recent = [((d - timedelta(days=i)).isoformat(), 3.0 if i % 5 else 0.0) for i in range(20)]
    m = sp._window_metrics(recent, 20)
    assert m and m["scoring_pct"] == 80 and m["piece_avg"] == 2.4

    # Fewer than N days → None, never vacuously true.
    assert sp._window_metrics(recent[:10], 20) is None

    # 20 tight days that ENDED 8 months ago → None (bound anchors at today,
    # not the window's internal span — the launch-review finding).
    old = TODAY - timedelta(days=240)
    stale = [((old - timedelta(days=i)).isoformat(), 3.0) for i in range(20)]
    assert sp._window_metrics(stale, 20) is None

    # Expert's second window: needs 30 more days behind the first.
    sixty = [((d - timedelta(days=i)).isoformat(), 2.0) for i in range(60)]
    w2 = sp._window_metrics(sixty, 30, skip=30)
    assert w2 and w2["scoring_pct"] == 100
    assert sp._window_metrics(sixty[:40], 30, skip=30) is None

    # A 1-sale day is a day WORKED, never a day SCORED — industry minimum
    # is 2 (owner, 2026-09-11). It still counts in the piece average.
    ones = [((d - timedelta(days=i)).isoformat(), 1.0) for i in range(20)]
    m1 = sp._window_metrics(ones, 20)
    assert m1 and m1["scoring_pct"] == 0 and m1["piece_avg"] == 1.0


# ── Levels ──────────────────────────────────────────────────────────────────


def test_veteran_levels_high_water_and_silent_first_touch(monkeypatch):
    db = _patch(monkeypatch)
    uid = _user(db)  # 2025 join → anchors waived
    for wb in range(1, 13):
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))

    doc = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc["auto_level"] == 4 and doc["level"] == 4
    assert doc["expert_data_eligible"] is True
    assert doc["green_weeks"] == 12
    assert doc["ramp"] is None  # veteran: no hire record

    # First-touch awards are silent (seen=True) — no launch push storm.
    keys = _run(db.user_badges.distinct("key", {"user_id": uid}))
    assert set(keys) == {"sales_competency", "sales_proficiency", "sales_advanced"}
    assert _run(db.user_badges.distinct("seen", {"user_id": uid})) == [True]

    # High-water: wipe recent form → level holds, Expert eligibility drops.
    _run(db.bells_entries.delete_many({"user_id": uid, "week_ending": {"$gte": _week(6)}}))
    doc2 = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc2["level"] == 4
    assert doc2["expert_data_eligible"] is False


def test_stale_history_caps_at_competency_and_form_reads_no_recent_data(monkeypatch):
    db = _patch(monkeypatch)
    uid = _user(db, created="2024-01-01")
    for wb in range(34, 46):  # 12 great weeks, all ~8 months back
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))
    doc = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc["windows"]["w20"] is None
    assert doc["auto_level"] == 2  # Competency is a lifetime event; 3+ need live form
    assert doc["form"]["days_in_window"] == 0


# ── Training cutoff regressions ─────────────────────────────────────────────


def _hire(db, uid, start_iso, hire_id="h1"):
    _run(db.new_hires.insert_one({
        "id": hire_id, "trainee_user_id": uid, "start_date": start_iso,
        "office_id": "boston", "created_at": start_iso,
    }))


def test_dateless_completed_day8_never_freezes_green_weeks(monkeypatch):
    """Promotion auto-complete historically left assessment_date unstamped; a
    today-moving fallback made `week > cutoff` unsatisfiable forever."""
    db = _patch(monkeypatch)
    uid = _user(db, created="2025-11-01")
    _hire(db, uid, "2025-11-01")
    _run(db.daily_assessments.insert_one({
        "id": "a8", "new_hire_id": "h1", "day_number": 8, "completed": True,
        "assessment_date": None,
    }))
    for wb in range(1, 5):
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))
    doc = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc["green_weeks"] == 4
    assert doc["auto_level"] >= 2


def test_abandoned_day8_grading_counts_after_stale_horizon(monkeypatch):
    """A hire row with day 8 never graded must be a bounded training state,
    not a permanent Beginner cap."""
    db = _patch(monkeypatch)
    start = (TODAY - timedelta(days=100)).isoformat()
    uid = _user(db, role="trainee", created=start)
    _hire(db, uid, start)
    for wb in range(1, 3):
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))
    doc = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc["green_weeks"] == 2

    # …while a RECENT hire with day 8 pending is genuinely still training.
    start2 = (TODAY - timedelta(days=10)).isoformat()
    uid2 = _user(db, role="trainee", created=start2)
    _run(db.new_hires.insert_one({
        "id": "h2", "trainee_user_id": uid2, "start_date": start2,
        "office_id": "boston", "created_at": start2,
    }))
    _bells_week(db, uid2, _week(1), _days(GREEN_5DAY))
    doc2 = _run(sp.recompute_sales_path(uid2, notify=False))
    assert doc2["green_weeks"] == 0


# ── Ramp lifecycle ──────────────────────────────────────────────────────────


def test_ramp_anchors_on_start_week_and_paused_rows_carry_no_number(monkeypatch):
    """Owner 2026-09-13: the ramp is graded from the START week — sales count
    from day one, no grace week. Excused/empty weeks extend the runway
    (week: None); a Green Week anywhere completes it."""
    db = _patch(monkeypatch)
    start_d = CUR_SUNDAY - timedelta(days=7 * 3 + 3)  # mid-week, 3+ weeks ago
    uid = _user(db, role="trainee", created=start_d.isoformat())
    _hire(db, uid, start_d.isoformat())

    week1 = sp._forward_sunday(start_d)
    week2 = (sp._parse_date(week1) + timedelta(days=7)).isoformat()
    week3 = (sp._parse_date(week2) + timedelta(days=7)).isoformat()
    if week3 > sp._current_sunday_iso():
        return  # not enough completed calendar room this run

    # Week 1: no bells row at all → paused (extends the runway, week: None).
    # Week 2: fully excused (all authorized absence) → paused too.
    _bells_week(db, uid, week2, _days([0] * 7, statuses=["ab"] * 6 + ["off"]))
    # Week 3: a Green Week → ramp completes; it carries week number 1
    # (the first GRADED week — the runway stretched behind it).
    _bells_week(db, uid, week3, _days(GREEN_5DAY))

    doc = _run(sp.recompute_sales_path(uid, notify=False))
    ramp = doc["ramp"]
    # The owner's What Good Looks Like bands: Amber, out of the red zone (7),
    # Green, Super Green.
    assert ramp and ramp["targets"] == [6, 7, 8, 10]
    assert ramp["phase"] == "weeks"
    assert ramp["status"] == "complete", ramp
    assert ramp["completed_at"] == week3
    paused = [w for w in ramp["weekly"] if w["paused"]]
    assert paused and all(w["week"] is None for w in paused)
    graded = [w for w in ramp["weekly"] if not w["paused"]]
    assert graded and graded[0]["week"] == 1 and graded[0]["target"] == 6


def test_ramp_counts_the_start_week_itself(monkeypatch):
    """Week 1 IS the week they start — a 7-sign-up start week meets target 1 (6)."""
    db = _patch(monkeypatch)
    start_d = CUR_SUNDAY - timedelta(days=10)
    uid = _user(db, role="trainee", created=start_d.isoformat())
    _hire(db, uid, start_d.isoformat())
    week1 = sp._forward_sunday(start_d)
    if week1 >= sp._current_sunday_iso():
        return
    _bells_week(db, uid, week1, _days([2, 2, 3, 0, 0, 0, 0]))  # 7 sign-ups — Amber
    doc = _run(sp.recompute_sales_path(uid, notify=False))
    ramp = doc["ramp"]
    w1 = next(w for w in ramp["weekly"] if w["week"] == 1)
    assert w1["met"] and w1["target"] == 6
    assert ramp["status"] in ("on_track", "behind")  # not complete: no Green (8+) yet


# ── NEXT UP progress (the live counter) ─────────────────────────────────────


def _rows(doc):
    return {r["key"]: r for r in doc["next_up"]["requirements"]}


def _module(db, stage, topic, idx, office="boston"):
    _run(db.training_modules.insert_one({
        "id": f"m{stage}-{idx}", "stage": stage, "topic": topic, "office_id": office,
    }))
    return f"m{stage}-{idx}"


def test_next_up_counts_up_and_ready_mirrors_the_gate(monkeypatch):
    """Each requirement reads as a scoreboard — the rep's own number against
    the target — and the block's `ready` is the engine's own verdict."""
    db = _patch(monkeypatch)
    uid = _user(db)  # 2025 join → anchors waived
    # 2 Green Weeks then 4 Amber ones (6 sign-ups over 3 days, below the
    # 8-a-week Green line): a full 20-day read that clears the good-days bar
    # but not the 3-a-day pace → Competency, chasing 3.
    for wb in (6, 5):
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))
    for wb in (4, 3, 2, 1):
        _bells_week(db, uid, _week(wb), _days(*AMBER_3DAY))

    doc = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc["level"] == 2
    nxt = doc["next_up"]
    assert nxt["level"] == 3 and nxt["level_name"] == "Proficiency"
    assert nxt["ready"] is (doc["auto_level"] >= 3) is False
    assert nxt["total"] == 4 and nxt["needs_signature"] is False
    rows = _rows(doc)

    # Green Weeks count UP toward the target, never down from it.
    gw = rows["green_weeks"]
    assert gw["kind"] == "count" and gw["current"] == doc["green_weeks"] == 2
    assert gw["target"] == sp.PROFICIENCY_GREEN_WEEKS and gw["remaining"] == 1

    # Good days come from the gate's own window, not a re-derivation.
    w20 = doc["windows"]["w20"]
    t3 = sp.THRESHOLDS[3]
    gd = rows["good_days"]
    assert gd["kind"] == "ratio" and gd["of_days"] == 20 and gd["window_ready"] is True
    assert gd["current"] == w20["days_scored"] == 20
    assert gd["target"] == 14 and gd["met"] is (w20["scoring_pct"] >= t3["scoring_pct"]) is True

    # The pace row counts SALES against the total the pace implies, so a rep
    # has a whole number to aim at instead of having to convert a rate.
    pace = rows["sales_per_day"]
    # 12 Amber days × 2 + the 8 most recent Green-week days × 3 = 48.
    assert pace["kind"] == "count" and pace["current"] == w20["total_sales"] == 48
    assert pace["target"] == t3["piece_avg"] * 20 == 60
    assert pace["met"] is (w20["piece_avg"] >= t3["piece_avg"]) is False
    assert pace["remaining"] == 12          # "12 to go", a number he can act on
    assert pace["value_sub"] == "3 a day"   # the pace the total stands for
    assert pace["piece_avg"] == w20["piece_avg"] == 2.4
    assert nxt["met_count"] == sum(1 for r in nxt["requirements"] if r["met"]) == 2
    _assert_never_reads_as_met(doc)


def test_next_up_shows_no_gate_number_until_the_stretch_is_long_enough(monkeypatch):
    """A short stretch is never graded on a smaller denominator, so it gets
    no gate number — the row counts days out instead of printing a figure
    that could sit above the target with no tick."""
    db = _patch(monkeypatch)
    uid = _user(db)
    for wb in range(1, 4):  # 15 field days — three short of a 20-day read
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))

    doc = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc["windows"]["w20"] is None
    gd = _rows(doc)["good_days"]
    assert gd["window_ready"] is False
    assert gd["current"] is None and gd["met"] is False
    assert gd["so_far"] == 15 and gd["days_out"] == 15 and gd["of_days"] == 20
    assert "20 days out" in gd["note"]
    # so_far is above the 14-day target — exactly the case a raw counter
    # would have rendered as "15 of 14" beside an empty tick box.
    assert gd["so_far"] > gd["target"]


def test_next_up_skills_row_carries_the_same_counts_the_gate_reads(monkeypatch):
    """The tick list and the level gate come from one query: 2 of 4 signed
    means 2 ticks AND a gate that still says no."""
    db = _patch(monkeypatch)
    monkeypatch.setattr(sp, "ANCHOR_WAIVER_BEFORE", "2020-01-01")  # nobody waived
    uid = _user(db, created="2026-09-20")
    for i, topic in enumerate(sp.STAGE1_CC_TOPICS):
        _module(db, 1, topic, i)
    for i, topic in enumerate(sp.STAGE2_CC_TOPICS):
        _module(db, 2, topic, i)
    # One Green Week then steady ones — Competency, and the 3-a-day pace
    # keeps them there whichever way the waiver falls, so the Stage 2 row is
    # the only thing moving.
    _bells_week(db, uid, _week(4), _days(GREEN_5DAY))
    for wb in (3, 2, 1):
        _bells_week(db, uid, _week(wb), _days([2, 2, 2, 2, 2, 0, 0]))
    for i in range(len(sp.STAGE1_CC_TOPICS)):  # Stage 1 fully signed → Competency
        _run(db.module_progress.insert_one({
            "module_id": f"m1-{i}", "target_user_id": uid, "ladder": 3, "completed": True,
        }))
    for i in range(2):  # Stage 2 half signed
        _run(db.module_progress.insert_one({
            "module_id": f"m2-{i}", "target_user_id": uid, "ladder": 3, "completed": True,
        }))

    doc = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc["level"] == 2 and doc["next_up"]["level"] == 3
    skills = _rows(doc)["skills_stage2"]
    assert skills["current"] == 2 and skills["target"] == 4 and skills["met"] is False
    # The counts on the row are the gate's own read, not a second query. (The
    # per-topic list behind them is NOT shipped on the row: the checklist has
    # never drawn per-topic ticks, so it was payload nothing read.)
    counts = _run(sp._anchor_counts(uid, "boston", 2, sp.STAGE2_CC_TOPICS))
    assert [i["done"] for i in counts["items"]] == [True, True, False, False]
    assert [i["topic"] for i in counts["items"]] == sp.STAGE2_CC_TOPICS
    assert skills["current"] == counts["done"] and skills["target"] == counts["total"]
    assert "items" not in skills and "of_skills" not in skills
    # The gate agrees with the ticks, from the same read.
    assert _run(sp._anchors_met(uid, "boston", 2, sp.STAGE2_CC_TOPICS)) is False
    assert doc["next_up"]["ready"] is False

    # A waived rep is asked for nothing here — a real tick, and no invented
    # count against a target they don't have.
    monkeypatch.setattr(sp, "ANCHOR_WAIVER_BEFORE", "2027-01-01")
    waived = _rows(_run(sp.recompute_sales_path(uid, notify=False)))["skills_stage2"]
    assert waived["met"] is True and waived["waived"] is True
    assert waived["current"] is None and waived["target"] is None
    assert waived["so_far"] == 2  # their real progress is still there


def test_next_up_is_none_at_mastery_and_a_signature_is_not_a_count(monkeypatch):
    """Mastery has no next level; Expert and Mastery need a human, which is
    its own kind of requirement rather than a faked number."""
    db = _patch(monkeypatch)
    uid = _user(db)
    for wb in range(1, 15):
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))
    doc = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc["level"] == 4 and doc["expert_data_eligible"] is True

    nxt = doc["next_up"]
    assert nxt["level"] == 5 and nxt["needs_signature"] is True and nxt["signed_off_by"] == "coach"
    assert nxt["ready"] is doc["expert_data_eligible"]
    sig = _rows(doc)["expert_sign_off"]
    assert sig["kind"] == "signature"
    assert sig["current"] is None and sig["target"] is None and sig["remaining"] is None
    assert sig["can_request"] is True

    # Signed Expert 100 days ago → Mastery's hold counts real days.
    _run(db.sales_path.update_one({"user_id": uid}, {"$set": {
        "expert_signed_at": (TODAY - timedelta(days=100)).isoformat(),
    }}))
    doc5 = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc5["level"] == 5 and doc5["next_up"]["level"] == 6
    hold = _rows(doc5)["expert_hold"]
    assert hold["current"] == 100 and hold["target"] == sp.MASTERY_HOLD_DAYS
    assert hold["met"] is True and doc5["next_up"]["ready"] is doc5["mastery_data_eligible"]

    # Top of the ladder: no next level, and none invented.
    _run(db.sales_path.update_one({"user_id": uid}, {"$set": {
        "mastery_signed_at": TODAY.isoformat(),
    }}))
    doc6 = _run(sp.recompute_sales_path(uid, notify=False))
    assert doc6["level"] == 6 and doc6["next_up"] is None


def _assert_never_reads_as_met(doc):
    """The invariant the checklist's score formatter is built on: an unticked
    row's number is strictly below its target, so the client can print the
    real figure and never contradict the tick box."""
    for r in (doc.get("next_up") or {}).get("requirements", []):
        if r["met"] or r["current"] is None or r["target"] is None:
            continue
        assert r["current"] < r["target"], f"{r['key']}: {r['current']} >= {r['target']} unticked"


def test_next_up_never_prints_its_own_target(monkeypatch):
    """A rep a hair under the pace is the case that broke the card: 2.95 a
    day rendered as "3.0 of 3.0" beside an empty tick box, because the client
    rounded to one decimal. The engine's half of the contract is that an
    unticked row's number is genuinely below the bar — the client's half
    (frontend/src/components/salespath/nextUpFormat.ts) is to print enough of
    it that a reader can see so.

    The row now counts sales rather than printing the rate, which does not
    retire the contract: a fractional total one sale short would round onto
    its target the same way. 59 of 60 here; the fractional case is covered
    client-side in nextUpFormat.test.ts."""
    db = _patch(monkeypatch)
    uid = _user(db)
    # 20 field days, 59 sales: every day scores, every week is Green, and the
    # pace lands at 2.95 — four hundredths under Proficiency's 3.0.
    for wb, week in ((4, [3, 3, 3, 3, 3]), (3, [3, 3, 3, 3, 3]),
                     (2, [3, 3, 3, 3, 3]), (1, [3, 3, 3, 3, 2])):
        _bells_week(db, uid, _week(wb), _days(week + [0, 0]))

    doc = _run(sp.recompute_sales_path(uid, notify=False))
    pace = _rows(doc)["sales_per_day"]
    # 59 sales over 20 days: the gate still reads the average (2.95 < 3.0),
    # the row shows the count a rep can act on, and one sale separates them.
    assert pace["piece_avg"] == 2.95
    assert pace["current"] == 59 and pace["target"] == 60
    assert pace["met"] is False
    assert pace["current"] < pace["target"]
    assert pace["remaining"] == 1  # one sale short, and it says so
    _assert_never_reads_as_met(doc)


def test_every_graded_row_says_what_to_actually_do(monkeypatch):
    """A scoreboard told a rep the gap but never the move. Each graded row now
    carries one sentence naming the rate and the days out that tick it."""
    db = _patch(monkeypatch)
    uid = _user(db)
    for wb in range(1, 15):  # 70 field days, both 30-day stretches full
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))
    doc = _run(sp.recompute_sales_path(uid, notify=False))
    rows = _rows(doc)

    for key, row in rows.items():
        if row["kind"] == "signature" or row.get("window_ready") is not True:
            continue
        if row["met"]:
            assert not row.get("action"), f"{key}: a ticked row needs no instruction"
            continue
        act = row.get("action")
        assert act, f"{key}: graded, unmet and silent about what to do"
        assert "days out" in act, f"{key}: no timeframe — {act!r}"

    # A row grading the stretch BEHIND the recent one cannot be moved today.
    # It must say so, and must NOT name a rate — "3 a day" there would promise
    # something today's work cannot deliver for another 30 days out.
    for key in ("good_days_before", "sales_per_day_before"):
        row = rows.get(key)
        if row and not row["met"] and row.get("action"):
            act = row["action"]
            assert "Already recorded" in act, (
                f"{key} does not say these days are already written: {act!r}"
            )
            assert "a day" not in act, (
                f"{key} names a rate for a window today's work cannot reach: {act!r}"
            )


def test_action_line_never_promises_a_day_that_is_already_here(monkeypatch):
    """The forecast and the tick box must agree. A row the gate has NOT
    ticked may never carry an instruction implying it is already done."""
    db = _patch(monkeypatch)
    uid = _user(db)
    for wb in range(1, 15):
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))
    doc = _run(sp.recompute_sales_path(uid, notify=False))
    for r in (doc.get("next_up") or {}).get("requirements", []):
        act = r.get("action")
        if not act:
            continue
        assert not r["met"], f"{r['key']}: ticked but still telling the rep to act"
        assert "0 more days out" not in act and "next 0 days" not in act, (
            f"{r['key']}: instruction says no days are needed — {act!r}"
        )


def test_forecast_respects_the_pipeline_not_just_effort():
    """Days already recorded cannot be outworked. A window sitting behind the
    recent one clears by ageing, so working twice as hard changes nothing —
    which is exactly why the copy for those rows must not name a rate."""
    # 60 days newest-first: the recent 30 are strong, the 30 behind carry
    # six one-sale days that no amount of future effort can rewrite.
    recent = [3.0] * 30
    behind = [3.0] * 24 + [1.0] * 6
    sales = recent + behind

    at_pace = sp._forecast_days_out(sales, 30, 30, "days", 27, 3.0)
    at_double = sp._forecast_days_out(sales, 30, 30, "days", 27, 6.0)
    assert at_pace is not None and at_pace == at_double, (
        "a window behind the recent one should not move faster for more effort"
    )
    # The recent window, by contrast, is pure effort. Each new day REPLACES a
    # one-sale day, so the window gains (rate - 1) per day, not `rate`:
    #   at 3 a day: 30 + 2i >= 90 -> 30 days out
    #   at 6 a day: 30 + 5i >= 90 -> 12 days out
    assert sp._forecast_days_out([1.0] * 30, 30, 0, "sales", 90, 3.0) == 30
    assert sp._forecast_days_out([1.0] * 30, 30, 0, "sales", 90, 6.0) == 12


def test_every_graded_row_says_which_dates_it_read(monkeypatch):
    """The Expert card grades THREE overlapping stretches at once and used to
    describe each only by its length — "your last 30 days out". A reader could
    not tell which period a number came from, nor that two of the three share
    most of their days. Every graded row now leads with the range it read.
    """
    db = _patch(monkeypatch)
    uid = _user(db)
    for wb in range(1, 15):  # 70 field days — both 30-day stretches full
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))
    doc = _run(sp.recompute_sales_path(uid, notify=False))
    rows = _rows(doc)
    wins = doc["windows"]

    # Each row's detail opens with its OWN window's range, not another's.
    for key, wkey in (("good_days", "w30a"), ("sales_per_day", "w30a"),
                      ("good_days_before", "w30b"), ("sales_per_day_before", "w30b"),
                      ("sales_per_day_recent", "w20")):
        expected = sp._window_dates(wins[wkey])
        assert expected, f"{wkey} produced no range"
        assert rows[key]["detail"].startswith(expected), (
            f"{key} reads {rows[key]['detail']!r}, expected it to lead with {expected!r}"
        )

    # The three stretches are genuinely distinguishable on screen — the whole
    # point. w30a and w20 END together and must not be confusable by their
    # descriptions alone, which is why the dates lead.
    assert rows["good_days"]["detail"] != rows["good_days_before"]["detail"]
    assert rows["sales_per_day"]["detail"] != rows["sales_per_day_recent"]["detail"]

    # And no row still calls a TOTAL a rate. The shape changed on 2026-09-15;
    # two labels were left behind saying "Sales per day" over "88 of 90".
    for key in ("sales_per_day", "sales_per_day_before", "sales_per_day_recent"):
        assert rows[key]["kind"] == "count"
        assert "per day" not in rows[key]["label"].lower(), (
            f"{key} is a count but its label says per day: {rows[key]['label']!r}"
        )


def test_window_dates_span_a_year_boundary_without_ambiguity(monkeypatch):
    """A stretch that crosses New Year must carry the years, or "3 Jan – 2 Feb"
    could mean either side of the boundary."""
    same = {"from": "2026-08-13", "to": "2026-09-15"}
    assert sp._window_dates(same) == "13 Aug – 15 Sep"
    crossing = {"from": "2025-12-20", "to": "2026-01-18"}
    assert sp._window_dates(crossing) == "20 Dec 2025 – 18 Jan 2026"
    assert sp._window_dates(None) == ""
    assert sp._window_dates({"from": None, "to": None}) == ""


def test_filling_notes_name_the_stretch_they_actually_measure(monkeypatch):
    """Two failures in one sentence: the Expert card's "before that" rows
    reused the generic note against the WRONG stretch of days, and neither
    note admitted that only recent days out count — so a rep back from a long
    break was told they had fewer days out than they had worked."""
    db = _patch(monkeypatch)
    uid = _user(db)
    for wb in range(1, 15):  # 70 field days → Advanced, chasing Expert
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))
    # Leave the recent 30 days full and the stretch behind them short, which
    # is the state the "before that" rows spend most of their life in.
    _run(db.bells_entries.delete_many({"week_ending": {"$in": [_week(w) for w in (12, 13, 14)]}}))
    doc = _run(sp.recompute_sales_path(uid, notify=False))

    rows = _rows(doc)
    before = rows["good_days_before"]
    assert before["window_ready"] is False
    note = before["note"]
    assert "before those" in note                    # the right stretch
    assert str(before["days_out"]) in note
    weeks = sp.WINDOW_RECENCY_DAYS[30] * 2 // 7
    assert f"the last {weeks} weeks" in note          # and the recency bound
    # The recent stretch's own note, when it has one, never says "before".
    short = sp._filling_note(20, 0, 12)
    assert "before" not in short and "in the last 16 weeks" in short and "12" in short


def test_green_weeks_row_says_which_weeks_it_counts(monkeypatch):
    """A Green (8+) Bells week inside the first 8 days is legitimately
    skipped (those weeks are coach-carried). The row has to say so, or anyone
    with one reads the counter as broken."""
    db = _patch(monkeypatch)
    uid = _user(db)
    _bells_week(db, uid, _week(1), _days(GREEN_5DAY))
    doc = _run(sp.recompute_sales_path(uid, notify=False))
    detail = _rows(doc)["green_weeks"]["detail"]
    assert str(sp.GREEN_WEEK_SALES) in detail and "first 8 days" in detail
    for jargon in ("window", "cutoff", "trailing", "close"):
        assert jargon not in detail.lower()


def test_mastery_hold_row_says_days_not_bare_numbers(monkeypatch):
    """Label and detail spoke in weeks while the number was days: "12 weeks
    at Expert" over a bare "100" reads as 100 weeks."""
    db = _patch(monkeypatch)
    uid = _user(db)
    for wb in range(1, 15):
        _bells_week(db, uid, _week(wb), _days(GREEN_5DAY))
    _run(sp.recompute_sales_path(uid, notify=False))
    _run(db.sales_path.update_one({"user_id": uid}, {"$set": {
        "expert_signed_at": (TODAY - timedelta(days=100)).isoformat(),
    }}))
    hold = _rows(_run(sp.recompute_sales_path(uid, notify=False)))["expert_hold"]
    assert hold["unit"] == "days"  # the checklist prints it beside the score
    assert f"{sp.MASTERY_HOLD_DAYS} days" in hold["detail"]
    assert f"{sp.MASTERY_HOLD_DAYS // 7} weeks" in hold["detail"]


def test_scoring_day_targets_are_the_day_the_gate_flips():
    """"14 of your last 20" is inverted from the gate's own rounding, so the
    tick lands on exactly the day the level is earned."""
    for n, pct in ((20, 70), (20, 80), (30, 90)):
        need = sp._scoring_days_target(n, pct)
        assert round((need - 1) / n * 100) < pct <= round(need / n * 100)
    assert sp._scoring_days_target(20, 70) == 14
    assert sp._scoring_days_target(20, 80) == 16
    assert sp._scoring_days_target(30, 90) == 27


# ── Eligibility guards ──────────────────────────────────────────────────────


def test_demo_users_and_dark_offices_are_untouched(monkeypatch):
    db = _patch(monkeypatch)
    demo = _user(db, is_demo=True)
    assert _run(sp.recompute_sales_path(demo)) is None

    uid = _user(db)
    monkeypatch.setenv("SALES_PATH_OFFICES", "newhaven")
    assert _run(sp.recompute_sales_path(uid)) is None
    assert _run(db.sales_path.count_documents({})) == 0
