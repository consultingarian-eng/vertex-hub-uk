"""LLM concurrency guard — a box-wide brake on simultaneous model calls.

The interactive LLM endpoints (planner AI coach, Leadership Hub coaching
assistant, Letter Maker) each hold an HTTP connection open for
the full duration of an upstream model round-trip. On our small box a
classroom of trainees tapping "ask" in the same minute piles up dozens of
concurrent upstream calls — each one pinning a connection and memory until
Anthropic/Gemini answers. This module caps how many model calls run at once
and turns the overflow into a fast, friendly 503 instead of a slow collapse.

Usage:
    from core.llm_guard import acquire_llm_slot

    async with acquire_llm_slot():
        response_text = await chat.send_message(...)

Rules of engagement:
  * Hold the slot ONLY around the model call itself (including any history
    replay that also hits the model) — never around Mongo reads, retrieval
    scoring, or request parsing, so a busy coach doesn't serialize cheap work.
  * If an endpoint ever streams, hold the slot for the stream's full duration
    — the upstream connection is open the whole time.

The cap defaults to 4 and can be overridden with the LLM_MAX_CONCURRENCY env
var. The semaphore is a module-level singleton created on first use, so the
override is read after dotenv has loaded (and tests can reset it).
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from fastapi import HTTPException

DEFAULT_MAX_CONCURRENCY = 4

BUSY_DETAIL = "The coach is helping several people right now — try again in a moment."

_semaphore: Optional[asyncio.Semaphore] = None
_limit: int = DEFAULT_MAX_CONCURRENCY
_in_use: int = 0


def _configured_limit() -> int:
    """LLM_MAX_CONCURRENCY env override, falling back to the default on
    anything unset, non-numeric, or < 1 (a zero/negative cap would deadlock
    every coach forever — fail safe to the default instead)."""
    raw = (os.getenv("LLM_MAX_CONCURRENCY") or "")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MAX_CONCURRENCY
    return value if value >= 1 else DEFAULT_MAX_CONCURRENCY


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore, _limit
    if _semaphore is None:
        _limit = _configured_limit()
        _semaphore = asyncio.Semaphore(_limit)
    return _semaphore


def _reset_for_tests() -> None:
    """Drop the singleton so the next use re-reads LLM_MAX_CONCURRENCY.
    Test-only — never call this while slots are held."""
    global _semaphore, _limit, _in_use
    _semaphore = None
    _limit = DEFAULT_MAX_CONCURRENCY
    _in_use = 0


@asynccontextmanager
async def acquire_llm_slot(wait_seconds: float = 2.0) -> AsyncIterator[None]:
    """Reserve one of the LLM_MAX_CONCURRENCY model-call slots.

    Waits up to `wait_seconds` for a slot to free up (a short queue absorbs
    normal bursts), then gives up with a 503 the frontend can surface as
    "coach is busy, try again" — much better than every trainee's request
    slowly grinding through a saturated box.
    """
    global _in_use
    sem = _get_semaphore()
    try:
        await asyncio.wait_for(sem.acquire(), timeout=wait_seconds)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail=BUSY_DETAIL) from None
    _in_use += 1
    try:
        yield
    finally:
        _in_use -= 1
        sem.release()


def stats() -> dict:
    """{in_use, limit} — for a future admin 'coach load' view."""
    _get_semaphore()  # ensure limit reflects the env override
    return {"in_use": _in_use, "limit": _limit}
