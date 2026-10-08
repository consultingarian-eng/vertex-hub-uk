"""Small in-memory rate limits shared by the routes.

Best effort, per worker process: a restart clears them. That is fine for
what they guard (password guessing, share-code guessing, AI spend), where the
point is to make brute force slow, not to keep an exact ledger.

Client IP
---------
`client_ip()` is the one place that decides who "this IP" is. With
TRUST_PROXY_HEADERS off, it is the socket peer (on a host like Railway that is
the platform's proxy, so every visitor shares it). With TRUST_PROXY_HEADERS on,
it is the RIGHT-MOST X-Forwarded-For entry: the hop the platform's own proxy
appended. Anything to the left of it came from the client and can be forged,
so it is never used. Set TRUSTED_PROXY_HOPS (default 1) only if more than one
proxy you control sits in front of the app (for example a CDN in front of
Railway).
"""
import os
import time
from typing import Dict, List

from fastapi import HTTPException, Request

_MAX_BUCKETS = 10_000


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _on_railway() -> bool:
    return bool((os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_ENVIRONMENT_NAME") or "").strip())


def trust_proxy_headers() -> bool:
    """TRUST_PROXY_HEADERS decides when it is set. Left blank it is on for a
    Railway deploy (Railway's edge always appends the caller's address, and
    client_ip reads that right-most hop) and off everywhere else."""
    raw = (os.getenv("TRUST_PROXY_HEADERS") or "").strip()
    if raw:
        return _truthy(raw)
    return _on_railway()


def _trusted_hops() -> int:
    try:
        return max(1, int(os.getenv("TRUSTED_PROXY_HOPS") or "1"))
    except ValueError:
        return 1


def proxy_warning() -> str | None:
    """The boot warning for a hosted deploy that doesn't trust its proxy's
    X-Forwarded-For: there every visitor has the proxy's address, so every
    per-IP limit (logins, share codes, the roster link, the manual editor) is
    shared by all visitors, and one person's wrong guesses lock everyone out
    for the window. None when there is nothing to warn about."""
    if _on_railway() and not trust_proxy_headers():
        return ("TRUST_PROXY_HEADERS is set to off on a Railway deploy: every visitor shares the proxy's IP, so "
                "per-IP limits (logins, share codes, the roster link) are shared by everyone. "
                "Set TRUST_PROXY_HEADERS=true or remove it.")
    return None


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else "unknown"
    if not trust_proxy_headers():
        return peer
    hops = [h.strip() for h in (request.headers.get("x-forwarded-for") or "").split(",") if h.strip()]
    if not hops:
        return peer
    n = _trusted_hops()
    # The Nth entry from the right was appended by the outermost proxy we
    # trust; a shorter header than expected falls back to its first entry.
    return hops[-n] if len(hops) >= n else hops[0]


class Limiter:
    """Sliding-window counter: `check` raises 429 once `limit` hits are
    recorded for a key inside `window` seconds; `hit` records one."""

    def __init__(self, limit: int, window_seconds: int, detail: str = "Too many attempts. Try again later."):
        self.limit = limit
        self.window = window_seconds
        self.detail = detail
        self._buckets: Dict[str, List[float]] = {}

    def _recent(self, key: str) -> List[float]:
        cutoff = time.monotonic() - self.window
        recent = [t for t in self._buckets.get(key, []) if t >= cutoff]
        if recent:
            self._buckets[key] = recent
        else:
            self._buckets.pop(key, None)
        return recent

    def blocked(self, key: str) -> bool:
        return len(self._recent(key)) >= self.limit

    def check(self, key: str) -> None:
        if self.blocked(key):
            raise HTTPException(status_code=429, detail=self.detail)

    def hit(self, key: str) -> None:
        if len(self._buckets) >= _MAX_BUCKETS and key not in self._buckets:
            stalest = min(self._buckets, key=lambda k: self._buckets[k][-1] if self._buckets[k] else 0)
            self._buckets.pop(stalest, None)
        self._buckets.setdefault(key, []).append(time.monotonic())

    def take(self, key: str) -> None:
        """check + hit in one go (for quotas, where every call counts)."""
        self.check(key)
        self.hit(key)

    def clear(self, key: str) -> None:
        self._buckets.pop(key, None)

    def reset(self) -> None:
        self._buckets.clear()


def _ai_hourly_limit() -> int:
    try:
        return max(1, int(os.getenv("AI_HOURLY_LIMIT_PER_USER") or "60"))
    except ValueError:
        return 60


# One shared hourly quota for every route that calls the AI model, keyed by
# user id. Default 60 calls per person per hour (AI_HOURLY_LIMIT_PER_USER).
AI_QUOTA = Limiter(_ai_hourly_limit(), 60 * 60,
                   detail="You've used the AI a lot this hour. Try again a little later.")


def take_ai_quota(user: dict, units: int = 1) -> None:
    """Charge `units` model calls to this person's hourly AI quota (429 once
    it is used up). A route that makes two model calls charges 2."""
    uid = str(user.get("_id") or user.get("id") or "")
    key = f"ai:{uid or 'anon'}"
    AI_QUOTA.check(key)
    for _ in range(max(1, units)):
        AI_QUOTA.hit(key)


# Cached content generation (module and coaching quizzes): one model attempt
# per content item per hour. The mark is set before the call and cleared on
# success, so a failure (timeout, bad JSON) isn't retried on every request,
# and parallel requests don't each start their own generation.
QUIZ_RETRY_SECONDS = 60 * 60
_GENERATION_ATTEMPTS = Limiter(1, QUIZ_RETRY_SECONDS)


def generation_allowed(key: str) -> bool:
    return not _GENERATION_ATTEMPTS.blocked(key)


def generation_started(key: str) -> None:
    _GENERATION_ATTEMPTS.hit(key)


def generation_succeeded(key: str) -> None:
    _GENERATION_ATTEMPTS.clear(key)
