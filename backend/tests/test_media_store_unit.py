"""Badge photos and avatars live in R2, not Mongo (core/media_store).

  • badge photos: Mongo keeps `photo_key`; GET/PATCH still answer with
    `photo_base64` so the editor, preview and print export are unchanged;
    re-saving the same photo does not re-upload; a replaced or deleted
    photo's object is removed; a legacy inline photo moves out on first edit;
  • avatars: `profile_image` becomes a /api/media URL, the old object goes
    when a new one replaces it;
  • the public media route serves only well-formed avatar keys;
  • with no bucket configured everything stays inline, as before.

Pure in-memory: mongomock + a dict standing in for the bucket.
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

from core import media_store, object_storage  # noqa: E402
from routes import badges as badges_route  # noqa: E402
from routes import media as media_route  # noqa: E402
from routes import auth_routes  # noqa: E402

OFFICE = "office-boston"
# Badges are for Admins and Coach+ (a plain Coach is refused), so the badge maker here is a Coach+.
LEADER = {"id": "u-leader", "role": "leader", "coach_plus": True, "office_id": OFFICE, "name": "Lee Leader"}


def _run(coro):
    return asyncio.run(coro)


def _png(color=(200, 30, 30, 255), size=(40, 40)) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGBA", size, color).save(buf, format="PNG")
    return buf.getvalue()


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.puts = 0

    async def put_bytes(self, key, data, content_type):
        self.puts += 1
        self.objects[key] = data
        return True

    async def get_bytes(self, key):
        return self.objects.get(key)

    async def delete(self, key):
        self.objects.pop(key, None)
        return True


class FakeRequest:
    def __init__(self, body=None):
        self._body = body or {}

    async def json(self):
        return self._body


@pytest.fixture
def bucket(monkeypatch):
    b = FakeBucket()
    monkeypatch.setattr(object_storage, "is_configured", lambda: True)
    monkeypatch.setattr(object_storage, "put_bytes", b.put_bytes)
    monkeypatch.setattr(object_storage, "get_bytes", b.get_bytes)
    monkeypatch.setattr(object_storage, "delete", b.delete)
    monkeypatch.setenv("APP_BASE_URL", "https://cg1.example.test")
    return b


@pytest.fixture
def db(monkeypatch):
    d = AsyncMongoMockClient()["cg1_media_test"]
    monkeypatch.setattr(badges_route, "db", d)
    monkeypatch.setattr(auth_routes, "db", d)

    async def _me(_request):
        return LEADER
    monkeypatch.setattr(badges_route, "get_current_user", _me)
    return d


def _create(photo_b64, **extra):
    body = {"full_name": "Jane Doe", "badge_number": "AMPJANE1", "photo_base64": photo_b64, **extra}
    return _run(badges_route.create_badge(FakeRequest(body)))


# ── helpers ──────────────────────────────────────────────────────────────

def test_decode_accepts_data_uri_and_bare_base64():
    raw = _png()
    assert media_store.decode_image(_b64(raw)) == raw
    assert media_store.decode_image("data:image/png;base64," + _b64(raw)) == raw
    with pytest.raises(ValueError):
        media_store.decode_image("")


def test_avatar_url_round_trips_to_its_key_and_rejects_others(monkeypatch):
    monkeypatch.setenv("APP_BASE_URL", "https://cg1.example.test")
    key = "avatars/u1/" + "a" * 32 + ".jpg"
    assert media_store.key_from_avatar_url(media_store.avatar_url(key)) == key
    assert media_store.key_from_avatar_url("data:image/jpeg;base64,xxx") is None
    assert media_store.key_from_avatar_url("https://cg1.example.test/api/media/badges/x/y.png") is None
    assert media_store.key_from_avatar_url(None) is None


def test_normalize_avatar_shrinks_to_jpeg_on_white():
    from PIL import Image
    out = media_store.normalize_avatar(_png(color=(0, 0, 0, 0), size=(1600, 1200)))
    img = Image.open(io.BytesIO(out))
    assert img.format == "JPEG"
    assert max(img.size) == media_store.AVATAR_MAX_SIDE
    assert img.getpixel((10, 10))[0] > 240  # transparency became white, not black


# ── badges ───────────────────────────────────────────────────────────────

def test_create_keeps_only_the_key_in_mongo(bucket, db):
    raw = _png()
    resp = _create("data:image/png;base64," + _b64(raw))
    stored = _run(db.badges.find_one({"id": resp["id"]}))
    assert "photo_base64" not in stored
    assert stored["photo_key"].startswith("badges/" + resp["id"] + "/")
    assert bucket.objects[stored["photo_key"]] == raw
    assert resp["photo_base64"] == _b64(raw)  # response shape unchanged


def test_get_fills_photo_from_the_bucket(bucket, db):
    raw = _png()
    created = _create(_b64(raw))
    got = _run(badges_route.get_badge(created["id"], FakeRequest()))
    assert got["photo_base64"] == _b64(raw)


def test_get_fails_loudly_when_the_photo_is_missing(bucket, db):
    created = _create(_b64(_png()))
    bucket.objects.clear()
    with pytest.raises(HTTPException) as e:
        _run(badges_route.get_badge(created["id"], FakeRequest()))
    assert e.value.status_code == 503


def test_list_never_carries_photo_fields(bucket, db):
    _create(_b64(_png()))
    rows = _run(badges_route.list_badges(FakeRequest()))
    assert rows and all("photo_key" not in r and "photo_base64" not in r for r in rows)


def test_editing_the_name_does_not_reupload_the_same_photo(bucket, db):
    raw = _png()
    created = _create(_b64(raw))
    puts = bucket.puts
    # The editor always sends the saved photo back, even when only the name changed.
    out = _run(badges_route.update_badge(created["id"], FakeRequest({"full_name": "Jane Q Doe", "photo_base64": _b64(raw)})))
    assert bucket.puts == puts
    assert out["full_name"] == "Jane Q Doe" and out["photo_base64"] == _b64(raw)


def test_replacing_the_photo_deletes_the_old_object(bucket, db):
    created = _create(_b64(_png()))
    old_key = _run(db.badges.find_one({"id": created["id"]}))["photo_key"]
    new_raw = _png(color=(10, 200, 10, 255))
    _run(badges_route.update_badge(created["id"], FakeRequest({"photo_base64": _b64(new_raw)})))
    new_key = _run(db.badges.find_one({"id": created["id"]}))["photo_key"]
    assert new_key != old_key
    assert old_key not in bucket.objects and bucket.objects[new_key] == new_raw


def test_a_legacy_inline_photo_moves_out_on_first_edit(bucket, db):
    raw = _png()
    _run(db.badges.insert_one({"id": "b-legacy", "office_id": OFFICE, "full_name": "Old One",
                               "badge_number": "AMPOLD01", "photo_base64": _b64(raw), "qr_base64": ""}))
    got = _run(badges_route.get_badge("b-legacy", FakeRequest()))
    assert got["photo_base64"] == _b64(raw)  # legacy reads still work untouched
    _run(badges_route.update_badge("b-legacy", FakeRequest({"photo_base64": _b64(raw)})))
    stored = _run(db.badges.find_one({"id": "b-legacy"}))
    assert "photo_base64" not in stored and bucket.objects[stored["photo_key"]] == raw


def test_deleting_a_badge_deletes_its_photo(bucket, db):
    created = _create(_b64(_png()))
    key = _run(db.badges.find_one({"id": created["id"]}))["photo_key"]
    _run(badges_route.delete_badge(created["id"], FakeRequest()))
    assert key not in bucket.objects


def test_without_a_bucket_badges_stay_inline(monkeypatch, db):
    monkeypatch.setattr(object_storage, "is_configured", lambda: False)
    raw = _png()
    created = _create(_b64(raw))
    stored = _run(db.badges.find_one({"id": created["id"]}))
    assert stored["photo_base64"] == _b64(raw) and "photo_key" not in stored


# ── avatars ──────────────────────────────────────────────────────────────

def _user(db):
    oid = ObjectId()
    _run(db.users.insert_one({"_id": oid, "id": str(oid), "name": "Ava", "email": "ava@example.test"}))
    return {"id": str(oid), "role": "trainee"}


def test_avatar_upload_stores_a_url_and_drops_the_previous_file(bucket, db, monkeypatch):
    me = _user(db)

    async def _me(_request):
        return me
    monkeypatch.setattr(auth_routes, "get_current_user", _me)
    req = auth_routes.ProfileImageRequest(image="data:image/png;base64," + _b64(_png(size=(900, 900))))

    first = _run(auth_routes.upload_profile_image(req, FakeRequest()))["profile_image"]
    assert first.startswith("https://cg1.example.test/api/media/avatars/" + me["id"] + "/")
    first_key = media_store.key_from_avatar_url(first)
    assert first_key in bucket.objects

    second = _run(auth_routes.upload_profile_image(req, FakeRequest()))["profile_image"]
    assert second != first and first_key not in bucket.objects
    stored = _run(db.users.find_one({"_id": ObjectId(me["id"])}))
    assert stored["profile_image"] == second

    _run(auth_routes.remove_own_profile_image(FakeRequest()))
    assert not bucket.objects


def test_avatar_upload_rejects_garbage(bucket, db, monkeypatch):
    me = _user(db)

    async def _me(_request):
        return me
    monkeypatch.setattr(auth_routes, "get_current_user", _me)
    with pytest.raises(HTTPException) as e:
        _run(auth_routes.upload_profile_image(auth_routes.ProfileImageRequest(image=_b64(b"not an image")), FakeRequest()))
    assert e.value.status_code == 400


# ── public media route ───────────────────────────────────────────────────

def test_media_route_serves_avatars_with_long_cache(bucket):
    key = "avatars/u1/" + "b" * 32 + ".jpg"
    bucket.objects[key] = b"\xff\xd8\xffjpeg"
    resp = _run(media_route.get_media(key))
    assert resp.body == b"\xff\xd8\xffjpeg"
    assert "immutable" in resp.headers["cache-control"]


@pytest.mark.parametrize("key", [
    "badges/b1/abc.png",                        # badge photos are never public
    "ci/office/user/session/000001.m4a",         # nor call audio
    "avatars/u1/../../ci/x.jpg",
    "avatars/u1/short.jpg",
])
def test_media_route_refuses_anything_but_avatar_keys(bucket, key):
    bucket.objects[key] = b"secret"
    with pytest.raises(HTTPException) as e:
        _run(media_route.get_media(key))
    assert e.value.status_code == 404
