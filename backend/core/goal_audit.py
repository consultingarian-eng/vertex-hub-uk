"""Append-only trail of every weekly_goal / team_weekly_goal change.

Sales goals are the one thing on a bells row people actually dispute — a
leader sees a crew goal they say they didn't set, and nothing on the row can
settle it. `updated_at` is no help: POST /bells bumps it on every sheet save
whether or not a goal moved, which is why a whole office can share one
timestamp to the second.

So record the transition itself — old → new, who did it, and which endpoint —
at every site that writes either field. The next report is then one query
instead of an inference.

Best-effort by construction: auditing must never fail a user's save, so every
write is wrapped and failures are logged, not raised.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


def _norm(v):
    """Goals arrive as int, float, str or None depending on the endpoint
    (the Bells path stores ints, the planner path floats). Compare on value
    so a 16 → 16.0 rewrite isn't logged as a change."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


async def record_goal_change(
    db,
    *,
    user_id: str,
    week_ending: Optional[str],
    field: str,
    old,
    new,
    actor: Optional[dict],
    source: str,
) -> None:
    """Append one row iff the value actually moved."""
    try:
        o, n = _norm(old), _norm(new)
        if o == n:
            return
        actor = actor or {}
        await db.goal_audit.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": str(user_id or ""),
            "week_ending": week_ending,
            "field": field,
            "old": o,
            "new": n,
            "actor_id": str(actor.get("id") or ""),
            "actor_name": actor.get("name") or actor.get("email") or "",
            "actor_role": actor.get("role") or "",
            "source": source,
            "at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:  # noqa: BLE001 — auditing must not break saving
        logger.warning("goal audit failed (%s %s user=%s): %s", source, field, user_id, e)
