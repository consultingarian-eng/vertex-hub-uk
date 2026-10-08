"""Someone marked `ab` on this week's bells gets that day blanked on their
schedule and no schedule reminders for it. Only `ab` counts — rt/pc/off/nc
never blank a day, other weeks never leak in, and unlinked rows are ignored."""
import asyncio
import sys
from datetime import datetime
from pathlib import Path

from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.app_time import APP_TZ  # noqa: E402
from core.bells_absence import absent_today_user_ids, current_week_absence  # noqa: E402

# Tuesday 2026-09-29 → bells week ending Sunday 2026-10-04.
TUE = datetime(2026, 9, 29, 9, 0, tzinfo=APP_TZ)


def _run(coro):
    return asyncio.run(coro)


def _days(**by_idx):
    return [{"status": by_idx.get(f"d{i}", "off")} for i in range(7)]


def _db():
    d = AsyncMongoMockClient()["cg1_bells_absence_test"]
    _run(d.bells_entries.insert_many([
        {"user_id": "u1", "week_ending": "2026-10-04", "days": _days(d1="ab", d3="ab", d0="in")},
        {"user_id": "u2", "week_ending": "2026-10-04", "days": _days(d1="rt", d2="pc", d4="nc")},
        {"user_id": "u3", "week_ending": "2026-09-27", "days": _days(d1="ab")},  # last week
        {"user_id": None, "user_name": "Unlinked", "week_ending": "2026-10-04", "days": _days(d1="ab")},
    ]))
    return d


def test_week_absence_lists_only_ab_days_with_dates():
    out = _run(current_week_absence("u1", TUE, database=_db()))
    assert out == {"week_ending": "2026-10-04", "days": [1, 3],
                   "dates": ["2026-09-29", "2026-10-01"]}


def test_other_statuses_and_other_weeks_blank_nothing():
    d = _db()
    assert _run(current_week_absence("u2", TUE, database=d))["days"] == []
    assert _run(current_week_absence("u3", TUE, database=d))["days"] == []
    assert _run(current_week_absence(None, TUE, database=d))["days"] == []


def test_absent_today_is_only_linked_ab_rows_for_today():
    assert _run(absent_today_user_ids(TUE, database=_db())) == {"u1"}


def test_reminder_tick_skips_whoever_is_absent_today(monkeypatch):
    import core.schedule_reminders as sr

    class _Now(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 29, 9, 55, tzinfo=APP_TZ)  # 5 min before 10:00

    d = _db()
    _run(d.schedule_blocks.insert_one({"id": "b1", "office_id": "o1", "day_of_week": 1,
                                       "start_time": "10:00", "audience": "all", "title": "Morning meeting"}))
    _run(d.users.insert_many([{"_id": "u1", "office_id": "o1", "role": "trainee"},
                              {"_id": "u2", "office_id": "o1", "role": "trainee"}]))
    _run(d.web_push_subscriptions.insert_many([{"user_id": "u1"}, {"user_id": "u2"}]))

    sent = []

    async def _send(uid, *a, **k):
        sent.append(uid)

    async def _enabled(*a, **k):
        return True

    monkeypatch.setattr(sr, "db", d)
    monkeypatch.setattr(sr, "datetime", _Now)
    monkeypatch.setattr(sr, "send_web_push_to_user", _send)
    monkeypatch.setattr(sr, "is_category_enabled_for_user_id", _enabled)
    monkeypatch.setattr(sr, "_ttl_index_ready", True)

    _run(sr.schedule_reminder_tick())
    assert sent == ["u2"]  # u1 is `ab` Tuesday; u2 is rt/pc/nc elsewhere and in today
