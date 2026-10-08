"""Coach+ and what each level may see.

  • Coach+ is a flag on a Coach: whole-office field numbers and ID badges.
  • A Coach's Performance Hub is their own team (and teams led by people
    under them), never the office.
  • The person page: Admin and Coach+ see anyone in the office; a Coach sees
    their own people in full and any other new start's development only.

In-memory (mongomock), no network.
"""
import asyncio
import sys
from pathlib import Path

import pytest
from bson import ObjectId
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import auth  # noqa: E402
import owneriq_hub  # noqa: E402
from routes import owneriq as owneriq_routes  # noqa: E402
from routes import people  # noqa: E402

OFFICE = "office-romford"


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _viewer(doc):
    return {**doc, "id": str(doc["_id"])}


@pytest.fixture()
def db(monkeypatch):
    database = AsyncMongoMockClient()["coach_plus_test"]
    for module in (auth, people, owneriq_routes):
        monkeypatch.setattr(module, "db", database)
    return database


def _user(db, name, role, reports_to=None, **extra):
    doc = {"_id": ObjectId(), "name": name, "role": role, "office_id": extra.pop("office_id", OFFICE),
           "reports_to": str(reports_to["_id"]) if reports_to else None, **extra}
    _run(db.users.insert_one(doc))
    return doc


def test_coach_plus_is_a_flag_on_a_coach_only():
    assert auth.is_coach_plus({"role": "leader", "coach_plus": True})
    assert not auth.is_coach_plus({"role": "leader"})
    assert not auth.is_coach_plus({"role": "trainee", "coach_plus": True})   # a BA can't carry it
    assert not auth.is_coach_plus(None)
    assert auth.sees_whole_office({"role": "admin"}) and auth.sees_whole_office({"role": "leader", "coach_plus": True})
    assert not auth.sees_whole_office({"role": "leader"}) and not auth.sees_whole_office({"role": "trainee"})


def test_badges_are_for_admins_and_coach_plus():
    assert auth.can_use_badges({"role": "admin"})
    assert auth.can_use_badges({"role": "leader", "coach_plus": True})
    assert not auth.can_use_badges({"role": "leader"})
    assert not auth.can_use_badges({"role": "trainee"})


def _office_view():
    def row(oid, name, team, leader=False):
        return {"user": {"id": oid, "full_name": name}, "team": team, "team_leader": leader}
    apex, shadow, tgc = ({"id": 65, "name": "APEX "}, {"id": 195, "name": "SHADOW"}, {"id": 60, "name": "TGC"})
    return {"users": [
        row(1, "Emma Coach", apex, True), row(2, "Ayo Lead", shadow, True), row(3, "Sam Member", shadow),
        row(4, "Tia Lead", tgc, True), row(5, "No Team", None),
    ]}


def test_a_coachs_hub_is_their_team_then_teams_led_under_them():
    app_users = {"1": {"id": "emma"}, "2": {"id": "ayo"}, "3": {"id": "sam"}, "4": {"id": "tia"}}
    # Emma leads APEX and has Ayo (who leads SHADOW) under her; TGC is nobody of hers.
    assert owneriq_hub.coach_teams(_office_view(), app_users, "emma", {"emma", "ayo", "sam"}) == [
        {"id": 65, "name": "APEX"}, {"id": 195, "name": "SHADOW"}]
    # Sam is a member of SHADOW with nobody under him: just his own team.
    assert owneriq_hub.coach_teams(_office_view(), app_users, "sam", {"sam"}) == [{"id": 195, "name": "SHADOW"}]
    # Somebody with no team, or not in OwnerIQ at all, has nothing to open.
    assert owneriq_hub.coach_teams(_office_view(), {**app_users, "5": {"id": "nt"}}, "nt", {"nt"}) == []
    assert owneriq_hub.coach_teams(_office_view(), app_users, "stranger", {"stranger"}) == []


def test_a_coach_not_linked_by_id_is_not_matched_by_name():
    # Names are display only: anyone can rename themselves to "Sam Member",
    # so a name match must not open Sam's team. Only the id link counts.
    assert owneriq_hub.coach_teams(_office_view(), {}, "sam", {"sam"}, "  sam   MEMBER ") == []


def test_person_page_scope(db):
    owner = _user(db, "Owner", "admin")
    coach = _user(db, "Coach", "leader", owner)
    plus = _user(db, "Plus", "leader", owner, coach_plus=True)
    mine = _user(db, "My BA", "trainee", coach)
    other_coach = _user(db, "Other Coach", "leader", owner)
    new_start = _user(db, "New Start", "trainee", other_coach)
    old_hand = _user(db, "Old Hand", "trainee", other_coach)
    elsewhere = _user(db, "Elsewhere", "trainee", office_id="office-other")
    _run(db.new_hires.insert_one({"id": "h1", "trainee_user_id": str(new_start["_id"]), "active": True, "office_id": OFFICE}))
    _run(db.new_hires.insert_one({"id": "h2", "trainee_user_id": str(old_hand["_id"]), "active": False, "office_id": OFFICE}))

    def load(viewer, target):
        return _run(people._load_person(_viewer(viewer), str(target["_id"])))

    # Admin and Coach+ : anyone in the office, in full.
    assert load(owner, old_hand)[1] is False
    assert load(plus, old_hand)[1] is False and load(plus, other_coach)[1] is False
    # Coach: their own people in full…
    assert load(coach, mine)[1] is False
    # …any other NEW START in the office, development only…
    assert load(coach, new_start)[1] is True
    # …and nobody else.
    for target in (old_hand, other_coach, plus):
        with pytest.raises(HTTPException) as err:
            load(coach, target)
        assert err.value.status_code == 403
    # Nobody crosses offices, Coach+ included.
    for viewer in (coach, plus, owner):
        with pytest.raises(HTTPException) as err:
            load(viewer, elsewhere)
        assert err.value.status_code == 403


def test_field_kpi_rows_are_office_wide_for_coach_plus_and_team_only_for_a_coach(db):
    _run(db.offices.insert_one({"id": OFFICE, "name": "Romford", "owneriq_pin": "4003"}))
    owner = _user(db, "Owner", "admin")
    coach = _user(db, "Coach", "leader", owner)
    plus = _user(db, "Plus", "leader", owner, coach_plus=True)
    mine = _user(db, "My BA", "trainee", coach)
    rows = [
        {"date": "2026-10-05", "mc_pin": "4003", "cg1_user_id": str(mine["_id"]), "sales": 2},
        {"date": "2026-10-05", "mc_pin": "4003", "cg1_user_id": str(plus["_id"]), "sales": 1},
        {"date": "2026-10-05", "mc_pin": "4003", "cg1_user_id": None, "sales": 3},        # not linked to an account yet
        {"date": "2026-10-05", "mc_pin": "1111", "cg1_user_id": "someone-else", "sales": 9},  # another office
    ]
    _run(db.owneriq_kpis.insert_many(rows))

    def sales(viewer):
        got = _run(owneriq_routes._scoped_rows(_viewer(viewer), "2026-10-05", "2026-10-05"))
        return sorted(r["sales"] for r in got)

    assert sales(plus) == [1, 2, 3]      # the office, exactly as an Admin gets it
    assert sales(owner) == [1, 2, 3]
    assert sales(coach) == [2]           # self + the people under them


def test_live_operations_teams_are_the_office_for_coach_plus_and_their_own_for_a_coach(db):
    _run(db.offices.insert_one({"id": OFFICE, "name": "Romford", "owneriq_pin": "4003"}))
    owner = _user(db, "Owner", "admin")
    coach = _user(db, "Coach One", "leader", owner)
    plus = _user(db, "Plus", "leader", owner, coach_plus=True)

    def sector(sid, leader_name, pin="4003", members=()):
        return {"id": sid, "leader": {"id": sid * 10, "full_name": leader_name, "marketing_company": {"pin": pin}},
                "members": [{"id": sid * 100 + i, "full_name": n} for i, n in enumerate(members)]}

    sectors = [sector(1, "Coach One"), sector(2, "Somebody Else", members=["A Person"]), sector(3, "Other Office", pin="1111")]
    # Coach One is linked to OwnerIQ user 10 (sector 1's leader) by id.
    oid2cg1 = {"10": str(coach["_id"])}

    def seen(viewer, caller_oids=frozenset()):
        got = _run(owneriq_routes._visible_sectors(_viewer(viewer), sectors, oid2cg1, {}, set(caller_oids)))
        return sorted(s["id"] for s in got)

    assert seen(plus) == [1, 2]      # every team in their office, none from another
    assert seen(owner) == [1, 2]
    assert seen(coach, {"10"}) == [1]  # the team they lead, by linked id


def test_live_operations_never_authorise_by_display_name(db, monkeypatch):
    import owneriq_sync
    monkeypatch.setattr(owneriq_sync, "db", db)
    _run(db.offices.insert_one({"id": OFFICE, "name": "Romford", "owneriq_pin": "4003"}))
    owner = _user(db, "Owner", "admin")
    impostor = _user(db, "Somebody Else", "leader", owner)      # same name as sector 2's leader
    trainee = _user(db, "A Person", "trainee", impostor)         # same name as a sector 2 member
    sectors = [{"id": 2, "leader": {"id": 20, "full_name": "Somebody Else", "marketing_company": {"pin": "4003"}},
                "members": [{"id": 200, "full_name": "A Person"}]}]
    # by_name would link both names to the impostors; neither may see the team.
    by_name = {"somebody else": str(impostor["_id"]), "a person": str(trainee["_id"])}
    for viewer in (impostor, trainee):
        got = _run(owneriq_routes._visible_sectors(_viewer(viewer), sectors, {}, by_name, set()))
        assert got == []
    with pytest.raises(HTTPException) as err:
        _run(owneriq_routes._assert_sector_visible(_viewer(impostor), sectors[0]))
    assert err.value.status_code == 403
