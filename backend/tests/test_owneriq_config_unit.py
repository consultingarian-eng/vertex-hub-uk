"""owneriq_config — mapping app offices to OwnerIQ companies without any
hard-coded company ids, pins or office names.
"""
import asyncio
import sys
from pathlib import Path

from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import owneriq_config as cfg  # noqa: E402

TWO = [{"id": "7", "pin": "4001", "name": "North Office"},
       {"id": "8", "pin": "4002", "name": "South Office"}]


def test_explicit_office_field_wins():
    office = {"id": "o1", "name": "North Office", "owneriq_pin": "9999"}
    assert cfg.resolve_office_pin(office, TWO, overrides={}) == "9999"


def test_env_override_by_office_name(monkeypatch):
    monkeypatch.setenv("OWNERIQ_OFFICE_PINS", "Head Office=4002, Other=4001")
    assert cfg.resolve_office_pin({"name": "head office"}, TWO) == "4002"


def test_single_company_maps_every_office():
    one = [{"id": "7", "pin": "4001", "name": "Anything"}]
    assert cfg.resolve_office_pin({"name": "Head Office"}, one, overrides={}) == "4001"


def test_several_companies_match_by_exact_name_only():
    assert cfg.resolve_office_pin({"name": "south office"}, TWO, overrides={}) == "4002"
    assert cfg.resolve_office_pin({"name": "South"}, TWO, overrides={}) is None
    assert cfg.resolve_office_pin(None, TWO, overrides={}) is None


def test_parse_companies_reads_json_api_rows():
    payload = {"data": [
        {"id": 7, "attributes": {"pin": 4001, "name": "North Office"}},
        {"id": 9, "attributes": {"name": "no pin — ignored"}},
    ]}
    assert cfg.parse_companies(payload) == [{"id": "7", "pin": "4001", "name": "North Office"}]


def test_known_companies_and_office_pin_use_the_cache(monkeypatch):
    monkeypatch.delenv("OWNERIQ_MC_PINS", raising=False)
    monkeypatch.delenv("OWNERIQ_OFFICE_PINS", raising=False)
    db = AsyncMongoMockClient()["owneriq_cfg_test"]

    async def go():
        await db.owneriq_meta.insert_one({"_id": "companies", "companies": TWO})
        await db.offices.insert_one({"id": "o-south", "name": "South Office"})
        assert await cfg.office_pin("o-south", db) == "4002"
        assert await cfg.office_pin_map(db) == {"o-south": "4002"}
        monkeypatch.setenv("OWNERIQ_MC_PINS", "4001,5000")
        pins = [c["pin"] for c in await cfg.known_companies(db)]
        assert pins == ["4001", "5000"]  # configured order; unknown pin kept

    asyncio.run(go())


def test_root_user_ids_default_empty(monkeypatch):
    monkeypatch.delenv("OWNERIQ_ROOT_USER_IDS", raising=False)
    assert cfg.root_user_ids() == set()
    monkeypatch.setenv("OWNERIQ_ROOT_USER_IDS", "55, 60")
    assert cfg.root_user_ids() == {"55", "60"}
