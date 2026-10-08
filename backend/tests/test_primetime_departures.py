"""Office Primetime: a person who leaves drops off future days, not past ones.

The whole feature rests on never materialising the roster into storage — the
names are computed live on every read — so "who is on the plan" is a pure
function of the day's date and the person's last day. That function is what
these tests pin down, because getting it wrong is either a data-loss bug
(someone's history vanishes when they leave) or an embarrassment bug (a
departed rep is still being scheduled to teach next Tuesday).
"""
import asyncio
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import primetime as pt  # noqa: E402
from core.app_time import APP_TZ  # noqa: E402

# Week ending Sunday 2026-08-09 → Mon 08-03 .. Sat 08-08.
WEEK = "2026-08-09"
MON, TUE, WED, THU, FRI, SAT = (pt._day_date(WEEK, d) for d in range(6))


# --------------------------------------------------------------------------
# _left_on — reading a last day out of whatever the user doc happens to carry
# --------------------------------------------------------------------------

def test_present_person_has_no_last_day():
    assert pt._left_on({"name": "Ana"}) is None
    assert pt._left_on({"name": "Ana", "is_active": True, "deleted": False}) is None


def test_explicit_left_on_wins_over_deleted_at():
    # deleted_at is when an admin pressed the button; left_on is the last day
    # actually worked. When they disagree, the human-entered date is the truth.
    u = {"deleted": True, "deleted_at": "2026-08-20T14:03:00+00:00", "left_on": WED}
    assert pt._left_on(u) == WED


def test_deleted_at_is_the_fallback_for_legacy_soft_deletes():
    u = {"deleted": True, "deleted_at": "2026-08-05T14:03:00+00:00"}
    assert pt._left_on(u) == WED


def test_flagged_gone_with_no_date_is_treated_as_long_gone():
    # `is_active: False` is never written by this codebase — it arrives by hand
    # or from an external process, with no timestamp. Fail closed: off the grid.
    assert pt._left_on({"is_active": False}) == "1970-01-01"
    assert pt._left_on({"deleted": True}) == "1970-01-01"


def test_garbage_left_on_falls_through_rather_than_crashing():
    assert pt._left_on({"deleted": True, "left_on": "last tuesday",
                        "deleted_at": "2026-08-05T00:00:00+00:00"}) == WED
    assert pt._left_on({"left_on": None}) is None


# --------------------------------------------------------------------------
# _on_grid — the actual rule the user asked for
# --------------------------------------------------------------------------

def test_someone_who_leaves_wednesday_works_wednesday():
    """"Removed from any future team plans after the day that person's left."

    Inclusive of the last day itself — she is at Primetime on her last day.
    """
    left = WED
    assert pt._on_grid(left, MON) is True
    assert pt._on_grid(left, TUE) is True
    assert pt._on_grid(left, WED) is True
    assert pt._on_grid(left, THU) is False
    assert pt._on_grid(left, FRI) is False
    assert pt._on_grid(left, SAT) is False


def test_still_here_means_every_day():
    assert all(pt._on_grid(None, d) for d in (MON, TUE, WED, THU, FRI, SAT))


def test_long_departed_is_on_no_day_at_all():
    assert not any(pt._on_grid("1970-01-01", d) for d in (MON, WED, SAT))


def test_last_day_in_a_future_week_keeps_them_on_this_whole_week():
    assert all(pt._on_grid("2026-09-01", d) for d in (MON, TUE, WED, THU, FRI, SAT))


# --------------------------------------------------------------------------
# _office_roster — the query has to be wider than the app-wide active filter
# --------------------------------------------------------------------------

class _FakeFind:
    def __init__(self, rows, query):
        self.rows = rows
        self.query = query

    async def to_list(self, _n):
        return [r for r in self.rows if _matches(r, self.query)]


def _matches(row, query):
    """Tiny subset of the Mongo query language: $in, $ne, $gte, $or, equality."""
    for field, cond in query.items():
        if field == "$or":
            if not any(_matches(row, sub) for sub in cond):
                return False
            continue
        value = row.get(field)
        if isinstance(cond, dict):
            if "$in" in cond and value not in cond["$in"]:
                return False
            if "$ne" in cond and value == cond["$ne"]:
                return False
            if "$gte" in cond:
                if value is None or str(value) < cond["$gte"]:
                    return False
        elif value != cond:
            return False
    return True


class _FakeUsers:
    def __init__(self, rows):
        self.rows = rows

    def find(self, query, _projection=None):
        return _FakeFind(self.rows, query)


def test_roster_keeps_the_present_drops_the_long_gone_and_keeps_the_recent(monkeypatch):
    rows = [
        {"_id": "1", "name": "Ana",  "role": "trainee", "office_id": "office-boston"},
        {"_id": "2", "name": "Ben",  "role": "leader",  "office_id": "office-boston",
         "deleted": True, "left_on": WED},                      # left mid-week
        {"_id": "3", "name": "Cara", "role": "trainee", "office_id": "office-boston",
         "deleted": True, "left_on": "2025-01-04"},             # left last year
        {"_id": "4", "name": "Dee",  "role": "trainee", "office_id": "office-newhaven"},
    ]

    class _DB:
        users = _FakeUsers(rows)

    monkeypatch.setattr(pt, "db", _DB)
    people = asyncio.run(pt._office_roster("office-boston", WEEK))
    names = sorted(p["name"] for p in people)

    # Ana is here; Ben left this week so his pre-departure days still need him;
    # Cara left long before the week started; Dee is a different office.
    assert names == ["Ana", "Ben"]

    ben = next(p for p in people if p["name"] == "Ben")
    assert ben["left_on"] == WED
    assert [d for d in range(6) if pt._on_grid(ben["left_on"], pt._day_date(WEEK, d))] == [0, 1, 2]

    ana = next(p for p in people if p["name"] == "Ana")
    assert ana["left_on"] is None


# --------------------------------------------------------------------------
# _editable_ids — the read and write paths must agree on who is on the plan
# --------------------------------------------------------------------------

def test_a_leader_can_still_finish_recording_a_departed_reports_days(monkeypatch):
    """Regression: the grid showed a leaver on Mon–Wed but every save 403'd.

    `get_subtree_ids` drops departed people at the query level, while the
    roster deliberately keeps them for the days they worked. When only the
    read path knew that, the two disagreed and the cells were unsaveable.
    """
    rows = [
        {"_id": "gone", "office_id": "office-boston", "reports_to": "leader",
         "deleted": True, "left_on": WED},
        # A different leader's leaver must NOT become editable by this leader.
        {"_id": "other", "office_id": "office-boston", "reports_to": "leader-b",
         "deleted": True, "left_on": WED},
        # Still here → already in the subtree, and not a departure row.
        {"_id": "present", "office_id": "office-boston", "reports_to": "leader"},
    ]

    class _DB:
        users = _FakeUsers(rows)

    monkeypatch.setattr(pt, "db", _DB)

    async def fake_subtree(_uid):
        return ["leader", "present"]

    monkeypatch.setattr(pt, "get_subtree_ids", fake_subtree)

    me = {"id": "leader", "role": "leader", "office_id": "office-boston"}
    editable = asyncio.run(pt._editable_ids(me, "office-boston"))

    assert "gone" in editable, "a departed direct report must stay editable for the days they worked"
    assert "other" not in editable, "another leader's leaver must not leak in"
    assert {"leader", "present"} <= editable


def test_an_admin_may_edit_their_whole_office(monkeypatch):
    me = {"id": "boss", "role": "admin", "office_id": "office-boston"}
    assert asyncio.run(pt._editable_ids(me, "office-boston")) is None


def test_an_admin_from_another_office_falls_back_to_their_tree(monkeypatch):
    class _DB:
        users = _FakeUsers([])

    monkeypatch.setattr(pt, "db", _DB)

    async def fake_subtree(_uid):
        return ["boss"]

    monkeypatch.setattr(pt, "get_subtree_ids", fake_subtree)
    me = {"id": "boss", "role": "admin", "office_id": "office-newhaven"}
    assert asyncio.run(pt._editable_ids(me, "office-boston")) == {"boss"}


# --------------------------------------------------------------------------
# _planning_day — after 6pm the office is looking at tomorrow
# --------------------------------------------------------------------------

def _at_hm(day: str, hour: int, minute: int = 0):
    """A moment in office time, from a YYYY-MM-DD and a clock time."""
    from datetime import date as _date, datetime as _dt
    d = _date.fromisoformat(day)
    return _dt(d.year, d.month, d.day, hour, minute, tzinfo=APP_TZ)


def _at(day: str, hour: int):
    return _at_hm(day, hour)


def test_before_six_the_plan_is_todays():
    # Tuesday 2026-08-04 at 09:00 and 17:59 → still Tuesday.
    assert pt._planning_day(_at("2026-08-04", 9)).isoformat() == "2026-08-04"
    assert pt._planning_day(_at("2026-08-04", 17)).isoformat() == "2026-08-04"


def test_from_six_the_plan_rolls_to_tomorrow():
    # 18:00 exactly is already tomorrow — the working day is done.
    assert pt._planning_day(_at("2026-08-04", 18)).isoformat() == "2026-08-05"
    assert pt._planning_day(_at("2026-08-04", 23)).isoformat() == "2026-08-05"


def test_saturday_evening_skips_sunday_and_lands_on_monday():
    """Sunday has no Primetime, and Monday belongs to the NEXT week.

    This is the case that makes a bare weekday index wrong — the caller has to
    take the date, not just "day 0".
    """
    sat_evening = pt._planning_day(_at("2026-08-08", 19))
    assert sat_evening.isoformat() == "2026-08-10"       # Monday
    assert sat_evening.weekday() == 0
    # …and it belongs to the following week, not the one Saturday was in.
    assert pt._coerce_to_sunday(sat_evening.isoformat()) == "2026-08-16"
    assert pt._coerce_to_sunday("2026-08-08") == "2026-08-09"


def test_sunday_daytime_looks_ahead_to_monday():
    assert pt._planning_day(_at("2026-08-09", 10)).isoformat() == "2026-08-10"


def test_friday_evening_is_saturday_not_monday():
    # Saturday is a working day here, so no skipping.
    assert pt._planning_day(_at("2026-08-07", 20)).isoformat() == "2026-08-08"


# --------------------------------------------------------------------------
# _unchased — one person, one owner, and the owner is never the admin
# --------------------------------------------------------------------------

def _grid(*rows):
    """{user_id: person} from (id, name, reports_to) triples."""
    return {r[0]: {"user_id": r[0], "name": r[1], "leader_id": r[2]} for r in rows}


def test_a_leader_owns_their_direct_reports_and_themselves():
    grid = _grid(("lead", "Dana", "owner"), ("t1", "Ana", "lead"), ("t2", "Ben", "lead"))
    assert sorted(pt._unchased(grid, "lead", set(), set())) == ["lead", "t1", "t2"]


def test_a_leader_is_not_chased_for_a_sub_leaders_crew():
    """Nudges fire DOWN one level, not down the whole tree.

    If every leader above were chased for the same trainee, one unplanned rep
    would push three people and everyone would learn to ignore them. The
    sub-leader is on their own leader's list, so it's watched once, not never.
    """
    grid = _grid(
        ("lead", "Dana", "owner"),
        ("sub", "Sam", "lead"),
        ("deep", "Zoe", "sub"),
    )
    top = pt._unchased(grid, "lead", set(), set())
    assert "sub" in top, "a sub-leader is still their own leader's responsibility"
    assert "deep" not in top, "but that sub-leader's crew is not"
    assert sorted(pt._unchased(grid, "sub", set(), set())) == ["deep", "sub"]


def test_a_first_generation_leader_with_no_crew_still_owns_their_own_row():
    """This is what covers an owner's direct reports without pushing the owner.

    An admin never gets nudged, so the leaders reporting straight to them have
    to be chased about themselves — otherwise nobody is.
    """
    grid = _grid(("fg", "Rafa", "owner"))
    assert pt._unchased(grid, "fg", set(), set()) == ["fg"]


def test_planned_and_absent_people_are_left_alone():
    grid = _grid(("lead", "Dana", "owner"), ("t1", "Ana", "lead"), ("t2", "Ben", "lead"))
    assert pt._unchased(grid, "lead", {"t1"}, set()) == ["lead", "t2"]
    assert pt._unchased(grid, "lead", {"t1"}, {"t2"}) == ["lead"]
    assert pt._unchased(grid, "lead", {"lead", "t1", "t2"}, set()) == []


def test_the_nudge_only_ever_looks_at_leaders():
    """Admins oversee an office; the planning belongs to the leaders under them.

    Guards the role filter in primetime_nudge_tick — if it ever widened to
    include admins, an owner would start getting pushed.
    """
    import inspect
    src = inspect.getsource(pt.primetime_nudge_tick)
    assert '"role": "leader"' in src


# --------------------------------------------------------------------------
# Quiet hours — nobody gets pushed overnight
# --------------------------------------------------------------------------

def test_the_scheduled_slots_are_all_allowed_to_send():
    """22:00, 08:30, 09:30 and 10:00 must every one of them get through."""
    for hh, mm in ((22, 0), (8, 30), (9, 30), (10, 0)):
        assert not pt._in_quiet_hours(_at_hm("2026-08-04", hh, mm)), f"{hh}:{mm:02d} was silenced"


def test_overnight_is_silent():
    for hh, mm in ((23, 0), (23, 30), (0, 0), (3, 15), (7, 59), (8, 29)):
        assert pt._in_quiet_hours(_at_hm("2026-08-04", hh, mm)), f"{hh}:{mm:02d} would have pushed"


def test_the_boundaries_land_the_right_side():
    # 22:59 still fine, 23:00 sharp is silent; 08:29 silent, 08:30 sharp sends.
    assert not pt._in_quiet_hours(_at_hm("2026-08-04", 22, 59))
    assert pt._in_quiet_hours(_at_hm("2026-08-04", 23, 0))
    assert pt._in_quiet_hours(_at_hm("2026-08-04", 8, 29))
    assert not pt._in_quiet_hours(_at_hm("2026-08-04", 8, 30))


def test_a_tick_inside_quiet_hours_sends_nothing_at_all():
    """The guard lives in the tick, not just the schedule.

    Belt and braces: if someone later adds a slot at a careless hour, the tick
    still refuses rather than waking the office up.
    """
    sent = asyncio.run(pt.primetime_nudge_tick(_at_hm("2026-08-04", 2, 0)))
    assert sent == 0


def test_the_evening_slot_chases_tomorrow_and_the_morning_slots_chase_today():
    # 22:00 Tuesday → Wednesday; 08:30 Tuesday → still Tuesday.
    assert pt._planning_day(_at_hm("2026-08-04", 22, 0)).isoformat() == "2026-08-05"
    assert pt._planning_day(_at_hm("2026-08-04", 8, 30)).isoformat() == "2026-08-04"
    assert pt._planning_day(_at_hm("2026-08-04", 10, 0)).isoformat() == "2026-08-04"


# --------------------------------------------------------------------------
# _day_statuses — Primetime is planned for whoever is actually in
# --------------------------------------------------------------------------

class _FakeBells:
    def __init__(self, rows):
        self.rows = rows

    def find(self, query, _projection=None):
        return _FakeFind(self.rows, query)


def _statuses(rows, monkeypatch, ids=("u1",)):
    class _DB:
        bells_entries = _FakeBells(rows)

    monkeypatch.setattr(pt, "db", _DB)
    return asyncio.run(pt._day_statuses("office-boston", WEEK, list(ids)))


def test_an_absent_day_is_read_off_the_bells_sheet(monkeypatch):
    rows = [{
        "user_id": "u1", "office_id": "office-boston", "week_ending": WEEK,
        # Mon..Sun; Wednesday marked absent.
        "days": [{"status": "in"}, {"status": "in"}, {"status": "ab"},
                 {"status": "in"}, {"status": "in"}, {"status": "off"}, {"status": "off"}],
    }]
    out = _statuses(rows, monkeypatch)
    assert out["u1"] == ["in", "in", "ab", "in", "in", "off"]
    assert [d for d in range(6) if out["u1"][d] == "ab"] == [2]


def test_a_missing_bells_row_is_not_an_absence(monkeypatch):
    """Plenty of weeks get planned before Bells is filled in.

    Silence must never be read as "they're away", or the day's Primetime list
    would quietly empty out for any office that plans ahead.
    """
    assert _statuses([], monkeypatch) == {}


def test_a_short_or_ragged_days_array_does_not_crash(monkeypatch):
    rows = [
        {"user_id": "u1", "office_id": "office-boston", "week_ending": WEEK,
         "days": [{"status": "in"}]},                      # truncated
        {"user_id": "u2", "office_id": "office-boston", "week_ending": WEEK,
         "days": [None, "nonsense", {"status": "ab"}]},     # junk entries
        {"user_id": "u3", "office_id": "office-boston", "week_ending": WEEK},  # no days at all
    ]
    out = _statuses(rows, monkeypatch, ids=("u1", "u2", "u3"))
    assert out["u1"] == ["in", "", "", "", "", ""]
    assert out["u2"][2] == "ab" and out["u2"][0] == ""
    assert out["u3"] == ["", "", "", "", "", ""]


def test_no_ids_means_no_query(monkeypatch):
    assert _statuses([{"user_id": "u1"}], monkeypatch, ids=()) == {}


# --------------------------------------------------------------------------
# _build_sessions — "who is running what, and who did I add to it"
# --------------------------------------------------------------------------

def _entry(**kw):
    base = {"day_index": 2, "day_date": WED, "session_id": "", "topic": "",
            "subject_user_id": "", "subject_name": "", "mode": None}
    base.update(kw)
    return base


def test_a_teaching_row_anchors_a_session_and_collects_its_attendees():
    entries = [
        _entry(subject_user_id="t1", subject_name="Ana", mode="teaching",
               topic="Objection handling", session_id="s1"),
        _entry(subject_user_id="t2", subject_name="Ben", mode="learning", session_id="s1"),
        _entry(subject_user_id="t3", subject_name="Cara", mode="watching", session_id="s1"),
    ]
    sessions = pt._build_sessions(entries)
    assert len(sessions) == 1
    s = sessions[0]
    assert s["host_name"] == "Ana"
    assert s["topic"] == "Objection handling"
    assert [(a["name"], a["mode"]) for a in s["attendees"]] == [("Ben", "learning"), ("Cara", "watching")]


def test_the_host_is_not_listed_as_their_own_attendee():
    entries = [_entry(subject_user_id="t1", subject_name="Ana", mode="teaching",
                      topic="Gate openers", session_id="s1")]
    assert pt._build_sessions(entries)[0]["attendees"] == []


def test_solo_learning_is_not_a_session():
    # Reading the manual on your own is a valid row, but nobody can join it.
    entries = [_entry(subject_user_id="t2", subject_name="Ben", mode="learning",
                      topic="Product knowledge")]
    assert pt._build_sessions(entries) == []


def test_two_teams_running_different_topics_stay_separate():
    entries = [
        _entry(subject_user_id="t1", subject_name="Ana", mode="teaching",
               topic="Objection handling", session_id="s1"),
        _entry(subject_user_id="t9", subject_name="Zoe", mode="teaching",
               topic="Bells", session_id="s2", day_index=3),
        _entry(subject_user_id="t2", subject_name="Ben", mode="learning", session_id="s2",
               day_index=3),
    ]
    sessions = {s["session_id"]: s for s in pt._build_sessions(entries)}
    assert sessions["s1"]["attendees"] == []
    assert [a["name"] for a in sessions["s2"]["attendees"]] == ["Ben"]
    assert sessions["s2"]["day_index"] == 3


# --------------------------------------------------------------------------
# date plumbing
# --------------------------------------------------------------------------

def test_day_index_zero_is_monday_and_five_is_saturday():
    assert MON == "2026-08-03"
    assert SAT == "2026-08-08"


def test_any_day_of_the_week_coerces_to_the_same_sunday():
    for d in (MON, WED, SAT, WEEK):
        assert pt._coerce_to_sunday(d) == WEEK


def test_a_bad_week_string_coerces_to_nothing_rather_than_raising():
    assert pt._coerce_to_sunday("not-a-date") is None
