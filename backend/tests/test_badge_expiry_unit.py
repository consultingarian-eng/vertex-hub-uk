"""A badge expires one year from the day it is generated."""
from datetime import date

from routes.badges import default_expiry


def test_one_year_from_generation():
    assert default_expiry(date(2026, 9, 30)) == "30/09/2027"


def test_leap_day_rolls_to_28_february():
    assert default_expiry(date(2028, 2, 29)) == "28/02/2029"
