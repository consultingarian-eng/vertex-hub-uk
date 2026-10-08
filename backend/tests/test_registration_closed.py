"""Nobody signs themselves up. Accounts come from an office admin.

People were signing themselves up minutes after being provisioned from the
recruiting roster, with a different email address, which left two accounts, two
new_hires rows and two sets of blank assessments for one person — and no way to
tell the real account from the duplicate. Whoever holds the roster decides who
gets in, and there is no second way in.

These tests guard the intent rather than the wording, so the door can't be
propped open again by accident.
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import auth_routes as ar  # noqa: E402


def test_self_registration_is_off():
    assert ar.SELF_REGISTRATION_ENABLED is False, (
        "Self-registration was re-enabled. If that is deliberate, the duplicate-account "
        "problem it caused needs solving first — see the module docstring."
    )


def test_the_route_still_exists_so_old_builds_get_an_explanation():
    """Deleting the endpoint would 404 every app build still showing Sign Up.

    A stale client should be told where to go, not left with an unexplained
    failure it can't interpret.
    """
    paths = {getattr(r, "path", "") for r in ar.router.routes}
    assert "/auth/register" in paths


def test_the_refusal_says_what_to_do_instead():
    msg = ar._REGISTRATION_CLOSED.lower()
    assert "office admin" in msg, "the refusal must point at who can create the account"
    assert "attended" in msg, "…and at the action that actually provisions it"


def test_registration_refuses_before_touching_the_database(monkeypatch):
    """The guard must come first.

    If it ran after the existing-email lookup, a closed endpoint would still
    confirm which addresses are registered.
    """
    import inspect
    src = inspect.getsource(ar.register)
    guard = src.index("SELF_REGISTRATION_ENABLED")
    first_db = src.index("db.users")
    assert guard < first_db, "the closed-registration check must precede any db access"
