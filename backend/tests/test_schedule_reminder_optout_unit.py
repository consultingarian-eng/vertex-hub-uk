"""The Profile-tab "Schedule Reminders" toggle must actually silence the
server-side web-push sender.

The toggle was device-local for months (AsyncStorage only), so the contract
that matters is the opt-out convention shared with the rest of the backend:
OFF is always an explicit stored False; a missing/None/garbage value means
enabled, so nobody who never touched the toggle loses reminders.
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.schedule_reminders import _reminders_opted_out  # noqa: E402


def test_explicit_false_opts_out():
    assert _reminders_opted_out({"schedule_reminders_enabled": False}) is True


def test_missing_means_enabled():
    assert _reminders_opted_out({}) is False


def test_true_and_odd_values_mean_enabled():
    # None (field cleared), truthy, and garbage all keep reminders on —
    # only a stored False silences them.
    for v in (True, None, 0, "", "false"):
        assert _reminders_opted_out({"schedule_reminders_enabled": v}) is False, repr(v)
