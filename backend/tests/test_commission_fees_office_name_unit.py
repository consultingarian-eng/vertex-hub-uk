"""GET/PUT /commission-fees — the office's Vertex pay knobs.

GET always answers with the full Vertex schema (stored values where valid,
the defaults elsewhere — including for documents written by the old nested
pay model) plus the derived `office_name`. PUT stores only known knobs,
validates their ranges, and never persists the derived fields.

Pure in-memory: mongomock_motor, no network, no real Mongo.
"""
import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import training_routes as tr  # noqa: E402
from core.vertex_pay import ADMIN_ONLY_FEE_KEYS, DEFAULT_FEES  # noqa: E402

# What everyone is shown: every knob except the office's own income (fee_mc),
# which only an Admin gets.
SHARED_FEES = {k: v for k, v in DEFAULT_FEES.items() if k not in ADMIN_ONLY_FEE_KEYS}


def _db():
    return AsyncMongoMockClient()["vertex_fees_test"]


def _run(coro):
    return asyncio.run(coro)


def _patch(monkeypatch, db, office_id="off-ldn"):
    async def _user(_request):
        return {"id": "u1", "role": "trainee", "office_id": office_id}

    async def _office(_request, _user, _office):
        return office_id

    monkeypatch.setattr(tr, "db", db)
    monkeypatch.setattr(tr, "get_current_user", _user)
    monkeypatch.setattr(tr, "resolve_office_id", _office)


def _admin_put(monkeypatch, body):
    class _Req:
        headers = {"content-type": "application/json"}

        async def json(self):
            return body

    async def _admin(_request):
        return {"id": "u1", "role": "admin", "office_id": "off-ldn"}

    monkeypatch.setattr(tr, "require_admin", _admin)
    return _Req()


def test_nothing_stored_gives_the_vertex_defaults(monkeypatch):
    db = _db()
    _patch(monkeypatch, db)
    _run(db.offices.insert_one({"id": "off-ldn", "name": "London"}))
    out = _run(tr.get_commission_fees(None))
    assert out["office_name"] == "London"
    for k, v in SHARED_FEES.items():
        assert out[k] == v
    assert "fee_mc" not in out          # a BA is never sent the office's fee
    assert out["fee_standard"] == 55 and out["fee_target"] == 60 and out["fee_premium"] == 60
    assert out["third_dd_bonus"] == 15
    assert out["quality_lag_months"] == 4


def test_stored_knobs_win_and_gaps_take_defaults(monkeypatch):
    db = _db()
    _patch(monkeypatch, db)
    _run(db.offices.insert_one({"id": "off-ldn", "name": "London"}))
    _run(db.commission_fees.insert_one({"office_id": "off-ldn", "fee_standard": 50, "quality_gate_pct": 75}))
    out = _run(tr.get_commission_fees(None))
    assert out["fee_standard"] == 50
    assert out["quality_gate_pct"] == 75
    assert out["fee_target"] == 60  # not stored → default


def test_old_shape_document_is_tolerated(monkeypatch):
    """A doc written by the previous (nested delivery-tier) pay model must
    not leak through or break the screen — every knob falls back."""
    db = _db()
    _patch(monkeypatch, db)
    _run(db.commission_fees.insert_one({
        "office_id": "off-ldn",
        "base": {"first": 35, "second": 20, "fourth": 10},
        "volume_threshold": 12,
        "base_commission": 25,
        "targets": {"second_pct": {"min": 60}},
        "fee_target": "not a number",
        "fee_premium": -5,
    }))
    out = _run(tr.get_commission_fees(None))
    assert {k: out[k] for k in SHARED_FEES} == SHARED_FEES
    assert "base" not in out and "volume_threshold" not in out and "base_commission" not in out


def test_unknown_office_yields_empty_name(monkeypatch):
    db = _db()
    _patch(monkeypatch, db, office_id="off-ghost")
    out = _run(tr.get_commission_fees(None))
    assert out["office_name"] == ""


def test_put_stores_only_known_knobs(monkeypatch):
    """A Fees-editor round-trip includes the GET's derived office_name — it
    must never be persisted (apply_all / office-clone would stamp one
    office's name onto every doc), nor may stray keys."""
    db = _db()
    _patch(monkeypatch, db)
    req = _admin_put(monkeypatch, {
        "fee_standard": "57", "third_dd_bonus": 20, "quality_lag_months": 4,
        "office_name": "London", "new_hire_training_pay": True, "base": {"first": 35},
    })
    out = _run(tr.update_commission_fees(req))
    doc = _run(db.commission_fees.find_one({"office_id": "off-ldn"}))
    assert doc["fee_standard"] == 57 and doc["third_dd_bonus"] == 20
    assert "office_name" not in doc and "new_hire_training_pay" not in doc and "base" not in doc
    assert out["fees"]["fee_standard"] == 57 and out["fees"]["fee_target"] == 60


@pytest.mark.parametrize("body", [
    {"fee_standard": -1},
    {"quality_gate_pct": 101},
    {"leadership_threshold_pct": "seventy"},
    {"fee_target": None},
])
def test_put_rejects_out_of_range_values(monkeypatch, body):
    db = _db()
    _patch(monkeypatch, db)
    req = _admin_put(monkeypatch, body)
    with pytest.raises(HTTPException) as exc:
        _run(tr.update_commission_fees(req))
    assert exc.value.status_code == 400
    assert next(iter(body)) in exc.value.detail
    assert _run(db.commission_fees.find_one({"office_id": "off-ldn"})) is None


def test_put_with_no_known_knobs_is_rejected(monkeypatch):
    db = _db()
    _patch(monkeypatch, db)
    req = _admin_put(monkeypatch, {"office_name": "London"})
    with pytest.raises(HTTPException) as exc:
        _run(tr.update_commission_fees(req))
    assert exc.value.status_code == 400


def test_the_office_fee_is_sent_to_an_admin_only(monkeypatch):
    db = _db()
    _patch(monkeypatch, db)
    _run(db.offices.insert_one({"id": "off-ldn", "name": "London"}))
    _run(db.commission_fees.insert_one({"office_id": "off-ldn", "fee_mc": 32}))
    assert "fee_mc" not in _run(tr.get_commission_fees(None))      # the BA from _patch

    async def _coach(_request):
        return {"id": "u2", "role": "leader", "coach_plus": True, "office_id": "off-ldn"}
    monkeypatch.setattr(tr, "get_current_user", _coach)
    assert "fee_mc" not in _run(tr.get_commission_fees(None))      # nor a Coach, Coach+ included

    async def _admin(_request):
        return {"id": "u3", "role": "admin", "office_id": "off-ldn"}
    monkeypatch.setattr(tr, "get_current_user", _admin)
    assert _run(tr.get_commission_fees(None))["fee_mc"] == 32
