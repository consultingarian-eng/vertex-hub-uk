"""Unit tests for the demo-account write guard (auth.demo_write_blocked).

A user doc with is_demo: true is a walk-around trial account: full visibility,
but no mutation may reach production data. The guard keys off the REAL token
subject, so a demo super admin stays read-only even while using "View As".
Pure in-memory via mongomock.
"""
import asyncio
import os
import sys
from pathlib import Path

from mongomock_motor import AsyncMongoMockClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("JWT_SECRET", "unit-test-secret-with-32-plus-chars!!")

import auth  # noqa: E402
from starlette.requests import Request  # noqa: E402


def _request(method: str, path: str, token: str | None = None) -> Request:
    headers = []
    if token:
        headers.append((b"authorization", f"Bearer {token}".encode()))
    return Request({
        "type": "http", "method": method, "path": path,
        "headers": headers, "query_string": b"", "scheme": "http",
        "server": ("test", 80),
    })


def _arm(monkeypatch, demo_ids):
    db = AsyncMongoMockClient()["cg1_demo_guard_test"]
    monkeypatch.setattr(auth, "db", db)
    monkeypatch.setitem(auth._demo_ids_cache, "ids", frozenset())
    monkeypatch.setitem(auth._demo_ids_cache, "at", 0.0)
    from bson import ObjectId

    async def _seed():
        out = []
        for is_demo in demo_ids:
            r = await db.users.insert_one({"is_demo": is_demo, "email": "x@example.com"})
            out.append(str(r.inserted_id))
        return out
    return asyncio.run(_seed())


def test_demo_user_mutations_are_blocked(monkeypatch):
    demo_id, real_id = _arm(monkeypatch, [True, False])
    demo_tok = auth.create_access_token(demo_id, "demo@example.com")
    real_tok = auth.create_access_token(real_id, "real@example.com")

    assert asyncio.run(auth.demo_write_blocked(_request("POST", "/api/schedule", demo_tok))) is True
    assert asyncio.run(auth.demo_write_blocked(_request("DELETE", "/api/users/1", demo_tok))) is True
    # Reads sail through; other accounts are untouched.
    assert asyncio.run(auth.demo_write_blocked(_request("GET", "/api/schedule", demo_tok))) is False
    assert asyncio.run(auth.demo_write_blocked(_request("POST", "/api/schedule", real_tok))) is False


def test_auth_endpoints_and_anonymous_traffic_stay_open(monkeypatch):
    demo_id, = _arm(monkeypatch, [True])
    demo_tok = auth.create_access_token(demo_id, "demo@example.com")

    for path in sorted(auth.DEMO_ALLOWED_PATHS):
        assert asyncio.run(auth.demo_write_blocked(_request("POST", path, demo_tok))) is False
    # No/garbage token → not our problem; the normal auth layer answers.
    assert asyncio.run(auth.demo_write_blocked(_request("POST", "/api/schedule"))) is False
    assert asyncio.run(auth.demo_write_blocked(_request("POST", "/api/schedule", "garbage"))) is False


def test_view_as_header_does_not_launder_a_demo_write(monkeypatch):
    """The guard follows the token subject, not the previewed identity."""
    demo_id, target_id = _arm(monkeypatch, [True, False])
    demo_tok = auth.create_access_token(demo_id, "demo@example.com")
    req = Request({
        "type": "http", "method": "POST", "path": "/api/schedule",
        "headers": [
            (b"authorization", f"Bearer {demo_tok}".encode()),
            (b"x-view-as-user-id", target_id.encode()),
        ],
        "query_string": b"", "scheme": "http", "server": ("test", 80),
    })
    assert asyncio.run(auth.demo_write_blocked(req)) is True


def test_read_only_posts_are_not_treated_as_writes(monkeypatch):
    """Reports, the bells parser and friends compute and return — a trial
    account must still be able to open those screens."""
    demo_id, = _arm(monkeypatch, [True])
    demo_tok = auth.create_access_token(demo_id, "demo@example.com")

    for path in sorted(auth.DEMO_ALLOWED_READ_POSTS):
        assert asyncio.run(auth.demo_write_blocked(_request("POST", path, demo_tok))) is False
    # Neighbours of an allowlisted path are still writes.
    assert asyncio.run(auth.demo_write_blocked(_request("POST", "/api/reports", demo_tok))) is True
    assert asyncio.run(auth.demo_write_blocked(_request("POST", "/api/reports/generate/x", demo_tok))) is True


def test_bulk_export_stays_shut_even_though_it_is_a_get(monkeypatch):
    """Seeing the product is visibility; streaming the database under it is not."""
    demo_id, real_id = _arm(monkeypatch, [True, False])
    demo_tok = auth.create_access_token(demo_id, "demo@example.com")
    real_tok = auth.create_access_token(real_id, "real@example.com")

    for path in sorted(auth.DEMO_BLOCKED_READS):
        assert asyncio.run(auth.demo_read_blocked(_request("GET", path, demo_tok))) is True
        # A real super admin keeps it.
        assert asyncio.run(auth.demo_read_blocked(_request("GET", path, real_tok))) is False
    # Ordinary reads are untouched.
    assert asyncio.run(auth.demo_read_blocked(_request("GET", "/api/schedule", demo_tok))) is False


def test_password_recovery_is_not_an_allowlisted_auth_path():
    """The login is shared, so one holder must not be able to rotate it."""
    for path in auth.DEMO_ALLOWED_PATHS:
        assert "forgot" not in path and "reset" not in path and "password" not in path
