"""The one timezone the whole app runs on.

Every "today", week boundary, quiet-hours window and scheduled job is read in
this zone, never the server's clock (Railway runs in UTC) and never a hardcoded
zone. Set APP_TIMEZONE to an IANA name to move the app; the default is UK time,
which handles GMT/BST switches automatically.

The frontend mirrors this in frontend/src/utils/appTime.ts — change both
together.
"""
import os
from zoneinfo import ZoneInfo

APP_TZ_NAME = (os.environ.get("APP_TIMEZONE") or "Europe/London").strip() or "Europe/London"
APP_TZ = ZoneInfo(APP_TZ_NAME)


def uk_date(value, year: bool = True) -> str:
    """A date as people in the UK write it: '30 Sep 2026' (or '30 Sep' with
    year=False). Accepts a date/datetime or an ISO 'YYYY-MM-DD…' string;
    anything unparseable comes back unchanged, so callers can pass raw data."""
    from datetime import date as _date, datetime as _datetime
    d = value
    if isinstance(value, str):
        try:
            d = _date.fromisoformat(value.strip()[:10])
        except ValueError:
            return value
    if isinstance(d, _datetime):
        d = d.date()
    if not isinstance(d, _date):
        return str(value) if value is not None else ""
    return f"{d.day} {d.strftime('%b')}" + (f" {d.year}" if year else "")
