"""The Timeline's sums (core/field_days) and the two-zeroes retrain alert
(core/zero_alerts). In-memory, no network."""
import asyncio
import sys
from datetime import date, datetime
from pathlib import Path

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import zero_alerts  # noqa: E402
from core.app_time import APP_TZ  # noqa: E402
from core.field_days import patterns, summarise_ba_day, timeline, week_ending_of  # noqa: E402


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _door(ts, state="lost", how=None):
    return {"created_at": ts, "state": state, "lost_state": how}


def _payload():
    # 5 Oct 2026 is BST: 13:30Z is 14:30 in the UK.
    lap1 = [_door("2026-10-05T13:30:00Z", "swing_by_later"), _door("2026-10-05T13:50:00Z", "lost", "spoken"),
            _door("2026-10-05T14:10:00Z", "won"), _door("2026-10-05T15:29:00Z", "lost", "pitched")]
    lap2 = [_door("2026-10-05T17:02:00Z", "won"), _door("2026-10-05T18:35:00Z", "partially_won"),
            _door(None, None)]                       # on the list, never knocked
    return {
        "ba": {"id": 1009611, "full_name": "Ayo Example", "stage": "stage_3_plus"},
        "sector": {"id": 10412, "name": "North"},
        "hero": {"doors_knocked": 6, "spoken_to": 5, "pitches_commenced": 4, "pitches_closed": 3, "sales": 2, "points": 40,
                 "first_knock_at": "2026-10-05T13:30:00Z", "last_knock_at": "2026-10-05T18:35:00Z"},
        "laps": [{"number": 1, "interactions_by_address": [{"interactions": lap1}]},
                 {"number": 2, "interactions_by_address": [{"interactions": lap2}]}],
    }


def test_a_day_is_summarised_in_uk_hours_with_the_sector_break():
    d = summarise_ba_day(_payload(), "2026-10-05")
    assert d["oid"] == "1009611" and d["week_ending"] == "2026-10-11" and d["sales"] == 2
    assert d["first_min"] == 14 * 60 + 30 and d["last_min"] == 19 * 60 + 35
    assert d["field_minutes"] == 305
    # last door of lap 1 (16:29) → first door of lap 2 (18:02)
    assert d["break_minutes"] == 93
    assert d["hours"]["15"] == {"doors": 1, "spoken": 1, "pitched": 1, "sales": 1}
    assert d["hours"]["18"]["sales"] == 1 and d["hours"]["19"] == {"doors": 1, "spoken": 1, "pitched": 1, "sales": 0}
    assert sum(c["doors"] for c in d["hours"].values()) == 6        # the never-knocked door is not counted
    assert sum(c["sales"] for c in d["hours"].values()) == d["sales"]


def test_one_lap_has_no_break_and_no_doors_is_no_day():
    p = _payload(); p["laps"] = p["laps"][:1]
    assert summarise_ba_day(p, "2026-10-05")["break_minutes"] is None
    empty = {"ba": {"id": 7}, "hero": {"doors_knocked": 0}, "laps": []}
    assert summarise_ba_day(empty, "2026-10-05") is None
    assert week_ending_of("2026-10-11") == "2026-10-11" and week_ending_of("2026-10-12") == "2026-10-18"


def _day(oid, day, sales, hours, first=870, last=1200, brk=40, name=None):
    return {"oid": oid, "name": name or f"BA {oid}", "date": day, "week_ending": week_ending_of(day), "sales": sales,
            "doors_knocked": 100, "spoken_to": 50, "first_min": first, "last_min": last, "field_minutes": last - first,
            "break_minutes": brk, "hours": {str(h): {"doors": 20, "spoken": 8, "pitched": 2, "sales": s} for h, s in hours.items()}}


def test_timeline_finds_the_peak_hour_and_each_bas_best_hour():
    days = [_day("a", "2026-10-05", 3, {15: 1, 16: 2}), _day("a", "2026-10-06", 1, {16: 1, 17: 0}),
            _day("b", "2026-10-05", 2, {17: 2}, last=1170)]
    t = timeline(days)
    assert [h["hour"] for h in t["hours"]] == [15, 16, 17] and t["peak_hour"] == 16
    sixteen = next(h for h in t["hours"] if h["hour"] == 16)
    assert sixteen["sales"] == 3 and sixteen["ba_hours"] == 2 and sixteen["people"] == 1 and sixteen["per_ba_hour"] == 1.5
    a, b = t["bas"]
    assert (a["oid"], a["sales"], a["days"], a["best_hour"]) == ("a", 4, 2, 16)
    assert a["field_hours"] == 11.0 and a["per_hour"] == round(4 / 11, 2)
    assert (b["oid"], b["best_hour"]) == ("b", 17) and b["hours"]["17"] == {"sales": 2, "doors": 20, "n": 1}
    assert t["totals"] == {"sales": 6, "doors": 300, "ba_days": 3, "people": 2}
    assert t["averages"]["break_minutes"] == 40 and t["averages"]["first_min"] == 870
    assert timeline([]) == {"hours": [], "peak_hour": None, "bas": [], "totals": {"sales": 0, "doors": 0, "ba_days": 0, "people": 0},
                            "averages": {k: None for k in ("first_min", "last_min", "field_minutes", "break_minutes", "doors", "spoken", "sales")}}


def test_patterns_cut_person_weeks_into_best_average_and_low():
    days = []
    # six people, one week each: sign-ups 12, 9, 6, 4, 1, 0. Earlier starts for the best.
    for i, (sales, first) in enumerate([(12, 840), (9, 850), (6, 880), (4, 890), (1, 930), (0, 940)]):
        days += [_day(str(i), "2026-10-05", sales // 2, {15: 0}, first=first), _day(str(i), "2026-10-06", sales - sales // 2, {15: 0}, first=first)]
    p = patterns(days)
    assert p["weeks"] == 6 and [b["key"] for b in p["bands"]] == ["best", "average", "low"]
    best, avg, low = p["bands"]
    assert (best["weeks"], best["sales_min"], best["sales_max"], best["sales_per_week"]) == (2, 9, 12, 10.5)
    assert (low["sales_min"], low["sales_max"]) == (0, 1) and avg["sales_per_week"] == 5.0
    assert best["first_min"] == 845 and low["first_min"] == 935 and best["days_per_week"] == 2.0
    # One or two weeks: nothing to cut into thirds.
    one = patterns(days[:2])
    assert [b["key"] for b in one["bands"]] == ["best", "average"] and one["weeks"] == 1
    assert patterns([]) == {"weeks": 0, "bands": []}


def test_the_date_range_is_tidied():
    from routes.insights import MAX_RANGE_DAYS, _clean_range
    today = datetime.now(APP_TZ).date()
    monday = today.fromordinal(today.toordinal() - today.weekday())
    assert _clean_range(None, None) == (monday.isoformat(), today.isoformat())           # this week so far
    assert _clean_range("2026-09-01", "2026-09-07") == ("2026-09-01", "2026-09-07")
    assert _clean_range("2026-09-07", "2026-09-01") == ("2026-09-01", "2026-09-01")      # back to front
    assert _clean_range("nonsense", "2099-01-01")[1] == today.isoformat()                # never the future
    start, end = _clean_range("2020-01-01", None)
    assert (today - today.fromisoformat(start)).days == MAX_RANGE_DAYS and end == today.isoformat()


# ── two zeroes in a row ──────────────────────────────────────────────────────
def _week(week_ending, days):
    """days: 7 of None (off) or a sign-up count for a day in."""
    return {"week_ending": week_ending, "days": [
        {"status": "off", "under30": None, "over30": None} if d is None else {"status": "in", "under30": d, "over30": 0} for d in days]}


def test_two_zero_days_in_a_row_even_across_a_day_off_or_a_weekend():
    wed = date(2026, 10, 7)
    assert zero_alerts.zero_run([_week("2026-10-11", [3, 0, 0, None, None, None, None])], wed) == ("2026-10-06", "2026-10-07")
    # a day off between them doesn't break the run
    assert zero_alerts.zero_run([_week("2026-10-11", [0, None, 0, None, None, None, None])], wed) == ("2026-10-05", "2026-10-07")
    # Saturday zero, then Monday zero
    mon = date(2026, 10, 12)
    weeks = [_week("2026-10-11", [2, 1, 1, 1, 1, 0, None]), _week("2026-10-18", [0, None, None, None, None, None, None])]
    assert zero_alerts.zero_run(weeks, mon) == ("2026-10-10", "2026-10-12")
    # one zero, a sale in between, a stale run, or days not yet judged: nothing
    assert zero_alerts.zero_run([_week("2026-10-11", [3, 1, 0, None, None, None, None])], wed) is None
    assert zero_alerts.zero_run([_week("2026-10-11", [0, 1, 0, None, None, None, None])], wed) is None
    assert zero_alerts.zero_run([_week("2026-10-11", [0, 0, None, None, None, None, None])], date(2026, 10, 10)) is None
    assert zero_alerts.zero_run([_week("2026-10-11", [1, 0, 0, None, None, None, None])], date(2026, 10, 6)) is None


def test_today_only_counts_once_the_field_day_is_over():
    assert zero_alerts.judged_through(datetime(2026, 10, 7, 20, 59, tzinfo=APP_TZ)) == date(2026, 10, 6)
    assert zero_alerts.judged_through(datetime(2026, 10, 7, 21, 0, tzinfo=APP_TZ)) == date(2026, 10, 7)


def test_the_owner_and_the_upline_are_told_once(monkeypatch):
    db = AsyncMongoMockClient()["zero_alerts_test"]
    office = "office-romford"

    def user(name, role, parent=None, **extra):
        doc = {"_id": ObjectId(), "name": name, "role": role, "office_id": office,
               "reports_to": str(parent["_id"]) if parent else None, **extra}
        _run(db.users.insert_one(doc))
        return doc

    owner = user("Owner", "admin")
    lead = user("Team Lead", "leader", owner)
    coach = user("Coach", "leader", lead)
    ba = user("Zero Zed", "trainee", coach)
    fine = user("Fine Fay", "trainee", coach)
    for person, days in ((ba, [2, 0, 0, None, None, None, None]), (fine, [0, 3, 0, None, None, None, None])):
        _run(db.bells_entries.insert_one({"user_id": str(person["_id"]), "office_id": office, **_week("2026-10-11", days)}))
    got = []

    async def send(user_id, title, body, data):
        got.append((user_id, title, body, data))

    night = datetime(2026, 10, 7, 21, 30, tzinfo=APP_TZ)
    sent = _run(zero_alerts.run(db, now_uk=night, send=send))
    assert [s["name"] for s in sent] == ["Zero Zed"]
    assert {g[0] for g in got} == {str(owner["_id"]), str(lead["_id"]), str(coach["_id"])}      # not the BA
    title, body, data = got[0][1], got[0][2], got[0][3]
    assert title == "Retrain needed: Zero Zed"
    assert body == "Zero Zed has had 2 zero days in a row (6 Oct and 7 Oct). They need a retrain."
    assert data["type"] == "zero_days" and data["url"] == f"/person/{ba['_id']}"
    # the same run is never sent twice
    assert _run(zero_alerts.run(db, now_uk=night, send=send)) == [] and len(got) == 3
    # a third zero the next day is a new run to flag
    _run(db.bells_entries.update_one({"user_id": str(ba["_id"])}, {"$set": {"days.3": {"status": "in", "under30": 0, "over30": 0}}}))
    again = _run(zero_alerts.run(db, now_uk=datetime(2026, 10, 8, 21, 30, tzinfo=APP_TZ), send=send))
    assert [(s["first"], s["second"]) for s in again] == [("2026-10-07", "2026-10-08")]


# ── keeping the door logs coming ─────────────────────────────────────────────
def test_the_tick_refreshes_today_and_fills_in_the_past_a_day_at_a_time(monkeypatch):
    import owneriq_field

    db = AsyncMongoMockClient()["field_tick_test"]
    clock = {"now": datetime(2026, 10, 8, 9, 0, tzinfo=APP_TZ)}

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock["now"].astimezone(tz) if tz else clock["now"]

    walked = []

    async def harvest(day):
        if day == "2026-10-04":
            raise RuntimeError("OwnerIQ said no")
        walked.append(day)
        await db.owneriq_live_cache.update_one({"_id": f"ba:1009611:{day}"}, {"$set": {
            "kind": "ba", "ref_id": "1009611", "date": day, "payload": _payload(), "fetched_at": f"{day}T03:00:00+00:00"}}, upsert=True)
        return {"sectors": 1, "bas": 1}

    monkeypatch.setattr(owneriq_field, "db", db)
    monkeypatch.setattr(owneriq_field, "datetime", Clock)
    monkeypatch.setattr(owneriq_field, "has_login", lambda: True)
    monkeypatch.setattr(owneriq_field, "_harvest", harvest)

    # Before the field day: the past, newest first. Yesterday is the nightly re-settle's.
    assert _run(owneriq_field.tick())["fetched"]["date"] == "2026-10-06"
    assert _run(owneriq_field.tick())["fetched"]["date"] == "2026-10-05"
    # A day OwnerIQ won't serve is tried three times, then left behind.
    for _ in range(3):
        assert "2026-10-04" in _run(owneriq_field.tick())["error"]
    assert _run(owneriq_field.tick())["fetched"]["date"] == "2026-10-03"
    # Each saved log became one small record, built once.
    assert _run(db.owneriq_field_days.count_documents({"empty": False})) == 3
    assert _run(owneriq_field.build_field_days()) == 0
    # In the field day, today comes first, then back to the past until today is due again.
    clock["now"] = datetime(2026, 10, 8, 12, 0, tzinfo=APP_TZ)
    assert _run(owneriq_field.tick())["fetched"]["date"] == "2026-10-08"
    assert _run(owneriq_field.tick())["fetched"]["date"] == "2026-10-02"
    clock["now"] = datetime(2026, 10, 8, 12, 55, tzinfo=APP_TZ)
    assert _run(owneriq_field.tick())["fetched"]["date"] == "2026-10-08"
    assert walked == ["2026-10-06", "2026-10-05", "2026-10-03", "2026-10-08", "2026-10-02", "2026-10-08"]
    # Without a login (a local run) nothing is fetched.
    monkeypatch.setattr(owneriq_field, "has_login", lambda: False)
    assert _run(owneriq_field.tick())["fetched"] is None
