"""core/admin_scope — the admin who IS the office vs. the admin who has a crew.

Sep 2026: a team leader was promoted to admin so he could see and edit
assessments and bells office-wide while still running his own team. Every
surface reading `role == "admin"` as "the office" then mis-fired — his crew
goal published itself as the office goal, the office goal wiped his crew
goal, and the Team Bulletin (which excludes admins on purpose) dropped his
team. These pin the rule that tells the two apart.

Pure in-memory: mongomock, no network.
"""

import asyncio
import sys
from pathlib import Path

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.admin_scope import (  # noqa: E402
    is_office_level_admin,
    leads_own_crew,
    leads_own_crew_by_id,
    office_level_admin_ids,
)

OFFICE = "office-boston"
OTHER_OFFICE = "office-new-haven"


def _run(coro):
    return asyncio.run(coro)


def _db():
    return AsyncMongoMockClient()["cg1_admin_scope_test"]


def _user(db, *, role, office_id=OFFICE, reports_to=None, **extra):
    oid = ObjectId()
    doc = {"_id": oid, "name": extra.pop("name", role.title()), "role": role,
           "office_id": office_id, "reports_to": reports_to, **extra}
    _run(db.users.insert_one(doc))
    return doc


# ── the owner shape ──────────────────────────────────────────────────────

def test_admin_at_the_top_of_the_tree_is_the_office():
    db = _db()
    owner = _user(db, role="admin", is_super_admin=True, name="Olivia")
    assert _run(is_office_level_admin(owner, db)) is True
    assert _run(leads_own_crew(owner, db)) is False


def test_admin_with_no_upline_at_all_is_the_office():
    db = _db()
    # Priya's shape: office owner, not a super admin, reports_to absent.
    owner = _user(db, role="admin", office_id=OTHER_OFFICE, name="Priya")
    assert _run(is_office_level_admin(owner, db)) is True


def test_super_admin_under_another_admin_is_still_the_office():
    db = _db()
    top = _user(db, role="admin", is_super_admin=True, name="Olivia")
    # A second owner-level account parked under the first must not be demoted
    # to a crew by the org chart.
    brian = _user(db, role="admin", is_super_admin=True,
                  reports_to=str(top["_id"]), name="Brian")
    assert _run(is_office_level_admin(brian, db)) is True
    assert _run(leads_own_crew(brian, db)) is False


# ── the crew-leading shape ───────────────────────────────────────────────

def test_admin_reporting_to_an_admin_leads_their_own_crew():
    db = _db()
    owner = _user(db, role="admin", is_super_admin=True, name="Olivia")
    marcus = _user(db, role="admin", reports_to=str(owner["_id"]),
                    team_name="North Stars", name="Marcus")
    assert _run(leads_own_crew(marcus, db)) is True
    assert _run(is_office_level_admin(marcus, db)) is False


def test_admin_under_a_leader_under_an_admin_still_leads_their_own_crew():
    db = _db()
    owner = _user(db, role="admin", is_super_admin=True, name="Olivia")
    mid = _user(db, role="leader", reports_to=str(owner["_id"]), name="Mid")
    promoted = _user(db, role="admin", reports_to=str(mid["_id"]), name="Promoted")
    # The chain is walked, not just the direct parent — re-parenting a
    # crew-leading admin under a leader must not turn them into the office.
    assert _run(leads_own_crew(promoted, db)) is True


def test_admin_parked_under_another_offices_owner_is_still_their_own_office():
    db = _db()
    foreign = _user(db, role="admin", office_id=OTHER_OFFICE, name="Priya")
    stray = _user(db, role="admin", office_id=OFFICE,
                  reports_to=str(foreign["_id"]), name="Boston Owner")
    # A stale cross-office reports_to is not a chain of command.
    assert _run(is_office_level_admin(stray, db)) is True


def test_admin_under_a_deleted_admin_is_the_office_again():
    db = _db()
    gone = _user(db, role="admin", deleted=True, name="Departed Owner")
    heir = _user(db, role="admin", reports_to=str(gone["_id"]), name="Heir")
    assert _run(is_office_level_admin(heir, db)) is True


# ── non-admins and bad input ─────────────────────────────────────────────

def test_leaders_and_trainees_are_neither():
    db = _db()
    owner = _user(db, role="admin", name="Olivia")
    leader = _user(db, role="leader", reports_to=str(owner["_id"]), name="Leo")
    trainee = _user(db, role="trainee", reports_to=str(leader["_id"]), name="Tara")
    for doc in (leader, trainee):
        assert _run(is_office_level_admin(doc, db)) is False
        assert _run(leads_own_crew(doc, db)) is False


def test_reports_to_cycle_terminates():
    db = _db()
    a = _user(db, role="admin", name="A")
    b = _user(db, role="leader", reports_to=str(a["_id"]), name="B")
    _run(db.users.update_one({"_id": a["_id"]}, {"$set": {"reports_to": str(b["_id"])}}))
    a["reports_to"] = str(b["_id"])
    # Walking A → B → A must stop, not spin. A reports up to no admin but
    # itself, so it stays the office.
    assert _run(is_office_level_admin(a, db)) is True


def test_by_id_lookup_matches_and_unknown_id_is_false():
    db = _db()
    owner = _user(db, role="admin", name="Olivia")
    marcus = _user(db, role="admin", reports_to=str(owner["_id"]), name="Marcus")
    assert _run(leads_own_crew_by_id(str(marcus["_id"]), db)) is True
    assert _run(leads_own_crew_by_id(str(owner["_id"]), db)) is False
    assert _run(leads_own_crew_by_id(str(ObjectId()), db)) is False
    assert _run(leads_own_crew_by_id("not-an-object-id", db)) is False


# ── the office roster ────────────────────────────────────────────────────

def test_office_level_admin_ids_leaves_the_crew_admin_out():
    db = _db()
    owner = _user(db, role="admin", is_super_admin=True, name="Olivia")
    brian = _user(db, role="admin", is_super_admin=True, name="Brian")
    marcus = _user(db, role="admin", reports_to=str(owner["_id"]), name="Marcus")
    _user(db, role="leader", reports_to=str(marcus["_id"]), name="Leo")
    ids = {str(a["_id"]) for a in _run(office_level_admin_ids(OFFICE, database=db))}
    assert ids == {str(owner["_id"]), str(brian["_id"])}


def test_office_level_admin_ids_skips_inactive_deleted_and_demo():
    db = _db()
    owner = _user(db, role="admin", name="Olivia")
    _user(db, role="admin", deleted=True, name="Gone")
    _user(db, role="admin", is_active=False, name="Paused")
    _user(db, role="admin", is_demo=True, name="Demo")
    ids = {str(a["_id"]) for a in _run(office_level_admin_ids(OFFICE, database=db))}
    assert ids == {str(owner["_id"])}


def test_office_level_admin_ids_falls_back_rather_than_returning_nothing():
    db = _db()
    # Two admins reporting to each other: neither is "top of the tree". The
    # office must not silently lose its goal mirror over a broken chart.
    a = _user(db, role="admin", name="A")
    b = _user(db, role="admin", reports_to=str(a["_id"]), name="B")
    _run(db.users.update_one({"_id": a["_id"]}, {"$set": {"reports_to": str(b["_id"])}}))
    ids = {str(x["_id"]) for x in _run(office_level_admin_ids(OFFICE, database=db))}
    assert ids == {str(a["_id"]), str(b["_id"])}


def test_office_level_admin_ids_carries_requested_fields():
    db = _db()
    owner = _user(db, role="admin", name="Olivia")
    rows = _run(office_level_admin_ids(OFFICE, {"name": 1}, database=db))
    assert [r.get("name") for r in rows] == ["Olivia"]
    assert str(rows[0]["_id"]) == str(owner["_id"])


def test_no_admins_at_all_is_empty_not_a_fallback():
    db = _db()
    _user(db, role="leader", name="Solo")
    assert _run(office_level_admin_ids(OFFICE, database=db)) == []


def test_a_thinly_projected_doc_is_re_read_rather_than_guessed_at():
    """A caller that projected only the name must not get a wrong answer."""
    db = _db()
    owner = _user(db, role="admin", is_super_admin=True, name="Olivia")
    marcus = _user(db, role="admin", reports_to=str(owner["_id"]), name="Marcus")
    thin_owner = {"_id": owner["_id"], "name": "Olivia"}
    thin_crew = {"_id": marcus["_id"], "name": "Marcus"}
    assert _run(is_office_level_admin(thin_owner, db)) is True
    assert _run(leads_own_crew(thin_crew, db)) is True


def test_a_doc_with_no_id_at_all_is_answered_from_what_it_carries():
    db = _db()
    assert _run(is_office_level_admin({"name": "ghost"}, db)) is False
    assert _run(leads_own_crew({"name": "ghost"}, db)) is False
