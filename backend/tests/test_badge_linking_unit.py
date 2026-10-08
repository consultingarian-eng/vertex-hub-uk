"""A badge links to an account only when the person is chosen explicitly.

The badge number is what ties a person to their OwnerIQ rows (live team view,
door logs, Bells credit), so:
  • a badge made without choosing a person is never linked by its typed name
    (anyone can rename themselves to an unlinked rep's name);
  • the chosen person must be live and, unless the caller is the owner, in the
    caller's office;
  • one badge number never belongs to two live people (create and edit).
Also: only admins can force a fresh OwnerIQ pull on the live pages.

Pure in-memory: mongomock, no bucket, no OwnerIQ.
"""
import asyncio
import base64
import io
import sys
from pathlib import Path

import pytest
from bson import ObjectId
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import badges as badges_route  # noqa: E402
from routes import owneriq as owneriq_route  # noqa: E402

OFFICE_A, OFFICE_B = "office-a", "office-b"
COACH_PLUS = {"id": "u-coach", "role": "leader", "coach_plus": True, "office_id": OFFICE_A, "name": "Casey Coach"}


def _run(coro):
    return asyncio.run(coro)


def _photo() -> str:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGBA", (20, 20), (10, 120, 200, 255)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class FakeRequest:
    def __init__(self, body=None):
        self._body = body or {}

    async def json(self):
        return self._body


@pytest.fixture
def db(monkeypatch):
    d = AsyncMongoMockClient()["badge_link_test"]
    monkeypatch.setattr(badges_route, "db", d)
    monkeypatch.setattr(badges_route.media_store, "enabled", lambda: False)
    state = {"me": COACH_PLUS}

    async def _me(_request):
        return state["me"]
    monkeypatch.setattr(badges_route, "get_current_user", _me)
    d.state = state
    return d


def _add_user(d, name, office, **extra):
    oid = ObjectId()
    _run(d.users.insert_one({"_id": oid, "name": name, "office_id": office, "role": "trainee", **extra}))
    return str(oid)


def _create(**body):
    payload = {"full_name": "Rhys Placeholder", "badge_number": "VX-1001", "photo_base64": _photo(), **body}
    return _run(badges_route.create_badge(FakeRequest(payload)))


def test_a_typed_name_never_links_a_badge(db):
    # Someone renamed themselves to the name of a rep who has no account yet.
    squatter = _add_user(db, "Rhys Placeholder", OFFICE_A)
    badge = _create()
    assert badge["user_id"] is None
    u = _run(db.users.find_one({"_id": ObjectId(squatter)}))
    assert not u.get("amplifi_codes")
    assert not u.get("is_badged_ba")


def test_a_chosen_person_in_the_same_office_is_linked(db):
    rep = _add_user(db, "Rhys Placeholder", OFFICE_A)
    badge = _create(user_id=rep)
    assert badge["user_id"] == rep
    u = _run(db.users.find_one({"_id": ObjectId(rep)}))
    assert u["amplifi_codes"] == ["VX-1001"]
    assert u["is_badged_ba"] is True


def test_a_person_in_another_office_is_refused(db):
    other = _add_user(db, "Rhys Placeholder", OFFICE_B)
    with pytest.raises(HTTPException) as err:
        _create(user_id=other)
    assert err.value.status_code == 403
    assert _run(db.badges.count_documents({})) == 0


def test_the_owner_may_badge_anyone(db):
    other = _add_user(db, "Rhys Placeholder", OFFICE_B)
    db.state["me"] = {**COACH_PLUS, "is_super_admin": True, "role": "admin"}
    assert _create(user_id=other)["user_id"] == other


def test_a_deleted_or_unknown_person_is_refused(db):
    gone = _add_user(db, "Rhys Placeholder", OFFICE_A, deleted=True)
    for uid in (gone, str(ObjectId())):
        with pytest.raises(HTTPException) as err:
            _create(user_id=uid)
        assert err.value.status_code == 404


def test_a_badge_number_held_by_someone_else_is_refused(db):
    _add_user(db, "Owen Original", OFFICE_A, amplifi_codes=["vx-1001"])
    me_too = _add_user(db, "Casey Copy", OFFICE_A)
    with pytest.raises(HTTPException) as err:
        _create(user_id=me_too, full_name="Casey Copy")
    assert err.value.status_code == 409
    # A deleted holder doesn't block it.
    _run(db.users.update_many({"name": "Owen Original"}, {"$set": {"deleted": True}}))
    assert _create(user_id=me_too, full_name="Casey Copy")["user_id"] == me_too


def test_editing_to_someone_elses_number_is_refused(db):
    _add_user(db, "Owen Original", OFFICE_A, amplifi_codes=["VX-2002"])
    wearer = _add_user(db, "Rhys Placeholder", OFFICE_A)
    badge = _create(user_id=wearer)
    with pytest.raises(HTTPException) as err:
        _run(badges_route.update_badge(badge["id"], FakeRequest({"badge_number": "VX-2002"})))
    assert err.value.status_code == 409
    u = _run(db.users.find_one({"_id": ObjectId(wearer)}))
    assert u["amplifi_codes"] == ["VX-1001"]


# ── live pages: only admins skip OwnerIQ's cache ─────────────────────────

@pytest.mark.parametrize("who,expected", [
    ({"id": "t1", "role": "trainee", "office_id": OFFICE_A}, False),
    ({"id": "a1", "role": "admin", "office_id": OFFICE_A}, True),
])
def test_only_admins_force_a_fresh_live_pull(monkeypatch, who, expected):
    seen = {}

    async def _me(_request):
        return who

    async def _get_sector(sector_id, iso, force=False):
        seen["force"] = force
        return {"id": sector_id, "members": []}

    async def _visible(caller, detail):
        return None

    async def _ctx(caller):
        return {}, {}, set()

    monkeypatch.setattr(owneriq_route, "get_current_user", _me)
    monkeypatch.setattr(owneriq_route, "get_sector", _get_sector)
    monkeypatch.setattr(owneriq_route, "_assert_sector_visible", _visible)
    monkeypatch.setattr(owneriq_route, "_live_link_ctx", _ctx)
    owneriq_route._LIVE_LOOKUPS.reset()
    _run(owneriq_route.owneriq_live_sector(FakeRequest(), "123", None, True))
    assert seen["force"] is expected


def test_live_lookups_are_capped_per_person_but_not_for_admins():
    owneriq_route._LIVE_LOOKUPS.reset()
    trainee = {"id": "t-cap", "role": "trainee"}
    for _ in range(owneriq_route._LIVE_LOOKUPS.limit):
        owneriq_route._count_live_lookup(trainee)
    with pytest.raises(HTTPException) as err:
        owneriq_route._count_live_lookup(trainee)
    assert err.value.status_code == 429
    admin = {"id": "a-cap", "role": "admin"}
    for _ in range(owneriq_route._LIVE_LOOKUPS.limit + 5):
        owneriq_route._count_live_lookup(admin)
    owneriq_route._LIVE_LOOKUPS.reset()


# ── the admin badge-numbers screen keeps the same rule ───────────────────

def test_admin_cannot_give_a_number_someone_else_holds(db, monkeypatch):
    from routes import admin_routes
    monkeypatch.setattr(admin_routes, "db", db)

    async def _admin(_request):
        return {"id": "u-admin", "role": "admin", "office_id": OFFICE_A}

    async def _guard(admin, user_id):
        return None
    monkeypatch.setattr(admin_routes, "require_admin", _admin)
    monkeypatch.setattr(admin_routes, "_guard_target_user", _guard)
    _add_user(db, "Owen Original", OFFICE_B, amplifi_codes=["VX-3003"])
    mine = _add_user(db, "Rhys Placeholder", OFFICE_A, amplifi_codes=["VX-0001"])
    with pytest.raises(HTTPException) as err:
        _run(admin_routes.update_user_amplifi_codes(mine, FakeRequest({"amplifi_codes": ["VX-0001", "vx-3003"]})))
    assert err.value.status_code == 409
    # Their own existing number and a free one are fine.
    out = _run(admin_routes.update_user_amplifi_codes(mine, FakeRequest({"amplifi_codes": ["VX-0001", "VX-4004"]})))
    assert out["amplifi_codes"] == ["VX-0001", "VX-4004"]
