"""LLM concurrency guard: the semaphore that keeps a classroom of trainees
from piling long model calls onto the small box. These tests pin the slot
lifecycle (released on success AND on exception), the busy 503 with its
friendly detail, the LLM_MAX_CONCURRENCY env override (including junk
values), and the stats() shape for the future admin view.

Pure asyncio — no network, no Mongo, no LLM.
"""
import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import llm_guard  # noqa: E402
from core.llm_guard import BUSY_DETAIL, acquire_llm_slot, stats  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_guard(monkeypatch):
    """Each test gets a fresh singleton (and a clean env) so limits and
    counters never leak between tests."""
    monkeypatch.delenv("LLM_MAX_CONCURRENCY", raising=False)
    llm_guard._reset_for_tests()
    yield
    llm_guard._reset_for_tests()


# ── Slot lifecycle ────────────────────────────────────────────────────────

def test_slot_released_on_success():
    async def run():
        async with acquire_llm_slot():
            assert stats() == {"in_use": 1, "limit": 4}
        assert stats() == {"in_use": 0, "limit": 4}
        # And the slot is genuinely reusable — a full round of re-acquires works.
        async with acquire_llm_slot(wait_seconds=0.05):
            assert stats()["in_use"] == 1
    asyncio.run(run())


def test_slot_released_on_exception():
    async def run():
        with pytest.raises(RuntimeError, match="model exploded"):
            async with acquire_llm_slot():
                raise RuntimeError("model exploded")
        assert stats() == {"in_use": 0, "limit": 4}
        # The freed slot must be immediately acquirable again.
        async with acquire_llm_slot(wait_seconds=0.05):
            pass
    asyncio.run(run())


def test_slot_released_when_httpexception_escapes_the_body():
    """Routes convert model failures to 502/504 inside the guarded block —
    those must release the slot on the way out too."""
    async def run():
        with pytest.raises(HTTPException) as exc:
            async with acquire_llm_slot():
                raise HTTPException(status_code=502, detail="LLM call failed")
        assert exc.value.status_code == 502
        assert stats()["in_use"] == 0
    asyncio.run(run())


# ── Saturation → 503 ──────────────────────────────────────────────────────

def test_timeout_raises_busy_503(monkeypatch):
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "1")
    llm_guard._reset_for_tests()

    async def run():
        release = asyncio.Event()

        async def hog():
            async with acquire_llm_slot():
                await release.wait()

        hog_task = asyncio.create_task(hog())
        for _ in range(20):  # let the hog grab the only slot
            await asyncio.sleep(0)
            if stats()["in_use"] == 1:
                break
        assert stats() == {"in_use": 1, "limit": 1}

        with pytest.raises(HTTPException) as exc:
            async with acquire_llm_slot(wait_seconds=0.05):
                pass  # pragma: no cover — must not be reached
        assert exc.value.status_code == 503
        assert exc.value.detail == BUSY_DETAIL

        # Once the hog finishes, the next caller gets straight in.
        release.set()
        await hog_task
        async with acquire_llm_slot(wait_seconds=0.05):
            assert stats()["in_use"] == 1
    asyncio.run(run())


def test_waiter_within_window_gets_the_slot(monkeypatch):
    """A caller arriving while the box is briefly full should WAIT (up to
    wait_seconds) and succeed — the queue absorbs normal bursts."""
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "1")
    llm_guard._reset_for_tests()

    async def run():
        async def quick_hog():
            async with acquire_llm_slot():
                await asyncio.sleep(0.05)

        hog_task = asyncio.create_task(quick_hog())
        await asyncio.sleep(0)
        async with acquire_llm_slot(wait_seconds=2.0):  # outlives the hog
            assert stats()["in_use"] == 1
        await hog_task
    asyncio.run(run())


# ── Env override ──────────────────────────────────────────────────────────

def test_env_override_raises_the_cap(monkeypatch):
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "2")
    llm_guard._reset_for_tests()

    async def run():
        async with acquire_llm_slot():
            async with acquire_llm_slot():
                assert stats() == {"in_use": 2, "limit": 2}
                # Third concurrent caller is over the cap → busy 503.
                with pytest.raises(HTTPException) as exc:
                    async with acquire_llm_slot(wait_seconds=0.05):
                        pass  # pragma: no cover
                assert exc.value.status_code == 503
        assert stats()["in_use"] == 0
    asyncio.run(run())


def test_env_override_ignores_junk_and_nonpositive(monkeypatch):
    # Junk falls back to the default …
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "lots")
    llm_guard._reset_for_tests()
    assert stats()["limit"] == 4
    # … and 0/negative would deadlock every coach, so it falls back too.
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "0")
    llm_guard._reset_for_tests()
    assert stats()["limit"] == 4


# ── stats() shape ─────────────────────────────────────────────────────────

def test_stats_shape_before_any_acquire():
    assert stats() == {"in_use": 0, "limit": 4}
