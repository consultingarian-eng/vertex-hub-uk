"""owneriq_performance — the Bells fill only ever writes an empty day."""
from datetime import date

from owneriq_performance import _day_untouched, monday_of


def test_empty_day_can_be_filled():
    assert _day_untouched({"over30": None, "under30": None, "memberships": None, "status": "off"})
    assert _day_untouched({"under30": 0, "over30": 0, "status": "normal"})


def test_entered_or_marked_days_are_left_alone():
    assert not _day_untouched({"under30": 2, "over30": None, "status": "in"})
    assert not _day_untouched({"under30": None, "over30": 1, "status": "in"})
    assert not _day_untouched({"under30": None, "over30": None, "status": "rt"})
    assert not _day_untouched({"under30": None, "over30": None, "status": "nc"})


def test_week_starts_on_monday():
    assert monday_of(date(2026, 10, 4)) == date(2026, 9, 28)   # Sunday
    assert monday_of(date(2026, 9, 28)) == date(2026, 9, 28)   # Monday
