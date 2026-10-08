"""Office scoping for the Weekly Plan (agenda) endpoints.

Background: the Schedule tab's Boston/New Haven toggle moved the schedule
blocks but not the Weekly Plan, which stayed pinned to the viewer's home
office. Fixing the reads alone would have been worse than the bug — the plan
would render New Haven while every save landed on Boston — so reads and writes
are scoped by the two helpers exercised here.

These are pure functions, so this file talks to no database and no server. It
is safe to run anywhere, unlike the `backend_test_*.py` scripts at the repo
root, which drive a live deployment over HTTP.
"""
import os
import sys
from pathlib import Path

import pytest

# Point Mongo at a dead address BEFORE importing the module under test. The
# module builds a client at import time and `load_dotenv()` would otherwise
# hand it the production URL from backend/.env. load_dotenv does not override
# variables that already exist, so setting it here wins. Motor connects lazily
# and nothing in this file issues a query, but a real URL should never be
# sitting in a test process to begin with.
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:1/unused")
os.environ.setdefault("DB_NAME", "test_unused")

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from fastapi import HTTPException  # noqa: E402

from routes.agenda import _scope_office, _scope_office_write  # noqa: E402

BOSTON = "office-boston"
NEW_HAVEN = "office-new-haven"

SUPER = {"office_id": BOSTON, "is_super_admin": True}
ADMIN = {"office_id": BOSTON, "is_super_admin": False}


# ─── reads ──────────────────────────────────────────────────────────────────

def test_super_admin_reads_the_office_they_asked_for():
    """The actual bug: the toggle is set to New Haven, so the plan must be
    New Haven's."""
    assert _scope_office(SUPER, NEW_HAVEN) == NEW_HAVEN


def test_no_office_param_falls_back_to_home():
    # Every non-super-admin client sends nothing, and must keep working.
    assert _scope_office(SUPER, None) == BOSTON
    assert _scope_office(ADMIN, None) == BOSTON


def test_ordinary_admin_cannot_read_another_office():
    """Ignored, not honoured — a hand-edited request must not become a way to
    read another office's plan."""
    assert _scope_office(ADMIN, NEW_HAVEN) == BOSTON


@pytest.mark.parametrize("empty", ["", None])
def test_empty_office_param_is_not_treated_as_a_selection(empty):
    assert _scope_office(SUPER, empty) == BOSTON


def test_missing_home_office_degrades_to_empty_not_crash():
    # Callers check for "" and return an empty payload; they must not see None.
    assert _scope_office({"is_super_admin": False}, None) == ""


# ─── writes ─────────────────────────────────────────────────────────────────

def test_super_admin_writes_land_on_the_selected_office():
    assert _scope_office_write(SUPER, NEW_HAVEN) == NEW_HAVEN


def test_write_without_a_target_stays_on_home_office():
    assert _scope_office_write(ADMIN, None) == BOSTON
    assert _scope_office_write(SUPER, None) == BOSTON


def test_admin_targeting_their_own_office_explicitly_is_fine():
    assert _scope_office_write(ADMIN, BOSTON) == BOSTON


def test_ordinary_admin_writing_to_another_office_is_refused():
    """A write must fail loudly rather than silently redirect.

    This is the case that separates the write helper from the read helper: if
    this returned BOSTON instead of raising, a Boston admin who somehow had
    New Haven selected would overwrite Boston's plan believing they had
    edited New Haven's.
    """
    with pytest.raises(HTTPException) as exc:
        _scope_office_write(ADMIN, NEW_HAVEN)
    assert exc.value.status_code == 403


def test_refusal_is_not_vacuous():
    # Guards against the check being trivially true for every input: the same
    # helper, same caller, different target must succeed.
    assert _scope_office_write(ADMIN, BOSTON) == BOSTON
    with pytest.raises(HTTPException):
        _scope_office_write(ADMIN, NEW_HAVEN)


def test_whitespace_cannot_smuggle_a_foreign_office_past_the_check():
    with pytest.raises(HTTPException):
        _scope_office_write(ADMIN, f"  {NEW_HAVEN}  ")
    # ...and the same padding around the caller's OWN office still resolves.
    assert _scope_office_write(ADMIN, f"  {BOSTON}  ") == BOSTON
