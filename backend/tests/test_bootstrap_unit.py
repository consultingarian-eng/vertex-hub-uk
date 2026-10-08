"""core/bootstrap — first boot seeds ONE office (named by SEED_OFFICE_NAME)
and the owner's super-admin from env, and nothing company-specific.
Pure in-memory: mongomock, no network.
"""
import asyncio
import sys
from pathlib import Path

from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import bootstrap  # noqa: E402
from seed_data import DAY_TARGETS, TRAINING_MANUAL  # noqa: E402


def _db():
    return AsyncMongoMockClient()["bootstrap_test"]


def _env(monkeypatch, **values):
    for key in ("ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_NAME", "SEED_OFFICE_NAME"):
        monkeypatch.delenv(key, raising=False)
    for key, value in values.items():
        monkeypatch.setenv(key, value)


def test_fresh_db_gets_one_named_office_and_a_super_admin_in_it(monkeypatch):
    _env(monkeypatch, ADMIN_EMAIL="Owner@Example.org", ADMIN_PASSWORD="a-long-password-123",
         ADMIN_NAME="Olivia Owner", SEED_OFFICE_NAME="Leeds")
    db = _db()

    async def go():
        out = await bootstrap.seed_admin_and_first_office(db)
        offices = await db.offices.find({}).to_list(10)
        assert [o["name"] for o in offices] == ["Leeds"]
        office_id = offices[0]["id"]
        assert out["seeded_office_id"] == office_id
        admin = await db.users.find_one({"email": "owner@example.org"})
        assert admin["name"] == "Olivia Owner"
        assert admin["is_super_admin"] is True and admin["role"] == "admin"
        assert admin["office_id"] == office_id
        assert admin["accessible_offices"] == [office_id]
        assert await db.targets.count_documents({"office_id": office_id}) == len(DAY_TARGETS)
        assert await db.training_manual.count_documents({"office_id": office_id}) == len(TRAINING_MANUAL)
        # Idempotent: a second boot adds nothing.
        again = await bootstrap.seed_admin_and_first_office(db)
        assert again["seeded_office_id"] is None
        assert await db.offices.count_documents({}) == 1
        assert await db.users.count_documents({}) == 1

    asyncio.run(go())


def test_defaults_without_env(monkeypatch):
    _env(monkeypatch)
    db = _db()

    async def go():
        out = await bootstrap.seed_admin_and_first_office(db)
        assert out["admin_email"] == ""
        assert await db.users.count_documents({}) == 0  # no admin without env
        office = await db.offices.find_one({})
        assert office["name"] == "Head Office"

    asyncio.run(go())


def test_admin_added_later_is_given_the_existing_office(monkeypatch):
    _env(monkeypatch)
    db = _db()

    async def go():
        await bootstrap.seed_admin_and_first_office(db)
        office = await db.offices.find_one({})
        _env(monkeypatch, ADMIN_EMAIL="late@example.org", ADMIN_PASSWORD="a-long-password-123")
        await bootstrap.seed_admin_and_first_office(db)
        admin = await db.users.find_one({"email": "late@example.org"})
        assert admin["name"] == "Admin"
        assert admin["office_id"] == office["id"]
        assert await db.offices.count_documents({}) == 1

    asyncio.run(go())
