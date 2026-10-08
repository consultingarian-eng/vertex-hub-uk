"""Proof-ladder date boxes (routes/modules._apply_ladder_dates).

The sheet's date boxes, digitized:
  • ticking rungs stamps today's date on every newly-achieved rung;
  • existing dates are never clobbered by re-saves;
  • stepping the ladder down clears the dates above it;
  • explicit edits override dates — but only for rungs the caller may
    write (self ≤ Do), and only with valid YYYY-MM-DD values.
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes.modules import _apply_ladder_dates  # noqa: E402

TODAY = "2026-08-26"


def test_ticking_stamps_today_on_new_rungs():
    out = _apply_ladder_dates({}, 3, None, 5, TODAY)
    assert out == {"know": TODAY, "do": TODAY, "deliver": TODAY}


def test_existing_dates_survive_resave():
    existing = {"know": "2026-08-01", "do": "2026-08-10"}
    out = _apply_ladder_dates(existing, 3, None, 5, TODAY)
    assert out["know"] == "2026-08-01" and out["do"] == "2026-08-10"
    assert out["deliver"] == TODAY


def test_stepping_down_clears_upper_dates():
    existing = {"know": "2026-08-01", "do": "2026-08-10", "deliver": "2026-08-20"}
    out = _apply_ladder_dates(existing, 1, None, 5, TODAY)
    assert out == {"know": "2026-08-01"}


def test_edit_overrides_within_permission():
    existing = {"know": TODAY, "do": TODAY, "deliver": TODAY}
    out = _apply_ladder_dates(existing, 3, {"deliver": "2026-08-19"}, 5, TODAY)
    assert out["deliver"] == "2026-08-19"


def test_self_cannot_edit_coach_rung_dates():
    existing = {"know": TODAY, "do": TODAY, "deliver": TODAY}
    out = _apply_ladder_dates(existing, 3, {"deliver": "2020-01-01", "do": "2026-08-15"}, 2, TODAY)
    assert out["deliver"] == TODAY          # coach rung — edit dropped
    assert out["do"] == "2026-08-15"        # self rung — edit applied


def test_invalid_dates_are_ignored():
    out = _apply_ladder_dates({}, 2, {"know": "yesterday", "do": "2026-13-99"}, 5, TODAY)
    assert out == {"know": TODAY, "do": TODAY}
