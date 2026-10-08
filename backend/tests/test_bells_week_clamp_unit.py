"""Bells week_ending write-clamp: every write path must land on a real
Sunday and can't be pushed past the current bells week — two rows already
escaped into prod with far-future week_endings and polluted the weeks list.
"""
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.app_time import APP_TZ  # noqa: E402
from routes.bells import _validate_week_ending_write, MAX_FUTURE_WEEK_DAYS  # noqa: E402


def _today_uk():
    return datetime.now(APP_TZ).date()


def _prev_sunday():
    today = _today_uk()
    return today - timedelta(days=(today.weekday() + 1) % 7)


def _next_sunday():
    today = _today_uk()
    return today + timedelta(days=(6 - today.weekday()))


def test_a_real_sunday_passes_unchanged():
    s = _prev_sunday().isoformat()
    assert _validate_week_ending_write(s) == s


def test_non_sunday_is_normalized_backward_to_its_sunday():
    # The documented timezone quirk: a client whose UTC date rolled to Monday
    # while it's still Sunday evening UK time must land in the week that just ended.
    monday = (_prev_sunday() + timedelta(days=1)).isoformat()
    assert _validate_week_ending_write(monday) == _prev_sunday().isoformat()


def test_current_bells_week_sunday_is_allowed():
    # Mid-week, the current week's Sunday is up to 6 days in the future —
    # that's the normal case for every sheet save and must always pass.
    s = _next_sunday().isoformat()
    assert _validate_week_ending_write(s) == s


def test_far_future_week_is_rejected_with_400():
    far = (_next_sunday() + timedelta(days=14)).isoformat()
    with pytest.raises(HTTPException) as exc:
        _validate_week_ending_write(far)
    assert exc.value.status_code == 400
    assert str(MAX_FUTURE_WEEK_DAYS) in exc.value.detail


def test_far_future_non_sunday_is_rejected_not_normalized_into_validity():
    # 2030-01-08 is a Tuesday; snapping back gives 2030-01-06 — still years
    # out, so the clamp must fire after normalization too.
    with pytest.raises(HTTPException) as exc:
        _validate_week_ending_write("2030-01-08")
    assert exc.value.status_code == 400


def test_garbage_and_empty_input_are_rejected_with_400():
    for bad in ("not-a-date", "2026-13-40", ""):
        with pytest.raises(HTTPException) as exc:
            _validate_week_ending_write(bad)
        assert exc.value.status_code == 400
